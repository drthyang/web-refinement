/**
 * SARAh-style irrep **combinations** and the bridge from the representation
 * route back to a named magnetic space group: the **isotropy subgroup**.
 *
 * Theory. A magnetic structure built from basis vectors of one or several
 * irreps of G_k (amplitudes c: m(j) = Σ_ν Σ_λ c_{νλ}·ψ_{νλ}(j), Bertaut's
 * representation analysis) has, as its actual symmetry, the **stabilizer** of
 * that moment configuration in the grey group G_k·1' — the isotropy subgroup
 * of the order parameter. Refining a *single* irrep (the Landau prescription)
 * gives the kernel of its character; mixing irreps intersects the kernels;
 * either way the honest, assumption-free route to the group is to build the
 * explicit configuration with **generic amplitudes** and test every (g, θ)
 * directly. The resulting operation set is then identified against the
 * bundled standard table ({@link identifyMagneticGroup}) — an exact match or
 * nothing, never a guessed symbol.
 *
 * For the 1-D irreps of an abelian little co-group every operation acts on an
 * irrep's modes by the scalar χ(g), so the isotropy subgroup is independent of
 * the mode amplitudes (kernels only — epikernels need multidimensional order
 * parameters). The generic-amplitude stabilizer is computed anyway (two
 * independent draws, intersected): it stays correct unchanged when the
 * non-abelian / multidimensional irreps land, and it guards against
 * accidental invariances of any special amplitude choice.
 *
 * Scope: real 1-D irreps (χ = ±1 — every irrep of the exponent-2 co-groups:
 * triclinic, monoclinic, orthorhombic) and k with real phase factors
 * (e^{2πi k·L} = ±1, i.e. k = 0 or half-integer k on the relevant lattice
 * vectors). Complex conjugate-pair irreps and genuinely complex k-phases give
 * a null result with a reason — those configurations generally stabilize as
 * type-IV / anti-translation groups, which the bundled type-I/III table
 * cannot name yet (see docs/MAGNETIC_SYMMETRY.md).
 *
 * References:
 *  - E. F. Bertaut, Acta Cryst. A24 (1968) 217 — representation analysis of
 *    magnetic structures (basis vectors from projection operators).
 *  - A. S. Wills, Physica B 276–278 (2000) 680 — SARAh: refinement of the
 *    mixing amplitudes of basis vectors of one or several irreps.
 *  - Yu. A. Izyumov, V. E. Naish & R. P. Ozerov, *Neutron Diffraction of
 *    Magnetic Materials* (Consultants Bureau, 1991) — basis-vector transport
 *    over an orbit by coset representatives.
 *  - H. T. Stokes & D. M. Hatch, *Isotropy Subgroups of the 230
 *    Crystallographic Space Groups* (World Scientific, 1988) — order
 *    parameter → isotropy subgroup (kernels and epikernels).
 *  - B. J. Campbell, H. T. Stokes, D. E. Tanner & D. M. Hatch, J. Appl.
 *    Cryst. 39 (2006) 607 — ISODISPLACE/ISODISTORT: mode amplitudes ↔
 *    symmetry groups, the same correspondence automated here.
 */

import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { applyOperation } from "@/core/crystal/symmetry";
import { determinant } from "@/core/math/mat3";
import { rotationKey } from "./magneticGroups";
import { projectIrrepModes, type Irrep } from "./irreps";
import {
  identifyMagneticGroup,
  identifyMagneticGroupAnySetting,
  type MagneticGroupIdentity,
  type TransformedIdentification,
} from "./bnsOg";

const TOL = 1e-3;

/** One selected irrep with the reference-site modes the combination uses. */
export interface IrrepSelection {
  readonly irrep: Irrep;
  /** Indices into the irrep's reference-site modes; omit for all modes. */
  readonly modeIndices?: readonly number[];
}

export interface IsotropyResult {
  /** The stabilizer of the generic combination — a magnetic group (θ set). */
  readonly operations: readonly SymmetryOperation[];
  /** Standard BNS/OG identification, or null (non-standard setting). */
  readonly standard: MagneticGroupIdentity | null;
  /** Fallback identification through a setting transformation when the exact
   *  match failed; null when no reachable setting matches either. */
  readonly settingMatch: TransformedIdentification | null;
  /** Order of the spatial part (distinct rotation cosets kept). */
  readonly subgroupOrder: number;
}

export type IsotropyFailure =
  | "no-modes"          // selection carries no moment on the chosen sites
  | "complex-irrep"     // conjugate-pair irrep — real combination out of scope
  | "multidim-irrep"    // ≥2-dim irrep — order-parameter direction UI pending
  | "complex-phase"     // e^{2πik·L} not ±1 — type-IV territory
  | "primed-translation"; // stabilizer needs a primed pure translation (type IV)

