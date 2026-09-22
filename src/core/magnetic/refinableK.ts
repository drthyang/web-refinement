/**
 * Refinable propagation vector (Track B1): k becomes a set of ordinary
 * refinement parameters, restricted to the directions symmetry leaves free.
 *
 * Which directions. Moving k must not change the symmetry the magnetic model
 * was built from, so an allowed shift δk keeps the little group G_k intact:
 * Rᵀ·δk = δk for every rotation of G_k (a Rᵀ·k ≡ k + G relation survives the
 * shift only if δk is itself invariant). This is the k-space twin of the
 * site-symmetry rule for `positionShift`: a k on a symmetry line (α,α,0) moves
 * only along the line, a k at a zone-boundary point (½,0,0) does not move.
 *
 * Why absolute components, not a shift. The workbench re-applies the refined
 * parameters onto the already-refined magnetic model, so a "k₀ + value·axis"
 * parameter would be added twice; an absolute component is idempotent. Each
 * allowed direction frees one component (the free column of the null space);
 * a component that follows another is a tie "= f·k_free + c".
 *
 * Guards (plan §B1 step 5):
 *   · a self-conjugate k (k = 0, ½-type) is refused: moving it off its special
 *     value changes the Fourier formalism itself (one arm → two arms);
 *   · a direction along which the symmetry-allowed Fourier mode space changes
 *     is dropped: the model's mode basis was derived at k₀ and is only valid
 *     where the stabilizer phases e^{2πi k·L} are generic;
 *   · bounds keep each free component inside the open interval between the
 *     half-integers around k₀, so a fit cannot walk k onto a special point.
 *
 * k is non-linear in the model, so its Jacobian columns are finite
 * differences, and the per-cycle step is capped absolutely (`maxShift`): a
 * shift larger than a satellite's width loses the minimum.
 */

import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import { centringTranslations } from "@/core/crystal/symmetry";
import { momentAnchorPosition } from "@/core/crystal/cellExpansion";
import type { Vec3 } from "@/core/math/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { littleGroup } from "@/core/magnetic/magneticGroups";
import { allowedFourierModes, nullSpace, quadratureOf } from "@/core/magnetic/allowedMoments";
import { classifyPropagation } from "@/core/magnetic/propagation";
import type { MagneticModel } from "@/core/magnetic/types";

/** Binding target keys of the three k components (reciprocal-lattice units). */
export const K_COMPONENT_KEYS = ["k1", "k2", "k3"] as const;

/** Largest k step per refinement cycle (r.l.u.). */
export const K_MAX_SHIFT = 0.005;

/** Parameter id of k component `i` (0-based). */
export function propagationParameterId(i: number): string {
  return `prop_k${i + 1}`;
}

/** Perturbation used to probe whether the mode basis is generic along a direction. */
const PROBE = 1e-3;

/**
 * Symmetry-allowed shift directions of k: the null space of the stacked
 * (Rᵀ − I) over the little group's rotations. Each basis vector has a 1 in
 * its own free component and 0 in every other free component, so it reads
 * directly as "free component f drives the dependent ones by these factors".
 */
export function allowedKShiftDirections(parentOps: readonly SymmetryOperation[], k: Vec3): Vec3[] {
  const rows: number[][] = [];
  for (const op of littleGroup(parentOps, k)) {
    const R = op.rotation;
    for (let i = 0; i < 3; i++) {
      // Row i of Rᵀ − I is column i of R minus e_i.
      const row = [R[0]![i]!, R[1]![i]!, R[2]![i]!];
      row[i]! -= 1;
      if (row.some((x) => Math.abs(x) > 1e-9)) rows.push(row);
    }
  }
  const space = rows.length === 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : nullSpace(rows, 3, 1e-6);
  return space.map((v) => [v[0]!, v[1]!, v[2]!] as Vec3);
}

/** Real rank of a set of row vectors. */
function rank(vectors: readonly (readonly number[])[], n: number): number {
  return vectors.length === 0 ? 0 : n - nullSpace(vectors.map((v) => [...v]), n, 1e-6).length;
}

/** Real 6-vectors spanning the site's allowed complex Fourier coefficients. */
function modeSpan(ops: readonly SymmetryOperation[], position: Vec3, k: Vec3): number[][] {
  const out: number[][] = [];
  for (const m of allowedFourierModes(ops, position, k).modes) {
    const q = quadratureOf(m);
    out.push([...m.cos, ...m.sin], [...q.cos, ...q.sin]);
  }
  return out;
}

/** True when every moment's Fourier mode space is the same at k and at k + δ. */
function basisStable(structure: StructureModel, magnetic: MagneticModel, k: Vec3, dir: Vec3): boolean {
  const ops = magnetic.operations ?? structure.spaceGroup.operations;
  const kp: Vec3 = [k[0] + PROBE * dir[0], k[1] + PROBE * dir[1], k[2] + PROBE * dir[2]];
  for (const moment of magnetic.moments) {
    const site = structure.sites.find((s) => s.label === moment.siteLabel);
    if (!site) continue;
    const pos = momentAnchorPosition(structure.spaceGroup.operations, ops, site.position, moment.orbitIndex, moment.position);
    const a = modeSpan(ops, pos, k);
    const b = modeSpan(ops, pos, kp);
    const ra = rank(a, 6);
    if (ra !== rank(b, 6) || rank([...a, ...b], 6) !== ra) return false;
  }
  return true;
}

