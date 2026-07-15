/**
 * Magnetic powder refinement (Phase 7): combine nuclear and magnetic Bragg
 * intensities into a single powder profile, keeping the two components
 * separable, and refine moments + scales against an observed pattern.
 *
 * Nuclear and magnetic peaks share the same CW/TOF placement (via powder.ts
 * `buildPeaks`/`placePeaks`) and one shared (GSAS-II) scale. Magnetic peaks are
 * satellites at G±k for a single commensurate k.
 *
 * Documented approximations: the magnetic intensity uses the perpendicular
 * projection for the representative reflection of each family (no full cone
 * average over symmetry-equivalent Q directions), and satellite multiplicity is
 * approximated by the parent nuclear multiplicity.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import type { ProfilePeak, ProfileOptions, PeakShape } from "@/core/diffraction/profile";
import { weightsFromSigma, applyExclusionMask, fitRangeMask } from "@/core/refinement/factors";
import type { FitRange } from "@/core/workflow/powder";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { phaseBindingsFor, type PowderPhase } from "@/core/workflow/multiPhase";
import { buildPeaks, createPeakBuilder, placePeaks, reflectionDRange } from "@/core/workflow/powder";
import { magneticSatellites } from "@/core/magnetic/satellites";
import { lorentzPolarization } from "@/core/diffraction/intensity";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { synthesizePattern } from "@/core/diffraction/profile";

export interface MagneticPowderComponents {
  readonly x: number[];
  readonly yObs: number[];
  readonly yNuclear: number[];
  readonly yMagnetic: number[];
  readonly yCalc: number[];
  readonly diff: number[];
}

interface Peaks {
  readonly nuclear: ProfilePeak[];
  readonly magnetic: ProfilePeak[];
}

/** Parameter kinds that change the magnetic satellite intensity list (moments
 *  and everything the nuclear geometry set contains — cell, positions, ADPs
 *  via the Debye–Waller factor, occupancies). The shared scale and the
 *  magneticScale ratio are hoisted out as pure multipliers. */
const MAGNETIC_GEOMETRY_KINDS = new Set<ParameterKind>([
  "cellLength", "cellAngle", "positionShift", "uAniso", "bIso", "occupancy", "poRatio",
  "momentMode", "momentX", "momentY", "momentZ",
]);

/** Binding kinds that drive the magnetic component. They always belong to the
 *  magnetic (primary) phase but target the derived `<structure.id>-mag` model
 *  id, so routing by `targetId` alone would drop them. */
const MAGNETIC_BINDING_KINDS = new Set<ParameterKind>([
  "momentMode", "momentX", "momentY", "momentZ", "magneticScale",
]);

/**
 * The bindings that act on the magnetic (primary) phase of a multi-phase
 * refinement: its own nuclear bindings plus the shared instrument rows (as
 * `phaseBindingsFor` routes them) plus every magnetic binding. Applying the
 * full multi-phase set unrouted would cross-apply the other phases' cells,
 * scale, and same-labelled atoms onto the primary — an impurity phase's cell
 * silently hijacking the magnetic model's indexing.
 */
export function magneticPhaseBindings(
  bindings: readonly ParameterBinding[],
  phaseId: string,
): ParameterBinding[] {
  const keep = new Set<ParameterBinding>(phaseBindingsFor(bindings, phaseId));
  return bindings.filter((b) => keep.has(b) || MAGNETIC_BINDING_KINDS.has(b.kind));
}

/**
 * Combined nuclear + magnetic peak builder with single-entry geometry caches
 * (see createPeakBuilder in workflow/powder.ts). The nuclear |F|² list is
 * reused whenever no nuclear-geometry parameter moved — including across every
 * MOMENT derivative column — and the magnetic |F_M⊥|² satellite list is reused
 * across every profile/scale/background/zero column. Exact by construction:
 * both lists cache at unit scale and multiply the current (shared × magnetic)
 * scale on retrieval, with the source multiplication ordered to match.
 */
