import { test } from "vitest";
import { readData } from "@/testSupport/data";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parsePowderData } from "@/parsers/powderData";
import { buildPowderSpec, guidedPowderParams } from "@/app/powderSpec";
import { buildPowderProblem } from "@/core/workflow/powder";
import { refineStaged } from "@/core/refinement/staged";
import { stagesFromKindGroups, DEFAULT_STAGE_KINDS } from "@/core/workflow/structureRefinement";

test("dbg staged guards on GaNb4Se8", { timeout: 300000 }, () => {
  const DIR = "GaNb4Se8_XRD";
  const structure = parseCif(readData(`${DIR}/GaNb4Se8_100K.cif`), "g");
  const inst = parseInstrumentParameters(readData(`${DIR}/xrd_instrum.instprm`));
  const pattern = parsePowderData(readData(`${DIR}/GaNb4Se8_799_T_298.8K_gsas.dat`), { id: "p", name: "d", xUnit: "twoTheta", radiation: { kind: "xray", wavelength: 0.4128 }, wavelength: 0.4128 });
  const spec = buildPowderSpec(structure, pattern, inst, true, 10, {});
  const params = guidedPowderParams(spec.params);
  const out = refineStaged(params, (ps) => buildPowderProblem(structure, pattern, ps, spec.bindings, spec.profile), stagesFromKindGroups(DEFAULT_STAGE_KINDS), { maxIterations: 15 });
  for (const st of out.stages) {
    const wr = st.result.agreement.rWeighted;
    console.log(`${st.name}: wR=${wr !== undefined ? (100 * wr).toFixed(2) + "%" : "—"} free=${st.freeIds.length}${st.rejected ? " REJECTED: " + st.rejected.reason : ""}`);
  }
});