/** A moment field: one (real) vector per orbit atom of the selected sites. */
interface FieldAtom {
  readonly pos: Vec3;
  readonly m: Vec3;
}

const mod1 = (x: number): number => ((x % 1) + 1) % 1;
const posKey = (p: Vec3): string =>
  p
    .map((x) => {
      let r = mod1(x);
      if (r > 1 - TOL) r = 0;
      return r.toFixed(3);
    })
    .join(",");

function samePos(a: Vec3, b: Vec3): boolean {
  return [0, 1, 2].every((i) => {
    const d = Math.abs(mod1(a[i]!) - mod1(b[i]!));
    return Math.min(d, 1 - d) < TOL;
  });
}

/** e^{2πi k·L} for integer L, required real: +1 / −1, or null when complex. */
function realPhase(k: Vec3, L: Vec3): 1 | -1 | null {
  const t = k[0]! * L[0]! + k[1]! * L[1]! + k[2]! * L[2]!;
  const half = Math.round(2 * t);
  if (Math.abs(2 * t - half) > 1e-6) return null;
  return half % 2 === 0 ? 1 : -1;
}

/** Apply the axial-vector action m ↦ s·θ·det(R)·R·m. */
function actOnMoment(op: SymmetryOperation, m: Vec3, sign: number): Vec3 {
  const R = op.rotation;
  const f = sign * determinant(R) * (op.timeReversal ?? 1);
  return [
    f * (R[0]![0]! * m[0]! + R[0]![1]! * m[1]! + R[0]![2]! * m[2]!),
    f * (R[1]![0]! * m[0]! + R[1]![1]! * m[1]! + R[1]![2]! * m[2]!),
    f * (R[2]![0]! * m[0]! + R[2]![1]! * m[1]! + R[2]![2]! * m[2]!),
  ];
}

/**
 * Build the real moment field of an irrep combination with the given
 * amplitudes: project the reference-site modes, then transport them over each
 * site's G_k-orbit by coset representatives, m(g·r₀) = χ(g)·e^{2πik·L}·
 * det(R_g)·R_g·m(r₀) (χ real ±1). Returns null with a failure reason when the
 * combination leaves the real-±1 scope.
 */
function buildMomentField(
  structure: StructureModel,
  k: Vec3,
  siteLabels: readonly string[],
  lgOps: readonly SymmetryOperation[],
  selections: readonly IrrepSelection[],
  amplitudes: readonly number[],
): { atoms: FieldAtom[] } | { failure: IsotropyFailure } {
  if (selections.some((s) => (s.irrep.dim ?? 1) > 1)) return { failure: "multidim-irrep" };
  if (selections.some((s) => !s.irrep.real)) return { failure: "complex-irrep" };

  let ampIdx = 0;
  // Accumulate per-atom moments across sites and irreps.
  const acc = new Map<string, { pos: Vec3; m: [number, number, number] }>();
  let anyMode = false;

  for (const label of siteLabels) {
    const site = structure.sites.find((s) => s.label === label);
    if (!site) continue;

    for (const sel of selections) {
      const allModes = projectIrrepModes(structure, k, [label], lgOps, sel.irrep);
      const indices = sel.modeIndices ?? allModes.map((_, i) => i);
      const modes = indices.map((i) => allModes[i]).filter((v): v is Vec3 => v !== undefined);
      if (modes.length === 0) continue;

      // Reference-site moment for this irrep: Σ c·mode.
      const m0: [number, number, number] = [0, 0, 0];
      for (const mode of modes) {
        const c = amplitudes[ampIdx % amplitudes.length]!;
        ampIdx++;
        m0[0] += c * mode[0]!;
        m0[1] += c * mode[1]!;
        m0[2] += c * mode[2]!;
      }
      if (Math.hypot(...m0) < 1e-9) continue;
      anyMode = true;

      // Transport over the orbit: first op reaching each new position wins
      // (consistent because m0 is projection-invariant under the stabilizer).
      const placed = new Set<string>();
      for (let gi = 0; gi < lgOps.length; gi++) {
        const op = lgOps[gi]!;
        const image = applyOperation(op, site.position);
        const key = posKey(image);
        if (placed.has(key)) continue;
        placed.add(key);
        const wrapped: Vec3 = [mod1(image[0]!), mod1(image[1]!), mod1(image[2]!)];
        const L: Vec3 = [
          Math.round(image[0]! - wrapped[0]!),
          Math.round(image[1]! - wrapped[1]!),
          Math.round(image[2]! - wrapped[2]!),
        ];
        const s = realPhase(k, L);
        if (s === null) return { failure: "complex-phase" };
        const chi = Math.round(sel.irrep.characters[gi]?.re ?? 1) as 1 | -1;
        const mj = actOnMoment({ ...op, timeReversal: 1 }, m0, chi * s);
        const cur = acc.get(key);
        if (cur) {
          cur.m[0] += mj[0]!;
          cur.m[1] += mj[1]!;
          cur.m[2] += mj[2]!;
        } else {
          acc.set(key, { pos: wrapped, m: [mj[0]!, mj[1]!, mj[2]!] });
        }
      }
    }
  }

  if (!anyMode) return { failure: "no-modes" };
  return { atoms: [...acc.values()].map((a) => ({ pos: a.pos, m: a.m as Vec3 })) };
}

