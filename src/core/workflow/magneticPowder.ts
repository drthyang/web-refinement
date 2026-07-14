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
import { createPeakBuilder, placePeaks, reflectionDRange } from "@/core/workflow/powder";
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
      const kVec = appliedMag.propagation[0] ?? [0, 0, 0];

      // Magnetic satellites at G ± k (single commensurate k), including the
      // pure (000)±k satellite and nuclear-extinct parents — see the shared
      // enumerator (core/magnetic/satellites) for the physics. |F_M|² evaluated
      // at the non-integer satellite indices carries the k-phase automatically;
      // parent nuclear multiplicity approximates the exact star-of-k satellite
      // multiplicity, and |F_M|² itself decides what is absent.
      unitMagIntensities = [];
      for (const s of magneticSatellites(applied.model.cell, applied.model.spaceGroup, kVec, dMin, dMax)) {
        const fm2 = magneticStructureFactor(applied.model, appliedMag, s.h, s.k, s.l).squared;
        const lp = lorentzPolarization(pattern.radiation, s.d);
        unitMagIntensities.push({ d: s.d, intensity: s.multiplicity * lp * fm2 });
      }
      lastKey = key;
    }
    const magIntensities = magScale === 1
      ? unitMagIntensities
      : unitMagIntensities.map((q) => ({ d: q.d, intensity: q.intensity * magScale }));
    const magneticPeaks = placePeaks(pattern, applied, magIntensities);
    return { nuclear, magnetic: magneticPeaks };
  };
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

  const combinedFor = createCombinedPeakBuilder(structure, magnetic, pattern, bindings);

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, bindings, resolved);
    const { nuclear, magnetic: magPeaks } = combinedFor(resolved);
    const opts: ProfileOptions = {
      shape: profile.shape,
      ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
      ...(applied.background.length ? { background: applied.background } : {}),
    };
    return synthesizePattern(xValues, [...nuclear, ...magPeaks], opts);
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
): MagneticPowderComponents {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const xValues = pattern.points.map((p) => p.x);
  const applied = applyParameters(structure, bindings, resolved);
  const { nuclear, magnetic: magPeaks } = buildCombinedPeaks(structure, magnetic, pattern, resolved, bindings);
  const bkgOpts: ProfileOptions = { shape: profile.shape, ...(applied.background.length ? { background: applied.background } : {}) };
  const yNuclear = Array.from(synthesizePattern(xValues, nuclear, bkgOpts));
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
