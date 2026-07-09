/**
 * Pure geometry for the 3D structure viewer: expand a structure's asymmetric
 * unit into the atoms of one unit cell (Cartesian Å). Kept free of three.js /
 * React so it is unit-testable and so the viewer component only exports a
 * component (clean React Fast Refresh).
 *
 * Each atom also carries its site label and the **moment-placing operation**:
 * rotation, time-reversal sign θ, and returning lattice translation L. The
 * moment arrow on a symmetry-equivalent atom is (see `displayMoment`)
 *   m′ = θ · det(R) · cos(2π k·(L + n)) · R·m,
 * matching the θ-signed axial transform + k-phase used by the magnetic
 * structure factor. When magnetic (Shubnikov) operations are supplied, they —
 * not the nuclear group — define θ and the arrow; atoms of the nuclear orbit
 * not reachable by a magnetic operation carry no moment (other k-arm/domain).
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import { momentBindingKey, type MagneticModel } from "@/core/magnetic/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { applyOperation } from "@/core/crystal/symmetry";
import { determinant } from "@/core/math/mat3";

/** The operation that carries the site's moment onto this atom. */
export interface MomentPlacing {
  readonly rot: Mat3;
  /** Time-reversal sign θ of the placing operation (+1 for nuclear ops). */
  readonly theta: 1 | -1;
  /** Returning lattice translation L (image = wrapped position + L). */
  readonly latt: Vec3;
  /** Key of the moment entry this atom's arrow derives from (defaults to the
   *  site label; split orbits carry a `#n` suffix — see momentBindingKey). */
  readonly momentKey: string;
}

/**
 * One moment entry for the viewer: the refined components plus the anchor the
 * magnetic group expands it from. `key` matches `MomentPlacing.momentKey`.
 */
export interface MomentEntry {
  readonly key: string;
  readonly siteLabel: string;
  /** Orbit-representative fractional position (defaults to the site position). */
  readonly position?: Vec3;
  /** Crystal-axis moment components (µ_B). */
  readonly components: Vec3;
}

/** The viewer's moment entries for a magnetic model (split orbits included). */
export function momentEntriesFrom(magnetic: MagneticModel): MomentEntry[] {
  return magnetic.moments.map((m) => ({
    key: momentBindingKey(m),
    siteLabel: m.siteLabel,
    ...(m.position ? { position: m.position } : {}),
    components: [...m.components] as Vec3,
  }));
}

/** One rendered atom: element, site label, Cartesian position (Å), placing op. */
export interface CellAtom {
  readonly element: string;
  readonly label: string;
  readonly xyz: Vec3;
  readonly rot: Mat3;
  /** Moment-placing operation; absent ⇒ draw no arrow on this atom. */
  readonly mag?: MomentPlacing;
  /** Integer cell translation n of the atom's copy (for k-phase moment modulation). */
  readonly cellIndex: readonly [number, number, number];
}

/**
 * Crystal-axis moment arrow for an expanded atom: the site moment `m`
 * transformed by the atom's placing operation (axial, θ-signed) and modulated
 * by the commensurate k-phase of its cell + returning translation. Returns
 * null when the atom carries no moment under the magnetic group.
 */
export function displayMoment(atom: CellAtom, m: Vec3, k?: Vec3): Vec3 | null {
  if (!atom.mag) return null;
  const { rot: R, theta, latt } = atom.mag;
  const n = atom.cellIndex;
  const kmod = k
    ? Math.cos(2 * Math.PI * (k[0]! * (latt[0]! + n[0]!) + k[1]! * (latt[1]! + n[1]!) + k[2]! * (latt[2]! + n[2]!)))
    : 1;
  const w = theta * determinant(R) * kmod;
  return [
    w * (R[0]![0]! * m[0]! + R[0]![1]! * m[1]! + R[0]![2]! * m[2]!),
    w * (R[1]![0]! * m[0]! + R[1]![1]! * m[1]! + R[1]![2]! * m[2]!),
    w * (R[2]![0]! * m[0]! + R[2]![1]! * m[1]! + R[2]![2]! * m[2]!),
  ];
}

