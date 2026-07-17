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
 * unchanged.
 *
 * Modes carry their **Brillouin-zone star** (Γ, X, H, or a literal k): the
 * parent centerings the child breaks generate an abelian translation quotient
 * whose ±1 character channels split the displacement space; channels related
 * by the child point group form one star, and the observed distortion is
 * decomposed into one frozen (order-parameter) mode PER star — the k-part of
 * the AMPLIMODES/ISODISTORT irrep label. Phase B (planned): import
 * irrep-labelled mode definitions from ISODISTORT displacive-mode CIFs for
 * the full authoritative labels (irrep index and branch).
 */

import type { StructureModel, AtomSite } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { applyOperation, siteMultiplicity } from "@/core/crystal/symmetry";
import { orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { inverse, mulVec, transpose } from "@/core/math/mat3";

export interface DistortionMode {
  /** Parameter id (mode_1, mode_2, …). */
  readonly id: string;
  /** Human label: mode index, dominant site, the k-star, and the frozen tag. */
  readonly label: string;
  /**
   * Brillouin-zone star of the mode's propagation vector, from the parent
   * centerings the child breaks: "Γ" (cell-preserving), "X"/"H" (cubic F/I
   * zone-boundary points), or a literal "k=(h,k,l)" for other lattices.
   * Absent when the channel decomposition was not applicable.
   */
  readonly star?: string;
  /** Observed amplitude (Å over the child cell) in the input child structure. */
  readonly observedAmplitude: number;
  /** Per-child-site fractional displacement at amplitude 1 Å. */
  readonly axes: readonly { readonly siteLabel: string; readonly axis: Vec3 }[];
  /**
   * Whether this mode enters the refinement FREE when spliced in by
   * `withDistortionModes`. When absent, the legacy heuristic applies (free iff
   * the label carries the "frozen" order-parameter tag) — so child-decomposed
   * sets keep their behavior, while symmetry-enumerated sets (which have no
   * observed distortion and hence no frozen mode) can state intent explicitly.
   */
  readonly active?: boolean;
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
  /**
   * Number of rigid-translation (acoustic) combinations projected out of the
   * catalog by `buildSymmetryModes` — unobservable in any scattering fit.
   * Absent for child-decomposed sets.
   */
  readonly acousticExcluded?: number;
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

  // ---- Brillouin-zone (k-star) channels ----------------------------------
  // The parent centerings the child breaks generate an abelian translation
  // quotient; same-cell displacement fields split into its character channels
  // k ∈ ℤ³ (phase e^{2πik·t} = ±1 on the lost half-translations). Channels
  // related by the child point group form one STAR — the symmetry name of a
  // mode (Γ, X, H, …), AMPLIMODES' k-label without the irrep index (Phase B).
  const stars = buildStars(parentAtomsRaw, child, paired.map((p) => p.reference));

  // Leading modes: the observed distortion's per-star components (each is an
  // independent order parameter), then a Cartesian Gram–Schmidt over the
  // star-projected candidates for the complement. Star projectors are
  // orthogonal in the multiplicity-weighted Cartesian metric and sum to the
  // identity, so the span — and the exact reproduction of the child by the
  // seeded amplitudes — is unchanged by the decomposition.
  const observed: GlobalVec = { frac: paired.map((p) => p.observed) };
  const observedNorm = Math.sqrt(cartNormSq(observed));
  const ortho: GlobalVec[] = [];
  const orthoMeta: { star: string | undefined; frozen: boolean }[] = [];
  const push = (v: GlobalVec, star: string | undefined, frozen: boolean): void => {
    let w = v;
    for (const u of ortho) w = minus(w, u, dot(w, u));
    const n = Math.sqrt(cartNormSq(w));
    if (n > 1e-8) {
      ortho.push(scaled(w, 1 / n));
      orthoMeta.push({ star, frozen });
    }
  };
  // Frozen components first, largest star share first — mode_1 stays the
  // dominant order parameter.
  const frozenPieces = stars
    .map((s) => ({ star: s.label, piece: s.project(observed) }))
    .map((q) => ({ ...q, norm: Math.sqrt(cartNormSq(q.piece)) }))
    .filter((q) => q.norm > 1e-6)
    .sort((a, b) => b.norm - a.norm);
  for (const q of frozenPieces) push(q.piece, q.star, true);
  for (const s of stars) {
    for (const c of candidates) push(s.project(c), s.label, false);
  }

  // Emit parameters + bindings. Seed = the observed decomposition, so the
  // parentized structure + seeded amplitudes reproduce the child exactly.
  const parameters: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const modes: DistortionMode[] = [];
  let frozenCount = 0;
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
    const { star, frozen } = orthoMeta[k]!;
    const starTag = star ? ` @ ${star}` : "";
    const label = frozen
      ? `A${++frozenCount} frozen distortion${starTag} (${paired[domJ]!.site.label}…)`
      : `mode ${k + 1}${starTag} (${paired[domJ]!.site.label})`;
    parameters.push({ id, label, kind: "positionShift", value: amp, initialValue: amp, fixed: false });
    const axes: { siteLabel: string; axis: Vec3 }[] = [];
    m.frac.forEach((f, j) => {
      if (Math.hypot(f[0], f[1], f[2]) < 1e-10) return;
      axes.push({ siteLabel: paired[j]!.site.label, axis: f });
      bindings.push({ parameterId: id, kind: "positionShift", targetId: child.id, targetKey: paired[j]!.site.label, axis: f });
    });
    modes.push({ id, label, ...(star !== undefined ? { star } : {}), observedAmplitude: amp, axes });
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
 * Enumerate the symmetry-adapted displacement modes of a structure FROM ITS
 * OWN SPACE GROUP — no second (parent/child) CIF. The loaded structure is
 * treated as the high-symmetry reference: each asymmetric site contributes its
 * symmetry-allowed shift directions (`allowedPositionShifts` — the null space
 * of the site stabilizer), orthonormalized in the whole-cell Cartesian metric
 * and normalized so amplitude 1 ⇒ 1 Å whole-cell displacement, exactly like
 * `buildDistortionModes`. All amplitudes seed at 0, so activating modes never
 * changes the calculated curve.
 *
 * Scope honesty: these are the symmetry-CONSERVING (identity-irrep) modes —
 * the same DOF as the per-coordinate `positionShift` parameters, re-expressed
 * as whole-cell Å amplitudes (span-equivalence is tested). Every mode is
 * cell-preserving, so the star is Γ by construction. Symmetry-BREAKING modes
 * (non-trivial irreps, isotropy subgroups) require the polar irrep engine —
 * the subgroup-tree phase — and are NOT produced here.
 *
 * Modes are emitted `active: false`: with no observed distortion there is no
 * order parameter to pre-free, so the user (or the subgroup tree) activates
 * modes deliberately — `withDistortionModes` honors the flag.
 *
 * SEEDS (subgroup-tree activation): `opts.seeds` supplies displacement fields
 * that become the LEADING modes of the catalog — normalized, orthogonalized
 * against the acoustic gauge (only the optic part of a seeded field is
 * observable) and each other, emitted `active: true` with the caller's label.
 * The complement basis then fills the remaining symmetry-allowed space as
 * usual. This is how an activated irrep distortion enters the refinement as
 * mode 1 while the child's other degrees of freedom stay deliberately fixed.
 *
 * ACOUSTIC EXCLUSION: a uniform (rigid) translation of the whole structure is
 * exactly unobservable in any scattering quantity — G(r) sees only interatomic
 * vectors and |F|² is origin-invariant — so when a lattice-axis translation
 * lies fully inside the symmetry-allowed space (every site free to follow), it
 * is an exact null direction of the fit. Refining it stalls the engine with a
 * ±1.00 correlation. Such combinations are projected OUT of the catalog here
 * (`acousticExcluded` counts them); when a symmetry-pinned site anchors the
 * origin, no translation is in-span and nothing is excluded. The per-coordinate
 * parameterization cannot make this distinction — a genuine advantage of the
 * mode basis. (The child-decomposition path `buildDistortionModes` is left
 * as-is: its frozen order parameter is an observed, observable displacement.)
 */
export interface SymmetryModeSeed {
  /** Per-site fractional displacement of the seeded mode. */
  readonly axes: readonly { readonly siteLabel: string; readonly axis: Vec3 }[];
  readonly label: string;
  readonly star?: string;
}

export function buildSymmetryModes(
  structure: StructureModel,
  opts?: { readonly seeds?: readonly SymmetryModeSeed[] },
): DistortionModeSet {
  const M = orthogonalizationMatrix(structure.cell);
  const ops = structure.spaceGroup.operations;

  interface SymSite {
    readonly site: AtomSite;
    readonly basis: Vec3[];
    readonly multiplicity: number;
  }
  const sites: SymSite[] = structure.sites
    .map((site) => ({
      site,
      basis: allowedPositionShifts(ops, site.position).basis.map((b) => [...b] as Vec3),
      multiplicity: siteMultiplicity(ops, site.position),
    }))
    .filter((s) => s.basis.length > 0);

  // Whole-cell Cartesian metric over the retained sites (multiplicity-weighted,
  // same convention as buildDistortionModes: rotations preserve the metric, so
  // each orbit image contributes the norm of its representative).
  interface GlobalVec {
    readonly frac: Vec3[];
  }
  const cartNormSq = (v: GlobalVec): number =>
    sites.reduce((s, p, j) => {
      const c = mulVec(M, v.frac[j]!);
      return s + p.multiplicity * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
    }, 0);
  const dot = (a: GlobalVec, b: GlobalVec): number =>
    sites.reduce((s, p, j) => {
      const ca = mulVec(M, a.frac[j]!);
      const cb = mulVec(M, b.frac[j]!);
      return s + p.multiplicity * (ca[0] * cb[0] + ca[1] * cb[1] + ca[2] * cb[2]);
    }, 0);
  const scaled = (v: GlobalVec, s: number): GlobalVec => ({ frac: v.frac.map((f) => [f[0] * s, f[1] * s, f[2] * s] as Vec3) });
  const minus = (a: GlobalVec, b: GlobalVec, s: number): GlobalVec => ({
    frac: a.frac.map((f, j) => [f[0] - s * b.frac[j]![0], f[1] - s * b.frac[j]![1], f[2] - s * b.frac[j]![2]] as Vec3),
  });
  const zero = (): GlobalVec => ({ frac: sites.map(() => [0, 0, 0] as Vec3) });

  // Acoustic gauge modes: a rigid translation of the whole structure along ANY
  // direction — not only a lattice axis — is an exact scattering null, and it
  // lies inside the parameter space exactly when the direction is in EVERY
  // site's allowed span (a symmetry-pinned site anchors the origin and kills
  // it). The gauge subspace is therefore the INTERSECTION of the per-site
  // spans, computed in Cartesian as the null space of Q = Σ_sites (I − P_s)
  // (P_s = orthogonal projector onto site s's allowed span): Q·v = 0 ⇔ v is
  // allowed at every site. Testing only the coordinate axes would miss oblique
  // gauges — e.g. every site on a [111] 3-fold (rhombohedral GeTe): the common
  // direction is [111], not x/y/z.
  const gauge: GlobalVec[] = [];
  {
    // Per-site projector complements, over ALL sites (a pinned site contributes
    // I − 0 = I, forcing an empty intersection — the origin is anchored).
    const Q: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const s of structure.sites) {
      const basis = allowedPositionShifts(ops, s.position).basis;
      const bC = basis.map((b) => mulVec(M, b));
      // P = B·(BᵀB)⁻¹·Bᵀ via the small Gram solve; complement added to Q.
      const nb = bC.length;
      const P: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      if (nb > 0) {
        const G = bC.map((bi) => bC.map((bj) => bi[0] * bj[0] + bi[1] * bj[1] + bi[2] * bj[2]));
        // Invert G (nb ≤ 3) by Gauss–Jordan with pivoting.
        const A = G.map((row, i) => [...row, ...G.map((_, j) => (i === j ? 1 : 0))]);
        let ok = true;
        for (let col = 0; col < nb; col++) {
          let piv = col;
          for (let r = col + 1; r < nb; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
          if (Math.abs(A[piv]![col]!) < 1e-12) { ok = false; break; }
          [A[col], A[piv]] = [A[piv]!, A[col]!];
          const d = A[col]![col]!;
          for (let k = 0; k < 2 * nb; k++) A[col]![k] = A[col]![k]! / d;
          for (let r = 0; r < nb; r++) {
            if (r === col) continue;
            const f = A[r]![col]!;
            for (let k = 0; k < 2 * nb; k++) A[r]![k] = A[r]![k]! - f * A[col]![k]!;
          }
        }
        if (ok) {
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              let v = 0;
              for (let a = 0; a < nb; a++) {
                for (let b = 0; b < nb; b++) v += bC[a]![i]! * A[a]![nb + b]! * bC[b]![j]!;
              }
              P[i]![j] = v;
            }
          }
        }
      }
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) Q[i]![j] = Q[i]![j]! + (i === j ? 1 : 0) - P[i]![j]!;
      }
    }
    // Null space of the symmetric PSD 3×3 Q by row reduction (entries are sums
    // of projectors, O(1) — an absolute pivot tolerance is safe).
    const R = Q.map((r) => [...r]);
    const pivotCols: number[] = [];
    let rr = 0;
    for (let c = 0; c < 3 && rr < 3; c++) {
      let best = rr;
      for (let i = rr + 1; i < 3; i++) if (Math.abs(R[i]![c]!) > Math.abs(R[best]![c]!)) best = i;
      if (Math.abs(R[best]![c]!) < 1e-9) continue;
      [R[rr], R[best]] = [R[best]!, R[rr]!];
      const d = R[rr]![c]!;
      for (let k = 0; k < 3; k++) R[rr]![k] = R[rr]![k]! / d;
      for (let i = 0; i < 3; i++) {
        if (i === rr) continue;
        const f = R[i]![c]!;
        for (let k = 0; k < 3; k++) R[i]![k] = R[i]![k]! - f * R[rr]![k]!;
      }
      pivotCols.push(c);
      rr++;
    }
    const Minv = inverse(M);
    for (let c = 0; c < 3; c++) {
      if (pivotCols.includes(c)) continue;
      // Free column c → null vector: v_c = 1, v_pivot = −R[row][c].
      const vC: [number, number, number] = [0, 0, 0];
      vC[c] = 1;
      pivotCols.forEach((pc, row) => {
        vC[pc] = -R[row]![c]!;
      });
      // Uniform fractional shift realizing the Cartesian translation vC.
      const tFrac = mulVec(Minv, vC);
      let t: GlobalVec = { frac: sites.map(() => [...tFrac] as Vec3) };
      for (const u of gauge) t = minus(t, u, dot(t, u));
      const n = Math.sqrt(cartNormSq(t));
      if (n > 1e-8) gauge.push(scaled(t, 1 / n));
    }
  }

  // Seeded modes first (subgroup-tree activation): the caller's displacement
  // fields, gauge-projected and normalized, become the leading catalog entries
  // and are emitted `active: true` under the caller's label.
  const ortho: GlobalVec[] = [];
  const seedMeta: { readonly label: string; readonly star?: string }[] = [];
  for (const seed of opts?.seeds ?? []) {
    let w = zero();
    for (const ax of seed.axes) {
      const j = sites.findIndex((p) => p.site.label === ax.siteLabel);
      if (j < 0) continue;
      const f = w.frac[j] as [number, number, number];
      f[0] += ax.axis[0];
      f[1] += ax.axis[1];
      f[2] += ax.axis[2];
    }
    for (const u of gauge) w = minus(w, u, dot(w, u));
    for (const u of ortho) w = minus(w, u, dot(w, u));
    const n = Math.sqrt(cartNormSq(w));
    if (n > 1e-8) {
      ortho.push(scaled(w, 1 / n));
      seedMeta.push({ label: seed.label, ...(seed.star !== undefined ? { star: seed.star } : {}) });
    }
  }

  // Candidates: every allowed direction of every site, in deterministic
  // (asymmetric-site order, basis order) sequence, orthogonalized against the
  // acoustic gauge modes first (they are seeded but never emitted) and then
  // against the already-accepted modes. Without gauge modes, candidates of
  // different sites have disjoint support and Gram–Schmidt never mixes sites;
  // with them, translation-orthogonal modes legitimately span several sites
  // (relative-displacement patterns — exactly the observable content).
  sites.forEach((p, j) => {
    for (const b of p.basis) {
      let w = zero();
      (w.frac[j] as [number, number, number])[0] = b[0];
      (w.frac[j] as [number, number, number])[1] = b[1];
      (w.frac[j] as [number, number, number])[2] = b[2];
      for (const u of gauge) w = minus(w, u, dot(w, u));
      for (const u of ortho) w = minus(w, u, dot(w, u));
      const n = Math.sqrt(cartNormSq(w));
      if (n > 1e-8) ortho.push(scaled(w, 1 / n));
    }
  });

  const parameters: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const modes: DistortionMode[] = [];
  ortho.forEach((m, k) => {
    const id = `mode_${k + 1}`;
    // Dominant site (largest multiplicity-weighted Cartesian share) for the
    // label. Without gauge exclusion modes are single-site; with it they may
    // span several sites (relative-displacement patterns).
    let domJ = 0;
    let domV = -1;
    m.frac.forEach((f, j) => {
      const c = mulVec(M, f);
      const w = sites[j]!.multiplicity * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
      if (w > domV) {
        domV = w;
        domJ = j;
      }
    });
    const seed = seedMeta[k];
    const label = seed ? seed.label : `mode ${k + 1} @ Γ (${sites[domJ]!.site.label})`;
    const active = seed !== undefined;
    parameters.push({ id, label, kind: "positionShift", value: 0, initialValue: 0, fixed: !active });
    const axes: { siteLabel: string; axis: Vec3 }[] = [];
    m.frac.forEach((f, j) => {
      if (Math.hypot(f[0], f[1], f[2]) < 1e-10) return;
      axes.push({ siteLabel: sites[j]!.site.label, axis: f });
      bindings.push({ parameterId: id, kind: "positionShift", targetId: structure.id, targetKey: sites[j]!.site.label, axis: f });
    });
    modes.push({ id, label, star: seed?.star ?? "Γ", observedAmplitude: 0, axes, active });
  });

  return {
    parentized: structure,
    originShift: [0, 0, 0],
    parameters,
    bindings,
    modes,
    totalAmplitude: 0,
    unpaired: [],
    acousticExcluded: gauge.length,
  };
}

