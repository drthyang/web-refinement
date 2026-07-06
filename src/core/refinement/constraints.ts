/**
 * Minimal constraint system (Phase 8): fixed/free and bounds are handled by the
 * engine; this module adds direct parameter *tying* and *grouping*.
 *
 * Deliberately not a symbolic language. A tie expression is one of:
 *   "= id"            → value equals parameter `id`
 *   "= factor*id"     → value equals factor × parameter `id`
 *   "= factor*id + c" → value equals factor × parameter `id` plus constant c
 * Anything else throws, so silent misparses cannot happen.
 */

import type { RefinementParameter } from "@/core/refinement/types";

interface ParsedTie {
  readonly factor: number;
  readonly refId: string;
  readonly constant: number;
}

export function parseTie(expression: string): ParsedTie {
  const s = expression.replace(/\s+/g, "");
  if (!s.startsWith("=")) {
    throw new Error(`Tie expression must start with "=": "${expression}"`);
  }
  const body = s.slice(1);
  // Match: [factor*]id[+const] or [factor*]id[-const]
  const m = body.match(/^(?:([+-]?\d*\.?\d+)\*)?([A-Za-z_][\w:-]*)(?:([+-]\d*\.?\d+))?$/);
  if (!m) {
    throw new Error(`Unsupported tie expression: "${expression}"`);
  }
  const factor = m[1] !== undefined ? parseFloat(m[1]) : 1;
  const refId = m[2]!;
  const constant = m[3] !== undefined ? parseFloat(m[3]) : 0;
  return { factor, refId, constant };
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
    const ref = out[tie.refId];
    if (ref === undefined) {
      throw new Error(`Tie for "${p.id}" references unknown parameter "${tie.refId}"`);
    }
    out[p.id] = tie.factor * ref + tie.constant;
  }
  return out;
}

/** Parameters that are tied should not be refined independently. */
export function freeParameterIds(params: readonly RefinementParameter[]): string[] {
  return params.filter((p) => !p.fixed && !p.expression).map((p) => p.id);
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
