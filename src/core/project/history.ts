/**
 * Step history — a tree of checkpoints of one session.
 *
 * A step is a snapshot of what Save writes (the phases + the technique
 * workspace), taken at a committed action: a refinement, a settings change, a
 * load. Going back to a step restores it exactly as opening a project would, so
 * the history needs no restore code of its own.
 *
 * It is a TREE, not a list: going back and then acting starts a branch, and
 * nothing is ever discarded. An abandoned branch stays readable — a dead end is
 * information too, for the user and as a record of which refinement decisions
 * did not pay off. Each parent → child edge is a (state, action, outcome)
 * triple: the action is what differs between the two snapshots.
 *
 * Storage: the data-sized parts of a snapshot (the observed pattern or
 * reflections, the verbatim original files, the phases, the bindings, …) are
 * stored ONCE in `blobs`, keyed by a hash of their content; steps point at them.
 * A step itself holds the parameter rows, the settings and the last result — a
 * few kB. In a file, a blob identical to the file's own workspace is written as
 * a pointer to it (`packHistory`), so the history never duplicates the data.
 *
 * Pure functions over plain JSON; the app records steps and moves `current`.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { Workspace } from "@/core/project/types";

export type StepKind = "load" | "open" | "edit" | "settings" | "refine" | "magnetic";
export const STEP_KINDS: readonly StepKind[] = ["load", "open", "edit", "settings", "refine", "magnetic"];

/** Who made a step. Absent means the user; "agent" marks an agent-driven step. */
export type StepActor = "agent";
export const STEP_ACTORS: readonly StepActor[] = ["agent"];

/** What a step list shows without opening the snapshot. */
export interface StepSummary {
  /** Weighted R of the snapshot's last result (fraction), when it has one. */
  readonly wR?: number;
  readonly gof?: number;
  readonly status?: string;
  /** Parameters that were free (not fixed, not constrained) in the snapshot. */
  readonly nFree: number;
}

/** A pointer to a shared blob. */
export interface BlobRef {
  readonly blob: string;
}

export interface HistoryStep {
  /** "s1", "s2", … in creation order. */
  readonly id: string;
  /** The step this one was taken from. Absent for the root. */
  readonly parent?: string;
  /** ISO-8601. */
  readonly at: string;
  readonly kind: StepKind;
  readonly label: string;
  readonly summary: StepSummary;
  readonly actor?: StepActor;
  /** A name the user gave the step ("before ADPs"). */
  readonly name?: string;
  readonly structures: BlobRef;
  /** The technique workspace with its data-sized fields replaced by `BlobRef`s. */
  readonly workspace: Readonly<Record<string, unknown>>;
}

export interface ProjectHistory {
  /** The step the live session was last restored from or recorded as. */
  readonly current: string;
  /** Every step, in creation order; a parent always precedes its children. */
  readonly steps: readonly HistoryStep[];
  readonly blobs: Readonly<Record<string, unknown>>;
}

/** What a step restores: the phases and the technique workspace. */
export interface Snapshot {
  readonly structures: readonly StructureModel[];
  readonly workspace: Workspace;
}

export interface StepInput extends Snapshot {
  readonly kind: StepKind;
  /** Generated from the change since the current step when absent. */
  readonly label?: string;
  readonly at?: string;
  readonly actor?: StepActor;
}

/**
 * Workspace fields stored as shared blobs: data-sized or rarely changing. The
 * parameter rows and the last result stay inline — they are what changes.
 */
const SHARED_FIELDS = [
  "pattern", "dataset", "magneticDataset", "rawData", "rawInstrument", "overlay",
  "magnetic", "distortionModes", "spinModel", "boxcar",
] as const;

/** Workspace fields that do not describe the model (left out of change detection). */
const DISPLAY_ONLY = new Set(["displayUnit"]);

/** Readable names for settings changes, keyed by workspace field. */
const FIELD_LABEL: Readonly<Record<string, string>> = {
  pattern: "data", dataset: "data", magneticDataset: "magnetic data", instrument: "instrument",
  instrumentLoaded: "instrument", profile: "profile", backgroundTerms: "background terms",
  siteTies: "site ties", anisotropicAdp: "ADP model", mustrain: "microstrain model",
  magnetic: "magnetic model", fitRange: "fit range", manualPeaks: "marked peaks",
  probe: "probe", outlierFilter: "outlier filter", modulated: "modulated model",
  positionMode: "position mode", distortionModes: "distortion modes", spinModel: "spin model",
  boxcar: "boxcar", overlay: "overlay", rawData: "data", rawInstrument: "instrument", source: "data",
};

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

/** cyrb53 — a fast 53-bit string hash (collisions are negligible at this scale). */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Content key per object, cached by identity: a session hands the same pattern
 * object to every snapshot, so it is serialized and hashed once.
 */
const KEYS = new WeakMap<object, { key: string; json: string }>();

