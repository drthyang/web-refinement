/**
 * Server-side references: what lets a language model drive the tool surface.
 *
 * The tools pass whole domain objects by value. A parsed powder pattern is
 * ~200 k characters of JSON, a refinement residual about as much, and the next
 * call needs them back as arguments. A model cannot read that on every
 * response, nor write it out again on every request. So the MCP server keeps
 * each call's full output in a `RefStore` and returns a VIEW of it: bulky
 * subtrees become `{ "ref": "#3/pattern", …summary }`, and any argument may be
 * such a ref, resolved back to the stored value before the handler runs.
 * Handlers stay pure and never see a ref; replaying the resolved calls
 * reproduces the run.
 *
 * Ref grammar: `#<call>` followed by zero or more `/<segment>` — object keys or
 * array indices, escaped as in JSON Pointer (`~0` = `~`, `~1` = `/`). `#3` is the
 * whole output of call 3, `#3/residual/d` one array inside it.
 */

/**
 * The ref key. Deliberately not `$ref`: that is a JSON Schema keyword, and the
 * tool schemas must name this property without a naive schema resolver taking
 * it for one.
 */
export const REF_KEY = "ref";

/** An object whose `ref` is a ref string; any other keys (a summary) are ignored. */
export interface RefObject {
  readonly ref: string;
  readonly [summary: string]: unknown;
}

type Json = unknown;
type Segment = string | number;

const REF_PATTERN = /^#(\d+)((?:\/[^/]*)*)$/;

export function isRef(v: unknown): v is RefObject {
  return isPlainObject(v) && typeof v[REF_KEY] === "string" && REF_PATTERN.test(v[REF_KEY]);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The per-session store: one entry per tool call, holding that call's output
 * JSON-normalized (exactly what the by-value transport would have sent).
 * Least-recently-used entries are evicted past `capacity`; reading a ref
 * refreshes its call, so a pattern forwarded to every refinement never ages out.
 */
export class RefStore {
  private readonly entries = new Map<number, Json>();
  private next = 1;

  constructor(private readonly capacity = 256) {}

  /** Store a call's output and return its root ref (`#n`). */
  put(value: unknown): string {
    const n = this.next++;
    this.entries.set(n, value === undefined ? null : JSON.parse(JSON.stringify(value)));
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as number;
      this.entries.delete(oldest);
    }
    return `#${n}`;
  }

  /**
   * The stored value a ref points at (shared, not a copy — callers clone
   * before handing it to a handler). Throws a message a model can act on.
   */
  get(ref: string): Json {
    const m = REF_PATTERN.exec(ref);
    if (!m) throw new Error(`"${ref}" is not a ref — refs look like "#3" or "#3/pattern", copied from an earlier tool result`);
    const call = Number(m[1]);
    if (!this.entries.has(call)) {
      throw new Error(`ref ${ref}: call #${call} is not in the store (never made, or evicted as least recently used) — re-run the tool that produced it`);
    }
    const root = this.entries.get(call);
    this.entries.delete(call); // refresh LRU position
    this.entries.set(call, root);
    let cur: Json = root;
    let at = `#${call}`;
    for (const raw of m[2]!.split("/").slice(1)) {
      const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(cur) && /^\d+$/.test(seg) && Number(seg) < cur.length) {
        cur = cur[Number(seg)];
      } else if (isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) {
        cur = cur[seg];
      } else {
        const has = Array.isArray(cur) ? `an array of ${cur.length}` : isPlainObject(cur) ? `keys ${Object.keys(cur).join(", ")}` : `a ${typeof cur}`;
        throw new Error(`ref ${ref}: nothing at "${seg}" under ${at} (it holds ${has})`);
      }
      at += `/${raw}`;
    }
    return cur;
  }
}

/** Replace every ref inside `value` by a private copy of what it points at. */
export function resolveRefs(value: unknown, store: RefStore): unknown {
  if (isRef(value)) return structuredClone(store.get(value.ref));
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, store));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, store)]));
  }
  return value;
}

function refPath(base: string, path: readonly Segment[]): string {
  return base + path.map((s) => "/" + String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("");
}

const size = (v: unknown): number => JSON.stringify(v)?.length ?? 0;
const sig = (x: unknown): unknown => (typeof x === "number" && Number.isFinite(x) ? Number(x.toPrecision(6)) : x);
const roundAll = (o: unknown): unknown =>
  isPlainObject(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sig(v)])) : o;