/**
 * Magnetic supercell size for a commensurate k: Nᵢ = smallest integer making
 * Nᵢ·kᵢ an integer (the denominator of kᵢ). k = 0 → (1,1,1); k = (0,0,½) → (1,1,2).
 */
export function magneticSupercell(k: Vec3): [number, number, number] {
  const denom = (v: number): number => {
    if (Math.abs(v) < 1e-6) return 1;
    for (let n = 1; n <= 12; n++) if (Math.abs(v * n - Math.round(v * n)) < 1e-4) return n;
    return 1;
  };
  return [denom(k[0]!), denom(k[1]!), denom(k[2]!)];
}

/** Fractional coord within this of 0 → also drawn at +1 (fill faces/edges/corners). */
const BOUNDARY_EPS = 0.02;
/** Guardrail against a pathological cell/space-group producing runaway atoms. */
const MAX_ATOMS = 4000;

/**
 * A standard-setting cell to populate alongside the parent cell: columns of
 * `P` are the new basis vectors in parent fractional coordinates, `origin`
 * the new cell origin (parent fractional). See {@link buildCellAtoms}.
 */
export interface StandardCellRegion {
  readonly P: readonly (readonly number[])[];
  readonly origin: Vec3;
}

const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function wrap01(v: number): number {
  return ((v % 1) + 1) % 1;
}

function coincide(a: Vec3, b: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(a[i]! - b[i]!);
    d = Math.min(d, 1 - d);
    if (d > 1e-3) return false;
  }
  return true;
}

/**
 * Expand `structure` into the atoms of one unit cell (default) or a `supercell`
 * of the atomic cell (e.g. the magnetic supercell for a commensurate k). For the
 * single cell, boundary atoms are duplicated so faces/edges/corners look complete;
 * for a supercell the wrapped atoms are tiled across the cells (each tagged with
 * its integer cell index, for k-phase moment modulation). Deduped per site.
 *
 * `magneticOps` (θ-signed Shubnikov operations, e.g. the chosen subgroup): when
 * given, each atom's moment-placing operation is looked up among them, so arrows
 * honour time reversal.
 *
 * `momentEntries`: the model's moment anchors. When the magnetic group splits a
 * site's crystallographic orbit, each split orbit has its own entry (anchored at
 * its representative position) — the placing search runs per anchor, so every
 * atom finds the entry whose G_M-orbit it belongs to. Without entries the site
 * position is the single anchor (legacy behaviour); an atom reachable from no
 * anchor carries no arrow (its moment is not defined by the model).
 *
 * `standardRegion`: additionally populate a standard-setting cell (a magnetic
 * subgroup identified through a basis transformation). The fill is exact: the
 * crystal is periodic under the **parent** lattice, so the region receives the
 * parent-lattice-translated copies r + t (t ∈ ℤ³) whose new-basis coordinates
 * P⁻¹·(r + t − origin) lie in [0, 1] (boundary-inclusive — and since P has
 * integer columns, face/corner-equivalent copies are themselves genuine
 * lattice translates, so they appear automatically). Each copy is tagged with
 * cellIndex = t, so {@link displayMoment} applies the same
 * θ·det(R)·cos(2π k·(L + t))·R·m arrow the magnetic structure factor uses —
 * the moments in the new cell are the identical physical field, not a
 * re-derivation. Copies coinciding with parent-cell atoms dedupe by position.
 */