function createCombinedPeakBuilder(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  bindings: readonly ParameterBinding[],
): (values: Readonly<Record<string, number>>) => Peaks {
  const nuclearFor = createPeakBuilder(pattern, bindings, true);
  const magGeomIds = [...new Set(bindings.filter((b) => MAGNETIC_GEOMETRY_KINDS.has(b.kind)).map((b) => b.parameterId))];
  const magScaleBinding = bindings.find((b) => b.kind === "magneticScale");
  let lastKey: string | null = null;
  let unitMagIntensities: { d: number; intensity: number }[] = [];

  return (values) => {
    const applied = applyParameters(structure, bindings, values);

    // Nuclear peaks: reuse the full CW/TOF placement (Caglioti/TCH/FCJ 2θ width
    // or the TOF back-to-back-exponential shape), so magnetic data of either
    // kind fits.
    const nuclear = nuclearFor(applied, values);

    // Shared (GSAS-II) scale: the nuclear histogram scale multiplies the
    // magnetic intensity too. An optional `magneticScale` binding is a
    // dimensionless ratio on top (default 1 = fully shared). No explicit
    // V_mag/V_nuc factor is needed: the propagation-vector (k) formalism keeps
    // moments on the nuclear cell.
    const magFactor = magScaleBinding ? values[magScaleBinding.parameterId] ?? 1 : 1;
    const magScale = applied.scale * magFactor;

    const { dMin, dMax } = reflectionDRange(pattern, applied);
    let key = `${dMin}|${dMax}`;
    for (const id of magGeomIds) key += `|${values[id]}`;
    if (key !== lastKey) {
      const appliedMag = applyMagneticMoments(magnetic, bindings, values);
      unitMagIntensities = unitMagneticIntensities(applied, appliedMag, pattern);
      lastKey = key;
    }
    const magIntensities = magScale === 1
      ? unitMagIntensities
      : unitMagIntensities.map((q) => ({ d: q.d, intensity: q.intensity * magScale }));
    const magneticPeaks = placePeaks(pattern, applied, magIntensities);
    return { nuclear, magnetic: magneticPeaks };
  };
}

/**
 * Unit-scale magnetic satellite intensities at G ± k (single commensurate k),
 * including the pure (000)±k satellite and nuclear-extinct parents — see the
 * shared enumerator (core/magnetic/satellites) for the physics. |F_M|²
 * evaluated at the non-integer satellite indices carries the k-phase
 * automatically; parent nuclear multiplicity approximates the exact star-of-k
 * satellite multiplicity, and |F_M|² itself decides what is absent.
 */
function unitMagneticIntensities(
  applied: ReturnType<typeof applyParameters>,
  appliedMag: MagneticModel,
  pattern: PowderPattern,
): { d: number; intensity: number }[] {
  const kVec = appliedMag.propagation[0] ?? [0, 0, 0];
  const { dMin, dMax } = reflectionDRange(pattern, applied);
  const out: { d: number; intensity: number }[] = [];
  for (const s of magneticSatellites(applied.model.cell, applied.model.spaceGroup, kVec, dMin, dMax)) {
    const fm2 = magneticStructureFactor(applied.model, appliedMag, s.h, s.k, s.l).squared;
    const lp = lorentzPolarization(pattern.radiation, s.d);
    out.push({ d: s.d, intensity: s.multiplicity * lp * fm2 });
  }
  return out;
}

/**
 * Just the magnetic satellite component of the pattern (no background, no
 * nuclear synthesis) — for display paths that overlay it on separately
 * computed nuclear curves (e.g. the multi-phase plot), where the full
 * `magneticPowderComponents` would redo all the nuclear work. `extraPhases`
 * only decides binding routing: with impurity phases present, the primary must
 * see only its own + shared + magnetic bindings.
 */
export function magneticComponentCurve(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: { shape: PeakShape; eta?: number } = { shape: "gaussian" },
  extraPhases: readonly PowderPhase[] = [],
): number[] {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const primaryBindings = extraPhases.length > 0 ? magneticPhaseBindings(bindings, structure.id) : bindings;
  const applied = applyParameters(structure, primaryBindings, resolved);
  const appliedMag = applyMagneticMoments(magnetic, primaryBindings, resolved);
  const magScaleBinding = primaryBindings.find((b) => b.kind === "magneticScale");
  const magFactor = magScaleBinding ? resolved[magScaleBinding.parameterId] ?? 1 : 1;
  const magScale = applied.scale * magFactor;
  const intensities = unitMagneticIntensities(applied, appliedMag, pattern)
    .map((q) => ({ d: q.d, intensity: q.intensity * magScale }));
  const peaks = placePeaks(pattern, applied, intensities);
  const xValues = pattern.points.map((p) => p.x);
  return Array.from(synthesizePattern(xValues, peaks, {
    shape: profile.shape,
    ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
  }));
}

