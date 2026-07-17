/**
 * Magnetic PDF (mPDF) co-refinement workflow (PDF_MPDF_ROADMAP P4): one
 * residual holding the nuclear G(r) PLUS the unnormalized magnetic d_mag(r),
 * with the two contributions kept separable for display — the real-space
 * sibling of `workflow/magneticPowder.ts`.
 *
 *   G_total(r) = G_nuc(r) + (N_spins/N_atoms) · d_mag(r)·(barn→fm²) / ⟨b⟩²
 *
 * The magnetic term is the Frandsen unnormalized mPDF (magnetic/mpdf.ts): when
 * neutron total-scattering data are reduced as if all scattering were nuclear,
 * the magnetic signal rides along divided by the same N⟨b⟩² normalization —
 * f(r) is per SPIN, so the spin-per-atom ratio converts it to the nuclear
 * per-atom convention (Frandsen & Billinge 2015). `mpdfOrdScale` multiplies
 * the ordered component and `mpdfParaScale` the paramagnetic self-hump, both
 * affine, absorbing residual normalization conventions. X-ray patterns get no
 * magnetic term (no neutron dipole coupling).
 *
 * The spin field is the commensurate magnetic box (`expandSpinField`): k = 0
 * and k ≠ 0 both become an explicit periodic set of moments, so the same pair
 * kernel serves ferro-, ferri-, and antiferromagnets. Moments are driven by the
 * ordinary `momentMode` parameters (`applyMagneticMoments`), so the whole
 * magnetic-symmetry stack (k-search, subgroups, allowed-moment bases) plugs in
 * unchanged.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type {
  LinearRestraint,
  ParameterBinding,
  ParameterKind,
  RefinementParameter,
} from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import type { StageKinds } from "@/core/workflow/structureRefinement";
import type { FitRange } from "@/core/workflow/powder";
import type { PdfPair } from "@/core/pdf/pairEnumerator";
import type { MpdfSpin, SpinPair } from "@/core/magnetic/mpdf";
import { applyExclusionMask, fitRangeMask } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { enumeratePairs } from "@/core/pdf/pairEnumerator";
import { computeGofR, PAIR_REACH_MARGIN, type PdfModelParams } from "@/core/pdf/forwardModel";
import { bandLimit } from "@/core/pdf/termination";
import { compositionWeights } from "@/core/totalscattering/weights";
import { expandSpinField } from "@/core/crystal/cellExpansion";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { magneticTable } from "@/core/scattering/magnetic";
import {
  MPDF_GRID_EXTENSION,
  BARN_TO_FM2,
  averageMomentSq,
  computeNormalizedMpdf,
  computeUnnormalizedMpdf,
  enumerateSpinPairs,
  formFactorEnvelope,
  j0Profile,
} from "@/core/magnetic/mpdf";
import {
  PAIR_GEOMETRY_KINDS,
  PDF_DEFAULTS,
  PDF_STAGE_KINDS,
  buildPdfSpec,
  terminationPlanFor,
  windowFor,
  type PdfSiteTies,
  type PdfSpec,
} from "@/core/workflow/pdf";

/** Neutral mPDF parameter set when no mPDF kind is bound. */
const MPDF_DEFAULTS = { ordScale: 1, paraScale: 1, psigma: 0.1, corrLength: 0 } as const;

/** Kinds whose value moves the spin-field MOMENTS (not the pair geometry). */
const MOMENT_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "momentMode", "momentX", "momentY", "momentZ",
]);

/** The magnetic box + spin list + composition bookkeeping for one evaluation. */
interface SpinField {
  readonly spins: MpdfSpin[];
  readonly boxVolumeCells: number;
  readonly cell: StructureModel["cell"];
}

