/**
 * The MCP host: the registry's pure tools behind server-side references.
 *
 * Transport only — no science here. `server.ts` connects this server to stdio;
 * tests connect it to an in-memory client. On top of each registry tool it adds
 * what a language model needs to drive the tools without shuttling data:
 *
 *  - REFS (`refs.ts`): every output is stored, the response is a compact view,
 *    and any argument may be a `{ "ref": … }` resolved before the handler runs;
 *  - `path` on the parse tools (`fileInput` in the registry): the server reads
 *    the file itself, confined to its data folders;
 *  - `free` on the refining tools (`selectsFree`): ids or globs that set every
 *    parameter's `fixed` flag, so the parameter array is never retyped;
 *  - `read_ref`, to look inside a stored value.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { TOOL_REGISTRY, type ToolDefinition } from "@/mcp/registry";
import { REF_KEY, RefStore, buildView, resolveRefs } from "@/mcp/refs";

export interface HostOptions {
  /** Folders a `path` argument may read from. Default: `defaultRoots()`. */
  readonly roots?: readonly string[];
  /** Largest response view, in characters of compact JSON. */
  readonly budget?: number;
  /** Tool calls kept in the ref store. */
  readonly capacity?: number;
}

/** Default response budget: ~2–3 k tokens, far below MCP clients' output caps. */
export const RESPONSE_BUDGET = 8000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const INSTRUCTIONS = `MATERIA: crystallographic refinement tools (powder, single crystal, PDF, magnetic).

Data travels by reference. Every object result carries "ref": "#n" for the whole output, and bulky parts (structure, pattern, parameters, residual, …) come back as {"ref": "#n/key", …summary}. Pass such an object, or just {"ref": "#n/key"}, wherever a tool expects that value: the server substitutes the stored data. Never retype data you received as a ref.

Files: the parse_* tools take \`path\` instead of the file's text — relative to the server's data folder, or absolute inside it.

What refines: refining tools take \`free\`, a list of parameter ids or globs such as ["scale", "bkg*", "*cell*"]. Exactly the matching parameters refine; every other one is held fixed. Globs can catch a parameter that must stay fixed (the magnetic phase gauge), so list ids when in doubt. Refining tools return \`parameters\` carrying the refined values — pass that ref to the next call and to assess_refinement.

To look inside a ref, call read_ref (with start/end for long arrays).`;

/**
 * Folders `path` may read from: MATERIA_ROOTS (a path list) when set, else the
 * working directory — unless that is the filesystem root or the home folder,
 * which some clients launch servers in. Then reading files stays off until
 * MATERIA_ROOTS names a folder.
 */
export function defaultRoots(): string[] {
  const env = process.env.MATERIA_ROOTS;
  if (env) return env.split(delimiter).filter(Boolean).map((r) => resolve(r));
  const cwd = resolve(process.cwd());
  return cwd === parse(cwd).root || cwd === resolve(homedir()) ? [] : [cwd];
}

/** The MCP server over the registry, with refs, `path`, `free` and `read_ref`. */
export function createMateriaServer(opts: HostOptions = {}): McpServer {
  const roots = opts.roots ?? defaultRoots();
  const budget = opts.budget ?? RESPONSE_BUDGET;
  const store = new RefStore(opts.capacity);
  const server = new McpServer({ name: "materia", version: "0.2.0" }, { instructions: INSTRUCTIONS });

  const respond = (out: unknown): CallResult => {
    const ref = store.put(out);
    const view = buildView(store.get(ref), ref, budget);
    return result(isPlainObject(view) ? { [REF_KEY]: ref, ...view } : view);
  };

  for (const tool of TOOL_REGISTRY) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: describe(tool), inputSchema: transportSchema(tool) },
      // The transport boundary is untyped JSON-RPC; the core validates by use.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      guarded(async (raw: any) => {
        let args = resolveRefs(raw, store) as Record<string, unknown>;
        if (tool.fileInput) args = await withFileText(args, tool.fileInput, roots);
        if (tool.selectsFree) args = withFree(args);
        return respond(await tool.handler(args));
      }),
    );
  }

  server.registerTool(
    "read_ref",
    {
      title: "Read a stored value",
      description: "Show the value behind a ref from an earlier result, e.g. \"#4/result/diagnostics\" or \"#2/residual/d\". Bulky parts inside it come back as refs again. For a long array or string, pass start/end (end exclusive) to read a window.",
      inputSchema: {
        ref: z.string().describe("A ref such as \"#4\" or \"#4/result/esd\""),
        start: z.number().int().min(0).optional(),
        end: z.number().int().min(0).optional(),
      },
    },
    guarded(async ({ ref, start, end }: { ref: string; start?: number | undefined; end?: number | undefined }) => {
      const value = store.get(ref);
      if (typeof value === "string" || Array.isArray(value)) {
        const s = Math.min(start ?? 0, value.length);
        const e = Math.min(end ?? value.length, value.length);
        const window = value.slice(s, e);
        const shown = typeof window === "string" ? window : buildView(window, ref, budget, s);
        const chars = JSON.stringify(shown).length;
        if (chars > budget) {
          const fits = Math.max(1, Math.floor(((e - s) * budget) / chars));
          throw new Error(`${ref} holds ${value.length} ${typeof value === "string" ? "characters" : "items"}; ${s}–${e} is ${chars} characters. Read about ${fits} at a time with start/end.`);
        }
        return result({ ref, length: value.length, start: s, end: e, [typeof value === "string" ? "text" : "items"]: shown });
      }
      return result({ ref, value: buildView(value, ref, budget) });
    }),
  );

  return server;
}

