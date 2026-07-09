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
 *
 * Every mode is normalized to unit **Cartesian** length before parameters are
 * built, so one unit of amplitude is 1 µ_B along that mode whatever the cell
 * metric — a raw null-space vector like (−1, 1, 0) is √3 µ_B long in a
 * hexagonal cell, and seeding it with the same amplitude as a (1, 0, 0) mode
 * would silently make one sublattice's moment √3× the other's.
 *
 * `equalAmplitude` swaps the per-mode amplitudes for the usual equal-|m|
 * crystallographic constraint: ONE shared magnitude |M| per site (across all
 * of its split orbits and co-located ions) plus per-orbit direction angles
 * over a metric-orthonormal basis, so every moment has exactly the same size
 * by construction and only directions are refined per sublattice.
 */

import type { AtomSite, StructureModel, SymmetryOperation, UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { momentBindingKey, type MagneticModel, type MagneticMoment } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { applyOperation } from "@/core/crystal/symmetry";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";

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

/** Cartesian dot product of two crystal-axis moment vectors (µ_B). */
function cartDot(cell: UnitCell, a: Vec3, b: Vec3): number {
  const ca = crystalComponentsToCartesian(cell, a);
  const cb = crystalComponentsToCartesian(cell, b);
  return ca[0]! * cb[0]! + ca[1]! * cb[1]! + ca[2]! * cb[2]!;
}

/** Scale a mode to unit Cartesian (µ_B) length. */
function unitMode(cell: UnitCell, v: Vec3): Vec3 {
  const n = Math.sqrt(cartDot(cell, v, v));
  return n > 1e-12 ? [v[0]! / n, v[1]! / n, v[2]! / n] : v;
}

/**
 * Gram–Schmidt over the Cartesian metric: an orthonormal frame (unit µ_B,
 * mutually perpendicular in real space) spanning the same allowed subspace.
 * Needed by the shared-magnitude parametrization — with an orthonormal frame
 * the direction angles never change |m|.
 */
function orthonormalModes(cell: UnitCell, basis: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const v of basis) {
    const w: [number, number, number] = [v[0]!, v[1]!, v[2]!];
    for (const e of out) {
      const p = cartDot(cell, w, e);
      w[0] -= p * e[0]!;
      w[1] -= p * e[1]!;
      w[2] -= p * e[2]!;
    }
    const n = Math.sqrt(cartDot(cell, w, w));
    if (n > 1e-9) out.push([w[0] / n, w[1] / n, w[2] / n]);
  }
  return out;
}

function wrap01(v: number): number {
  return ((v % 1) + 1) % 1;
}

function samePosition(a: Vec3, b: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(a[i]! - b[i]!);
    d = Math.min(d, 1 - d);
    if (d > 1e-3) return false;
  }
  return true;
}

/**
 * Representative positions of the orbits into which the magnetic subgroup
 * splits a site's crystallographic orbit. The nuclear group G generates the
 * full orbit of `position`; the (possibly smaller) magnetic group G_M — for
 * k ≠ 0 the little group — partitions it into G_M-orbits. Each is an
 * independent magnetic sublattice: its moment is NOT related by any magnetic
 * operation to the others', so it needs its own allowed-moment basis and
 * amplitudes. (Without the split, split-orbit atoms would silently carry no
 * moment at all — zero magnetic intensity and no arrow in the viewer.)
 *
 * The first representative is the site position itself, so single-orbit cases
 * reduce to the pre-existing behaviour and parameter naming.
 */
