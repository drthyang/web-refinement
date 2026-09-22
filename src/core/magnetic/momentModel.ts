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
 * Note (moment magnitude): components are in the crystal-axis convention (µ_B),
 * and `components` is the FULL physical moment — verified by the supercell
 * consistency gate (supercellConsistency.test.ts: the parent-cell k-formalism
 * and the explicit supercell agree per-reflection up to the pure N²
 * normalization). Two historical factor-of-2 traps at self-conjugate k
 * (2k ∈ ℤ³) are fixed and pinned by tests: the satellite enumerator counted
 * every ±k node twice (satellites.test.ts), and the Fourier-side momentInCell
 * folded in a −k arm that does not exist there (fourierMoment.test.ts).
 * Remaining caveat: k ≠ 0 magnitudes have no EXTERNAL golden yet — the GSAS-II
 * per-reflection cross-check (mn3ga350KGolden) is a k = 0 structure; the
 * FullProf external golden is gate 8 of docs/INCOMMENSURATE_PLAN.md.
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
import { allowedMomentDirections, allowedFourierModes, quadratureOf, type FourierMode } from "@/core/magnetic/allowedMoments";
import { magneticOrbitRepresentatives } from "@/core/crystal/cellExpansion";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { classifyPropagation, type PropagationClass } from "@/core/magnetic/propagation";
import { centringTranslations } from "@/core/crystal/symmetry";

export interface MagneticModelBuild {
  readonly magnetic: MagneticModel;
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  /** Site labels that are magnetic under this group (dimension > 0). */
  readonly activeSites: string[];
  /** How k was classified (arms, commensurability, supercell). */
  readonly propagation: PropagationClass;
  /**
   * True when k has two distinct arms (−k ≢ k): every mode then carries a
   * cosine amplitude AND a sine (quadrature) amplitude — complex Fourier
   * coefficients, the representation helices/cycloids/elliptical modulations
   * need. False for k = 0 and ½-type k, where the sine part is unobservable
   * and the parameter set is the classic real one.
   */
  readonly fourier: boolean;
  /**
   * The quadrature parameter held FIXED as the global modulation phase gauge
   * (two-arm k only). Shifting the phase of every Fourier coefficient by the
   * same angle moves the modulation's origin — unobservable in any intensity
   * — so exactly one quadrature amplitude must stay fixed; freeing it makes
   * that direction singular. Relative phases between sublattices ARE
   * observable and stay free.
   */
  readonly phaseGauge?: { readonly parameterId: string };
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
  readonly members: readonly {
    readonly key: string;
    readonly label: string;
    readonly flipped: boolean;
    /** How the size is tied: shared amplitude parameters (same mode geometry),
     *  or a derived amplitude "= ±hypot(reference amplitudes)" (a single-mode
     *  sublattice against a multi-mode reference). */
    readonly via: "shared" | "magnitude";
  }[];
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

const ZERO3: Vec3 = [0, 0, 0];
const isZero3 = (v: Vec3): boolean => v[0] === 0 && v[1] === 0 && v[2] === 0;

/** Cartesian dot product of two (cos, sin) mode pairs: Σ over both parts. */
function pairDot(cell: UnitCell, a: FourierMode, b: FourierMode): number {
  return cartDot(cell, a.cos, b.cos) + cartDot(cell, a.sin, b.sin);
}

/** Scale a mode pair to unit Cartesian (µ_B) length, √(|cos|² + |sin|²). For a
 *  pure-cosine mode this is exactly the historical unit-mode scaling. */
function unitMode(cell: UnitCell, m: FourierMode): FourierMode {
  const n = Math.sqrt(pairDot(cell, m, m));
  if (n <= 1e-12) return m;
  return {
    cos: [m.cos[0]! / n, m.cos[1]! / n, m.cos[2]! / n],
    sin: isZero3(m.sin) ? m.sin : [m.sin[0]! / n, m.sin[1]! / n, m.sin[2]! / n],
  };
}

/**
 * Whether two mode sets have the same geometry (equal signed Gram matrices in
 * the Cartesian µ_B metric). Sharing amplitude coefficients across two
 * sublattices preserves |M| for ANY amplitudes exactly when this holds — the
 * modes are unit length, so for a single mode it always does, and multi-mode
 * sets must agree pairwise (including relative signs; a conservative check —
 * bases that differ only by mode order/sign fail it and simply stay untied).
 */
function sameModeGeometry(cell: UnitCell, a: readonly FourierMode[], b: readonly FourierMode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      if (Math.abs(pairDot(cell, a[i]!, a[j]!) - pairDot(cell, b[i]!, b[j]!)) > 1e-6) return false;
    }
  }
  return true;
}

