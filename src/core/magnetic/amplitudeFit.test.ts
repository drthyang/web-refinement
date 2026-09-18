import { describe, it, expect } from "vitest";
import { exampleMagnetic } from "@/examples/mn3gaMagnetic";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { fitAmplitudesToMoments } from "@/core/magnetic/amplitudeFit";
import type { StructureModel } from "@/core/crystal/types";

/** The bundled 30 K Mn₃Ga: parent P2₁/m (time reversal stripped) + the P2₁'/m' model. */
function parentAndModel(): { parent: StructureModel; ops: NonNullable<ReturnType<typeof exampleMagnetic>["magnetic"]["operations"]> } {
  const { structure, magnetic } = exampleMagnetic();
  const parent: StructureModel = {
    ...structure,
    spaceGroup: { ...structure.spaceGroup, operations: structure.spaceGroup.operations.map(({ timeReversal: _t, ...o }) => o) },
  };
  return { parent, ops: magnetic.operations ?? structure.spaceGroup.operations };
}

describe("fitAmplitudesToMoments", () => {
  const { parent, ops } = parentAndModel();
  const sites = ["Mn1_0", "Mn2_1", "Mn3_2"];

  it("inverts applyMagneticMoments exactly (round trip through random amplitudes)", () => {
    const build = buildMagneticModel(parent, [0, 0, 0], sites, ops, { moment: 2 });
    expect(build.params.length).toBeGreaterThan(0);
    const truth: Record<string, number> = {};
    build.params.forEach((p, i) => { truth[p.id] = Math.sin(1 + i) * 2.5; });
    const target = applyMagneticMoments(build.magnetic, build.bindings, truth);
    const fit = fitAmplitudesToMoments(build, target);
    for (const p of build.params) expect(fit.values[p.id]).toBeCloseTo(truth[p.id]!, 9);
    expect(fit.rms).toBeLessThan(1e-9);
  });

  it("reproduces the GSAS-II 30 K moments of the bundled mCIF through P2₁'/m' modes", () => {
    const { magnetic } = exampleMagnetic();
    const build = buildMagneticModel(parent, [0, 0, 0], sites, ops, { moment: 2 });
    const fit = fitAmplitudesToMoments(build, magnetic);
    // m' site symmetry keeps the moments in the ac plane: two modes per site, exact.
    expect(fit.maxMisfit).toBeLessThan(1e-6);
    const applied = applyMagneticMoments(build.magnetic, build.bindings, fit.values);
    for (const m of magnetic.moments) {
      if (m.components.every((c) => c === 0)) continue; // Ga carries none
      const got = applied.moments.find((x) => x.siteLabel === m.siteLabel)!;
      got.components.forEach((c, i) => expect(c).toBeCloseTo(m.components[i]!, 6));
    }
  });

  it("fits a build sublattice absent from the target to zero, and ignores extra target sites", () => {
    const { magnetic } = exampleMagnetic();
    const build = buildMagneticModel(parent, [0, 0, 0], sites, ops, { moment: 2 });
    const partial = { ...magnetic, moments: magnetic.moments.filter((m) => m.siteLabel !== "Mn3_2") };
    const fit = fitAmplitudesToMoments(build, partial);
    const applied = applyMagneticMoments(build.magnetic, build.bindings, fit.values);
    const mn3 = applied.moments.find((m) => m.siteLabel === "Mn3_2")!;
    mn3.components.forEach((c) => expect(Math.abs(c)).toBeLessThan(1e-9));
  });
});
