/**
 * Structural ISOTROPY machinery at Γ — the activation half of the
 * ISODISTORT-style subgroup/mode tree (PDF distortion modes, Phase 3a):
 *
 *  - `projectIsotypicModes`: the character projector onto one irrep's isotypic
 *    component of the Γ displacement representation, acting on the full orbit
 *    displacement space — needs only characters (never irrep matrices), so it
 *    works for multidimensional irreps of non-abelian groups too;
 *  - `stabilizerOfField`: the exact isotropy subgroup of a CONCRETE
 *    displacement field — the operations under which the field is invariant,
 *    u(g·r) = R_g·u(r). Computing the stabilizer of the chosen field (rather
 *    than tabulating per-irrep kernels) handles multidimensional order
 *    parameters for free: distinct OP directions of one irrep get their
 *    distinct isotropy subgroups (P4mm vs Amm2 vs R3m for a T1u vector);
 *  - `identifySubgroup`: name the subgroup — exact operation-set match against
 *    the generated 230-group table, retried over the 24 proper axis-permutation
 *    settings; honest fallback to point group + index when no match is found
 *    (origin-shifted settings are a later addition);
 *  - `realizeSubgroup`: re-express the parent structure in the subgroup
 *    setting by splitting each Wyckoff orbit into its subgroup orbits — the
 *    step that makes an activated symmetry-breaking mode PHYSICAL: expanding a
 *    displaced site with the parent operations would re-symmetrize the
 *    distortion into a wrong orbit;
 *  - `activateDisplacementMode`: the end-to-end wiring — stabilizer → child →
 *    a DistortionModeSet whose leading (active) mode is the chosen field and
 *    whose complement is the child's remaining symmetry-allowed space, ready
 *    for the existing withDistortionModes/PdfWorkbench machinery.
 *
 * Scope: Γ only (cell-preserving). Zone-boundary distortions need supercell
 * realization and projective small representations — deliberately absent.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { StructureModel, SymmetryOperation, AtomSite } from "@/core/crystal/types";
import { applyOperation, equivalentPositions, parseSymmetryOperation } from "@/core/crystal/symmetry";
import { classifyPointGroup } from "@/core/crystal/pointGroup";
import { SPACE_GROUP_DATA } from "@/core/crystal/spaceGroupData";
import { transformOperation } from "@/core/crystal/settings";
import { orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { mulVec, determinant } from "@/core/math/mat3";
import { orbitAtoms, type DisplaciveIrrepTerm } from "@/core/crystal/displaciveModes";
import { buildSymmetryModes, type DistortionModeSet } from "@/core/crystal/distortionModes";

/** A Γ displacement field: fractional displacement per orbit atom. */
export interface DisplacementField {
  readonly atoms: readonly { readonly position: Vec3; readonly u: Vec3 }[];
}

const wrap = (v: number): number => {
  let x = v % 1;
  if (x < 0) x += 1;
  return x;
};
// Position tolerance 1e-3, matching the repo-wide orbit-dedup convention
// (equivalentPositions / orbitAtoms / the isInteger lattice test). A tighter
// tolerance here would silently DROP group actions for coordinates that sit
// 1e-4–1e-3 off a special position — exactly what refined geometries produce —
// degrading the character projector into garbage (verified failure mode).
const samePos = (a: Vec3, b: Vec3, tol = 1e-3): boolean => {
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(wrap(a[i]!) - wrap(b[i]!));
    if (Math.min(d, 1 - d) > tol) return false;
  }
  return true;
};

/**
 * Orthonormal (whole-cell Cartesian) basis of one irrep's isotypic component
 * of the Γ displacement representation on the given sites' orbits. Uses the
 * character projector P = (d/|G|)·Σ_g χ(g)*·ρ(g) with (ρ(g)u)(g·r) = R_g·u(r):
 * characters suffice for the isotypic subspace (no irrep matrices), so
 * multidimensional irreps work. Complex conjugate-pair irreps contribute their
 * real span (real and imaginary parts of the projected columns). The basis
 * size equals multiplicity·dim for real irreps — asserted by tests.
 */