/**
 * Gram–Schmidt in the Cartesian µ_B metric: the same allowed-moment space
 * spanned by orthonormal modes (the first keeps its direction), so the
 * Euclidean norm of the amplitudes IS the moment size — what a derived
 * "= hypot(…)" |M| tie needs. Cosine parts only (self-conjugate k).
 */
function orthonormalModes(cell: UnitCell, modes: readonly FourierMode[]): FourierMode[] {
  const out: FourierMode[] = [];
  for (const m of modes) {
    let v: Vec3 = [m.cos[0]!, m.cos[1]!, m.cos[2]!];
    for (const e of out) {
      const d = cartDot(cell, v, e.cos);
      v = [v[0]! - d * e.cos[0]!, v[1]! - d * e.cos[1]!, v[2]! - d * e.cos[2]!];
    }
    const n = Math.sqrt(cartDot(cell, v, v));
    if (n < 1e-9) continue; // linearly dependent — cannot happen for a basis
    out.push({ cos: [v[0]! / n, v[1]! / n, v[2]! / n], sin: ZERO3 });
  }
  return out;
}

/** Label a (cos, sin) mode: "Mx" for a pure direction, "Mx + i·My" for a
 *  symmetry-forced helical/elliptical coupling. */
function describeFourierMode(m: FourierMode): string {
  if (isZero3(m.sin)) return describeMomentMode(m.cos);
  if (isZero3(m.cos)) return `i·${describeMomentMode(m.sin)}`;
  return `${describeMomentMode(m.cos)} + i·${describeMomentMode(m.sin)}`;
}

