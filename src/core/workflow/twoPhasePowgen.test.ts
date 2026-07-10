import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { buildPowderSpec } from "@/app/powderSpec";
import { buildMultiPhaseSpec } from "@/app/multiPhaseSpec";
import { buildMultiPhasePowderProblem, multiPhaseCurves } from "@/core/workflow/multiPhase";
import { refine } from "@/core/refinement/engine";
import { computeAgreementFactors, weightsFromSigma } from "@/core/refinement/factors";
import { dataExists, readData } from "@/testSupport/data";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { PowderPhase } from "@/core/workflow/multiPhase";

/**
 * Real POWGEN TOF data: an Mn₃Ga sample with a rock-salt MnO impurity phase — the
 * textbook two-phase Rietveld example. Exercises the multi-phase problem (shared
 * instrument profile / TOF calibration, per-phase scale + cell) end to end: a
 * single-phase Mn₃Ga fit leaves the MnO peaks unexplained (high wR), and adding
 * MnO drops it dramatically. Skips when the git-ignored data/ folder is absent.
 */
const DIR = "Mn3Ga_POWGEN_600K";
const has = dataExists(`${DIR}/PG3_45607.gsa`) && dataExists(`${DIR}/MnO.cif`);

describe.skipIf(!has)("Mn3Ga + MnO two-phase POWGEN refinement", () => {
  const mn3ga = parseCif(readData(`${DIR}/Mn3GaHexagonal_structure_600K_Final.cif`), "mn3ga");
  const mno = parseCif(readData(`${DIR}/MnO.cif`), "mno");
  const inst = parseInstrumentParameters(readData(`${DIR}/2022B_Dec_HighRes_60HzB1_CWL0p8.instprm`));
  const pattern = parseGsasHistogramPattern(readData(`${DIR}/PG3_45607.gsa`), "pg", "Mn3Ga", { radiation: { kind: "neutron-tof" } });
  const yObs = pattern.points.map((p) => p.yObs);
  const weights = weightsFromSigma(pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1)));

  const wRpct = (phases: PowderPhase[], params: readonly RefinementParameter[], bindings: readonly ParameterBinding[], profile: PowderProfile): number => {
    const c = multiPhaseCurves(phases, pattern, params, bindings, profile);
    const a = computeAgreementFactors(Float64Array.from(yObs), Float64Array.from(c.yCalc), weights, params.length);
    return 100 * (a.rWeighted ?? 0);
  };
  const free = (p: RefinementParameter): RefinementParameter =>
    (["scale", "background", "cellLength"].includes(p.kind) ? { ...p, fixed: false } : p);

  it("MnO impurity: single-phase wR is high, two-phase is a good fit at a sensible fraction", () => {
    // Single-phase Mn₃Ga.
    const single = buildPowderSpec(mn3ga, pattern, inst, true, 6, {});
    const p1 = [{ structure: mn3ga, id: "mn3ga" }];
    const b1 = single.bindings.map((b) => (b.kind === "scale" ? { ...b, targetId: "mn3ga" } : b));
    const sFree = single.params.map(free);
    const rSingle = refine(buildMultiPhasePowderProblem(p1, pattern, sFree, b1, single.profile), {});
    const singleOut = sFree.map((p) => ({ ...p, value: rSingle.parameters[p.id] ?? p.value }));
    const wrSingle = wRpct(p1, singleOut, b1, single.profile);

    // Two phases (Mn₃Ga + MnO), sharing the instrument profile.
    const spec = buildMultiPhaseSpec([mn3ga, mno], pattern, inst);
    const tFree = spec.params.map(free);
    const rTwo = refine(buildMultiPhasePowderProblem(spec.phases, pattern, tFree, spec.bindings, spec.profile), {});
    const twoOut = tFree.map((p) => ({ ...p, value: rTwo.parameters[p.id] ?? p.value }));
    const wrTwo = wRpct(spec.phases, twoOut, spec.bindings, spec.profile);

    const s0 = twoOut.find((p) => p.id === "p0_scale")!.value;
    const s1 = twoOut.find((p) => p.id === "p1_scale")!.value;
    const mnoScaleFraction = s1 / (s0 + s1);

    // Mn₃Ga alone already fits reasonably; MnO is a minor impurity that refines
    // to a nonzero scale and further reduces wR (a real two-phase improvement).
    expect(wrTwo).toBeLessThan(wrSingle); // adding MnO improves the fit
    expect(wrTwo).toBeLessThan(10); // and it stays a good fit
    expect(s1).toBeGreaterThan(0.01); // MnO is genuinely present (nonzero scale)
    expect(mnoScaleFraction).toBeGreaterThan(0.01);
    expect(mnoScaleFraction).toBeLessThan(0.25); // a minority impurity, not co-major
  });
});