/**
 * Stabilizer of a moment field in G_k × {1, 1'}: every operation (g, θ) with
 * θ·e^{2πik·L}·det(R_g)·R_g·m(r_i) = m(g·r_i) for all field atoms — the same
 * axial-vector/phase convention as {@link allowedMomentDirections} (its
 * site-fixing condition is the i = image case). Returns null when a primed
 * pure translation would be needed (type-IV, out of naming scope).
 */
function stabilizer(
  atoms: readonly FieldAtom[],
  k: Vec3,
  lgOps: readonly SymmetryOperation[],
): SymmetryOperation[] | { failure: IsotropyFailure } {
  const stab: SymmetryOperation[] = [];
  const thetaByRotation = new Map<string, 1 | -1>();

  for (const op of lgOps) {
    for (const theta of [1, -1] as const) {
      let ok = true;
      for (const atom of atoms) {
        const image = applyOperation(op, atom.pos);
        const target = atoms.find((a) => samePos(a.pos, image));
        if (!target) { ok = false; break; }
        const L: Vec3 = [
          Math.round(image[0]! - target.pos[0]!),
          Math.round(image[1]! - target.pos[1]!),
          Math.round(image[2]! - target.pos[2]!),
        ];
        const s = realPhase(k, L);
        if (s === null) return { failure: "complex-phase" };
        const mapped = actOnMoment({ ...op, timeReversal: theta }, atom.m, s);
        if (
          Math.abs(mapped[0]! - target.m[0]!) > 1e-6 ||
          Math.abs(mapped[1]! - target.m[1]!) > 1e-6 ||
          Math.abs(mapped[2]! - target.m[2]!) > 1e-6
        ) { ok = false; break; }
      }
      if (ok) {
        const key = rotationKey(op);
        const prev = thetaByRotation.get(key);
        if (prev !== undefined && prev !== theta) {
          // Same rotation coset stabilizing with both signs ⇒ a pure
          // translation with θ = −1 is in the group: type IV.
          return { failure: "primed-translation" };
        }
        thetaByRotation.set(key, theta);
        stab.push({ ...op, timeReversal: theta });
      }
    }
  }
  return stab;
}

/** Deterministic generic amplitudes (golden-ratio sequence, never near 0). */
function genericAmplitudes(count: number, seed: number): number[] {
  const PHI = 0.6180339887498949;
  return Array.from({ length: count }, (_, i) => 0.5 + ((seed + (i + 1) * PHI) % 1));
}

/**
 * The isotropy subgroup of an irrep combination: build the moment field with
 * generic amplitudes twice (independent draws) and intersect the stabilizers,
 * so no accidental invariance of one draw survives. The operation set is the
 * magnetic space group implied by "ordering transforms as these irreps", and
 * `standard` carries its BNS/OG identification when tabulated.
 */
export function isotropySubgroup(
  structure: StructureModel,
  k: Vec3,
  siteLabels: readonly string[],
  lgOps: readonly SymmetryOperation[],
  selections: readonly IrrepSelection[],
): IsotropyResult | { failure: IsotropyFailure } {
  if (selections.length === 0) return { failure: "no-modes" };

  let ops: SymmetryOperation[] | null = null;
  for (const seed of [0.137, 0.719]) {
    const amps = genericAmplitudes(64, seed);
    const field = buildMomentField(structure, k, siteLabels, lgOps, selections, amps);
    if ("failure" in field) return field;
    const stab = stabilizer(field.atoms, k, lgOps);
    if ("failure" in stab) return stab;
    if (ops === null) {
      ops = stab;
    } else {
      const keep = new Set(stab.map((o) => `${rotationKey(o)}|${o.timeReversal ?? 1}`));
      ops = ops.filter((o) => keep.has(`${rotationKey(o)}|${o.timeReversal ?? 1}`));
    }
  }
  if (!ops || ops.length === 0) return { failure: "no-modes" };

  const cosets = new Set(ops.map((o) => rotationKey(o)));
  const standard = identifyMagneticGroup(ops);
  return {
    operations: ops,
    standard,
    settingMatch: standard ? null : identifyMagneticGroupAnySetting(ops),
    subgroupOrder: cosets.size,
  };
}