function magneticOrbitRepresentatives(
  nuclearOps: readonly SymmetryOperation[],
  magneticOps: readonly SymmetryOperation[],
  position: Vec3,
): Vec3[] {
  const orbit: Vec3[] = [];
  for (const op of nuclearOps) {
    const raw = applyOperation(op, position);
    const p: Vec3 = [wrap01(raw[0]), wrap01(raw[1]), wrap01(raw[2])];
    if (!orbit.some((q) => samePosition(q, p))) orbit.push(p);
  }
  const site: Vec3 = [wrap01(position[0]!), wrap01(position[1]!), wrap01(position[2]!)];
  const assigned = orbit.map(() => false);
  const reps: Vec3[] = [];
  const claim = (rep: Vec3): void => {
    reps.push(rep);
    for (const op of magneticOps) {
      const raw = applyOperation(op, rep);
      const p: Vec3 = [wrap01(raw[0]), wrap01(raw[1]), wrap01(raw[2])];
      const idx = orbit.findIndex((q) => samePosition(q, p));
      if (idx >= 0) assigned[idx] = true;
    }
  };
  claim(site);
  for (let i = 0; i < orbit.length; i++) {
    if (!assigned[i]) claim(orbit[i]!);
  }
  return reps;
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
 *
 * When `equalAmplitude` is true, the refinable quantities become ONE shared
 * moment magnitude |M| per site plus per-orbit direction angles (degrees) over
 * a metric-orthonormal frame — every sublattice's |m| is identical by
 * construction (the "all moments the same size" constraint). A relative sign
 * flip of a 1-D orbit is not an independent degree of freedom here: for a
 * single 1-D orbit it is absorbed by global time reversal plus the other
 * orbits' angles (diffraction-equivalent), which covers the common cases.
 */
export function buildMagneticModel(
  structure: StructureModel,
  k: Vec3,
  ionLabels: readonly string[],
  subgroupOps: readonly SymmetryOperation[],
  options: {
    readonly moment?: number;
    readonly tieSameSite?: boolean;
    readonly equalAmplitude?: boolean;
  } = {},
): MagneticModelBuild {
  const moment0 = options.moment ?? 1.0;
  const tieSameSite = options.tieSameSite ?? true;
  const equalAmplitude = options.equalAmplitude ?? false;
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
    // The magnetic subgroup may split the site's crystallographic orbit
    // (G_M ⊂ G for a k ≠ 0 little group). Every split orbit is an independent
    // magnetic sublattice: it gets its own allowed-moment basis, parameters,
    // and moment entry (anchored at the orbit's representative position).
    const orbitReps = magneticOrbitRepresentatives(structure.spaceGroup.operations, subgroupOps, rep.position);

    const groupLabel = group.length > 1 ? `${rep.label}+${group.length - 1}` : rep.label;

    // Shared-magnitude parametrization: one |M| parameter for the whole site
    // (every split orbit, every co-located ion), created lazily so a site whose
    // moment is forbidden on all orbits emits nothing.
    const magnitudeId = `mom_${rep.label}_M`;
    let magnitudeEmitted = false;
    const emitMagnitudeParam = (): void => {
      if (magnitudeEmitted) return;
      magnitudeEmitted = true;
      params.push({
        id: magnitudeId,
        label: `${groupLabel} |M|`,
        kind: "momentMagnitude",
        value: moment0,
        initialValue: moment0,
        min: 0,
        max: 12,
        fixed: true, // shown but fixed on build; freed by the user like atomic rows
      });
    };

    orbitReps.forEach((orbitPos, oi) => {
      const orbitIndex = oi + 1;
      const allowed = allowedMomentDirections(subgroupOps, orbitPos, k);
      if (allowed.dimension === 0) return; // moment forbidden by symmetry here

      // Unit-µ_B modes: 1 unit of amplitude = 1 µ_B along the mode, so seeds
      // and refined amplitudes compare honestly across orbits and cells.
      const basis = allowed.basis.map((b) => unitMode(structure.cell, b));

      // Split orbits (≥ 2) carry the orbit index in the id/label and binding key.
      const orbitId = orbitIndex > 1 ? `o${orbitIndex}_` : "";
      const orbitTag = orbitIndex > 1 ? ` orbit ${orbitIndex}` : "";

      let seed: [number, number, number];
      if (equalAmplitude) {
        // Shared |M| + per-orbit direction angles over an orthonormal frame:
        // m = |M|·(cos θ·(cos φ·ê₁ + sin φ·ê₂) + sin θ·ê₃), angles in degrees,
        // seeded at 0 so the starting moment is |M|·ê₁ — the same magnitude on
        // every sublattice.
        const frame = orthonormalModes(structure.cell, basis);
        const e1 = frame[0]!;
        seed = [moment0 * e1[0]!, moment0 * e1[1]!, moment0 * e1[2]!];
        emitMagnitudeParam();
        for (const m of group) {
          bindings.push({
            parameterId: magnitudeId,
            kind: "momentMagnitude",
            targetId: magId,
            targetKey: momentBindingKey({ siteLabel: m.label, orbitIndex }),
            momentBasis: e1,
          });
        }
        frame.slice(1).forEach((axis, ai) => {
          const id = `mom_${rep.label}_${orbitId}ang${ai}`;
          const angleName = ai === 0 ? "∠" : "∠₂";
          params.push({
            id,
            label: `${groupLabel}${orbitTag} M${angleName} (${ai === 0 ? `${describeMomentMode(e1)}→` : "→"}${describeMomentMode(axis)})`,
            kind: "momentAngle",
            value: 0,
            initialValue: 0,
            fixed: true,
          });
          for (const m of group) {
            bindings.push({
              parameterId: id,
              kind: "momentAngle",
              targetId: magId,
              targetKey: momentBindingKey({ siteLabel: m.label, orbitIndex }),
              momentBasis: axis,
              angleIndex: ai as 0 | 1,
            });
          }
        });
      } else {
        // Per-mode amplitudes: the first allowed mode at moment0, the rest at 0.
        const amps = basis.map((_, i) => (i === 0 ? moment0 : 0));
        seed = [0, 0, 0];
        basis.forEach((b, i) => {
          const a = amps[i]!;
          seed[0] += a * b[0]!;
          seed[1] += a * b[1]!;
          seed[2] += a * b[2]!;
        });

        // One shared set of moment-mode params (keyed by the group
        // representative), bound to every member so their moments stay equal.
        basis.forEach((b, i) => {
          const id = `mom_${rep.label}_${orbitId}${i}`;
          const modeName = describeMomentMode(b);
          const suffix = basis.length > 1 ? ` ${i + 1}` : "";
          params.push({
            id,
            label: `${groupLabel}${orbitTag} M${suffix} (${modeName})`,
            kind: "momentMode",
            value: amps[i]!,
            initialValue: amps[i]!,
            min: -12,
            max: 12,
            fixed: true, // shown but fixed on build; freed by the user like atomic rows
          });
          for (const m of group) {
            bindings.push({
              parameterId: id,
              kind: "momentMode",
              targetId: magId,
              targetKey: momentBindingKey({ siteLabel: m.label, orbitIndex }),
              momentBasis: b,
            });
          }
        });
      }

      for (const m of group) {
        moments.push({
          siteLabel: m.label,
          frame: "crystallographic",
          components: [...seed] as Vec3,
          formFactorId: `${m.element}${m.oxidationState ?? 2}`,
          ...(orbitIndex > 1 ? { position: orbitPos, orbitIndex } : {}),
        });
        if (!activeSites.includes(m.label)) activeSites.push(m.label);
      }
    });
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