function buildSpinField(structure: StructureModel, magnetic: MagneticModel): SpinField {
  const box = expandSpinField(structure, magnetic);
  const spins: MpdfSpin[] = [];
  for (const atom of box.atoms) {
    if (!atom.moment) continue;
    // Crystal-axis (normalized â,b̂,ĉ) → Cartesian μ_B; the normalized axes of
    // an axis-diagonal supercell coincide with the parent's.
    const m = crystalComponentsToCartesian(box.cell, atom.moment);
    if (Math.hypot(m[0]!, m[1]!, m[2]!) < 1e-9) continue;
    spins.push({ position: atom.site.position, moment: m });
  }
  return { spins, boxVolumeCells: box.n[0] * box.n[1] * box.n[2], cell: box.cell };
}

/** Occupancy-weighted distinct ⟨j0⟩ ion ids of the model's moments. */
function ionIdsOf(magnetic: MagneticModel): string[] {
  const ids = new Set<string>();
  for (const m of magnetic.moments) {
    if (m.formFactorId && magneticTable.has(m.formFactorId)) ids.add(m.formFactorId);
  }
  return [...ids];
}

export function buildMpdfProblem(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  restraints: readonly LinearRestraint[] = [],
  fitRange?: FitRange,
): RefinementProblem {
  const rValues = pattern.points.map((p) => p.r);
  const gObs = pattern.points.map((p) => p.gObs);
  const observations = Float64Array.from([...gObs, ...restraints.map((r) => r.target)]);
  const uniform = new Float64Array(rValues.length).fill(1);
  const dataWeights = applyExclusionMask(uniform, fitRangeMask(rValues, fitRange));
  const weights = new Float64Array(observations.length);
  weights.set(dataWeights, 0);
  for (let i = 0; i < restraints.length; i++) {
    const sigma = Math.max(restraints[i]!.sigma, 1e-12);
    weights[rValues.length + i] = 1 / (sigma * sigma);
  }

  const { i0, i1 } = windowFor(rValues, fitRange);
  const rWindow = rValues.slice(i0, i1);
  const { modelGrid, sliceOffset, terminate, step: qstep, qmax } = terminationPlanFor(pattern, rWindow);
  const rMaxModel = modelGrid.length ? modelGrid[modelGrid.length - 1]! : 0;

  // Nuclear pair cache (identical to buildPdfProblem's).
  const geomIds = [...new Set(bindings.filter((b) => PAIR_GEOMETRY_KINDS.has(b.kind)).map((b) => b.parameterId))];
  let lastNucKey: string | null = null;
  let cachedNucPairs: PdfPair[] = [];

  // Magnetic caches: the spin-PAIR geometry follows the nuclear geometry key;
  // the spin FIELD additionally moves with the moment parameters. The magnetic
  // grid extends the model grid down to its 0-phase start (the para hump and
  // the ordered convolution need low-r support) and up by the mPDF margin.
  const magneticActive = pattern.scatteringType === "neutron" && magnetic.moments.length > 0;
  const momentIds = [...new Set(bindings.filter((b) => MOMENT_KINDS.has(b.kind)).map((b) => b.parameterId))];
  const step = modelGrid.length > 1 ? modelGrid[1]! - modelGrid[0]! : 0.01;
  const nDown = Math.max(0, Math.floor((modelGrid[0] ?? 0) / step + 1e-9));
  const nUp = Math.round(MPDF_GRID_EXTENSION / step);
  const rMag = new Float64Array(nDown + modelGrid.length + nUp);
  for (let k = 0; k < rMag.length; k++) rMag[k] = (modelGrid[0] ?? 0) + (k - nDown) * step;
  let lastFieldKey: string | null = null;
  let cachedField: SpinField | null = null;
  let lastSpinGeomKey: string | null = null;
  let cachedSpinPairs: SpinPair[] = [];
  let cachedEnvelope: ReturnType<typeof formFactorEnvelope> | null = null;

  const magneticComponent = (
    resolved: Readonly<Record<string, number>>,
    applied: ReturnType<typeof applyParameters>,
  ): Float64Array | null => {
    if (!magneticActive) return null;
    let geomKey = "";
    for (const id of geomIds) geomKey += `|${resolved[id]}`;
    let fieldKey = geomKey;
    for (const id of momentIds) fieldKey += `|${resolved[id]}`;
    if (fieldKey !== lastFieldKey) {
      const appliedMag = applyMagneticMoments(magnetic, bindings, resolved);
      cachedField = buildSpinField(applied.model, appliedMag);
      lastFieldKey = fieldKey;
    }
    const field = cachedField!;
    if (field.spins.length === 0) return null;
    if (geomKey !== lastSpinGeomKey) {
      cachedSpinPairs = enumerateSpinPairs(
        field.cell,
        field.spins.map((s) => s.position),
        rMag[rMag.length - 1]! + step / 2,
      );
      lastSpinGeomKey = geomKey;
    }
    cachedEnvelope ??= formFactorEnvelope(j0Profile(ionIdsOf(magnetic)), 5, step);

    const mpdfParams = applied.mpdf ?? MPDF_DEFAULTS;
    const f = computeNormalizedMpdf(field.cell, field.spins, rMag, {
      psigma: mpdfParams.psigma,
      qdamp: applied.pdf?.qdamp ?? PDF_DEFAULTS.qdamp,
      corrLength: mpdfParams.corrLength,
      ordScale: mpdfParams.ordScale,
    }, cachedSpinPairs);
    // f(r) carries ordScale; the para term is independent of f, so paraScale
    // passes through directly — d(r) is exactly affine in each scale.
    const d = computeUnnormalizedMpdf(rMag, f, cachedEnvelope, mpdfParams.paraScale, averageMomentSq(field.spins));
    const atoms = expandStructureAtoms(applied.model);
    const w = compositionWeights(atoms, "neutron");
    const nAtomsBox = w.nEff * field.boxVolumeCells;
    const scale = w.bAvg !== 0 && nAtomsBox > 0
      ? (field.spins.length / nAtomsBox) * (BARN_TO_FM2 / (w.bAvg * w.bAvg))
      : 0;
    const out = new Float64Array(modelGrid.length);
    for (let k = 0; k < out.length; k++) out[k] = scale * d[nDown + k]!;
    return out;
  };

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, bindings, resolved);
    const atoms = expandStructureAtoms(applied.model);
    let nucKey = "";
    for (const id of geomIds) nucKey += `|${resolved[id]}`;
    if (nucKey !== lastNucKey) {
      cachedNucPairs = enumeratePairs(applied.model.cell, atoms, rMaxModel + PAIR_REACH_MARGIN);
      lastNucKey = nucKey;
    }
    const params: PdfModelParams = { scatteringType: pattern.scatteringType, ...(applied.pdf ?? PDF_DEFAULTS) };
    const gModel = computeGofR(applied.model.cell, atoms, modelGrid, params, cachedNucPairs);
    const gMag = magneticComponent(resolved, applied);
    if (gMag) for (let k = 0; k < gModel.length; k++) gModel[k] = gModel[k]! + gMag[k]!;
    const gWindow = terminate
      ? bandLimit(gModel, modelGrid[0]!, qstep, qmax).subarray(sliceOffset, sliceOffset + rWindow.length)
      : gModel;
    const out = new Float64Array(rValues.length + restraints.length);
    out.set(gWindow.subarray(0, rWindow.length), i0);
    for (let i = 0; i < restraints.length; i++) {
      const restraint = restraints[i]!;
      let value = 0;
      for (const term of restraint.terms) value += term.coefficient * (resolved[term.parameterId] ?? 0);
      out[rValues.length + i] = value;
    }
    return out;
  };

  return { parameters, observations, weights, calculate };
}