/**
 * Re-seed `positionShift` parameter VALUES so a realized geometry is preserved
 * across a change of position parameterization (constrained-atomic ↔ mode
 * amplitudes). Solves the weighted least-squares system
 * `Σ_p v_p·axes_p ≈ (realized − anchor)` in the multiplicity-weighted
 * whole-cell Cartesian metric. This is an interpolation, not a fit: whenever
 * the displacement lies in the target parameterization's span the solution is
 * exact, and any unrepresentable component (e.g. the rigid-translation gauge a
 * symmetry-mode basis excludes) is dropped — which leaves the calculated curve
 * unchanged by construction, since that component is unobservable.
 */
export function positionShiftValuesFor(
  anchor: StructureModel,
  bindings: readonly ParameterBinding[],
  realized: StructureModel,
): Record<string, number> {
  const M = orthogonalizationMatrix(anchor.cell);
  const bySite = new Map(anchor.sites.map((s) => [s.label, s]));
  const mult = new Map(
    anchor.sites.map((s) => [s.label, siteMultiplicity(anchor.spaceGroup.operations, s.position)]),
  );
  // Fractional displacement per site, minimum-image wrapped.
  const disp = new Map<string, Vec3>();
  for (const s of realized.sites) {
    const a = bySite.get(s.label);
    if (!a) continue;
    disp.set(s.label, [
      wrapDelta(s.position[0] - a.position[0]),
      wrapDelta(s.position[1] - a.position[1]),
      wrapDelta(s.position[2] - a.position[2]),
    ]);
  }
  // Group each parameter's axes by site.
  const paramAxes = new Map<string, { site: string; axis: Vec3 }[]>();
  for (const b of bindings) {
    if (b.kind !== "positionShift" || !b.axis || b.targetKey === undefined) continue;
    const list = paramAxes.get(b.parameterId) ?? [];
    list.push({ site: b.targetKey, axis: b.axis as Vec3 });
    paramAxes.set(b.parameterId, list);
  }
  const ids = [...paramAxes.keys()];
  const n = ids.length;
  if (n === 0) return {};
  // Weighted Gram system G·v = rhs over the parameter axes.
  const cart = (v: Vec3): Vec3 => mulVec(M, v);
  const G: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (let p = 0; p < n; p++) {
    const ap = paramAxes.get(ids[p]!)!;
    for (let q = p; q < n; q++) {
      const aq = paramAxes.get(ids[q]!)!;
      let g = 0;
      for (const { site, axis } of ap) {
        const other = aq.find((x) => x.site === site);
        if (!other) continue;
        const ca = cart(axis);
        const cb = cart(other.axis);
        g += (mult.get(site) ?? 1) * (ca[0] * cb[0] + ca[1] * cb[1] + ca[2] * cb[2]);
      }
      G[p]![q] = g;
      if (q !== p) G[q]![p] = g;
    }
    let r = 0;
    for (const { site, axis } of ap) {
      const d = disp.get(site);
      if (!d) continue;
      const ca = cart(axis);
      const cd = cart(d);
      r += (mult.get(site) ?? 1) * (ca[0] * cd[0] + ca[1] * cd[1] + ca[2] * cd[2]);
    }
    G[p]![n] = r;
  }
  // Gaussian elimination with partial pivoting; skipped (near-zero) pivots
  // leave that direction at 0 — a particular solution, fine for re-seeding.
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(G[r]![col]!) > Math.abs(G[piv]![col]!)) piv = r;
    if (Math.abs(G[piv]![col]!) < 1e-12) continue;
    [G[col], G[piv]] = [G[piv]!, G[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = G[r]![col]! / G[col]![col]!;
      for (let k = col; k <= n; k++) G[r]![k] = G[r]![k]! - f * G[col]![k]!;
    }
  }
  const out: Record<string, number> = {};
  for (let p = 0; p < n; p++) {
    out[ids[p]!] = Math.abs(G[p]![p]!) > 1e-12 ? G[p]![n]! / G[p]![p]! : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brillouin-zone star decomposition of the same-cell displacement space.
// ---------------------------------------------------------------------------

/** A whole-cell displacement field, reduced to the child asymmetric sites. */
interface FieldVec {
  readonly frac: Vec3[];
}

/** One k-star channel group: its display label and orthogonal projector. */
interface KStar {
  readonly label: string | undefined;
  readonly project: (v: FieldVec) => FieldVec;
}

function wrapFrac(v: Vec3): Vec3 {
  return [((v[0] % 1) + 1) % 1, ((v[1] % 1) + 1) % 1, ((v[2] % 1) + 1) % 1];
}

/** Periodic fractional-position equality (tolerance matches the pairing). */
function sameFrac(a: Vec3, b: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(a[i]! - b[i]!);
    d = Math.min(d, 1 - d);
    if (d > 1e-3) return false;
  }
  return true;
}

