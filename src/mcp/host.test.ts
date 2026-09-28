import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_REGISTRY } from "@/mcp/registry";
import { createMateriaServer, defaultRoots } from "@/mcp/host";
import { RefStore, buildView, isRef, resolveRefs } from "@/mcp/refs";
import { build_refinement, parse_powder_data, parse_structure, refine_powder } from "@/mcp/tools";
import { MN3GA_CIF } from "@/examples/mn3ga";

/**
 * The transport a language model actually drives. The registry tests call the
 * handlers with JS objects, which hides the one thing that breaks an LLM: data
 * passed by value. A parsed pattern is ~200 k characters and every refine call
 * needs it back. These tests go through a real MCP client and pin that
 *
 *  - every request and response of a whole powder loop stays small (refs),
 *  - refs are transparent: the ref-driven fit equals the by-value one,
 *  - `path`, `free` and `read_ref` work and fail with actionable messages.
 */

/** Largest response a test accepts, in characters — well under the ~25 k-token caps of MCP clients. */
const RESPONSE_LIMIT = 12_000;
/** Largest request a model should have to write. */
const REQUEST_LIMIT = 2_000;

const DATASETS = resolve(__dirname, "../examples/datasets");
const MN3GA_DAT = "mn3ga_powgen_600k.dat";
const TOF = { kind: "tof", difC: 22585.8 };