function range(xs: readonly unknown[]): [unknown, unknown] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (typeof x !== "number") return undefined;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return xs.length ? [sig(lo), sig(hi)] : undefined;
}

/** Most parameters a summary lists with values; beyond it, only the free ones. */
const PARAMETER_VALUES_MAX = 150;

type Summarizer = (v: unknown) => Record<string, unknown> | null;

/**
 * Keys whose values are domain objects a model FORWARDS rather than reads. They
 * always travel as refs (when the value has the expected shape), with a short
 * summary of what a model needs to see; everything else stays inline unless
 * the response is over budget.
 */
const HANDLES: Record<string, Summarizer> = {
  structure: structureSummary,
  parent: structureSummary,
  child: structureSummary,
  extraPhases: (v) => (Array.isArray(v) ? { phases: v.map((s) => (isPlainObject(s) ? s.name : null)) } : null),
  pattern: patternSummary,
  dataset: datasetSummary,
  nuclearDataset: datasetSummary,
  magneticDataset: datasetSummary,
  parameters: parametersSummary,
  bindings: (v) => (Array.isArray(v) ? { count: v.length } : null),
  restraints: (v) => (Array.isArray(v) ? { count: v.length } : null),
  operations: (v) => (Array.isArray(v) ? { count: v.length } : null),
  residual: seriesSummary,
  curves: seriesSummary,
  components: seriesSummary,
  partials: (v) => (Array.isArray(v) ? { count: v.length } : null),
  magnetic: magneticSummary,
  result: resultSummary,
  resume: (v) => (v === null || v === undefined ? null : { note: "opaque sampler state — pass this ref back as `resume` to continue the chain" }),
};

function structureSummary(v: unknown): Record<string, unknown> | null {
  if (!isPlainObject(v) || !Array.isArray(v.sites) || !isPlainObject(v.cell)) return null;
  const sg = isPlainObject(v.spaceGroup) ? v.spaceGroup : {};
  const ops = Array.isArray(sg.operations) ? sg.operations.length : 0;
  return {
    name: v.name,
    spaceGroup: sg.hermannMauguin ?? (sg.number !== undefined ? `No. ${String(sg.number)}` : `${ops} operations`),
    cell: roundAll(v.cell),
    sites: v.sites.map((s) => (isPlainObject(s) ? `${String(s.label)} ${String(s.element)}` : null)),
  };
}

function patternSummary(v: unknown): Record<string, unknown> | null {
  if (!isPlainObject(v) || !Array.isArray(v.points)) return null;
  const first = v.points[0];
  if (isPlainObject(first) && "r" in first) {
    return {
      name: v.name, points: v.points.length, scatteringType: v.scatteringType,
      rRange: range(v.points.map((p) => (isPlainObject(p) ? p.r : null))),
      ...(v.qmax !== undefined ? { qmax: v.qmax } : {}),
    };
  }
  return {
    name: v.name, points: v.points.length, xUnit: v.xUnit,
    xRange: range(v.points.map((p) => (isPlainObject(p) ? p.x : null))),
    radiation: v.radiation,
  };
}

function datasetSummary(v: unknown): Record<string, unknown> | null {
  if (!isPlainObject(v) || !Array.isArray(v.reflections)) return null;
  return { name: v.name, reflections: v.reflections.length, radiation: v.radiation };
}

function parametersSummary(v: unknown): Record<string, unknown> | null {
  if (!Array.isArray(v) || !v.every((p) => isPlainObject(p) && typeof p.id === "string")) return null;
  const ps = v as { id: string; value?: unknown; fixed?: boolean; expression?: unknown }[];
  const free = ps.filter((p) => !p.fixed && !p.expression);
  const listed = ps.length <= PARAMETER_VALUES_MAX ? ps : free;
  return {
    count: ps.length,
    free: free.map((p) => p.id),
    values: Object.fromEntries(listed.map((p) => [p.id, sig(p.value)])),
    ...(listed === ps ? {} : { note: `values of the ${free.length} free parameters only — read_ref for the rest` }),
  };
}

function seriesSummary(v: unknown): Record<string, unknown> | null {
  if (!isPlainObject(v)) return null;
  const series = Object.entries(v).filter(([, a]) => Array.isArray(a));
  if (!series.length) return null;
  return { points: (series[0]![1] as unknown[]).length, series: series.map(([k]) => k) };
}

