import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/highEntropyWO4";
import { buildSyntheticPowder } from "@/examples/synthetic";
import { buildStructureRefinement, refinePowderStructure, siteGroups } from "@/core/workflow/structureRefinement";
import { applyParameters } from "@/core/workflow/apply";

/**
 * Occupancy-disorder refinement for the high-entropy tungstate (Co,Fe,Ni,Mn,Cu,Zn)WO₄:
 * six 3d cations share one 2f site. The same-site position/ADP ties and the
 * automatic Σ(occupancy) restraint keep the disordered site physical.
 */
const CATIONS = ["Co1", "Fe1", "Ni1", "Mn1", "Cu8", "Zn1"];

describe("occupancy-disorder refinement (shared-site ties)", () => {
  const structure = exampleStructure();
  const pattern = buildSyntheticPowder(structure);

  it("groups the six cations into one shared crystallographic site", () => {
    const groups = siteGroups(structure.sites, true);
    const shared = groups.find((g) => g.members.length > 1)!;
    expect(shared).toBeDefined();
    expect(shared.members.map((m) => m.label).sort()).toEqual([...CATIONS].sort());
    // W, O1, O2 stay as their own singletons.
    expect(groups.filter((g) => g.members.length === 1).map((g) => g.rep.label).sort())
      .toEqual(["O1", "O2", "W1"]);
  });

  it("ties ADP and position to ONE shared parameter each (not six)", () => {
    const spec = buildStructureRefinement(structure, pattern, { refineOccupancy: true });
    const bParams = spec.params.filter((p) => p.kind === "bIso");
    // One B for the shared cation site + one each for W, O1, O2 = 4 (not 9).
    expect(bParams).toHaveLength(4);
    const sharedB = bParams.find((p) => p.id === "B_Co1")!;
    const sharedBBindings = spec.bindings.filter((b) => b.parameterId === sharedB.id);
    expect(sharedBBindings.map((b) => b.targetKey).sort()).toEqual([...CATIONS].sort());

    // Position modes of the shared site bind to all six members.
    const posIds = new Set(spec.params.filter((p) => p.kind === "positionShift" && p.id.startsWith("pos_Co1_")).map((p) => p.id));
    expect(posIds.size).toBeGreaterThan(0);
    for (const id of posIds) {
      const bound = spec.bindings.filter((b) => b.parameterId === id).map((b) => b.targetKey).sort();
      expect(bound).toEqual([...CATIONS].sort());
    }
  });

  it("untying restores six independent ADP parameters", () => {
    const spec = buildStructureRefinement(structure, pattern, { tieSharedAdp: false });
    const bIds = spec.params.filter((p) => p.kind === "bIso").map((p) => p.id).sort();
    expect(bIds).toEqual(["B_Co1", "B_Cu8", "B_Fe1", "B_Mn1", "B_Ni1", "B_O1", "B_O2", "B_W1", "B_Zn1"]);
  });

  it("emits an automatic Σ(occupancy) restraint over the shared site", () => {
    const spec = buildStructureRefinement(structure, pattern, { refineOccupancy: true });
    const sum = spec.restraints.find((r) => r.id === "occ_sum_Co1")!;
    expect(sum).toBeDefined();
    expect(sum.terms.map((t) => t.parameterId).sort()).toEqual(CATIONS.map((c) => `occ_${c}`).sort());
    for (const t of sum.terms) expect(t.coefficient).toBe(1);
    // Target = starting total occupancy of the site (6 × 0.167 ≈ 1).
    expect(sum.target).toBeCloseTo(1.0, 1);
  });

  it("constrains Σ occupancy to exactly 1 when requested", () => {
    const spec = buildStructureRefinement(structure, pattern, { refineOccupancy: true, constrainOccupancyToUnity: true });
    expect(spec.restraints.find((r) => r.id === "occ_sum_Co1")!.target).toBe(1);
    // Default keeps the starting-model sum (6 × 0.167 = 1.002 > 1).
    const dflt = buildStructureRefinement(structure, pattern, { refineOccupancy: true });
    expect(dflt.restraints.find((r) => r.id === "occ_sum_Co1")!.target).toBeGreaterThan(1);
  });

  it("keeps the six atoms coincident when a tied position mode is moved", () => {
    const spec = buildStructureRefinement(structure, pattern, {});
    const pos = spec.params.find((p) => p.kind === "positionShift" && p.id.startsWith("pos_Co1_"));
    expect(pos).toBeDefined();
    const values: Record<string, number> = Object.fromEntries(spec.params.map((p) => [p.id, p.initialValue]));
    values[pos!.id] = 0.05; // shift the shared site along its allowed mode
    const applied = applyParameters(structure, spec.bindings, values);
    const moved = CATIONS.map((l) => applied.model.sites.find((s) => s.label === l)!.position);
    for (const p of moved) expect(p).toEqual(moved[0]); // all six still coincide
    // …and they actually moved from the original position.
    const orig = structure.sites.find((s) => s.label === "Co1")!.position;
    expect(moved[0]).not.toEqual(orig);
  });

  it("refines self-consistent data with the total site occupancy preserved", () => {
    const spec = buildStructureRefinement(structure, pattern, { refineOccupancy: true, backgroundTerms: 3 });
    const result = refinePowderStructure(structure, pattern, spec, { shape: "gaussian" }, { maxIterations: 40 });
    // The synthetic pattern is self-consistent, so a good fit is reachable…
    expect(result.final?.agreement.rWeighted ?? 1).toBeLessThan(0.05);
    // …and the Σ-occupancy restraint keeps the total near its starting value.
    const valueOf = (id: string): number => result.parameters.find((p) => p.id === id)?.value ?? 0;
    const total = CATIONS.reduce((acc, c) => acc + valueOf(`occ_${c}`), 0);
    expect(total).toBeCloseTo(1.0, 1);
  });
});
