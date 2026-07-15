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
  /** Cross-site |M| ties actually applied (see `tieEqualMagnitude`): one entry
   *  per element with ≥2 magnetic sublattices, listing the reference sublattice
   *  whose amplitudes drive the group, the tied members (with their flip
   *  state), and any sublattice that could NOT be tied (incompatible
   *  symmetry-allowed mode geometry). Empty when the option is off. */
  readonly magnitudeTies: readonly MagnitudeTie[];
}

export interface MagnitudeTie {
  /** Cluster label: the element symbol, or "all sites" for the all-scope tie. */
  readonly element: string;
  /** Display label of the reference sublattice (its params drive the group). */
  readonly reference: string;
  /** Tied sublattices: binding key (site label + orbit suffix), display label,
   *  and whether the moment is flipped (antiparallel) relative to the reference. */
  readonly members: readonly { readonly key: string; readonly label: string; readonly flipped: boolean }[];
  /** Same-element sublattices left independent, with the reason. */
  readonly skipped: readonly { readonly label: string; readonly reason: string }[];
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
 * Whether two mode sets have the same geometry (equal signed Gram matrices in
 * the Cartesian µ_B metric). Sharing amplitude coefficients across two
 * sublattices preserves |M| for ANY amplitudes exactly when this holds — the
 * modes are unit length, so for a single mode it always does, and multi-mode
 * sets must agree pairwise (including relative signs; a conservative check —
 * bases that differ only by mode order/sign fail it and simply stay untied).
 */
function sameModeGeometry(cell: UnitCell, a: readonly Vec3[], b: readonly Vec3[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      if (Math.abs(cartDot(cell, a[i]!, a[j]!) - cartDot(cell, b[i]!, b[j]!)) > 1e-6) return false;
    }
  }
  return true;
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
 */
export function buildMagneticModel(
  structure: StructureModel,
  k: Vec3,
  ionLabels: readonly string[],
  subgroupOps: readonly SymmetryOperation[],
  options: {
    readonly moment?: number;
    readonly tieSameSite?: boolean;
    /**
     * Constrain the moment MAGNITUDE to be equal across sublattices while
     * every sublattice keeps its own symmetry-allowed direction(s): the tied
     * sublattices share the reference's amplitude parameters, each applied
     * through its OWN mode basis. Scope "element" (or `true`) ties within
     * each element (|M(Mn1)| = |M(Mn2)|); "all" ties every selected magnetic
     * sublattice regardless of element (the high-entropy case). Exact
     * whenever the mode geometries match (`sameModeGeometry`); incompatible
     * sublattices stay independent and are reported in
     * `magnitudeTies[].skipped`.
     */
    readonly tieEqualMagnitude?: boolean | "element" | "all";
    /** Binding keys (site label + orbit suffix) of tied sublattices whose
     *  moment is antiparallel to the reference (their bases are negated). */
    readonly flippedUnits?: readonly string[];
  } = {},
): MagneticModelBuild {
  const moment0 = options.moment ?? 1.0;
  const tieSameSite = options.tieSameSite ?? true;
  // Normalized tie scope: true keeps the per-element behaviour; false/absent = off.
  const tieScope: "element" | "all" | null =
    options.tieEqualMagnitude === true ? "element" : options.tieEqualMagnitude || null;
  const flippedUnits = new Set(options.flippedUnits ?? []);
  const magId = `${structure.id}-mag`;
  const moments: MagneticMoment[] = [];
  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const activeSites: string[] = [];
  const magnitudeTies: MagnitudeTie[] = [];

  const ionSites = ionLabels
    .map((l) => structure.sites.find((s) => s.label === l))
    .filter((s): s is AtomSite => s !== undefined);

  // Phase 1 — collect the magnetic sublattices ("units"): one per
  // position-group × split orbit with an allowed moment. The magnetic subgroup
  // may split a site's crystallographic orbit (G_M ⊂ G for a k ≠ 0 little
  // group); every split orbit is an independent sublattice with its own
  // allowed-moment basis, parameters, and moment entry.
  interface Unit {
    readonly group: AtomSite[];
    readonly rep: AtomSite;
    readonly groupLabel: string;
    readonly orbitIndex: number;
    readonly orbitId: string;
    readonly orbitTag: string;
    readonly orbitPos: Vec3;
    readonly basis: Vec3[];
    /** Binding key of the representative — the unit's stable identity. */
    readonly key: string;
    readonly displayLabel: string;
  }
  const units: Unit[] = [];
  for (const group of groupByPosition(ionSites, tieSameSite)) {
    const rep = group[0]!;
    const orbitReps = magneticOrbitRepresentatives(structure.spaceGroup.operations, subgroupOps, rep.position);
    const groupLabel = group.length > 1 ? `${rep.label}+${group.length - 1}` : rep.label;
    orbitReps.forEach((orbitPos, oi) => {
      const orbitIndex = oi + 1;
      const allowed = allowedMomentDirections(subgroupOps, orbitPos, k);
      if (allowed.dimension === 0) return; // moment forbidden by symmetry here
      // Unit-µ_B modes: 1 unit of amplitude = 1 µ_B along the mode, so seeds
      // and refined amplitudes compare honestly across orbits and cells.
      const basis = allowed.basis.map((b) => unitMode(structure.cell, b));
      const orbitTag = orbitIndex > 1 ? ` orbit ${orbitIndex}` : "";
      units.push({
        group, rep, groupLabel, orbitIndex, orbitPos, basis,
        orbitId: orbitIndex > 1 ? `o${orbitIndex}_` : "",
        orbitTag,
        key: momentBindingKey({ siteLabel: rep.label, orbitIndex }),
        displayLabel: `${groupLabel}${orbitTag}`,
      });
    });
  }

  // Phase 2 — cross-site |M| ties: cluster units by element (or all together
  // for the "all" scope); within a cluster the first unit is the reference,
  // and every unit with the same mode geometry shares its amplitude
  // parameters (through its own basis, negated when flipped). Same magnitude
  // by construction, directions per sublattice.
  const tiedTo = new Map<string, Unit>(); // unit key → reference unit
  if (tieScope) {
    const byElement = new Map<string, Unit[]>();
    for (const u of units) {
      const el = tieScope === "all" ? "all sites" : u.rep.element;
      byElement.set(el, [...(byElement.get(el) ?? []), u]);
    }
    for (const [element, cluster] of byElement) {
      if (cluster.length < 2) continue;
      const reference = cluster[0]!;
      const members: { key: string; label: string; flipped: boolean }[] = [];
      const skipped: { label: string; reason: string }[] = [];
      for (const u of cluster.slice(1)) {
        if (sameModeGeometry(structure.cell, reference.basis, u.basis)) {
          tiedTo.set(u.key, reference);
          members.push({ key: u.key, label: u.displayLabel, flipped: flippedUnits.has(u.key) });
        } else {
          skipped.push({ label: u.displayLabel, reason: "different symmetry-allowed mode geometry" });
        }
      }
      if (members.length > 0 || skipped.length > 0) {
        magnitudeTies.push({ element, reference: reference.displayLabel, members, skipped });
      }
    }
  }

  // Phase 3 — emit parameters, bindings, and moment entries.
  for (const u of units) {
    const reference = tiedTo.get(u.key);
    const paramOwner = reference ?? u;
    const flipped = reference !== undefined && flippedUnits.has(u.key);
    const sign = flipped ? -1 : 1;

    // Per-mode amplitudes: the first allowed mode at moment0, the rest at 0.
    const amps = u.basis.map((_, i) => (i === 0 ? moment0 : 0));
    const seed: [number, number, number] = [0, 0, 0];
    u.basis.forEach((b, i) => {
      const a = amps[i]! * sign;
      seed[0] += a * b[0]!;
      seed[1] += a * b[1]!;
      seed[2] += a * b[2]!;
    });

    u.basis.forEach((b, i) => {
      const id = `mom_${paramOwner.rep.label}_${paramOwner.orbitId}${i}`;
      // The reference (or an untied unit) owns the parameter row; tied units
      // only add bindings onto it, each through its OWN (possibly negated)
      // basis — one shared amplitude, per-sublattice direction.
      if (reference === undefined) {
        const tie = magnitudeTies.find((t) => t.reference === u.displayLabel && t.members.length > 0);
        const tieTag = tie ? ` =|M| ${tie.members.map((m) => m.label).join(", ")}` : "";
        const modeName = describeMomentMode(b);
        const suffix = u.basis.length > 1 ? ` ${i + 1}` : "";
        params.push({
          id,
          label: `${u.groupLabel}${u.orbitTag} M${suffix} (${modeName})${tieTag}`,
          kind: "momentMode",
          value: amps[i]!,
          initialValue: amps[i]!,
          min: -12,
          max: 12,
          fixed: true, // shown but fixed on build; freed by the user like atomic rows
        });
      }
      const signedBasis: Vec3 = flipped ? [-b[0]!, -b[1]!, -b[2]!] : b;
      for (const m of u.group) {
        bindings.push({
          parameterId: id,
          kind: "momentMode",
          targetId: magId,
          targetKey: momentBindingKey({ siteLabel: m.label, orbitIndex: u.orbitIndex }),
          momentBasis: signedBasis,
        });
      }
    });

    for (const m of u.group) {
      moments.push({
        siteLabel: m.label,
        frame: "crystallographic",
        components: [...seed] as Vec3,
        formFactorId: `${m.element}${m.oxidationState ?? 2}`,
        ...(u.orbitIndex > 1 ? { position: u.orbitPos, orbitIndex: u.orbitIndex } : {}),
      });
      if (!activeSites.includes(m.label)) activeSites.push(m.label);
    }
  }

  return {
    // Carry the magnetic subgroup operations so the structure factor expands the
    // moments over the correct (θ-signed) symmetry — not the nuclear group.
    magnetic: { id: magId, structureId: structure.id, propagation: [k], moments, operations: subgroupOps },
    params,
    bindings,
    activeSites,
    magnitudeTies,
  };
}
