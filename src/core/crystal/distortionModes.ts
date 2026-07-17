/**
 * Symmetry-adapted DISTORTION-MODE parameterization (AMPLIMODES / ISODISTORT
 * paradigm): refine mode AMPLITUDES instead of raw symmetry-constrained
 * coordinates. The two parameterizations span the same space — a mode is a
 * fixed linear combination of the child structure's symmetry-allowed
 * displacements — but amplitudes are the physically informative coordinates:
 * they read directly as order parameters (amplitude vs temperature), and one
 * dominant mode often replaces a dozen coordinate parameters.
 *
 * Phase A (this module, fully computed in-core):
 *  - pair the CHILD asymmetric sites to the nearest members of the PARENT
 *    orbits (both structures must be expressed on the same lattice/setting —
 *    the AMPLIMODES "reference vs distorted" input convention);
 *  - build a Cartesian-orthonormal basis of the child's allowed displacement
 *    space, with the OBSERVED parent→child distortion as the leading "frozen"
 *    mode and an orthonormal complement (Gram–Schmidt in Cartesian Å);
 *  - normalize so a parameter value of 1 equals a whole-cell displacement
 *    norm of 1 Å: A = √(Σ_cell |u_i|²) — amplitudes are in Å (note: AMPLIMODES
 *    reports the same functional form, normalized over its parent cell; the
 *    convention here is the CHILD cell, stated so comparisons are explicit);
 *  - return the "parentized" child (sites moved to the parent reference) with
 *    mode parameters seeded at the observed decomposition, so refinement
 *    starts exactly at the input child structure and the fitted amplitude of
 *    mode 1 IS the distortion order parameter.
 *
 * The parameters are ordinary `positionShift` parameters whose value drives
 * SEVERAL bindings (one per involved site, each with its fractional `axis`) —
 * the same multi-binding pattern the magnetic `momentMode` uses, so the whole
 * refinement stack (engine, staged, multi-start, pool, UI grouping) works
 * unchanged. Phase B (planned): import irrep-labelled mode definitions from
 * ISODISTORT displacive-mode CIFs for authoritative labels.
 */

import type { StructureModel, AtomSite } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { mulVec } from "@/core/math/mat3";

export interface DistortionMode {
  /** Parameter id (mode_1, mode_2, …). */
  readonly id: string;
  /** Human label: mode index, dominant site, and the frozen-mode tag. */
  readonly label: string;
  /** Observed amplitude (Å over the child cell) in the input child structure. */
  readonly observedAmplitude: number;
  /** Per-child-site fractional displacement at amplitude 1 Å. */
  readonly axes: readonly { readonly siteLabel: string; readonly axis: Vec3 }[];
}

export interface DistortionModeSet {
  /** The child structure with every paired site moved to its PARENT reference
   *  position — the amplitude-zero anchor. */
  readonly parentized: StructureModel;
  /** The origin shift (fractional, child = parent + shift) that aligned the
   *  two settings — searched automatically unless supplied. */
  readonly originShift: Vec3;
  /** Mode amplitude parameters (Å), seeded at the observed decomposition so
   *  the starting model reproduces the input child exactly. */
  readonly parameters: RefinementParameter[];
  /** Multi-site positionShift bindings (one per mode × involved site). */
  readonly bindings: ParameterBinding[];
  readonly modes: readonly DistortionMode[];
  /** Total observed distortion amplitude √(Σ A_obs²) in Å. */
  readonly totalAmplitude: number;
  /** Child sites that found no parent partner (left untouched, no modes). */
  readonly unpaired: readonly string[];
}

const PAIR_TOLERANCE = 1.2; // Å — max parent↔child site separation to pair

function wrapDelta(d: number): number {
  let x = d % 1;
  if (x > 0.5) x -= 1;
  if (x < -0.5) x += 1;
  return x;
}