interface CallResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function result(payload: unknown): CallResult {
  // `structuredContent` must be a JSON object; array results (suggest_next_steps)
  // travel as text only, which clients parse back.
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isPlainObject(payload) ? { structuredContent: payload } : {}),
  };
}

/** Turn a thrown error into an MCP tool error the model can read and act on. */
function guarded<A>(fn: (args: A) => Promise<CallResult>): (args: A) => Promise<CallResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function describe(tool: ToolDefinition): string {
  return tool.description
    + (tool.fileInput ? ` Pass \`path\` instead of \`${tool.fileInput.text}\` to read the file on the server.` : "")
    + (tool.selectsFree ? " `free` lists the parameter ids or globs to refine; every other parameter is held fixed." : "");
}

/** A ref object as an argument: `ref` plus whatever summary was copied along. */
const RefArg = z.looseObject({ [REF_KEY]: z.string().regex(/^#\d+/) });

/**
 * The registry schema as the transport accepts it: array/object fields also
 * take a ref (a loose record already does), the file-text field becomes
 * optional beside `path`, and refining tools gain `free`.
 */
export function transportSchema(tool: ToolDefinition): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, s] of Object.entries(tool.inputSchema)) shape[k] = acceptRef(s);
  if (tool.fileInput) {
    const text = tool.fileInput.text;
    shape[text] = shape[text]!.optional();
    shape.path = z.string().optional().describe("File to read instead of passing its text: relative to the server's data folder, or absolute inside it");
  }
  if (tool.selectsFree) {
    shape.free = z.array(z.string()).optional().describe("Parameter ids or globs (\"bkg*\") to refine; every other parameter is held fixed. Omit to use the parameters' own `fixed` flags.");
  }
  return shape;
}

function acceptRef(s: z.ZodType): z.ZodType {
  let inner: z.ZodType = s;
  let optional = false;
  let nullable = false;
  for (;;) {
    if (inner instanceof z.ZodOptional) { optional = true; inner = inner.unwrap() as z.ZodType; continue; }
    if (inner instanceof z.ZodNullable) { nullable = true; inner = inner.unwrap() as z.ZodType; continue; }
    break;
  }
  const looseRecord = inner instanceof z.ZodRecord && inner.valueType instanceof z.ZodAny;
  const structured = inner instanceof z.ZodArray || inner instanceof z.ZodObject || inner instanceof z.ZodRecord;
  if (looseRecord || !structured) return s;
  let out: z.ZodType = z.union([inner, RefArg]);
  if (nullable) out = out.nullable();
  if (optional) out = out.optional();
  return s.description ? out.describe(s.description) : out;
}

async function withFileText(
  args: Record<string, unknown>,
  spec: NonNullable<ToolDefinition["fileInput"]>,
  roots: readonly string[],
): Promise<Record<string, unknown>> {
  const { path, ...rest } = args;
  if (path === undefined) {
    if (rest[spec.text] === undefined) throw new Error(`pass \`${spec.text}\` (the file's text) or \`path\``);
    return rest;
  }
  if (rest[spec.text] !== undefined) throw new Error(`pass \`${spec.text}\` or \`path\`, not both`);
  const file = await allowedFile(String(path), roots);
  const text = await readFile(file, "utf8");
  return { ...rest, [spec.text]: text, ...(spec.name && rest[spec.name] === undefined ? { [spec.name]: basename(file) } : {}) };
}

/** Resolve `p` to a real file inside one of `roots` (symlinks followed first). */
async function allowedFile(p: string, roots: readonly string[]): Promise<string> {
  if (!roots.length) {
    throw new Error("reading files is off: the server has no data folder. Set MATERIA_ROOTS to a folder list, or start the server inside the project.");
  }
  const realRoots = (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter((r): r is string => r !== null);
  const candidates = isAbsolute(p) ? [p] : roots.map((r) => resolve(r, p));
  for (const candidate of candidates) {
    const real = await realpath(candidate).catch(() => null);
    if (!real) continue;
    if (!realRoots.some((r) => inside(r, real))) {
      throw new Error(`${p} is outside the server's data folders (${roots.join(", ")})`);
    }
    const info = await stat(real);
    if (!info.isFile()) throw new Error(`${p} is not a file`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${p} is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}`);
    return real;
  }
  throw new Error(`no such file: ${p} (data folders: ${roots.join(", ")})`);
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/** Apply `free`: matching parameters refine, all others are held fixed. */
function withFree(args: Record<string, unknown>): Record<string, unknown> {
  const { free, ...rest } = args;
  if (free === undefined) return rest;
  if (!Array.isArray(rest.parameters)) throw new Error("`free` needs `parameters`");
  const params = rest.parameters as { id: string }[];
  const patterns = (free as string[]).map((f) => ({ f, re: glob(f) }));
  const unmatched = patterns.filter(({ re }) => !params.some((p) => re.test(p.id))).map(({ f }) => `"${f}"`);
  if (unmatched.length) {
    throw new Error(`free: nothing matches ${unmatched.join(", ")}. Parameter ids: ${params.map((p) => p.id).join(", ")}`);
  }
  return { ...rest, parameters: params.map((p) => ({ ...p, fixed: !patterns.some(({ re }) => re.test(p.id)) })) };
}

function glob(pattern: string): RegExp {
  return new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}