const negate = (v: Vec3): Vec3 => [-v[0]!, -v[1]!, -v[2]!];

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
     * every sublattice keeps its own symmetry-allowed direction(s). The
     * reference is the sublattice with the most allowed modes; a sublattice
     * with the same mode geometry shares its amplitude parameters through its
     * OWN basis, and a sublattice with a single allowed mode gets a DERIVED
     * amplitude "= ±hypot(reference amplitudes)" (the reference's modes made
     * orthonormal, so hypot is |M|). Scope "element" (or `true`) ties within
     * each element (|M(Mn1)| = |M(Mn2)|); "all" ties every selected magnetic
     * sublattice regardless of element (the high-entropy case). Two
     * multi-mode sublattices of different geometry cannot be tied and are
     * reported in `magnitudeTies[].skipped`.
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
  // Two distinct arms ±k ⇒ complex coefficients: every mode gets a cosine and
  // a sine (quadrature) amplitude; one quadrature amplitude is the phase gauge.
  // "Distinct" is judged against the parent's true reciprocal lattice: in a
  // C-centred cell k = (½,0,0) has two arms (2k = (1,0,0) is not a C node).
  const propagation = classifyPropagation(k, { centrings: centringTranslations(structure.spaceGroup.operations) });
  const fourier = propagation.twoArms;
  let phaseGauge: { parameterId: string } | undefined;

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
    /** Unit-length (cos, sin) mode pairs; sin ≡ 0 for a self-conjugate k. */
    readonly basis: FourierMode[];
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
      // Self-conjugate k: the classic real allowed-direction basis (the sine
      // part is unobservable). Two arms: the complex (cos, sin) mode pairs.
      const raw: FourierMode[] = fourier
        ? allowedFourierModes(subgroupOps, orbitPos, k).modes
        : allowedMomentDirections(subgroupOps, orbitPos, k).basis.map((b) => ({ cos: b, sin: ZERO3 }));
      if (raw.length === 0) return; // moment forbidden by symmetry here
      // Unit-µ_B modes: 1 unit of amplitude = 1 µ_B along the mode, so seeds
      // and refined amplitudes compare honestly across orbits and cells.
      const basis = raw.map((b) => unitMode(structure.cell, b));
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
  // for the "all" scope). Within a cluster the reference is the sublattice
  // with the MOST allowed modes (first among equals), and every other unit is
  // tied to it one of two ways:
  //   · same mode geometry → it SHARES the reference's amplitude parameters,
  //     each applied through its own basis (same |M| for any amplitudes);
  //   · a single allowed mode against a multi-mode reference → its one
  //     amplitude becomes a DERIVED parameter, "= ±hypot(reference amplitudes)",
  //     with the reference's modes orthonormalized so that hypot IS |M|.
  // Two multi-mode sublattices of different geometry stay independent and are
  // reported: equal |M| there would need direction angles, which the linear
  // mode model does not have.
  const tiedTo = new Map<string, Unit>(); // unit key → reference (shared amplitudes)
  const normTiedTo = new Map<string, Unit>(); // unit key → reference (derived |M|)
  const orthonormal = new Set<string>(); // reference keys that must use an orthonormal basis
  if (tieScope) {
    const byElement = new Map<string, Unit[]>();
    for (const u of units) {
      const el = tieScope === "all" ? "all sites" : u.rep.element;
      byElement.set(el, [...(byElement.get(el) ?? []), u]);
    }
    for (const [element, cluster] of byElement) {
      if (cluster.length < 2) continue;
      const reference = cluster.reduce((best, u) => (u.basis.length > best.basis.length ? u : best), cluster[0]!);
      const members: { key: string; label: string; flipped: boolean; via: "shared" | "magnitude" }[] = [];
      const skipped: { label: string; reason: string }[] = [];
      for (const u of cluster) {
        if (u === reference) continue;
        if (sameModeGeometry(structure.cell, reference.basis, u.basis)) {
          tiedTo.set(u.key, reference);
          members.push({ key: u.key, label: u.displayLabel, flipped: flippedUnits.has(u.key), via: "shared" });
        } else if (!fourier && u.basis.length === 1) {
          normTiedTo.set(u.key, reference);
          orthonormal.add(reference.key);
          members.push({ key: u.key, label: u.displayLabel, flipped: flippedUnits.has(u.key), via: "magnitude" });
        } else {
          skipped.push({
            label: u.displayLabel,
            reason: fourier
              ? "two-arm k: complex Fourier amplitudes have no single size to tie"
              : "several allowed modes with a different geometry from the reference — equal |M| would need direction angles",
          });
        }
      }
      if (members.length > 0 || skipped.length > 0) {
        magnitudeTies.push({ element, reference: reference.displayLabel, members, skipped });
      }
    }
  }
  const basisOf = (u: Unit): FourierMode[] => (orthonormal.has(u.key) ? orthonormalModes(structure.cell, u.basis) : u.basis);
  const paramId = (owner: Unit, i: number): string => `mom_${owner.rep.label}_${owner.orbitId}${i}`;

  // Phase 3 — emit parameters, bindings, and moment entries.
  for (const u of units) {
    const reference = tiedTo.get(u.key);
    const normRef = normTiedTo.get(u.key);
    const paramOwner = reference ?? u;
    const flipped = flippedUnits.has(u.key) && (reference !== undefined || normRef !== undefined);
    // A shared tie flips by negating this unit's basis (one amplitude, the
    // opposite sense); a derived |M| tie flips through the sign of the derived
    // amplitude, so the basis stays as the symmetry gives it.
    const sign = reference !== undefined && flipped ? -1 : 1;
    const valueSign = normRef !== undefined && flipped ? -1 : 1;
    const basis = basisOf(u);

    // Per-mode amplitudes: the first allowed mode at moment0, the rest at 0
    // (quadrature amplitudes always seed at 0: a pure cosine modulation).
    const amps = basis.map((_, i) => (i === 0 ? valueSign * moment0 : 0));
    const seed: [number, number, number] = [0, 0, 0];
    const seedSin: [number, number, number] = [0, 0, 0];
    basis.forEach((b, i) => {
      const a = amps[i]! * sign;
      seed[0] += a * b.cos[0]!;
      seed[1] += a * b.cos[1]!;
      seed[2] += a * b.cos[2]!;
      seedSin[0] += a * b.sin[0]!;
      seedSin[1] += a * b.sin[1]!;
      seedSin[2] += a * b.sin[2]!;
    });

    // Emit one parameter (+ its bindings onto every group member) for a mode
    // pair: the cosine-part basis drives `components`, the sine-part basis
    // drives `sinComponents`. Self-conjugate k never has a sine part, so its
    // bindings are exactly the historical single-basis ones.
    const emitMode = (id: string, label: string, value: number, mode: FourierMode, own: boolean, fixed: boolean, expression?: string): void => {
      if (own) {
        params.push({ id, label, kind: "momentMode", value, initialValue: value, min: -12, max: 12, fixed, ...(expression ? { expression } : {}) });
      }
      const cosBasis = sign < 0 ? negate(mode.cos) : mode.cos;
      const sinBasis = sign < 0 ? negate(mode.sin) : mode.sin;
      for (const m of u.group) {
        const targetKey = momentBindingKey({ siteLabel: m.label, orbitIndex: u.orbitIndex });
        if (!isZero3(cosBasis) || isZero3(sinBasis)) {
          bindings.push({
            parameterId: id, kind: "momentMode", targetId: magId, targetKey,
            momentBasis: cosBasis,
            ...(fourier ? { momentPart: "cos" as const } : {}),
          });
        }
        if (!isZero3(sinBasis)) {
          bindings.push({
            parameterId: id, kind: "momentMode", targetId: magId, targetKey,
            momentBasis: sinBasis, momentPart: "sin",
          });
        }
      }
    };

    basis.forEach((b, i) => {
      const id = paramId(paramOwner, i);
      // The reference (or an untied unit) owns the parameter row; shared-tied
      // units only add bindings onto it, each through its OWN (possibly
      // negated) basis — one shared amplitude, per-sublattice direction.
      const own = reference === undefined;
      const tie = own ? magnitudeTies.find((t) => t.reference === u.displayLabel && t.members.length > 0) : undefined;
      const tieTag = tie ? ` =|M| ${tie.members.map((m) => m.label).join(", ")}` : "";
      const modeName = describeFourierMode(b);
      const suffix = basis.length > 1 ? ` ${i + 1}` : "";
      const head = `${u.groupLabel}${u.orbitTag} M${suffix}`;
      if (!fourier) {
        if (normRef) {
          // Derived |M| tie: this unit's single amplitude equals ±|M| of the
          // reference — hypot over the reference's (orthonormal) amplitudes.
          const refIds = basisOf(normRef).map((_, j) => paramId(normRef, j));
          const expression = `= ${valueSign < 0 ? "-" : ""}hypot(${refIds.join(",")})`;
          emitMode(id, `${head} (${modeName}) = ${valueSign < 0 ? "−" : ""}|M(${normRef.displayLabel})|`, amps[i]!, b, true, true, expression);
          return;
        }
        emitMode(id, `${head} (${modeName})${tieTag}`, amps[i]!, b, own, true);
        return;
      }
      // Two-arm k: cosine amplitude + sine (quadrature) amplitude per mode. A
      // symmetry-forced helical mode (nonzero sin part) is labelled amp/quad
      // rather than cos/sin, since neither parameter is a pure cosine.
      const forced = !isZero3(b.sin);
      const cosTag = forced ? "amp" : "cos";
      const sinTag = forced ? "quad" : "sin";
      emitMode(id, `${head} ${cosTag} (${modeName})${tieTag}`, amps[i]!, b, own, true);
      const qid = `${id}q`;
      // The first quadrature amplitude of the whole model is the modulation
      // phase gauge: unobservable, held fixed, flagged in the label.
      const isGauge = own && phaseGauge === undefined;
      if (isGauge) phaseGauge = { parameterId: qid };
      const gaugeTag = isGauge ? " [phase gauge]" : "";
      emitMode(qid, `${head} ${sinTag} (${modeName})${gaugeTag}`, 0, quadratureOf(b), own, true);
    });

    for (const m of u.group) {
      moments.push({
        siteLabel: m.label,
        frame: "crystallographic",
        components: [...seed] as Vec3,
        ...(fourier ? { sinComponents: [...seedSin] as Vec3 } : {}),
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
    propagation,
    fourier,
    ...(phaseGauge ? { phaseGauge } : {}),
  };
}