function keyOf(value: unknown): { key: string; json: string } {
  const cached = typeof value === "object" && value !== null ? KEYS.get(value) : undefined;
  if (cached) return cached;
  const json = JSON.stringify(value) ?? "null";
  const entry = { key: `b${hash53(json)}`, json };
  if (typeof value === "object" && value !== null) KEYS.set(value, entry);
  return entry;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isBlobRef(v: unknown): v is BlobRef {
  return isRecord(v) && typeof v.blob === "string" && Object.keys(v).length === 1;
}

/** The snapshot as stored in a step: shared fields moved into `blobs` (mutated). */
function slim(snapshot: Snapshot, blobs: Record<string, unknown>): { structures: BlobRef; workspace: Record<string, unknown> } {
  const put = (v: unknown): BlobRef => {
    const { key, json } = keyOf(v);
    // A private, plain-JSON copy: the session's objects are never aliased.
    if (!(key in blobs)) blobs[key] = JSON.parse(json);
    return { blob: key };
  };
  const ws: Record<string, unknown> = { ...(snapshot.workspace as unknown as Record<string, unknown>) };
  for (const f of SHARED_FIELDS) if (ws[f] !== undefined) ws[f] = put(ws[f]);
  const refinement = ws.refinement as Record<string, unknown>;
  ws.refinement = { ...refinement, bindings: put(refinement.bindings) };
  return { structures: put(snapshot.structures), workspace: JSON.parse(JSON.stringify(ws)) as Record<string, unknown> };
}

/** Inverse of `slim`. Throws when a blob is missing (a damaged file). */
function rehydrate(step: HistoryStep, blobs: Readonly<Record<string, unknown>>): Snapshot {
  const get = (ref: unknown, what: string): unknown => {
    if (!isBlobRef(ref)) return ref;
    if (!(ref.blob in blobs)) throw new Error(`step ${step.id}: its ${what} (${ref.blob}) is missing from the history`);
    return structuredClone(blobs[ref.blob]);
  };
  const ws: Record<string, unknown> = structuredClone({ ...step.workspace });
  for (const f of SHARED_FIELDS) if (ws[f] !== undefined) ws[f] = get(ws[f], f);
  const refinement = ws.refinement as Record<string, unknown>;
  ws.refinement = { ...refinement, bindings: get(refinement.bindings, "bindings") };
  return { structures: get(step.structures, "phases") as StructureModel[], workspace: ws as unknown as Workspace };
}

/** The model state a step stands for, as a string — equal strings, same state. */
function stateKey(structures: BlobRef, workspace: Readonly<Record<string, unknown>>): string {
  const model = Object.fromEntries(Object.entries(workspace).filter(([k]) => !DISPLAY_ONLY.has(k)));
  return JSON.stringify([structures.blob, model]);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function freeCount(params: readonly RefinementParameter[]): number {
  return params.filter((p) => !p.fixed && !p.expression).length;
}

function summaryOf(workspace: Workspace): StepSummary {
  const r: RefinementResult | undefined = workspace.refinement.lastResult;
  return {
    ...(r?.agreement.rWeighted !== undefined ? { wR: r.agreement.rWeighted } : {}),
    ...(r?.agreement.goodnessOfFit !== undefined ? { gof: r.agreement.goodnessOfFit } : {}),
    ...(r ? { status: r.status } : {}),
    nFree: freeCount(workspace.refinement.parameters),
  };
}

/**
 * Append a step taken from the current one (or start a history). A snapshot
 * identical to the current step's model state is not recorded again — callers
 * can record defensively (before a refinement, before going back) and only a
 * real change becomes a step.
 */
export function recordStep(history: ProjectHistory | null, input: StepInput): ProjectHistory {
  const blobs: Record<string, unknown> = { ...(history?.blobs ?? {}) };
  const stored = slim(input, blobs);
  const current = history ? stepById(history, history.current) : undefined;
  if (history && current && stateKey(current.structures, current.workspace) === stateKey(stored.structures, stored.workspace)) {
    return history;
  }
  const step: HistoryStep = {
    id: `s${nextNumber(history)}`,
    ...(current ? { parent: current.id } : {}),
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    label: input.label ?? (current ? describeChange(current.workspace, stored.workspace) : "Start"),
    summary: summaryOf(input.workspace),
    ...(input.actor ? { actor: input.actor } : {}),
    structures: stored.structures,
    workspace: stored.workspace,
  };
  return { current: step.id, steps: [...(history?.steps ?? []), step], blobs };
}

function nextNumber(history: ProjectHistory | null): number {
  let max = 0;
  for (const s of history?.steps ?? []) {
    const n = Number(s.id.slice(1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * A short account of what changed between two stored workspaces: parameters
 * freed / fixed / set, rows added or removed, and the settings that moved.
 */
export function describeChange(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string {
  const rows = (ws: Readonly<Record<string, unknown>>): readonly RefinementParameter[] =>
    ((ws.refinement as { parameters?: RefinementParameter[] } | undefined)?.parameters) ?? [];
  const old = new Map(rows(before).map((p) => [p.id, p]));
  const now = rows(after);
  const freed: string[] = [];
  const fixed: string[] = [];
  const set: string[] = [];
  for (const p of now) {
    const q = old.get(p.id);
    if (!q) continue;
    if (q.fixed && !p.fixed) freed.push(p.id);
    if (!q.fixed && p.fixed) fixed.push(p.id);
    if (q.value !== p.value) set.push(p.id);
  }
  const added = now.filter((p) => !old.has(p.id)).length;
  const nowIds = new Set(now.map((p) => p.id));
  const removed = [...old.keys()].filter((id) => !nowIds.has(id)).length;

  const settings = new Set<string>();
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === "refinement" || k === "technique" || DISPLAY_ONLY.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) settings.add(FIELD_LABEL[k] ?? k);
  }

  const list = (verb: string, ids: readonly string[]): string =>
    ids.length <= 3 ? `${verb} ${ids.join(", ")}` : `${verb} ${ids.slice(0, 2).join(", ")} +${ids.length - 2}`;
  const parts = [
    ...(settings.size ? [[...settings].join(", ")] : []),
    ...(freed.length ? [list("freed", freed)] : []),
    ...(fixed.length ? [list("fixed", fixed)] : []),
    ...(set.length ? [list("set", set)] : []),
    ...(added ? [`+${added} parameters`] : []),
    ...(removed ? [`−${removed} parameters`] : []),
  ];
  if (!parts.length) return "No change";
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Moving around
// ---------------------------------------------------------------------------

export function stepById(history: ProjectHistory, id: string): HistoryStep | undefined {
  return history.steps.find((s) => s.id === id);
}

/** The snapshot a step restores (private copies). Throws for a damaged step. */
export function restoreStep(history: ProjectHistory, id: string): Snapshot {
  const step = stepById(history, id);
  if (!step) throw new Error(`no step ${id} in the history`);
  return rehydrate(step, history.blobs);
}

/** Make `id` the current step (after the session was restored from it). */
export function moveTo(history: ProjectHistory, id: string): ProjectHistory {
  if (!stepById(history, id)) throw new Error(`no step ${id} in the history`);
  return id === history.current ? history : { ...history, current: id };
}

/** The steps from the root down to `id` (default: the current step). */
export function lineage(history: ProjectHistory, id: string = history.current): HistoryStep[] {
  const byId = new Map(history.steps.map((s) => [s.id, s]));
  const path: HistoryStep[] = [];
  for (let s = byId.get(id); s; s = s.parent ? byId.get(s.parent) : undefined) path.push(s);
  return path.reverse();
}

export function childrenOf(history: ProjectHistory, id: string): HistoryStep[] {
  return history.steps.filter((s) => s.parent === id);
}

/** Where "back" goes: the current step's parent. */
export function undoTarget(history: ProjectHistory): string | undefined {
  return stepById(history, history.current)?.parent;
}

/** Where "forward" goes: the current step's newest child. */
export function redoTarget(history: ProjectHistory): string | undefined {
  const kids = childrenOf(history, history.current);
  return kids[kids.length - 1]?.id;
}

/** Name a step (an empty name removes it). */
export function renameStep(history: ProjectHistory, id: string, name: string): ProjectHistory {
  const trimmed = name.trim();
  return {
    ...history,
    steps: history.steps.map((s) => {
      if (s.id !== id) return s;
      const { name: _old, ...rest } = s;
      return trimmed ? { ...rest, name: trimmed } : rest;
    }),
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A blob written as a pointer to the file's own copy of the same value. */
interface SameAs {
  readonly sameAs: string;
}

/**
 * The history as written into a file whose phases and workspace are
 * `structures` / `workspace`: blobs identical to one of those are replaced by
 * `{ sameAs: "<field>" }`, so the current data is not stored twice.
 */
export function packHistory(history: ProjectHistory, structures: readonly StructureModel[], workspace: Workspace): ProjectHistory {
  const own = ownValues(structures, workspace);
  const blobs = Object.fromEntries(
    Object.entries(history.blobs).map(([key, value]) => {
      const field = own.get(key);
      return [key, field ? ({ sameAs: field } satisfies SameAs) : value];
    }),
  );
  return { ...history, blobs };
}

/** Inverse of `packHistory`: pointers resolved against the file's own values. */
export function unpackHistory(history: ProjectHistory, structures: readonly StructureModel[], workspace: Workspace): ProjectHistory {
  const byField = new Map([...ownValues(structures, workspace)].map(([key, field]) => [field, key]));
  const blobs = Object.fromEntries(
    Object.entries(history.blobs).map(([key, value]) => {
      if (!isRecord(value) || typeof value.sameAs !== "string" || Object.keys(value).length !== 1) return [key, value];
      const field = value.sameAs;
      if (byField.get(field) !== key) throw new Error(`history blob ${key} points at "${field}", which no longer matches it`);
      const source = field === "structures" ? structures : (workspace as unknown as Record<string, unknown>)[field];
      return [key, structuredClone(source)];
    }),
  );
  return { ...history, blobs };
}

/** Blob key → the file field holding the same value. */
function ownValues(structures: readonly StructureModel[], workspace: Workspace): Map<string, string> {
  const out = new Map<string, string>([[keyOf(structures).key, "structures"]]);
  const ws = workspace as unknown as Record<string, unknown>;
  for (const f of SHARED_FIELDS) if (ws[f] !== undefined) out.set(keyOf(ws[f]).key, f);
  return out;
}