/** Obs / nuclear / magnetic / total / difference G(r) curves for the current
 *  values — the separable display the magnetic powder page established. */
export interface MpdfComponents {
  readonly x: number[];
  readonly yObs: number[];
  readonly yNuclear: number[];
  readonly yMagnetic: number[];
  readonly yCalc: number[];
  readonly diff: number[];
}

export function mpdfComponents(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  fitRange?: FitRange,
): MpdfComponents {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const x = pattern.points.map((p) => p.r);
  const yObs = pattern.points.map((p) => p.gObs);
  const total = buildMpdfProblem(structure, magnetic, pattern, parameters, bindings, [], fitRange)
    .calculate(values);
  // The nuclear-only curve: the same problem with every moment zeroed.
  const zeroMagnetic: MagneticModel = {
    ...magnetic,
    moments: magnetic.moments.map((m) => ({ ...m, components: [0, 0, 0] as [number, number, number] })),
  };
  const momentFree = bindings.filter((b) => !MOMENT_KINDS.has(b.kind));
  const nuclear = buildMpdfProblem(structure, zeroMagnetic, pattern, parameters, momentFree, [], fitRange)
    .calculate(values);
  const yCalc = Array.from(total.subarray(0, x.length));
  const yNuclear = Array.from(nuclear.subarray(0, x.length));
  return {
    x,
    yObs,
    yNuclear,
    yMagnetic: yCalc.map((v, i) => v - yNuclear[i]!),
    yCalc,
    diff: yObs.map((o, i) => o - yCalc[i]!),
  };
}

