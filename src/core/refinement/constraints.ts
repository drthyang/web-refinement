/**
 * Minimal constraint system (Phase 8): fixed/free and bounds are handled by the
 * engine; this module adds direct parameter *tying* and *grouping*.
 *
 * Deliberately not a symbolic language. A tie expression is one of:
 *   "= id"                    → value equals parameter `id`
 *   "= factor*id"             → value equals factor × parameter `id`
 *   "= factor*id + c"         → value equals factor × parameter `id` plus constant c
 *   "= [±|factor*]hypot(a,b,…)" → value equals ±(factor ×) √(a² + b² + …) — the
 *                               magnitude tie: a moment amplitude equal to the
 *                               size of another sublattice's moment, whose
 *                               amplitudes a, b, … lie along orthonormal modes
 * Anything else throws, so silent misparses cannot happen.
 */

import type { RefinementParameter } from "@/core/refinement/types";

export type ParsedTie =
  | { readonly kind: "linear"; readonly factor: number; readonly refId: string; readonly constant: number }
  | { readonly kind: "norm"; readonly factor: number; readonly refIds: readonly string[] };

const ID = "[A-Za-z_][\\w:-]*";

export function parseTie(expression: string): ParsedTie {
  const s = expression.replace(/\s+/g, "");
  if (!s.startsWith("=")) {
    throw new Error(`Tie expression must start with "=": "${expression}"`);
  }
  const body = s.slice(1);
  // Magnitude tie: [±|factor*]hypot(id, id, …)
  const h = body.match(new RegExp(`^(?:([+-]?\\d*\\.?\\d+)\\*|([+-]))?hypot\\((${ID}(?:,${ID})*)\\)$`));
  if (h) {
    const factor = h[1] !== undefined ? parseFloat(h[1]) : h[2] === "-" ? -1 : 1;
    return { kind: "norm", factor, refIds: h[3]!.split(",") };
  }
  // Linear tie: [factor*]id[+const] or [factor*]id[-const]
  const m = body.match(/^(?:([+-]?\d*\.?\d+)\*)?([A-Za-z_][\w:-]*)(?:([+-]\d*\.?\d+))?$/);
  if (!m) {
    throw new Error(`Unsupported tie expression: "${expression}"`);
  }
  const factor = m[1] !== undefined ? parseFloat(m[1]) : 1;
  const refId = m[2]!;
  const constant = m[3] !== undefined ? parseFloat(m[3]) : 0;
  return { kind: "linear", factor, refId, constant };
}

/** The parameter ids a tie expression reads. */
export function tieReferences(expression: string): string[] {
  const tie = parseTie(expression);
  return tie.kind === "linear" ? [tie.refId] : [...tie.refIds];
}

/**
 * Resolve tie expressions: return an id→value record where every tied parameter
 * takes its computed value. Ties may reference other (untied) parameters; a
 * single resolution pass is applied (chained ties are not followed).
 */
export function resolveTies(
  params: readonly RefinementParameter[],
  values: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...values };
  for (const p of params) {
    if (!p.expression) continue;
    const tie = parseTie(p.expression);
    if (tie.kind === "norm") {
      let sum = 0;
      for (const id of tie.refIds) {
        const v = out[id];
        if (v === undefined) throw new Error(`Tie for "${p.id}" references unknown parameter "${id}"`);
        sum += v * v;
      }
      out[p.id] = tie.factor * Math.sqrt(sum);
      continue;
    }
    const ref = out[tie.refId];
    if (ref === undefined) {
      throw new Error(`Tie for "${p.id}" references unknown parameter "${tie.refId}"`);
    }
    out[p.id] = tie.factor * ref + tie.constant;
  }
  return out;
}


/**
 * Grouped (equal-value) refinement (Phase 8): within each named group the first
 * member is the free "leader" and the rest are tied equal to it. Returns a new
 * parameter list with tie expressions applied, so only one value per group is
 * refined (e.g. equal occupancies or equal displacement parameters).
 */
export function applyEqualValueGroups(
  params: readonly RefinementParameter[],
): RefinementParameter[] {
  const leaders = new Map<string, string>();
  for (const p of params) {
    if (p.group && !leaders.has(p.group)) leaders.set(p.group, p.id);
  }
  return params.map((p) => {
    if (!p.group) return { ...p };
    const leader = leaders.get(p.group)!;
    if (p.id === leader) return { ...p };
    return { ...p, expression: `= ${leader}` };
  });
}