/**
 * Non-trivial half-integer translations mapping the parent atom set onto
 * itself — the centerings (F/I/A/B/C) a same-cell child can break. Candidates
 * come from the rarest element's position differences; each is validated over
 * every atom and the set is closed under addition. Translations with other
 * denominators (e.g. rhombohedral ⅓) are deliberately not handled — the caller
 * degrades to unlabeled modes.
 */
function pseudoHalfTranslations(atoms: readonly { readonly element: string; readonly position: Vec3 }[]): Vec3[] {
  if (atoms.length < 2) return [];
  const counts = new Map<string, number>();
  for (const a of atoms) counts.set(a.element, (counts.get(a.element) ?? 0) + 1);
  const seedEl = [...counts.entries()].sort((x, y) => x[1] - y[1])[0]![0];
  const seeds = atoms.filter((a) => a.element === seedEl);
  const ref = seeds[0]!;
  const isTranslation = (t: Vec3): boolean =>
    atoms.every((a) => atoms.some((c) => c.element === a.element && sameFrac(wrapFrac([a.position[0] + t[0], a.position[1] + t[1], a.position[2] + t[2]]), c.position)));
  const found: Vec3[] = [];
  const pushCandidate = (raw: Vec3): void => {
    // Snap to exact halves; reject anything that is not a pure half-translation.
    const snapped: number[] = [];
    for (const x of wrapFrac(raw)) {
      const d0 = Math.min(x, 1 - x);
      if (d0 < 1e-3) snapped.push(0);
      else if (Math.abs(x - 0.5) < 1e-3) snapped.push(0.5);
      else return;
    }
    const t = snapped as unknown as Vec3;
    if (t[0] === 0 && t[1] === 0 && t[2] === 0) return;
    if (found.some((q) => q[0] === t[0] && q[1] === t[1] && q[2] === t[2])) return;
    if (isTranslation(t)) found.push(t);
  };
  for (const b of seeds) {
    pushCandidate([b.position[0] - ref.position[0], b.position[1] - ref.position[1], b.position[2] - ref.position[2]]);
  }
  // Closure (elementary abelian 2-group): sums of members are members.
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      pushCandidate([found[i]![0] + found[j]![0], found[i]![1] + found[j]![1], found[i]![2] + found[j]![2]]);
    }
  }
  return found;
}