/**
 * Full mPDF parameter set: the nuclear PDF spec plus the magnetic build's
 * moment-mode rows and the four mPDF rows bound to the pattern. Scales and
 * psigma/ξ start FIXED (ordScale is degenerate with the moment magnitude —
 * free one deliberately); moments keep the magnetic build's fixed state.
 */
export function buildMpdfSpec(
  structure: StructureModel,
  pattern: PdfPattern,
  magneticBuild: {
    readonly magnetic: MagneticModel;
    readonly params: RefinementParameter[];
    readonly bindings: ParameterBinding[];
  },
  ties: PdfSiteTies = {},
): PdfSpec & { magnetic: MagneticModel } {
  const nuclear = buildPdfSpec(structure, pattern, ties);
  const params: RefinementParameter[] = [...nuclear.params];
  const bindings: ParameterBinding[] = [...nuclear.bindings];
  const push = (p: RefinementParameter): void => {
    params.push(p);
    bindings.push({ parameterId: p.id, kind: p.kind, targetId: pattern.id });
  };
  push({ id: "mpdfOrdScale", label: "mPDF ordered scale", kind: "mpdfOrdScale", value: 1, initialValue: 1, min: 0, fixed: true });
  push({ id: "mpdfParaScale", label: "mPDF para scale", kind: "mpdfParaScale", value: 1, initialValue: 1, min: 0, fixed: true });
  push({ id: "mpdfPsigma", label: "mPDF peak σ (Å)", kind: "mpdfPsigma", value: 0.1, initialValue: 0.1, min: 0.01, max: 1, fixed: true });
  push({ id: "corrLength", label: "SRO length ξ (Å)", kind: "corrLength", value: 0, initialValue: 0, min: 0, fixed: true });
  params.push(...magneticBuild.params.map((p) => ({ ...p })));
  bindings.push(...magneticBuild.bindings);
  return { params, bindings, restraints: nuclear.restraints, magnetic: magneticBuild.magnetic };
}

/** Guided stage order for a magnetic PDF: the nuclear stages with the moments
 *  freed after the correlated-motion stage (they ride on well-placed nuclear
 *  peaks), then positions/occupancy last as usual. */
export const MPDF_STAGE_KINDS: readonly StageKinds[] = (() => {
  const stages = [...PDF_STAGE_KINDS];
  const at = stages.findIndex((s) => s.name === "positions");
  stages.splice(at < 0 ? stages.length : at, 0, { name: "moments", kinds: ["momentMode"] });
  return stages;
})();