function magneticSummary(v: unknown): Record<string, unknown> | null {
  if (!isPlainObject(v) || !Array.isArray(v.moments)) return null;
  return {
    propagation: v.propagation,
    moments: v.moments.map((m) =>
      isPlainObject(m) && Array.isArray(m.components) ? `${String(m.siteLabel)}: [${m.components.map((c) => sig(c)).join(", ")}]` : null,
    ),
    ...(Array.isArray(v.operations) ? { operations: v.operations.length } : {}),
  };
}

function resultSummary(v: unknown): Record<string, unknown> | null {
  if (!isPlainObject(v) || typeof v.status !== "string" || !isPlainObject(v.agreement)) return null;
  const values = isPlainObject(v.parameters) ? v.parameters : {};
  const esd = isPlainObject(v.esd) ? v.esd : {};
  return {
    status: v.status,
    iterations: Array.isArray(v.history) ? v.history.length : undefined,
    agreement: roundAll(v.agreement),
    refined: Object.fromEntries(Object.keys(esd).map((id) => [id, `${String(sig(values[id]))} ± ${String(sig(esd[id]))}`])),
    ...(v.message ? { message: v.message } : {}),
  };
}

function genericSummary(v: unknown): Record<string, unknown> {
  if (typeof v === "string") return { chars: v.length, head: v.slice(0, 160) };
  if (Array.isArray(v)) {
    const r = range(v);
    const first = v[0];
    return {
      length: v.length,
      ...(r ? { min: r[0], max: r[1] } : {}),
      ...(isPlainObject(first) ? { itemKeys: Object.keys(first) } : {}),
    };
  }
  return { keys: isPlainObject(v) ? Object.keys(v) : [] };
}

/**
 * The response a model sees for a stored value: handle keys become refs, then,
 * while the view is over `budget` characters (compact JSON), the largest
 * remaining subtree becomes a ref too. `base` is the stored value's own ref;
 * `offset` shifts the indices of a root array that is a slice of it. The root
 * itself is never replaced.
 */
export function buildView(value: unknown, base: string, budget: number, offset = 0): unknown {
  const view = handleView(value, [], base, offset);
  for (let guard = 0; guard < 128 && size(view) > budget; guard++) {
    const target = largestSubtree(view);
    if (!target) break;
    const { parent, key, path } = target;
    if (Array.isArray(view) && typeof path[0] === "number") path[0] += offset;
    const node = (parent as Record<Segment, unknown>)[key];
    (parent as Record<Segment, unknown>)[key] = { [REF_KEY]: refPath(base, path), ...genericSummary(node) };
  }
  return view;
}

/** Copy `node`, turning handle-keyed values into refs. `path` is relative to the stored value. */
function handleView(node: unknown, path: Segment[], base: string, offset: number): unknown {
  if (Array.isArray(node)) {
    return node.map((v, i) => handleView(v, [...path, path.length === 0 ? i + offset : i], base, offset));
  }
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    const summary = HANDLES[k]?.(v) ?? null;
    out[k] = summary ? { [REF_KEY]: refPath(base, [...path, k]), ...summary } : handleView(v, [...path, k], base, offset);
  }
  return out;
}

interface Subtree {
  readonly parent: object;
  readonly key: Segment;
  readonly path: Segment[];
}

/**
 * The subtree to replace next: the largest child of the root, followed down
 * while one child holds most of an object — so a big correlation matrix inside
 * `diagnostics` goes, not the whole small-but-for-it parent. Refs, numbers and
 * short strings are never candidates.
 */
function largestSubtree(root: unknown): Subtree | null {
  let best = largestChild(root);
  if (!best) return null;
  let parent = root as object;
  const path: Segment[] = [best.key];
  let node = (parent as Record<Segment, unknown>)[best.key];
  for (;;) {
    if (!isPlainObject(node)) break;
    const next = largestChild(node);
    if (!next || next.size < 0.5 * size(node)) break;
    parent = node;
    best = next;
    path.push(next.key);
    node = node[next.key];
  }
  return { parent, key: best.key, path };
}

function largestChild(node: unknown): { key: Segment; size: number } | null {
  const entries: [Segment, unknown][] = Array.isArray(node)
    ? node.map((v, i) => [i, v] as [Segment, unknown])
    : isPlainObject(node) ? Object.entries(node) : [];
  let best: { key: Segment; size: number } | null = null;
  for (const [k, v] of entries) {
    const candidate = (typeof v === "string" && v.length > 200) || Array.isArray(v) || (isPlainObject(v) && !isRef(v));
    if (!candidate) continue;
    const s = size(v);
    if (!best || s > best.size) best = { key: k, size: s };
  }
  return best;
}