describe("RefStore / resolveRefs / buildView", () => {
  it("resolves refs into a stored value, JSON-Pointer escaped", () => {
    const store = new RefStore();
    const ref = store.put({ a: { "x/y": [10, 20, 30] }, skip: undefined });
    expect(ref).toBe("#1");
    expect(store.get("#1/a/x~1y/2")).toBe(30);
    expect(store.get("#1")).toEqual({ a: { "x/y": [10, 20, 30] } }); // JSON-normalized
    expect(() => store.get("#1/a/nope")).toThrow(/nothing at "nope" under #1\/a \(it holds keys x\/y\)/);
    expect(() => store.get("#9")).toThrow(/not in the store/);
    expect(() => store.get("pattern:1")).toThrow(/not a ref/);
  });

  it("resolveRefs substitutes nested refs with private copies", () => {
    const store = new RefStore();
    store.put({ pattern: { points: [1, 2] } });
    const args = resolveRefs({ pattern: { ref: "#1/pattern", points: 2 }, list: [{ ref: "#1/pattern/points" }], n: 3 }, store) as {
      pattern: { points: number[] }; list: number[][]; n: number;
    };
    expect(args).toEqual({ pattern: { points: [1, 2] }, list: [[1, 2]], n: 3 });
    args.pattern.points.push(99);
    expect(store.get("#1/pattern/points")).toEqual([1, 2]); // handlers cannot mutate the store
    // A `ref` that is not a ref string is ordinary data.
    expect(resolveRefs({ ref: "hello" }, store)).toEqual({ ref: "hello" });
  });

  it("evicts the least recently used call, and reading refreshes it", () => {
    const store = new RefStore(2);
    store.put(1);
    store.put(2);
    store.get("#1"); // #1 is now the most recent
    store.put(3); // evicts #2
    expect(store.get("#1")).toBe(1);
    expect(() => store.get("#2")).toThrow(/evicted/);
  });

  it("views turn handle keys into refs and keep the rest inline", () => {
    const out = {
      result: { status: "converged", agreement: { rWeighted: 0.123456789 }, parameters: { a: 1.5 }, esd: { a: 0.01 }, history: [{}, {}] },
      parameters: [{ id: "a", value: 1.5, fixed: false }, { id: "b", value: 2, fixed: true }],
      observationCount: 42,
      magnetic: null,
    };
    const view = buildView(out, "#7", 8000) as Record<string, Record<string, unknown>>;
    expect(view.result).toEqual({
      ref: "#7/result", status: "converged", iterations: 2, agreement: { rWeighted: 0.123457 }, refined: { a: "1.5 ± 0.01" },
    });
    expect(view.parameters).toEqual({ ref: "#7/parameters", count: 2, free: ["a"], values: { a: 1.5, b: 2 } });
    expect(view.observationCount).toBe(42);
    expect(view.magnetic).toBeNull();
  });

  it("views stay under budget by replacing the largest subtree, never the root", () => {
    const out = { summary: "small", diagnostics: { note: "x", correlation: Array.from({ length: 2000 }, (_, i) => i / 7) } };
    const view = buildView(out, "#3", 500) as { summary: string; diagnostics: { note: string; correlation: Record<string, unknown> } };
    expect(view.summary).toBe("small");
    expect(view.diagnostics.note).toBe("x"); // the dominant child went, not its parent
    expect(view.diagnostics.correlation).toMatchObject({ ref: "#3/diagnostics/correlation", length: 2000, min: 0 });
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(500);
    // A slice keeps the stored indices in its refs.
    const slice = buildView([{ structure: { name: "s", cell: {}, sites: [] } }], "#3/phases", 8000, 5) as { structure: { ref: string } }[];
    expect(slice[0]!.structure.ref).toBe("#3/phases/5/structure");
    expect(isRef(slice[0]!.structure)).toBe(true);
  });
});

describe("defaultRoots", () => {
  afterAll(() => vi.restoreAllMocks());

  it("reads MATERIA_ROOTS, else the working directory — never / or the home folder", () => {
    vi.stubEnv("MATERIA_ROOTS", ["/a", "/b"].join(process.platform === "win32" ? ";" : ":"));
    expect(defaultRoots()).toEqual([resolve("/a"), resolve("/b")]);
    vi.unstubAllEnvs();
    vi.stubEnv("MATERIA_ROOTS", "");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/");
    expect(defaultRoots()).toEqual([]);
    cwd.mockReturnValue(resolve(__dirname));
    expect(defaultRoots()).toEqual([resolve(__dirname)]);
    vi.unstubAllEnvs();
  });
});

describe("MCP host — an LLM-sized powder loop over a real client", () => {
  let client: Client;
  let dir: string;
  const log: { name: string; request: number; response: number }[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    log.push({ name, request: JSON.stringify(args).length, response: text.length });
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "materia-host-"));
    writeFileSync(join(dir, "mn3ga.cif"), MN3GA_CIF);
    const server = createMateriaServer({ roots: [dir, DATASETS] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "host-test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves every registry tool plus read_ref, with path/free where declared and no $ref keyword", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_REGISTRY.map((t) => t.name), "read_ref"].sort());
    for (const def of TOOL_REGISTRY) {
      const schema = tools.find((t) => t.name === def.name)!.inputSchema;
      expect("path" in (schema.properties ?? {}), def.name).toBe(Boolean(def.fileInput));
      expect("free" in (schema.properties ?? {}), def.name).toBe(Boolean(def.selectsFree));
      if (def.fileInput) expect(schema.required ?? [], def.name).not.toContain(def.fileInput.text);
    }
    // `$ref` is a JSON Schema keyword; a property by that name confuses naive resolvers.
    expect(JSON.stringify(tools)).not.toContain("\"$ref\"");
    expect(client.getInstructions()).toMatch(/Never retype data you received as a ref/);
  });

  it("runs parse → build → refine → assess → suggest → read_ref with small messages, matching the by-value fit", async () => {
    const s = await call("parse_structure", { path: join(dir, "mn3ga.cif") });
    const p = await call("parse_powder_data", { path: MN3GA_DAT }); // relative to a data folder
    expect(p.pattern).toMatchObject({ ref: `${p.ref}/pattern`, points: 4613, xUnit: "tof" });
    expect(p.summary.xUnit).toBe("tof");

    const b = await call("build_refinement", { structure: { ref: s.structure.ref }, pattern: { ref: p.pattern.ref }, instrument: TOF });
    expect(b.parameters.count).toBeGreaterThan(5);
    const common = { structure: s.structure, pattern: p.pattern, instrument: TOF, bindings: b.bindings, profile: b.profile, maxIterations: 6 };
    const free = ["scale", "bkg*", "cell_*"];
    const r = await call("refine_powder", { ...common, parameters: b.parameters, free });
    expect(r.result.status).toMatch(/converged|maxIterations|stalled/);
    expect(Object.keys(r.result.refined).sort()).toEqual(r.parameters.free.slice().sort());
    expect(r.parameters.free).toContain("scale");

    // Refs are transparent: the same fit by value gives the same numbers.
    const byValue = await (async () => {
      const { structure } = parse_structure({ cif: MN3GA_CIF });
      const { pattern } = parse_powder_data({ text: readFileSync(join(DATASETS, MN3GA_DAT), "utf8"), filename: MN3GA_DAT });
      const built = build_refinement({ structure, pattern, instrument: TOF as never });
      const re = new RegExp(`^(${free.map((f) => f.replace(/\*/g, ".*")).join("|")})$`);
      const parameters = built.parameters.map((q) => ({ ...q, fixed: !re.test(q.id) }));
      return refine_powder({ structure, pattern, instrument: TOF as never, parameters, bindings: built.bindings, profile: built.profile, maxIterations: 6 });
    })();
    const agreement = await call("read_ref", { ref: `${r.result.ref}/agreement` });
    expect(agreement.value.rWeighted).toBeCloseTo(byValue.result.agreement.rWeighted!, 12);

    // The refined `parameters` chain straight into the next block and the judgment tools.
    const r2 = await call("refine_powder", { ...common, parameters: { ref: r.parameters.ref }, free: [...free, "tof_sig2"] });
    expect(r2.parameters.free).toContain("tof_sig2");
    const a = await call("assess_refinement", { result: r2.result, parameters: r2.parameters, observationCount: r2.observationCount, residual: r2.residual });
    expect(a.verdict).toBeDefined();
    const steps = await call("suggest_next_steps", { assessment: { ref: a.ref } });
    expect(Array.isArray(steps)).toBe(true);

    const window = await call("read_ref", { ref: `${r2.residual.ref}/d`, start: 10, end: 13 });
    expect(window).toMatchObject({ length: 4613, start: 10, end: 13 });
    expect(window.items).toHaveLength(3);

    for (const m of log) {
      expect(m.response, `${m.name} response`).toBeLessThanOrEqual(RESPONSE_LIMIT);
      expect(m.request, `${m.name} request`).toBeLessThanOrEqual(REQUEST_LIMIT);
    }
  });

  it("fails with messages a model can act on", async () => {
    const p = await call("parse_powder_data", { path: MN3GA_DAT });
    await expect(call("parse_powder_data", { path: "/etc/hosts" })).rejects.toThrow(/outside the server's data folders/);
    await expect(call("parse_powder_data", { path: "nope.dat" })).rejects.toThrow(/no such file/);
    await expect(call("parse_powder_data", { path: MN3GA_DAT, text: "1 2" })).rejects.toThrow(/not both/);
    await expect(call("parse_powder_data", {})).rejects.toThrow(/pass `text`/);
    await expect(call("simulate_pattern", { structure: { ref: "#999/structure" } })).rejects.toThrow(/not in the store/);
    await expect(call("read_ref", { ref: `${p.pattern.ref}/points` })).rejects.toThrow(/Read about \d+ at a time/);

    const s = await call("parse_structure", { path: join(dir, "mn3ga.cif") });
    const b = await call("build_refinement", { structure: s.structure, pattern: p.pattern, instrument: TOF });
    await expect(call("refine_powder", {
      structure: s.structure, pattern: p.pattern, instrument: TOF, parameters: b.parameters, bindings: b.bindings, profile: b.profile, free: ["scael"],
    })).rejects.toThrow(/free: nothing matches "scael"\. Parameter ids: scale/);
  });
});