export function projectIsotypicModes(
  structure: StructureModel,
  siteLabels: readonly string[] | undefined,
  term: DisplaciveIrrepTerm,
  ops: readonly SymmetryOperation[],
): DisplacementField[] {
  const labels = siteLabels ?? structure.sites.map((s) => s.label);
  const atoms = orbitAtoms(structure, labels);
  const N = atoms.length;
  if (N === 0) return [];
  const M = orthogonalizationMatrix(structure.cell);

  // Atom index of the op-image of atom j (mod lattice), per op. A failed match
  // means the orbit is NOT closed under the supplied group (tolerance drift or
  // a caller bug) — the projector output would be silently wrong, so refuse.
  const imageIndex: number[][] = ops.map((g) =>
    atoms.map((r) => {
      const img = applyOperation(g, r);
      const m = atoms.findIndex((q) => samePos(q, img));
      if (m < 0) {
        throw new Error(
          `projectIsotypicModes: orbit not closed under the group (atom ${r.join(",")} maps outside the atom list under ${g.xyz}) — position tolerances disagree or the structure/ops mismatch`,
        );
      }
      return m;
    }),
  );

  // Apply the projector to each canonical basis vector e_{j,α}; collect the
  // real and imaginary parts as real candidate fields.
  const candidates: number[][] = [];
  for (let j = 0; j < N; j++) {
    for (let a = 0; a < 3; a++) {
      const re = new Array<number>(3 * N).fill(0);
      const im = new Array<number>(3 * N).fill(0);
      ops.forEach((g, gi) => {
        const chi = term.irrep.characters[gi] ?? { re: 1, im: 0 };
        const m = imageIndex[gi]![j]!;
        if (m < 0) return;
        const R = g.rotation;
        // (ρ(g) e_{j,α})(r_m) = column α of R; weight χ(g)* = (chi.re, −chi.im).
        for (let b = 0; b < 3; b++) {
          const v = R[b]![a]!;
          re[3 * m + b] = re[3 * m + b]! + chi.re * v;
          im[3 * m + b] = im[3 * m + b]! - chi.im * v;
        }
      });
      candidates.push(re);
      if (im.some((x) => Math.abs(x) > 1e-9)) candidates.push(im);
    }
  }

  // Gram–Schmidt in the whole-cell Cartesian metric (atoms are explicit — no
  // multiplicity weights needed).
  const cart = (v: number[], j: number): Vec3 => mulVec(M, [v[3 * j]!, v[3 * j + 1]!, v[3 * j + 2]!]);
  const dot = (x: number[], y: number[]): number => {
    let s = 0;
    for (let j = 0; j < N; j++) {
      const cx = cart(x, j);
      const cy = cart(y, j);
      s += cx[0] * cy[0] + cx[1] * cy[1] + cx[2] * cy[2];
    }
    return s;
  };
  const basis: number[][] = [];
  for (const c of candidates) {
    const w = [...c];
    for (const q of basis) {
      const s = dot(w, q);
      for (let i = 0; i < w.length; i++) w[i] = w[i]! - s * q[i]!;
    }
    const n = Math.sqrt(dot(w, w));
    if (n > 1e-7) basis.push(w.map((x) => x / n));
  }
  return basis.map((v) => ({
    atoms: atoms.map((r, j) => ({ position: r, u: [v[3 * j]!, v[3 * j + 1]!, v[3 * j + 2]!] as Vec3 })),
  }));
}

/**
 * The exact isotropy subgroup of a displacement field: the parent operations
 * under which the field is invariant, u(g·r) ≡ R_g·u(r) for every orbit atom.
 * A subgroup by construction (the condition is multiplicative).
 */
export function stabilizerOfField(
  field: DisplacementField,
  parentOps: readonly SymmetryOperation[],
  tol = 1e-6,
): SymmetryOperation[] {
  return parentOps.filter((g) => {
    for (const { position, u } of field.atoms) {
      const img = applyOperation(g, position);
      const target = field.atoms.find((a) => samePos(a.position, img));
      if (!target) return false; // field not defined on a closed orbit
      const Ru = mulVec(g.rotation, u);
      for (let i = 0; i < 3; i++) {
        if (Math.abs(Ru[i]! - target.u[i]!) > tol) return false;
      }
    }
    return true;
  });
}

export interface SubgroupIdentity {
  /** IT number + standard H-M symbol when an exact op-set match was found. */
  readonly number?: number;
  readonly hermannMauguin?: string;
  /** Point-group symbol (always computable). */
  readonly pointGroup: string | null;
  /** [G : H] index in the parent point group. */
  readonly index: number;
  /** How the name was found (or why not). */
  readonly method: "direct" | "permuted-setting" | "point-group-only";
}