function buildCombinedPeaks(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  values: Readonly<Record<string, number>>,
  bindings: readonly ParameterBinding[],
): Peaks {
  return createCombinedPeakBuilder(structure, magnetic, pattern, bindings)(values);
}

export function buildMagneticPowderProblem(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: { shape: PeakShape; eta?: number } = { shape: "gaussian" },
  fitRange?: FitRange,
  extraPhases: readonly PowderPhase[] = [],
): RefinementProblem {
  const xValues = pattern.points.map((p) => p.x);
  const observations = Float64Array.from(pattern.points.map((p) => p.yObs));
  // A fit range zeroes the weight of every point outside it, so the nuclear +
  // magnetic co-refinement optimizes only the selected window (same masking as
  // the single-phase nuclear problem).
  const weights = applyExclusionMask(
    weightsFromSigma(pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1))),
    fitRangeMask(xValues, fitRange),
  );

  // Multi-phase: the magnetic (primary) phase sees only its own + shared +
  // magnetic bindings, and each extra phase contributes its nuclear peaks
  // through its own routed bindings — same per-phase caching as
  // buildMultiPhasePowderProblem, so an impurity phase's parameters can never
  // cross-apply onto the magnetic phase's model.
  const primaryBindings = extraPhases.length > 0 ? magneticPhaseBindings(bindings, structure.id) : bindings;
  const combinedFor = createCombinedPeakBuilder(structure, magnetic, pattern, primaryBindings);
  const extraBuilders = extraPhases.map((phase) => {
    const phaseBindings = phaseBindingsFor(bindings, phase.id);
    return { phase, phaseBindings, peaksFor: createPeakBuilder(pattern, phaseBindings, true) };
  });

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, primaryBindings, resolved);
    const { nuclear, magnetic: magPeaks } = combinedFor(resolved);
    const allPeaks: ProfilePeak[] = [...nuclear, ...magPeaks];
    for (const b of extraBuilders) {
      const appliedExtra = applyParameters(b.phase.structure, b.phaseBindings, resolved);
      allPeaks.push(...b.peaksFor(appliedExtra, resolved));
    }
    const opts: ProfileOptions = {
      shape: profile.shape,
      ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
      ...(applied.background.length ? { background: applied.background } : {}),
    };
    return synthesizePattern(xValues, allPeaks, opts);
  };
  return { parameters, observations, weights, calculate };
}

/** Observed / nuclear / magnetic / total / difference curves for the current model. */
export function magneticPowderComponents(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: { shape: PeakShape; eta?: number } = { shape: "gaussian" },
  extraPhases: readonly PowderPhase[] = [],
): MagneticPowderComponents {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const xValues = pattern.points.map((p) => p.x);
  const primaryBindings = extraPhases.length > 0 ? magneticPhaseBindings(bindings, structure.id) : bindings;
  const applied = applyParameters(structure, primaryBindings, resolved);
  const { nuclear, magnetic: magPeaks } = buildCombinedPeaks(structure, magnetic, pattern, resolved, primaryBindings);
  const nuclearPeaks: ProfilePeak[] = [...nuclear];
  for (const phase of extraPhases) {
    const appliedExtra = applyParameters(phase.structure, phaseBindingsFor(bindings, phase.id), resolved);
    nuclearPeaks.push(...buildPeaks(pattern, appliedExtra));
  }
  const bkgOpts: ProfileOptions = { shape: profile.shape, ...(applied.background.length ? { background: applied.background } : {}) };
  const yNuclear = Array.from(synthesizePattern(xValues, nuclearPeaks, bkgOpts));
  const yMagnetic = Array.from(synthesizePattern(xValues, magPeaks, { shape: profile.shape }));
  const yObs = pattern.points.map((p) => p.yObs);
  const yCalc = yNuclear.map((n, i) => n + (yMagnetic[i] ?? 0));
  return {
    x: [...xValues],
    yObs,
    yNuclear,
    yMagnetic,
    yCalc,
    diff: yObs.map((o, i) => o - (yCalc[i] ?? 0)),
  };
}
