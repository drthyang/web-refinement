/**
 * Canonicalization of magnetically-equivalent moment solutions, and detection of
 * the data-limited "flat directions" that make a powder magnetic refinement
 * look unstable.
 *
 * WHY (Phase 1a diagnosis, docs/REFINEMENT_NOTES.md): a powder magnetic
 * refinement of Mn₃Ga does not fall into distinct deep minima — from 24 random
 * moment starts, 23/24 land within <1% of the same χ². What varies is (1) the
 * GLOBAL SIGN of the whole moment set and (2) the PARTITION of moment between
 * sublattices along a near-null (soft) direction. Both are physics, not solver
 * failure:
 *
 *  - Global time reversal m → −m of every site is diffraction-equivalent for an
 *    unpolarized powder (|F_M(G±k)|² is even in the moments). So ±m twins are the
 *    SAME structure and must be mapped to one canonical representative before
 *    solutions are compared or clustered — otherwise a multi-start reports two
 *    "different" answers that are identical.
 *  - A soft partition direction (e.g. m(site A) ↔ m(site B) anticorrelated at
 *    constant χ²) is a genuine indeterminacy of the data, surfaced from the
 *    engine's existing SVD/correlation diagnostics rather than hidden.
 *
 * This module is pure core (no UI, no solver import): it decides a deterministic
 * global sign and reports degeneracies; the caller applies the sign to the
 * refined amplitudes and shows the report.
 */

import type { Vec3 } from "@/core/math/types";
import type { UnitCell } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { RefinementDiagnostics, RefinementParameter } from "@/core/refinement/types";
import { isMomentParameterKind } from "@/core/refinement/types";
import { momentBindingKey } from "@/core/magnetic/types";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";

/** Moment vectors below this Cartesian magnitude (µ_B) are treated as zero when
 *  choosing the canonical sign — a paramagnetic/undetermined site must not cast
 *  the deciding vote. */
const SIGN_EPS = 1e-6;

/**
 * The global time-reversal sign (+1 or −1) that puts a moment set in canonical
 * form. Deterministic and basis-independent: it looks at the actual moment
 * VECTORS (Cartesian, so the answer does not depend on the arbitrary sign of a
 * symmetry mode's basis vector), orders the moment entries by their binding key,
 * and picks the sign that makes the first significant Cartesian component
 * (x, then y, then z) of the first significant moment positive.
 *
 * Applying the returned sign to every moment (or, equivalently, to every
 * momentMode amplitude — moments are linear in the amplitudes) yields the
 * canonical representative of the ±m diffraction-equivalence class.
 */
export function globalMomentSign(magnetic: MagneticModel, cell: UnitCell): 1 | -1 {
  const ordered = [...magnetic.moments].sort((a, b) =>
    momentBindingKey(a).localeCompare(momentBindingKey(b)),
  );
  for (const m of ordered) {
    const cart = crystalComponentsToCartesian(cell, m.components as Vec3);
    for (let i = 0; i < 3; i++) {
      if (Math.abs(cart[i]!) > SIGN_EPS) return cart[i]! < 0 ? -1 : 1;
    }
  }
  return 1;
}

/**
 * Return a copy of `values` with every momentMode amplitude negated when the
 * model's canonical global sign is −1, leaving nuclear parameters untouched.
 * Use on a converged parameter set so that ±m twins produce identical reported
 * values (determinism) and cluster together.
 */
export function canonicalizeMomentValues(
  values: Readonly<Record<string, number>>,
  magnetic: MagneticModel,
  cell: UnitCell,
  parameters: readonly RefinementParameter[],
): Record<string, number> {
  const sign = globalMomentSign(magnetic, cell);
  const out: Record<string, number> = { ...values };
  if (sign === 1) return out;
  for (const p of parameters) {
    if (isMomentParameterKind(p.kind) && out[p.id] !== undefined) out[p.id] = -out[p.id]!;
  }
  return out;
}

/** One data-limited direction among the magnetic parameters. */
export interface MomentDegeneracy {
  /** "soft" = a near-null (poorly determined) singular direction; "correlated" =
   *  a strong pairwise correlation between two moment parameters. */
  readonly kind: "soft" | "correlated";
  /** Moment parameter ids participating in the degeneracy. */
  readonly parameterIds: readonly string[];
  /** Correlation coefficient for a "correlated" entry (absent for "soft"). */
  readonly coefficient?: number;
  /** Human-readable, using the parameter labels where available. */
  readonly message: string;
}

/**
 * Read the engine's SVD/correlation diagnostics and report the degeneracies that
 * involve MAGNETIC parameters — the honest deliverable for the ill-conditioned
 * "flat" directions found in Phase 1a. Two sources:
 *
 *  - `singularParameterIds`: parameters dominating an SVD near-null direction
 *    the pseudo-inverse dropped → the moment component(s) the data cannot pin.
 *  - `highCorrelations`: |ρ| ≥ `corrThreshold` between two moment parameters →
 *    a soft partition (e.g. sublattice A ↔ B moment trade-off).
 *
 * Pure and side-effect free; returns [] when nothing magnetic is degenerate.
 */
export function momentDegeneracies(
  diagnostics: RefinementDiagnostics | undefined,
  parameters: readonly RefinementParameter[],
  corrThreshold = 0.9,
): MomentDegeneracy[] {
  if (!diagnostics) return [];
  const momentIds = new Set(parameters.filter((p) => isMomentParameterKind(p.kind)).map((p) => p.id));
  if (momentIds.size === 0) return [];
  const label = (id: string): string => parameters.find((p) => p.id === id)?.label ?? id;
  const out: MomentDegeneracy[] = [];

  const softMoment = diagnostics.singularParameterIds.filter((id) => momentIds.has(id));
  if (softMoment.length > 0) {
    out.push({
      kind: "soft",
      parameterIds: softMoment,
      message: `Data poorly determines ${softMoment.map(label).join(", ")} (near-null direction dropped by the pseudo-inverse); its e.s.d. is unreliable.`,
    });
  }

  for (const c of diagnostics.highCorrelations) {
    if (Math.abs(c.coefficient) < corrThreshold) continue;
    const a = momentIds.has(c.parameterIdA);
    const b = momentIds.has(c.parameterIdB);
    // Report a correlation only when at least one side is a moment parameter; a
    // moment↔moment pair is the sublattice-partition flat direction, a
    // moment↔nuclear pair (scale, ADP) is a physical coupling worth flagging too.
    if (!a && !b) continue;
    out.push({
      kind: "correlated",
      parameterIds: [c.parameterIdA, c.parameterIdB],
      coefficient: c.coefficient,
      message: `${label(c.parameterIdA)} and ${label(c.parameterIdB)} are ${Math.abs(c.coefficient) >= 0.98 ? "near-degenerate" : "strongly correlated"} (ρ = ${c.coefficient.toFixed(2)}); their partition is data-limited.`,
    });
  }
  return out;
}