const opKey = (op: SymmetryOperation): string => {
  const r = op.rotation.flat().map((x) => Math.round(x)).join(",");
  const t = op.translation.map((x) => Math.round(wrap(x) * 24) % 24).join(",");
  return `${r}|${t}`;
};
const opSetKey = (ops: readonly SymmetryOperation[]): string =>
  [...new Set(ops.map(opKey))].sort().join(";");

/** The 24 proper rotation matrices of the cube (axis-permutation settings). */
function properCubicRotations(): Mat3[] {
  const out: Mat3[] = [];
  const perms: [number, number, number][] = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const perm of perms) {
    for (const s0 of [1, -1]) {
      for (const s1 of [1, -1]) {
        for (const s2 of [1, -1]) {
          const rows: [number, number, number][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          const signs = [s0, s1, s2];
          for (let i = 0; i < 3; i++) rows[i]![perm[i]!] = signs[i]!;
          const P: Mat3 = [rows[0]!, rows[1]!, rows[2]!];
          if (Math.round(determinant(P)) === 1) out.push(P);
        }
      }
    }
  }
  return out;
}

/**
 * Name a subgroup operation set: exact op-set match against the generated
 * 230-group table (standard settings), retried across the 24 proper
 * axis-permutation changes of basis. Falls back to the point group + index —
 * origin-shifted settings are not searched yet (honest degradation, reported
 * via `method`).
 */
export function identifySubgroup(
  subOps: readonly SymmetryOperation[],
  parentOps: readonly SymmetryOperation[],
): SubgroupIdentity {
  const pg = classifyPointGroup(subOps);
  const parentPg = classifyPointGroup(parentOps);
  const index = pg.order > 0 ? Math.round(parentPg.order / pg.order) : 0;

  // Prefilter table entries by op count; compare canonical op-set keys.
  const nOps = new Set(subOps.map(opKey)).size;
  const entries = SPACE_GROUP_DATA.filter((e) => e.ops.length === nOps).map((e) => ({
    e,
    key: opSetKey(e.ops.map(parseSymmetryOperation)),
  }));

  const direct = opSetKey(subOps);
  for (const { e, key } of entries) {
    if (key === direct) {
      return { number: e.number, hermannMauguin: e.hm, pointGroup: pg.symbol, index, method: "direct" };
    }
  }
  for (const P of properCubicRotations()) {
    const transformed = opSetKey(subOps.map((op) => transformOperation(op, P)));
    for (const { e, key } of entries) {
      if (key === transformed) {
        return { number: e.number, hermannMauguin: e.hm, pointGroup: pg.symbol, index, method: "permuted-setting" };
      }
    }
  }
  return { pointGroup: pg.symbol, index, method: "point-group-only" };
}

/**
 * Setting-invariant canonical key for a subgroup operation set: the minimal
 * canonical op-set key over the 24 proper axis-permutation settings. Two
 * conjugate (axis-permuted) subgroups share a key; subgroups differing in
 * TRANSLATION content (Pm vs Pc — same point group, same index) do not, so
 * grouping tree entries by this key never merges inequivalent subgroups.
 */
export function subgroupTypeKey(subOps: readonly SymmetryOperation[]): string {
  let best: string | null = null;
  for (const P of properCubicRotations()) {
    const k = opSetKey(subOps.map((op) => transformOperation(op, P)));
    if (best === null || k < best) best = k;
  }
  return best ?? opSetKey(subOps);
}

/**
 * Re-express the parent structure in a subgroup setting: split every Wyckoff
 * orbit into its subgroup orbits and emit one asymmetric site per subgroup
 * orbit (labels get a/b/c… suffixes when an orbit splits). Cell and site
 * properties carry over; the child's space group is the subgroup (with the
 * identified H-M symbol when available).
 */
