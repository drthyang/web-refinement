import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parse_structure,
  parse_instrument,
  parse_powder_data,
  build_refinement,
  refine_powder,
  assess_refinement,
  suggest_next_steps,
  interpret_structure,
} from "@/mcp/tools";

const DATA = resolve(__dirname, "../../data/GaNb4Se8_XRD");
const read = (f: string): string => readFileSync(resolve(DATA, f), "utf8");

/**
 * The MCP tool handlers, exercised as the full expert loop an agent would run —
 * on the real GaNb4Se8 XRD regression dataset. The transport is covered
 * separately by scripts; here we lock in the handler contract under `npm test`.
 */
describe("MCP tool handlers — the agent expert loop", () => {
  it("parse_structure reads a CIF into a structure", () => {
    const { structure } = parse_structure({ cif: read("GaNb4Se8_100K.cif") });
    expect(structure.sites.length).toBeGreaterThan(0);
    expect(structure.spaceGroup.operations.length).toBeGreaterThan(0);
  });

  it("runs parse → build → refine → assess → suggest and produces an expert judgment", () => {
    const { structure } = parse_structure({ cif: read("GaNb4Se8_100K.cif") });
    const instrument = parse_instrument({ text: read("xrd_instrum.instprm") });
    const { pattern } = parse_powder_data({ text: read("GaNb4Se8_799_T_298.8K_gsas.dat"), filename: "GaNb4Se8.dat" });

    const built = build_refinement({ structure, pattern, instrument });
    expect(built.parameters.length).toBeGreaterThan(0);

    const refined = refine_powder({ structure, pattern, parameters: built.parameters, bindings: built.bindings, profile: built.profile, instrument });
    expect(["converged", "maxIterations", "stalled"]).toContain(refined.result.status);
    expect(refined.observationCount).toBeGreaterThan(0);
    expect(refined.residual.d.length).toBe(refined.residual.yObs.length);

    const refinedParams = built.parameters.map((p) => ({ ...p, value: refined.result.parameters[p.id] ?? p.value }));
    const assessment = assess_refinement({ result: refined.result, parameters: refinedParams, observationCount: refined.observationCount, residual: refined.residual });
    expect(assessment.verdict.band).toBeDefined();
    expect(typeof assessment.summary).toBe("string");

    const steps = suggest_next_steps({ assessment });
    expect(Array.isArray(steps)).toBe(true);
    // A poor/at-bound fit always yields at least one concrete next action.
    if (assessment.findings.length > 0) expect(steps.length).toBeGreaterThan(0);
  });

  it("interpret_structure returns a materials reading", () => {
    const { structure } = parse_structure({ cif: read("GaNb4Se8_100K.cif") });
    const interp = interpret_structure({ structure });
    expect(typeof interp.summary).toBe("string");
    expect(Array.isArray(interp.findings)).toBe(true);
  });

  it("parse_powder_data rejects single-crystal reflection lists with a clear error", () => {
    const hkl = "   1   0   0   100.0   2.0\n   1   1   0   250.0   3.0\n   2   0   0   80.0   2.5\n";
    expect(() => parse_powder_data({ text: hkl, filename: "x.hkl" })).toThrow(/single-crystal/i);
  });
});
