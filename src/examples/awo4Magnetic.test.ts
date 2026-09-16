import { describe, it, expect } from "vitest";
import { AWO4_DEMO_FILES, buildAwo4MagneticExample } from "@/examples/awo4Magnetic";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { operationKey } from "@/core/crystal/symmetry";
import { momentCartesian } from "@/core/magnetic/moment";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { loadedSession } from "@/app/powderSession";
import { powderCurves } from "@/core/workflow/powder";
import { magneticComponentCurve } from "@/core/workflow/magneticPowder";
import { dataExists, readData } from "@/testSupport/data";
import type { SymmetryOperation } from "@/core/crystal/types";

const sig = (ops: readonly SymmetryOperation[]): string =>
  [...new Set(ops.map((o) => `${operationKey(o)}|${o.timeReversal ?? 1}`))].sort().join(" ");

const has = Object.values(AWO4_DEMO_FILES).every((rel) => dataExists(rel));

/**
 * The LOCAL AWO₄ magnetic demo must stay coherent with the machinery that
 * produced it (`awo4MagneticSolve.test.ts`): a real histogram, a k = (½,0,0)
 * model whose group is a candidate the magnetic page enumerates, moment rows
 * whose ids the page's builder regenerates, and a session that reopens near
 * the solved fit. Data-gated: the files live only in the git-ignored data/
 * folder (unpublished data), so this skips on CI and fresh clones.
 */
describe.skipIf(!has)("local AWO₄ magnetic demo (POWGEN 6 K, k = ½ 0 0)", () => {
  const ex = buildAwo4MagneticExample({
    data: readData(AWO4_DEMO_FILES.data),
    instrument: readData(AWO4_DEMO_FILES.instrument),
    solution: readData(AWO4_DEMO_FILES.solution),
  });

  it("reads the bank-3 histogram and the TOF calibration", () => {
    expect(ex.pattern.points.length).toBe(3670);
    expect(ex.pattern.xUnit).toBe("tof");
    expect(ex.pattern.points.every((p) => Number.isFinite(p.yObs) && (p.sigma ?? 0) > 0)).toBe(true);
    expect(ex.instrument.kind).toBe("tof");
    if (ex.instrument.kind === "tof") expect(ex.instrument.difC).toBeCloseTo(22600, 0);
  });

  it("carries the solved P2/c′ model: a maximal candidate of the k = (½,0,0) lattice, tied cations at 2.57 µ_B", () => {
    expect(ex.k).toEqual([0.5, 0, 0]);
    expect(ex.magnetic.propagation[0]).toEqual([0.5, 0, 0]);
    const reps = latticeRepresentatives(magneticSubgroupLattice(ex.structure.spaceGroup.operations, ex.k));
    const hit = reps.find((r) => sig(r.candidate.operations) === sig(ex.magnetic.operations ?? []));
    expect(hit).toBeDefined();
    expect(hit!.index).toBe(2);
    expect(hit!.candidate.standard?.bnsNumber ?? hit!.settingMatch?.identity.bnsNumber).toBe("13.68");
    expect(magneticIonCandidates(ex.structure).map((i) => i.siteLabel)).toEqual(ex.magneticSites);
    const carried = ex.magnetic.moments.filter((m) => m.components.some((c) => c !== 0));
    expect(carried.map((m) => m.siteLabel).sort()).toEqual([...ex.magneticSites].sort());
    for (const m of carried) expect(Math.hypot(...momentCartesian(ex.structure.cell, m))).toBeCloseTo(2.57, 1);
    expect(ex.momentParams).toHaveLength(2);
  });

  it("reopens as a powder session with the moment rows merged and the fit near the solved wR", () => {
    const base = loadedSession(ex.structure, ex.pattern, ex.instrument, [], ex.refinedParams, ex.backgroundTerms);
    expect(base.backgroundTerms).toBe(ex.backgroundTerms);
    expect(base.powderProfile.shape).toBe("tof");
    const ids = new Set(base.powderParams.map((p) => p.id));
    for (const p of ex.momentParams) expect(ids.has(p.id)).toBe(false);
    for (const id of ["scale", "cell_beta", "tof_sig0", "B_Co1", "pos_O2_2"]) {
      expect(base.powderParams.find((p) => p.id === id)?.value).toBeCloseTo(ex.refinedParams[id]!, 6);
    }
    const params = [...base.powderParams, ...ex.momentParams];
    const bindings = [...base.powderBindings, ...ex.momentBindings];
    const nuclear = powderCurves(ex.structure, ex.pattern, base.powderParams, base.powderBindings, base.powderProfile);
    const mag = magneticComponentCurve(ex.structure, ex.magnetic, ex.pattern, params, bindings, { shape: "tof" });
    let num = 0, den = 0;
    for (let i = 0; i < nuclear.yObs.length; i++) {
      const o = nuclear.yObs[i]!, c = nuclear.yCalc[i]! + (mag[i] ?? 0);
      const s = ex.pattern.points[i]!.sigma!;
      num += (o - c) ** 2 / (s * s); den += (o * o) / (s * s);
    }
    const wR = Math.sqrt(num / den);
    expect(wR).toBeLessThan(0.08);
    expect(wR).toBeCloseTo(ex.jointWr, 2);
    expect(Math.max(...mag)).toBeGreaterThan(0);
  });
});
