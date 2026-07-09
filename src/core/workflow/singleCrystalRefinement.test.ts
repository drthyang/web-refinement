import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { generateReflections } from "@/core/diffraction/reflections";
import { refine } from "@/core/refinement/engine";
import {
  buildSingleCrystalSpec,
  buildSingleCrystalRefinementProblem,
  singleCrystalRefinementComparison,
} from "@/core/workflow/singleCrystalRefinement";

const iso = { kind: "isotropic", bIso: 0.5 } as const;

// A small P-1 structure with two atoms — a general position that will carry a
// real coordinate gradient.
const structure: StructureModel = {
  id: "sx",
  name: "SX test",
  cell: { a: 6, b: 7, c: 8, alpha: 88, beta: 95, gamma: 91 },
  spaceGroup: buildSpaceGroup(2), // P-1
  sites: [
    { label: "Fe1", element: "Fe", oxidationState: 2, position: [0.2, 0.3, 0.15], occupancy: 1, adp: iso },
    { label: "O1", element: "O", oxidationState: -2, position: [0.4, 0.1, 0.35], occupancy: 1, adp: iso },
  ],
};
const radiation = { kind: "xray" as const, wavelength: 0.71073 };

/** A truth dataset: I_calc from the model at a known scale, used as observations. */
function truthDataset(scale: number): SingleCrystalDataset {
  const reflections = generateReflections(structure.cell, structure.spaceGroup, 0.8, 8).slice(0, 60);
  const base: SingleCrystalDataset = {
    id: "sx",
    name: "truth",
    radiation,
    reflections: reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, iObs: 0 })),
  };
  const spec = buildSingleCrystalSpec(structure, base, { scale });
  const cmp = singleCrystalRefinementComparison(structure, base, spec.params, spec.bindings);
  return {
    ...base,
    reflections: cmp.rows.map((row) => ({
      h: row.h, k: row.k, l: row.l,
      iObs: row.fcSq,
      sigma: Math.sqrt(Math.abs(row.fcSq)) + 0.1,
    })),
  };
}

describe("buildSingleCrystalSpec", () => {
  it("frees scale on load and fixes structural rows (powder-consistent convention)", () => {
    const data = truthDataset(3);
    const spec = buildSingleCrystalSpec(structure, data);
    const scale = spec.params.find((p) => p.id === "scale")!;
    expect(scale.fixed).toBe(false);
    // Cell + positions + ADP all present but fixed.
    expect(spec.params.filter((p) => p.kind === "positionShift").length).toBeGreaterThan(0);
    expect(spec.params.filter((p) => p.kind === "cellLength").every((p) => p.fixed)).toBe(true);
    expect(spec.params.filter((p) => p.kind === "bIso").every((p) => p.fixed)).toBe(true);
  });

  it("emits an extinction parameter only when requested", () => {
    const data = truthDataset(3);
    expect(buildSingleCrystalSpec(structure, data).params.some((p) => p.kind === "extinction")).toBe(false);
    expect(buildSingleCrystalSpec(structure, data, { extinction: 0 }).params.some((p) => p.kind === "extinction")).toBe(true);
  });
});

describe("single-crystal F² refinement recovery", () => {
  it("recovers the overall scale from a wrong start", () => {
    const data = truthDataset(3);
    const spec = buildSingleCrystalSpec(structure, data);
    // Only scale free; start at 1 vs true 3.
    const params = spec.params.map((p) => (p.id === "scale" ? { ...p, value: 1, initialValue: 1 } : p));
    const problem = buildSingleCrystalRefinementProblem(structure, data, params, spec.bindings);
    const result = refine(problem, { maxIterations: 30 });
    expect(result.parameters.scale).toBeCloseTo(3, 2);
  });

  it("recovers a displaced atom and drives wR2/R1 to ~0", () => {
    const data = truthDataset(2);
    const spec = buildSingleCrystalSpec(structure, data);
    // Displace Fe1 along its first positional mode, free scale + that mode.
    const posId = spec.params.find((p) => p.id.startsWith("pos_Fe1_"))!.id;
    const params = spec.params.map((p) => {
      if (p.id === "scale") return { ...p, value: 2, initialValue: 2, fixed: false };
      if (p.id === posId) return { ...p, value: 0.05, initialValue: 0.05, fixed: false }; // 0.05 off truth
      return { ...p, fixed: true };
    });
    const problem = buildSingleCrystalRefinementProblem(structure, data, params, spec.bindings);
    const result = refine(problem, { maxIterations: 60 });
    expect(Math.abs(result.parameters[posId] ?? 1)).toBeLessThan(0.01); // back to ~0

    const refined = spec.params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
    const cmp = singleCrystalRefinementComparison(structure, data, refined, spec.bindings);
    expect(cmp.agreement.wr2).toBeLessThan(0.02);
    expect(cmp.agreement.r1).toBeLessThan(0.02);
    expect(cmp.agreement.total).toBe(data.reflections.length);
  });

  it("reports per-reflection standardized residuals for outlier diagnosis", () => {
    const data = truthDataset(2);
    const spec = buildSingleCrystalSpec(structure, data, { scale: 2 }); // at the truth scale
    const cmp = singleCrystalRefinementComparison(structure, data, spec.params, spec.bindings);
    // At the truth scale the residuals are ~0.
    expect(Math.max(...cmp.rows.map((r) => Math.abs(r.deltaOverSigma)))).toBeLessThan(1e-6);
  });
});