/**
 * Partition the same-cell displacement channels into Brillouin-zone stars.
 * `references` are the parentized child asymmetric positions the fields live
 * on. Returns a single identity star ("Γ" when the parent has no lost
 * half-translations; unlabeled when the geometry fails to close) so callers
 * never branch.
 */
function buildStars(
  parentAtoms: readonly { readonly element: string; readonly position: Vec3 }[],
  child: StructureModel,
  references: readonly Vec3[],
): KStar[] {
  const lost = pseudoHalfTranslations(parentAtoms);
  if (lost.length === 0) return [{ label: "Γ", project: (v) => v }];
  const untagged: KStar[] = [{ label: undefined, project: (v) => v }];
  const group: Vec3[] = [[0, 0, 0], ...lost];

  // Atom matching is by NEAREST position with a physical (Å) cutoff, not an
  // exact fractional tolerance: the searched origin shift absorbs the seed
  // atom's own displacement, so reference-orbit copies sit up to ~0.1 Å off
  // the ideal translation grid — far from any OTHER atom, so the permutation
  // (all the projector needs) is still unambiguous.
  const M = orthogonalizationMatrix(child.cell);
  const distCart = (a: Vec3, b: Vec3): number => {
    const d: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]].map((x) => {
      let w = x % 1;
      if (w > 0.5) w -= 1;
      if (w < -0.5) w += 1;
      return w;
    }) as unknown as Vec3;
    const c = mulVec(M, d);
    return Math.hypot(c[0], c[1], c[2]);
  };
  const MATCH_CUTOFF = 0.6; // Å — well under any interatomic distance

  // Full-cell field table on the reference geometry: position, owning
  // asymmetric site, and the (fractional) rotation relating them.
  const entries: { pos: Vec3; j: number; R: Mat3 }[] = [];
  references.forEach((ref, j) => {
    for (const op of child.spaceGroup.operations) {
      const pos = wrapFrac(applyOperation(op, ref) as Vec3);
      if (!entries.some((e) => distCart(e.pos, pos) < MATCH_CUTOFF)) entries.push({ pos, j, R: op.rotation });
    }
  });

  // T(t) on a (child-symmetric) reduced field: u′(r_j) = u(r_j − t) = R_g·u_{j′}.
  const translate = (v: FieldVec, t: Vec3): FieldVec | null => {
    const frac: Vec3[] = [];
    for (let j = 0; j < references.length; j++) {
      const r = references[j]!;
      const src = wrapFrac([r[0] - t[0], r[1] - t[1], r[2] - t[2]]);
      let best: { e: (typeof entries)[number]; d: number } | null = null;
      for (const e of entries) {
        const d = distCart(e.pos, src);
        if (!best || d < best.d) best = { e, d };
      }
      if (!best || best.d > MATCH_CUTOFF) return null;
      frac.push(mulVec(best.e.R, v.frac[best.e.j]!) as Vec3);
    }
    return { frac };
  };
  const probe: FieldVec = { frac: references.map((_, i) => [i + 1, 0, 0] as Vec3) };
  for (const t of lost) if (!translate(probe, t)) return untagged;

  // Channels: k ∈ {0,1}³ with the ±1 phase pattern over the group; dedupe by
  // pattern (k's differing by a parent reciprocal vector alias), keeping the
  // smallest-|k| representative.
  const sigmaOf = (k: Vec3): number[] =>
    group.map((t) => (Math.round(2 * (k[0] * t[0] + k[1] * t[1] + k[2] * t[2])) % 2 === 0 ? 1 : -1));
  const kNormSq = (k: Vec3): number => k[0] * k[0] + k[1] * k[1] + k[2] * k[2];
  const channels: { k: Vec3; sigma: number[] }[] = [];
  for (let h = 0; h <= 1; h++) {
    for (let kk = 0; kk <= 1; kk++) {
      for (let l = 0; l <= 1; l++) {
        const k: Vec3 = [h, kk, l];
        const sigma = sigmaOf(k);
        const dup = channels.find((c) => c.sigma.every((s, i) => s === sigma[i]));
        if (!dup) channels.push({ k, sigma });
        else if (kNormSq(k) < kNormSq(dup.k)) dup.k = k;
      }
    }
  }

  // Stars: orbits of channels under the child point group, k′ = R⁻ᵀk matched
  // back by phase pattern.
  const starOf: number[] = channels.map(() => -1);
  let nStars = 0;
  for (let i = 0; i < channels.length; i++) {
    if (starOf[i]! >= 0) continue;
    const star = nStars++;
    const queue = [i];
    starOf[i] = star;
    while (queue.length > 0) {
      const c = channels[queue.pop()!]!;
      for (const op of child.spaceGroup.operations) {
        const kPrimeRaw = mulVec(transpose(inverse(op.rotation)), c.k);
        const kPrime: Vec3 = [Math.round(kPrimeRaw[0]), Math.round(kPrimeRaw[1]), Math.round(kPrimeRaw[2])];
        const sigma = sigmaOf(kPrime);
        const m = channels.findIndex((q) => q.sigma.every((s, ii) => s === sigma[ii]));
        if (m >= 0 && starOf[m]! < 0) {
          starOf[m] = star;
          queue.push(m);
        }
      }
    }
  }

  // Standard letters where they are unambiguous; a literal k elsewhere.
  const cell = child.cell;
  const cubic =
    Math.abs(cell.a - cell.b) < 1e-3 * cell.a &&
    Math.abs(cell.a - cell.c) < 1e-3 * cell.a &&
    [cell.alpha, cell.beta, cell.gamma].every((x) => Math.abs(x - 90) < 1e-3);
  const has = (t: Vec3): boolean => lost.some((q) => q[0] === t[0] && q[1] === t[1] && q[2] === t[2]);
  const isF = lost.length === 3 && has([0, 0.5, 0.5]) && has([0.5, 0, 0.5]) && has([0.5, 0.5, 0]);
  const isI = lost.length === 1 && has([0.5, 0.5, 0.5]);
  const letter = (k: Vec3): string => {
    if (k[0] === 0 && k[1] === 0 && k[2] === 0) return "Γ";
    const sorted = k.map(Math.abs).sort((a, b) => a - b);
    const zoneEdge = sorted[0] === 0 && sorted[1] === 0 && sorted[2] === 1;
    if (cubic && isF && zoneEdge) return "X";
    if (cubic && isI && zoneEdge) return "H";
    return `k=(${k.join(",")})`;
  };

  const stars: KStar[] = [];
  for (let s = 0; s < nStars; s++) {
    const members = channels.filter((_, i) => starOf[i] === s);
    const rep = members.reduce((best, c) => (kNormSq(c.k) < kNormSq(best.k) ? c : best));
    const project = (v: FieldVec): FieldVec => {
      const acc: Vec3[] = v.frac.map(() => [0, 0, 0] as Vec3);
      group.forEach((t, ti) => {
        let w = 0;
        for (const m of members) w += m.sigma[ti]!;
        if (w === 0) return;
        const tv = translate(v, t)!;
        for (let j = 0; j < acc.length; j++) {
          (acc[j] as [number, number, number])[0] += w * tv.frac[j]![0];
          (acc[j] as [number, number, number])[1] += w * tv.frac[j]![1];
          (acc[j] as [number, number, number])[2] += w * tv.frac[j]![2];
        }
      });
      const inv = 1 / group.length;
      return { frac: acc.map((u) => [u[0] * inv, u[1] * inv, u[2] * inv] as Vec3) };
    };
    stars.push({ label: letter(rep.k), project });
  }
  return stars;
}