/** Bounds keeping a free component strictly between the half-integers around it. */
function componentBounds(v: number): { min: number; max: number } {
  const margin = 1e-3;
  const lo = Math.floor(2 * v + 1e-9) / 2;
  if (Math.abs(2 * v - Math.round(2 * v)) < 1e-9) {
    // Sitting on a half-integer along a direction symmetry leaves free: nothing
    // is special here, so allow half a zone either way.
    return { min: v - 0.5 + margin, max: v + 0.5 - margin };
  }
  return { min: lo + margin, max: lo + 0.5 - margin };
}

/** A tie constant written in the fixed-point form `parseTie` accepts. */
function fixed(x: number): string {
  const s = Math.abs(x).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}

export interface PropagationKParameters {
  /** k component rows: free components (held fixed until the user frees them)
   *  and tied dependent components. Empty when k cannot be refined. */
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  /** Directions k can move along (free-component form), after the guards. */
  readonly directions: Vec3[];
  /** Why k, or a direction of it, is not refinable. Empty when every
   *  symmetry-allowed direction survived. */
  readonly notes: string[];
}

/**
 * Parameter rows that refine the model's propagation vector. The free
 * components start fixed, like every other row the builders emit; freeing
 * them is the user's (or an agent's) decision.
 */
export function propagationKParameters(structure: StructureModel, magnetic: MagneticModel): PropagationKParameters {
  const empty = (note: string): PropagationKParameters => ({ params: [], bindings: [], directions: [], notes: [note] });
  const k = magnetic.propagation[0];
  if (!k) return empty("the magnetic model has no propagation vector");
  const cls = classifyPropagation(k, { centrings: centringTranslations(structure.spaceGroup.operations) });
  if (!cls.twoArms) {
    return empty("k is self-conjugate (k = 0 or ½-type): moving it would change the modulation from one arm to two");
  }

  const notes: string[] = [];
  const allowed = allowedKShiftDirections(structure.spaceGroup.operations, k);
  if (allowed.length === 0) return empty("k sits at a point fixed by the little group: no symmetry-allowed shift");
  const directions = allowed.filter((dir) => {
    const ok = basisStable(structure, magnetic, k, dir);
    if (!ok) notes.push(`the moment basis is special at this k along [${dir.map(fixed).join(", ")}] — held fixed`);
    return ok;
  });
  if (directions.length === 0) return { params: [], bindings: [], directions, notes };

  const freeCols = directions.map((d) => d.findIndex((x, i) => x === 1 && directions.every((o) => o === d || o[i] === 0)));
  const magId = magnetic.id;
  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const bind = (i: number): void => {
    bindings.push({ parameterId: propagationParameterId(i), kind: "propagationK", targetId: magId, targetKey: K_COMPONENT_KEYS[i]! });
  };

  freeCols.forEach((col) => {
    const v = k[col]!;
    params.push({
      id: propagationParameterId(col), label: `k${col + 1} (r.l.u.)`, kind: "propagationK",
      value: v, initialValue: v, ...componentBounds(v), maxShift: K_MAX_SHIFT, fixed: true,
    });
    bind(col);
  });

  for (let i = 0; i < 3; i++) {
    if (freeCols.includes(i)) continue;
    // Dependent component: k_i = k₀_i + Σ_f d_f[i]·(k_f − k₀_f).
    const drivers = directions
      .map((d, j) => ({ col: freeCols[j]!, f: d[i]! }))
      .filter((t) => Math.abs(t.f) > 1e-9);
    if (drivers.length === 0) continue; // pinned by symmetry: stays at k₀
    if (drivers.length > 1) {
      notes.push(`k${i + 1} depends on several free components — k is held fixed`);
      return { params: [], bindings: [], directions: [], notes };
    }
    const { col, f } = drivers[0]!;
    const c = k[i]! - f * k[col]!;
    const ref = propagationParameterId(col);
    const factor = Math.abs(f - 1) < 1e-12 ? "" : `${f < 0 ? "-" : ""}${fixed(f)}*`;
    const constant = Math.abs(c) < 1e-12 ? "" : `${c < 0 ? "-" : "+"}${fixed(c)}`;
    const v = k[i]!;
    params.push({
      id: propagationParameterId(i), label: `k${i + 1} (r.l.u.) = ${factor.replace("*", "·")}k${col + 1}${constant}`,
      kind: "propagationK", value: v, initialValue: v, fixed: true,
      expression: `= ${factor}${ref}${constant}`,
    });
    bind(i);
  }
  return { params, bindings, directions, notes };
}

/**
 * The propagation vector a set of `propagationK` bindings resolves to, or null
 * when no binding carries a value. Components without a binding keep k₀.
 */
export function resolvePropagation(
  k0: Vec3,
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
): Vec3 | null {
  let out: [number, number, number] | null = null;
  for (const b of bindings) {
    if (b.kind !== "propagationK" || !b.targetKey) continue;
    const v = values[b.parameterId];
    const i = (K_COMPONENT_KEYS as readonly string[]).indexOf(b.targetKey);
    if (v === undefined || i < 0) continue;
    out ??= [k0[0], k0[1], k0[2]];
    out[i] = v;
  }
  return out;
}