export function buildCellAtoms(
  structure: StructureModel,
  supercell: readonly [number, number, number] = [1, 1, 1],
  magneticOps?: readonly SymmetryOperation[],
  momentEntries?: readonly MomentEntry[],
  standardRegion?: StandardCellRegion,
): CellAtom[] {
  const [nx, ny, nz] = supercell;
  const single = nx === 1 && ny === 1 && nz === 1;
  const ops = structure.spaceGroup.operations.length
    ? structure.spaceGroup.operations
    : [{ rotation: IDENTITY, translation: [0, 0, 0] as Vec3, xyz: "x,y,z" }];
  const atoms: CellAtom[] = [];
  const seen = new Set<string>();
  const push = (element: string, label: string, frac: Vec3, rot: Mat3, mag: MomentPlacing | undefined, cellIndex: [number, number, number]): void => {
    if (atoms.length >= MAX_ATOMS) return;
    const key = `${label}|${frac.map((v) => v.toFixed(3)).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    atoms.push({ element, label, xyz: fractionalToCartesian(structure.cell, frac), rot, ...(mag ? { mag } : {}), cellIndex });
  };

  // Standard-region machinery: P⁻¹ (for the inside test) and the integer
  // translation box that can reach the region from the wrapped [0,1) atoms.
  const region = (() => {
    if (!standardRegion) return null;
    const P = standardRegion.P;
    const det =
      P[0]![0]! * (P[1]![1]! * P[2]![2]! - P[1]![2]! * P[2]![1]!) -
      P[0]![1]! * (P[1]![0]! * P[2]![2]! - P[1]![2]! * P[2]![0]!) +
      P[0]![2]! * (P[1]![0]! * P[2]![1]! - P[1]![1]! * P[2]![0]!);
    if (Math.abs(det) < 1e-9) return null;
    const cof = (r1: number, c1: number, r2: number, c2: number): number =>
      P[r1]![c1]! * P[r2]![c2]! - P[r1]![c2]! * P[r2]![c1]!;
    const Pinv: number[][] = [
      [cof(1, 1, 2, 2) / det, -cof(0, 1, 2, 2) / det, cof(0, 1, 1, 2) / det],
      [-cof(1, 0, 2, 2) / det, cof(0, 0, 2, 2) / det, -cof(0, 0, 1, 2) / det],
      [cof(1, 0, 2, 1) / det, -cof(0, 0, 2, 1) / det, cof(0, 0, 1, 1) / det],
    ];
    // Parent-fractional extent of the region: its 8 corners.
    const lo: number[] = [Infinity, Infinity, Infinity];
    const hi: number[] = [-Infinity, -Infinity, -Infinity];
    for (const i of [0, 1]) for (const j of [0, 1]) for (const kk of [0, 1]) {
      for (let a = 0; a < 3; a++) {
        const v = standardRegion.origin[a]! + i * P[a]![0]! + j * P[a]![1]! + kk * P[a]![2]!;
        if (v < lo[a]!) lo[a] = v;
        if (v > hi[a]!) hi[a] = v;
      }
    }
    const tMin = lo.map((v) => Math.floor(v - BOUNDARY_EPS) - 1);
    const tMax = hi.map((v) => Math.ceil(v + BOUNDARY_EPS));
    return { Pinv, origin: standardRegion.origin, tMin, tMax };
  })();

  /** New-basis coordinates of a parent-fractional point. */
  const toRegionCoords = (x: Vec3): Vec3 => {
    const d: Vec3 = [x[0]! - region!.origin[0]!, x[1]! - region!.origin[1]!, x[2]! - region!.origin[2]!];
    const M = region!.Pinv;
    return [
      M[0]![0]! * d[0]! + M[0]![1]! * d[1]! + M[0]![2]! * d[2]!,
      M[1]![0]! * d[0]! + M[1]![1]! * d[1]! + M[1]![2]! * d[2]!,
      M[2]![0]! * d[0]! + M[2]![1]! * d[1]! + M[2]![2]! * d[2]!,
    ];
  };

  // The moment-placing op for the atom at `frac`: the (first) op in `list`
  // carrying `anchorPos` onto that position, with its θ and returning L.
  const placingFor = (
    list: readonly SymmetryOperation[],
    anchorPos: Vec3,
    frac: Vec3,
    momentKey: string,
  ): MomentPlacing | undefined => {
    for (const op of list) {
      const raw = applyOperation(op, anchorPos);
      const w: Vec3 = [wrap01(raw[0]), wrap01(raw[1]), wrap01(raw[2])];
      if (!coincide(w, frac)) continue;
      const latt: Vec3 = [Math.round(raw[0] - w[0]!), Math.round(raw[1] - w[1]!), Math.round(raw[2] - w[2]!)];
      return { rot: op.rotation, theta: (op.timeReversal ?? 1) as 1 | -1, latt, momentKey };
    }
    return undefined;
  };

  for (const site of structure.sites) {
    // Distinct equivalent positions (wrapped), each with its placing rotation.
    const placed: { frac: Vec3; rot: Mat3 }[] = [];
    for (const op of ops) {
      const raw = applyOperation(op, site.position);
      const frac: Vec3 = [wrap01(raw[0]), wrap01(raw[1]), wrap01(raw[2])];
      if (!placed.some((q) => coincide(q.frac, frac))) placed.push({ frac, rot: op.rotation });
    }
    // The anchors this site's arrows can derive from: its moment entries
    // (one per split orbit) or, absent a model, the site position itself.
    const anchors: { key: string; pos: Vec3 }[] = momentEntries
      ? momentEntries
          .filter((e) => e.siteLabel === site.label)
          .map((e) => ({ key: e.key, pos: e.position ?? site.position }))
      : [{ key: site.label, pos: site.position }];
    for (const { frac, rot } of placed) {
      let mag: MomentPlacing | undefined;
      for (const anchor of anchors) {
        mag = placingFor(magneticOps ?? ops, anchor.pos, frac, anchor.key);
        if (mag) break;
      }
      if (single) {
        // Duplicate across each near-zero axis so faces/edges/corners are filled.
        // Each duplicate belongs to the next cell along that axis (its k-phase cell index).
        const axisImages = [0, 1, 2].map((i) => (frac[i]! < BOUNDARY_EPS ? [0, 1] : [0]));
        for (const dx of axisImages[0]!) {
          for (const dy of axisImages[1]!) {
            for (const dz of axisImages[2]!) {
              push(site.element, site.label, [frac[0]! + dx, frac[1]! + dy, frac[2]! + dz], rot, mag, [dx, dy, dz]);
            }
          }
        }
      } else {
        // Tile the wrapped atom across the supercell, tagging each with its cell.
        for (let i = 0; i < nx; i++) {
          for (let j = 0; j < ny; j++) {
            for (let k = 0; k < nz; k++) {
              push(site.element, site.label, [frac[0]! + i, frac[1]! + j, frac[2]! + k], rot, mag, [i, j, k]);
            }
          }
        }
      }
      // Standard-setting cell fill: every parent-lattice translate of this
      // atom whose new-basis coordinates land in [0,1] (boundary-inclusive).
      // cellIndex = the true integer translation, so the k-phase stays exact.
      if (region) {
        for (let tx = region.tMin[0]!; tx <= region.tMax[0]!; tx++) {
          for (let ty = region.tMin[1]!; ty <= region.tMax[1]!; ty++) {
            for (let tz = region.tMin[2]!; tz <= region.tMax[2]!; tz++) {
              const x: Vec3 = [frac[0]! + tx, frac[1]! + ty, frac[2]! + tz];
              const c = toRegionCoords(x);
              if (
                c[0]! >= -BOUNDARY_EPS && c[0]! <= 1 + BOUNDARY_EPS &&
                c[1]! >= -BOUNDARY_EPS && c[1]! <= 1 + BOUNDARY_EPS &&
                c[2]! >= -BOUNDARY_EPS && c[2]! <= 1 + BOUNDARY_EPS
              ) {
                push(site.element, site.label, x, rot, mag, [tx, ty, tz]);
              }
            }
          }
        }
      }
    }
  }
  return atoms;
}