/**
 * Swap a spec's per-coordinate position parameters for mode amplitudes: drop
 * every `positionShift` row/binding and splice in the mode set. The frozen
 * (order-parameter) modes — one per k-star component of the observed
 * distortion — enter free; the complement enters fixed, freed deliberately
 * like any strongly-correlated group. Works for any engine's spec (PDF, powder).
 */
export function withDistortionModes(
  spec: { params: RefinementParameter[]; bindings: ParameterBinding[] },
  modeSet: DistortionModeSet,
): { params: RefinementParameter[]; bindings: ParameterBinding[] } {
  // Free selection: an explicit `active` flag wins; absent (child-decomposed
  // sets) falls back to the frozen-label heuristic, preserving legacy behavior.
  const frozenIds = new Set(
    modeSet.modes.filter((m) => m.active ?? m.label.includes("frozen")).map((m) => m.id),
  );
  const params = [
    ...spec.params.filter((p) => p.kind !== "positionShift"),
    ...modeSet.parameters.map((p) => ({ ...p, fixed: !frozenIds.has(p.id) })),
  ];
  const keep = new Set(params.map((p) => p.id));
  const bindings = [
    ...spec.bindings.filter((b) => b.kind !== "positionShift" && keep.has(b.parameterId)),
    ...modeSet.bindings,
  ];
  return { params, bindings };
}
