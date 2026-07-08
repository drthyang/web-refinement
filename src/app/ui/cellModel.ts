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
 * honour time reversal; atoms not reachable by a magnetic operation get none.
 */
export function buildCellAtoms(
  structure: StructureModel,
  supercell: readonly [number, number, number] = [1, 1, 1],
  magneticOps?: readonly SymmetryOperation[],
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

  // The moment-placing op for the atom at `frac` (site image, wrapped): the
  // (first) op in `list` reaching that position, with its θ and returning L.
  const placingFor = (list: readonly SymmetryOperation[], sitePos: Vec3, frac: Vec3): MomentPlacing | undefined => {
    for (const op of list) {
      const raw = applyOperation(op, sitePos);
      const w: Vec3 = [wrap01(raw[0]), wrap01(raw[1]), wrap01(raw[2])];
      if (!coincide(w, frac)) continue;
      const latt: Vec3 = [Math.round(raw[0] - w[0]!), Math.round(raw[1] - w[1]!), Math.round(raw[2] - w[2]!)];
      return { rot: op.rotation, theta: (op.timeReversal ?? 1) as 1 | -1, latt };
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
    for (const { frac, rot } of placed) {
      const mag = placingFor(magneticOps ?? ops, site.position, frac);
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
    }
  }
  return atoms;
}