/**
 * Decompose `child` (low-symmetry structure) against `parent` (high-symmetry
 * reference on the SAME lattice) into refinable distortion modes. The two
 * settings may differ by an origin shift — searched automatically (candidates
 * seeded from the rarest element's parent atoms, scored by total pairing
 * cost) unless `originShift` is given explicitly.
 */
export function buildDistortionModes(parent: StructureModel, child: StructureModel, originShift?: Vec3): DistortionModeSet {
  const M = orthogonalizationMatrix(child.cell);
  const parentAtomsRaw = expandStructureAtoms(parent);

  // Origin-shift search: child = parent + t. Candidate t's come from matching
  // the child site of the RAREST element against each parent atom of that
  // element; each candidate is scored by the summed squared pairing distance
  // over all child sites (unpairable sites are charged the tolerance²).
  const shift: Vec3 = originShift ?? (() => {
    const counts = new Map<string, number>();
    for (const a of parentAtomsRaw) counts.set(a.element, (counts.get(a.element) ?? 0) + 1);
    const seedSite = [...child.sites].sort((a, b) => (counts.get(a.element) ?? 1e9) - (counts.get(b.element) ?? 1e9))[0];
    if (!seedSite) return [0, 0, 0] as Vec3;
    const candidates: Vec3[] = [[0, 0, 0]];
    for (const a of parentAtomsRaw) {
      if (a.element !== seedSite.element) continue;
      candidates.push([
        wrapDelta(seedSite.position[0] - a.position[0]),
        wrapDelta(seedSite.position[1] - a.position[1]),
        wrapDelta(seedSite.position[2] - a.position[2]),
      ]);
    }
    let bestT: Vec3 = [0, 0, 0];
    let bestScore = Infinity;
    for (const t of candidates) {
      let score = 0;
      for (const s of child.sites) {
        let d2 = PAIR_TOLERANCE * PAIR_TOLERANCE;
        for (const a of parentAtomsRaw) {
          if (a.element !== s.element) continue;
          const df: Vec3 = [
            wrapDelta(s.position[0] - a.position[0] - t[0]),
            wrapDelta(s.position[1] - a.position[1] - t[1]),
            wrapDelta(s.position[2] - a.position[2] - t[2]),
          ];
          const dc = mulVec(M, df);
          d2 = Math.min(d2, dc[0] * dc[0] + dc[1] * dc[1] + dc[2] * dc[2]);
        }
        score += d2;
      }
      if (score < bestScore - 1e-12) {
        bestScore = score;
        bestT = t;
      }
    }
    return bestT;
  })();

  // Parent atoms carried into the child's setting.
  const parentAtoms = parentAtomsRaw.map((a) => ({
    ...a,
    position: [a.position[0] + shift[0], a.position[1] + shift[1], a.position[2] + shift[2]] as Vec3,
  }));

  // Pair each child asymmetric site with its nearest parent-cell atom of the
  // same element; the parent position is the mode anchor (amplitude 0).
  interface Paired {
    readonly site: AtomSite;
    readonly reference: Vec3;
    readonly observed: Vec3; // fractional displacement reference → child
    readonly basis: Vec3[]; // child-symmetry-allowed shift directions
    readonly multiplicity: number;
  }
  const paired: Paired[] = [];
  const unpaired: string[] = [];
  for (const site of child.sites) {
    let best: { pos: Vec3; dist: number } | null = null;
    for (const atom of parentAtoms) {
      if (atom.element !== site.element) continue;
      const df: Vec3 = [
        wrapDelta(site.position[0] - atom.position[0]),
        wrapDelta(site.position[1] - atom.position[1]),
        wrapDelta(site.position[2] - atom.position[2]),
      ];
      const dc = mulVec(M, df);
      const dist = Math.hypot(dc[0], dc[1], dc[2]);
      if (!best || dist < best.dist) best = { pos: atom.position, dist };
    }
    if (!best || best.dist > PAIR_TOLERANCE) {
      unpaired.push(site.label);
      continue;
    }
    const { basis } = allowedPositionShifts(child.spaceGroup.operations, site.position);
    // Raw displacement parent → child, then PROJECT onto the child's allowed
    // shift space (Cartesian metric). Only the in-space part is a refinable
    // distortion; the residual is a fixed offset between the parent point and
    // the child's Wyckoff manifold and is absorbed into the reference — so the
    // parentized site stays ON its special position (orbit and multiplicity
    // intact) and amplitude 0 is the closest symmetry-legal point.
    const dRaw: Vec3 = [
      wrapDelta(site.position[0] - best.pos[0]),
      wrapDelta(site.position[1] - best.pos[1]),
      wrapDelta(site.position[2] - best.pos[2]),
    ];
    const dCart = mulVec(M, dRaw);
    const bCart = basis.map((b) => mulVec(M, b));
    // Solve the (≤3×3) Gram system G·c = rhs for the projection coefficients.
    const n = bCart.length;
    const dProj: [number, number, number] = [0, 0, 0];
    if (n > 0) {
      const G = bCart.map((bi) => bCart.map((bj) => bi[0] * bj[0] + bi[1] * bj[1] + bi[2] * bj[2]));
      const rhs = bCart.map((bi) => bi[0] * dCart[0] + bi[1] * dCart[1] + bi[2] * dCart[2]);
      // Gaussian elimination with partial pivoting (n ≤ 3).
      const A = G.map((row, i) => [...row, rhs[i]!]);
      for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
        if (Math.abs(A[piv]![col]!) < 1e-12) continue;
        [A[col], A[piv]] = [A[piv]!, A[col]!];
        for (let r = 0; r < n; r++) {
          if (r === col) continue;
          const f = A[r]![col]! / A[col]![col]!;
          for (let k = col; k <= n; k++) A[r]![k] = A[r]![k]! - f * A[col]![k]!;
        }
      }
      for (let k = 0; k < n; k++) {
        const c = Math.abs(A[k]![k]!) > 1e-12 ? A[k]![n]! / A[k]![k]! : 0;
        for (let i = 0; i < 3; i++) dProj[i] = dProj[i]! + c * basis[k]![i]!;
      }
    }
    const reference: Vec3 = [
      site.position[0] - dProj[0],
      site.position[1] - dProj[1],
      site.position[2] - dProj[2],
    ];
    paired.push({
      site,
      reference,
      observed: dProj,
      basis: basis.map((b) => [...b] as Vec3),
      multiplicity: siteMultiplicity(child.spaceGroup.operations, site.position),
    });
  }

  // The displacement space: one global coordinate per (site, allowed direction).
  // Work in whole-cell Cartesian Å (space-group rotations preserve the metric,
  // so each orbit image contributes the same norm as its representative).
  interface GlobalVec {
    /** Per paired-site fractional displacement. */
    readonly frac: Vec3[];
  }
  const cartNormSq = (v: GlobalVec): number =>
    paired.reduce((s, p, j) => {
      const c = mulVec(M, v.frac[j]!);
      return s + p.multiplicity * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
    }, 0);
  const dot = (a: GlobalVec, b: GlobalVec): number =>
    paired.reduce((s, p, j) => {
      const ca = mulVec(M, a.frac[j]!);
      const cb = mulVec(M, b.frac[j]!);
      return s + p.multiplicity * (ca[0] * cb[0] + ca[1] * cb[1] + ca[2] * cb[2]);
    }, 0);
  const scaled = (v: GlobalVec, s: number): GlobalVec => ({ frac: v.frac.map((f) => [f[0] * s, f[1] * s, f[2] * s] as Vec3) });
  const minus = (a: GlobalVec, b: GlobalVec, s: number): GlobalVec => ({
    frac: a.frac.map((f, j) => [f[0] - s * b.frac[j]![0], f[1] - s * b.frac[j]![1], f[2] - s * b.frac[j]![2]] as Vec3),
  });
  const zero = (): GlobalVec => ({ frac: paired.map(() => [0, 0, 0] as Vec3) });

  // Candidate directions: every allowed shift direction of every site.
  const candidates: GlobalVec[] = [];
  paired.forEach((p, j) => {
    for (const b of p.basis) {
      const v = zero();
      (v.frac[j] as [number, number, number])[0] = b[0];
      (v.frac[j] as [number, number, number])[1] = b[1];
      (v.frac[j] as [number, number, number])[2] = b[2];
      candidates.push(v);
    }
  });

  // Leading mode: the observed distortion itself (when nonzero), then a
  // Cartesian Gram–Schmidt over the candidates for the complement.
  const observed: GlobalVec = { frac: paired.map((p) => p.observed) };
  const observedNorm = Math.sqrt(cartNormSq(observed));
  const ortho: GlobalVec[] = [];
  const push = (v: GlobalVec): void => {
    let w = v;
    for (const u of ortho) w = minus(w, u, dot(w, u));
    const n = Math.sqrt(cartNormSq(w));
    if (n > 1e-8) ortho.push(scaled(w, 1 / n));
  };
  if (observedNorm > 1e-6) push(observed);
  for (const c of candidates) push(c);

  // Emit parameters + bindings. Seed = the observed decomposition, so the
  // parentized structure + seeded amplitudes reproduce the child exactly.
  const parameters: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const modes: DistortionMode[] = [];
  ortho.forEach((m, k) => {
    const id = `mode_${k + 1}`;
    const amp = observedNorm > 1e-6 ? dot(observed, m) : 0;
    // Dominant site for the label (largest Cartesian share).
    let domJ = 0;
    let domV = -1;
    m.frac.forEach((f, j) => {
      const c = mulVec(M, f);
      const w = paired[j]!.multiplicity * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
      if (w > domV) {
        domV = w;
        domJ = j;
      }
    });
    const frozen = k === 0 && observedNorm > 1e-6;
    const label = frozen
      ? `A1 frozen distortion (${paired[domJ]!.site.label}…)`
      : `mode ${k + 1} (${paired[domJ]!.site.label})`;
    parameters.push({ id, label, kind: "positionShift", value: amp, initialValue: amp, fixed: false });
    const axes: { siteLabel: string; axis: Vec3 }[] = [];
    m.frac.forEach((f, j) => {
      if (Math.hypot(f[0], f[1], f[2]) < 1e-10) return;
      axes.push({ siteLabel: paired[j]!.site.label, axis: f });
      bindings.push({ parameterId: id, kind: "positionShift", targetId: child.id, targetKey: paired[j]!.site.label, axis: f });
    });
    modes.push({ id, label, observedAmplitude: amp, axes });
  });

  const parentized: StructureModel = {
    ...child,
    sites: child.sites.map((s) => {
      const p = paired.find((q) => q.site.label === s.label);
      return p ? { ...s, position: [...p.reference] as [number, number, number] } : s;
    }),
  };

  return { parentized, originShift: shift, parameters, bindings, modes, totalAmplitude: observedNorm, unpaired };
}

/**
 * Swap a spec's per-coordinate position parameters for mode amplitudes: drop
 * every `positionShift` row/binding and splice in the mode set (fixed on
 * entry except the frozen mode — free the rest deliberately, as with any
 * strongly-correlated group). Works for any engine's spec (PDF, powder).
 */
export function withDistortionModes(
  spec: { params: RefinementParameter[]; bindings: ParameterBinding[] },
  modeSet: DistortionModeSet,
): { params: RefinementParameter[]; bindings: ParameterBinding[] } {
  const params = [
    ...spec.params.filter((p) => p.kind !== "positionShift"),
    ...modeSet.parameters.map((p, i) => ({ ...p, fixed: i > 0 })),
  ];
  const keep = new Set(params.map((p) => p.id));
  const bindings = [
    ...spec.bindings.filter((b) => b.kind !== "positionShift" && keep.has(b.parameterId)),
    ...modeSet.bindings,
  ];
  return { params, bindings };
}
