import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { RefinementParameter } from "@/core/refinement/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { generateReflections } from "@/core/diffraction/reflections";
import { refine } from "@/core/refinement/engine";
import { refinementCost } from "@/core/refinement/multiStart";
import {
  buildSingleCrystalSpec,
  buildSingleCrystalRefinementProblem,
  singleCrystalRefinementComparison,
} from "@/core/workflow/singleCrystalRefinement";
import { ComputeClient } from "@/workers/computeClient";

/**
 * The single-crystal escape path (Prefit / Escape min on the F² page). An F²
 * surface traps LM readily: from a start with every positional mode displaced
 * by 0.15, a plain refine converges CLEANLY onto the ±0.2 bound with wR ≈ 83 %
 * — a wrong answer with a converged status. The multi-start, at the page's
 * Prefit settings (12 restarts, ~4σ kicks with the 0.1 fractional-coordinate
 * floor), lands a restart in the true basin and recovers the exact truth. The
 * settings come from a seed sweep (8–9 of 10 seeds recover; the default seed
 * used here does). Synthetic P-1 data, no data files; worker pooling is
 * inactive under vitest (no `Worker`), so ComputeClient runs in-thread and
 * deterministically.
 */
const iso = { kind: "isotropic", bIso: 0.5 } as const;
const structure: StructureModel = {
  id: "sx",
  name: "SX multi-start",
  cell: { a: 6, b: 7, c: 8, alpha: 88, beta: 95, gamma: 91 },
  spaceGroup: buildSpaceGroup(2), // P-1
  sites: [
    { label: "Fe1", element: "Fe", oxidationState: 2, position: [0.2, 0.3, 0.15], occupancy: 1, adp: iso },
    { label: "O1", element: "O", oxidationState: -2, position: [0.4, 0.1, 0.35], occupancy: 1, adp: iso },
  ],
};
const radiation = { kind: "xray" as const, wavelength: 0.71073 };

/** Exact I_calc of the model at a known scale, used as observations. */
function truthDataset(scale: number, n: number): SingleCrystalDataset {
  const reflections = generateReflections(structure.cell, structure.spaceGroup, 0.8, 8).slice(0, n);
  const base: SingleCrystalDataset = {
    id: "sx", name: "truth", radiation,
    reflections: reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, iObs: 0 })),
  };
  const spec = buildSingleCrystalSpec(structure, base, { scale });
  const cmp = singleCrystalRefinementComparison(structure, base, spec.params, spec.bindings);
  return {
    ...base,
    reflections: cmp.rows.map((row) => ({ h: row.h, k: row.k, l: row.l, iObs: row.fcSq, sigma: Math.sqrt(Math.abs(row.fcSq)) + 0.1 })),
  };
}

const data = truthDataset(2, 120);
const spec = buildSingleCrystalSpec(structure, data);
const posIds = spec.params.filter((p) => p.kind === "positionShift").map((p) => p.id);
/** Scale + every positional mode free, each mode displaced by 0.15 (alternating sign). */
const DISPLACE = [0.15, 0.15, -0.15, 0.15, -0.15, 0.15];
const start: RefinementParameter[] = spec.params.map((p) => {
  if (p.id === "scale") return { ...p, value: 2, initialValue: 2, fixed: false };
  const i = posIds.indexOf(p.id);
  if (i >= 0) return { ...p, value: DISPLACE[i] ?? 0, initialValue: DISPLACE[i] ?? 0, fixed: false };
  return { ...p, fixed: true };
});
/** The page's positional kick floor and its Prefit settings. */
const minKick = (p: RefinementParameter): number | undefined => (p.kind === "positionShift" ? 0.1 : undefined);
const PREFIT = { restarts: 12, escapeSigma: 4, relFraction: 0.5, minKick };

describe("refineSingleCrystalMultiStart — escapes a bound-trapped positional minimum", () => {
  it("a plain refine converges onto the ±0.2 bound with a large wR (the trap)", () => {
    const r = refine(buildSingleCrystalRefinementProblem(structure, data, start, spec.bindings), { maxIterations: 25 });
    expect(r.status).toBe("converged");
    expect(r.agreement.rWeighted ?? 0).toBeGreaterThan(0.5);
    expect(Math.max(...posIds.map((id) => Math.abs(r.parameters[id] ?? 0)))).toBeCloseTo(0.2, 3);
  });

  it("the multi-start recovers the exact truth from the same start", async () => {
    const client = new ComputeClient();
    const ms = await client.refineSingleCrystalMultiStart(
      { structure, dataset: data, parameters: start, bindings: spec.bindings, options: { maxIterations: 25 } },
      PREFIT,
    );
    expect(ms.costByStart).toHaveLength(13);
    expect(ms.improved).toBe(true);
    expect(ms.bestStartIndex).toBeGreaterThan(0);
    expect(refinementCost(ms.final)).toBeLessThan(ms.costByStart[0]! * 1e-6);
    for (const id of posIds) expect(Math.abs(ms.final.parameters[id] ?? 1)).toBeLessThan(1e-3);
    expect(ms.final.parameters["scale"]).toBeCloseTo(2, 3);
    const cmp = singleCrystalRefinementComparison(structure, data, ms.parameters, spec.bindings);
    expect(cmp.agreement.wr2).toBeLessThan(1e-3);
  });

  it("is deterministic — the same seed reproduces every start's χ²", async () => {
    const client = new ComputeClient();
    const req = { structure, dataset: data, parameters: start, bindings: spec.bindings, options: { maxIterations: 25 } };
    const a = await client.refineSingleCrystalMultiStart(req, PREFIT);
    const b = await client.refineSingleCrystalMultiStart(req, PREFIT);
    expect(b.costByStart).toEqual(a.costByStart);
    expect(b.bestStartIndex).toBe(a.bestStartIndex);
  });
});
