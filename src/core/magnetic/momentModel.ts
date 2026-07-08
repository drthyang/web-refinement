/**
 * Build a symmetry-allowed magnetic model + refinable moment parameters over a
 * (real, refined) nuclear structure, for a chosen commensurate propagation
 * vector k and magnetic subgroup.
 *
 * The refinable quantities are **moment-mode amplitudes**: each site's moment is
 * m = Σ aᵢ·basisᵢ over the basis of directions allowed by its magnetic
 * stabilizer (allowedMomentDirections). Symmetry-forbidden directions cannot be
 * refined — the search space is pre-pruned, exactly as for atomic positions.
 * Moments start **fixed** (the user frees them), mirroring the atomic-refinement
 * convention (see App / powderSpec: structural rows shown-but-fixed on load).
 *
 * Note (moment magnitude): components are in the crystal-axis convention (µ_B);
 * the absolute magnitude in the propagation-vector formalism carries a
 * convention-dependent factor that should be cross-checked against GSAS-II before
 * quoting a refined moment. Directions and relative sizes are well defined here.
 */

import type { AtomSite, StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { MagneticModel, MagneticMoment } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";

export interface MagneticModelBuild {
  readonly magnetic: MagneticModel;
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  /** Site labels that are magnetic under this group (dimension > 0). */
  readonly activeSites: string[];
}

/** Label a moment mode by the axes it drives, e.g. "Mx", "My+Mz". */
export function describeMomentMode(basis: Vec3): string {
  const names = ["Mx", "My", "Mz"];
  const nz = basis.map((c, i) => ({ c, i })).filter((o) => Math.abs(o.c) > 1e-6);
  if (nz.length === 0) return "·";
  const minAbs = Math.min(...nz.map((o) => Math.abs(o.c)));
  return nz
    .map(({ c, i }, idx) => {
      const k = Math.round((c / minAbs) * 100) / 100;
      const mag = Math.abs(k);
      const coeff = Math.abs(mag - 1) < 1e-6 ? "" : Number.isInteger(mag) ? String(mag) : mag.toFixed(2);
      const sign = k < 0 ? "−" : idx === 0 ? "" : "+";
      return `${sign}${coeff}${names[i]}`;
    })
    .join("");
}

/** Group sites that share a fractional position (periodic, per-component). */
function groupByPosition(sites: readonly AtomSite[], tie: boolean): AtomSite[][] {
  if (!tie) return sites.map((s) => [s]);
  const groups: AtomSite[][] = [];
  for (const s of sites) {
    const g = groups.find((grp) => {
      const p = grp[0]!.position;
      for (let i = 0; i < 3; i++) {
        let d = Math.abs(p[i]! - s.position[i]!);
        d = Math.min(d, 1 - d);
        if (d > 1e-3) return false;
      }
      return true;
    });
    if (g) g.push(s); else groups.push([s]);
  }
  return groups;
}

/**
 * Assemble the magnetic model + moment-mode parameters for the given magnetic
 * ion sites, propagation vector, and (little-group) magnetic subgroup operations.
 * Sites whose allowed-moment space is empty under the group are skipped.
 *
 * When `tieSameSite` is true (default), atoms that share one crystallographic
 * site (occupancy disorder) are constrained to the **same moment**: a single set
 * of moment-mode parameters drives all of them, so their moment vectors stay
 * identical (each still carries its own occupancy and form factor in |F_M|²).
 */
export function buildMagneticModel(
  structure: StructureModel,
  k: Vec3,
  ionLabels: readonly string[],
  subgroupOps: readonly SymmetryOperation[],
  options: { readonly moment?: number; readonly tieSameSite?: boolean } = {},
): MagneticModelBuild {
  const moment0 = options.moment ?? 1.0;
  const tieSameSite = options.tieSameSite ?? true;
  const magId = `${structure.id}-mag`;
  const moments: MagneticMoment[] = [];
  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const activeSites: string[] = [];

  const ionSites = ionLabels
    .map((l) => structure.sites.find((s) => s.label === l))
    .filter((s): s is AtomSite => s !== undefined);

  for (const group of groupByPosition(ionSites, tieSameSite)) {
    const rep = group[0]!;
    const allowed = allowedMomentDirections(subgroupOps, rep.position);
    if (allowed.dimension === 0) continue; // moment forbidden by symmetry here

    // Seed: the first allowed mode at moment0, the rest at 0.
    const amps = allowed.basis.map((_, i) => (i === 0 ? moment0 : 0));
    const seed: [number, number, number] = [0, 0, 0];
    allowed.basis.forEach((b, i) => {
      const a = amps[i]!;
      seed[0] += a * b[0]!;
      seed[1] += a * b[1]!;
      seed[2] += a * b[2]!;
    });

    // One shared set of moment-mode params (keyed by the group representative),
    // bound to every member so their moments stay equal.
    const groupLabel = group.length > 1 ? `${rep.label}+${group.length - 1}` : rep.label;
    allowed.basis.forEach((b, i) => {
      const id = `mom_${rep.label}_${i}`;
      const modeName = describeMomentMode(b);
      const suffix = allowed.basis.length > 1 ? ` ${i + 1}` : "";
      params.push({
        id,
        label: `${groupLabel} M${suffix} (${modeName})`,
        kind: "momentMode",
        value: amps[i]!,
        initialValue: amps[i]!,
        min: -12,
        max: 12,
        fixed: true, // shown but fixed on build; freed by the user like atomic rows
      });
      for (const m of group) {
        bindings.push({ parameterId: id, kind: "momentMode", targetId: magId, targetKey: m.label, momentBasis: b });
      }
    });

    for (const m of group) {
      moments.push({
        siteLabel: m.label,
        frame: "crystallographic",
        components: [...seed] as Vec3,
        formFactorId: `${m.element}${m.oxidationState ?? 2}`,
      });
      activeSites.push(m.label);
    }
  }

  return {
    // Carry the magnetic subgroup operations so the structure factor expands the
    // moments over the correct (θ-signed) symmetry — not the nuclear group.
    magnetic: { id: magId, structureId: structure.id, propagation: [k], moments, operations: subgroupOps },
    params,
    bindings,
    activeSites,
  };
}