export function realizeSubgroup(
  parent: StructureModel,
  subOps: readonly SymmetryOperation[],
  identity?: SubgroupIdentity,
): StructureModel {
  const sites: AtomSite[] = [];
  for (const site of parent.sites) {
    const orbit = equivalentPositions(parent.spaceGroup.operations, site.position);
    // Group the parent orbit into subgroup orbits.
    const classes: Vec3[][] = [];
    for (const atom of orbit) {
      const found = classes.find((cls) => cls.some((rep) => subOps.some((h) => samePos(applyOperation(h, rep), atom))));
      if (found) found.push(atom);
      else classes.push([atom]);
    }
    // One child site per class; keep the original stored position as the
    // representative of its own class. Split labels get base-26 letter
    // suffixes (a…z, aa, ab, …), advanced past any collision with existing
    // parent labels or already-emitted child labels — everything downstream
    // (bindings, seeds, exports) is keyed by site label.
    const taken = new Set<string>([...parent.sites.map((s) => s.label), ...sites.map((s) => s.label)]);
    const suffix = (n: number): string => {
      let s = "";
      let x = n;
      do {
        s = String.fromCharCode(97 + (x % 26)) + s;
        x = Math.floor(x / 26) - 1;
      } while (x >= 0);
      return s;
    };
    classes.forEach((cls, ci) => {
      const rep = cls.find((p) => samePos(p, site.position)) ?? cls[0]!;
      let label = site.label;
      if (classes.length > 1) {
        let k = ci;
        do {
          label = `${site.label}${suffix(k)}`;
          k += classes.length;
        } while (taken.has(label));
      }
      taken.add(label);
      sites.push({ ...site, label, position: [rep[0]!, rep[1]!, rep[2]!] as [number, number, number] });
    });
  }
  // Stamp the standard name ONLY when the operation list actually IS the
  // standard setting (a permuted-setting match would put a symbol on ops it
  // does not describe — the identity is still reported to callers for labels).
  const direct = identity?.method === "direct";
  return {
    ...parent,
    spaceGroup: {
      operations: [...subOps],
      ...(direct && identity?.hermannMauguin !== undefined ? { hermannMauguin: identity.hermannMauguin } : {}),
      ...(direct && identity?.number !== undefined ? { number: identity.number } : {}),
    },
    sites,
  };
}

export interface ActivatedMode {
  /** The child (subgroup-setting) structure the fit must run on. */
  readonly child: StructureModel;
  readonly identity: SubgroupIdentity;
  /** Drop-in mode set: leading mode = the activated field (active/free),
   *  complement = the child's remaining symmetry-allowed space (inactive). */
  readonly modeSet: DistortionModeSet;
}

/**
 * Activate a symmetry-breaking Γ displacement field end-to-end: compute its
 * isotropy subgroup, name it, realize the child structure (split orbits), and
 * build the DistortionModeSet whose leading (active) mode is the field — the
 * acoustic-gauge part is projected off by the seeded Gram–Schmidt, which is
 * scientifically right: only the optic (relative) content is observable.
 *
 * STATIONARY-START CAVEAT (real physics, not a defect): when the parent is
 * centrosymmetric and the activated irrep is inversion-ODD (a polar mode),
 * χ²(a) = χ²(−a) — the ±a structures are inversion domains with identical
 * G(r) and |F|² — so amplitude 0 is an exact stationary point and a
 * gradient-based refinement cannot leave it. The amplitude parameter still
 * seeds at 0 (the zero-amplitude = parent-curve guarantee holds); callers
 * activating such a mode must kick it off zero (a small starting amplitude,
 * or the multi-start/escape machinery). The engine's dead-column guard flags
 * the un-kicked case as singular rather than stalling.
 */
export function activateDisplacementMode(
  parent: StructureModel,
  field: DisplacementField,
  label: string,
): ActivatedMode {
  const subOps = stabilizerOfField(field, parent.spaceGroup.operations);
  const identity = identifySubgroup(subOps, parent.spaceGroup.operations);
  const child = realizeSubgroup(parent, subOps, identity);

  // Field value at each child asymmetric site (its own orbit representative).
  const seedAxes: { siteLabel: string; axis: Vec3 }[] = [];
  for (const s of child.sites) {
    const at = field.atoms.find((a) => samePos(a.position, s.position));
    if (at && Math.hypot(at.u[0], at.u[1], at.u[2]) > 1e-12) {
      seedAxes.push({ siteLabel: s.label, axis: at.u });
    }
  }
  const modeSet = buildSymmetryModes(child, {
    seeds: [{ axes: seedAxes, label }],
  });
  return { child, identity, modeSet };
}
