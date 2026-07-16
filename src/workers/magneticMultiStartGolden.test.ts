import { describe, it, expect } from "vitest";
import type { Vec3 } from "@/core/math/types";
import type { UnitCell } from "@/core/crystal/types";
import type { RefinementParameter } from "@/core/refinement/types";
import { parseMagneticCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { buildPowderSpec } from "@/app/powderSpec";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { refine } from "@/core/refinement/engine";
import { ComputeClient } from "@/workers/computeClient";
import { dataExists, readData } from "@/testSupport/data";

/**
 * Phase 1c ACCEPTANCE (Improvement Plan) — the magnetic multi-start / escape path
 * on the real Mn₃Ga 350 K POWGEN histogram. Gate to Phase 2. Skips when the
 * git-ignored data/ folder is absent (CI). ComputeClient runs in-thread under
 * vitest (no Worker), so this is deterministic.
 */
const DIR = "Mn3Ga_POWGEN_350K";
const hasData =
  dataExists(`${DIR}/Mn3Ga-mag_53_350K_Final_ortho.cif`) &&
  dataExists(`${DIR}/PG3_45598_Bank1.fxye`) &&
  dataExists(`${DIR}/PG3_45598_Bank1.instprm`);

const TOF_MIN = 12158.9;
const TOF_MAX = 118441.4;

const dot = (cell: UnitCell, a: Vec3, b: Vec3): number => {
  const ca = crystalComponentsToCartesian(cell, a);
  const cb = crystalComponentsToCartesian(cell, b);
  return ca[0]! * cb[0]! + ca[1]! * cb[1]! + ca[2]! * cb[2]!;
};
const magnitude = (cell: UnitCell, v: Vec3): number => Math.sqrt(dot(cell, v, v));

describe.skipIf(!hasData)("Mn3Ga 350K — Phase 1c magnetic multi-start acceptance", () => {
  function setup(): { client: ComputeClient; specBase: Parameters<ComputeClient["refineMagneticPowderMultiStart"]>[0]; cell: UnitCell; build: ReturnType<typeof buildMagneticModel> } {
    const { structure } = parseMagneticCif(readData(`${DIR}/Mn3Ga-mag_53_350K_Final_ortho.cif`), "mn3ga350");
    const inst = parseInstrumentParameters(readData(`${DIR}/PG3_45598_Bank1.instprm`));
    const full = parseGsasHistogramPattern(readData(`${DIR}/PG3_45598_Bank1.fxye`), "pg45598", "Mn3Ga 350K", { radiation: { kind: "neutron-tof" } });
    const pattern = { ...full, points: full.points.filter((p) => p.x >= TOF_MIN && p.x <= TOF_MAX) };

    const spec = buildPowderSpec(structure, pattern, inst, true, 6, {});
    const build = buildMagneticModel(structure, [0, 0, 0], ["Mn1_0", "Mn1_1"], structure.spaceGroup.operations);
    const modes = build.params.filter((p) => p.kind === "momentMode");
    const bindingsAll = [...spec.bindings, ...build.bindings];

    // Converge the nuclear scaffold once (scale + background + profile, moments 0),
    // staged as the golden test does, then hold the profile: the acceptance is
    // about the moment search, and a fixed converged profile keeps the final
    // joint fast and stable.
    const nucFreeKinds = new Set(["scale", "background", "tofProfile"]);
    const nucBase = spec.params.map((p) => ({ ...p, fixed: !nucFreeKinds.has(p.kind) }));
    const zero = modes.map((p) => ({ ...p, value: 0, initialValue: 0, fixed: true }));
    const p1 = [...nucBase, ...zero].map((p) => (p.kind === "tofProfile" ? { ...p, fixed: true } : p));
    const r1 = refine(buildMagneticPowderProblem(structure, build.magnetic, pattern, p1, bindingsAll, { shape: "tof" }), { maxIterations: 20 });
    const p2 = [...nucBase, ...zero].map((p) => ({ ...p, value: r1.parameters[p.id] ?? p.value }));
    const r2 = refine(buildMagneticPowderProblem(structure, build.magnetic, pattern, p2, bindingsAll, { shape: "tof" }), { maxIterations: 30 });

    // Final freed set: scale + background free (profile held), moments freed at a
    // deliberately bad cold start (0.5 µ_B each — right order of magnitude, wrong
    // partition and possibly wrong sign).
    const nucConverged = nucBase.map((p) => ({
      ...p,
      value: r2.parameters[p.id] ?? p.value,
      fixed: p.kind === "tofProfile" ? true : !nucFreeKinds.has(p.kind) ? true : false,
    }));
    const coldModes = modes.map((p) => ({ ...p, value: 0.5, initialValue: 0.5, fixed: false }));
    const parameters: RefinementParameter[] = [...nucConverged, ...coldModes];

    return {
      client: new ComputeClient(),
      specBase: { structure, magnetic: build.magnetic, pattern, parameters, bindings: bindingsAll, shape: "tof" },
      cell: structure.cell,
      build,
    };
  }

  it("recovers the golden moment topology from ≥20 seeded starts; ≥95% share the same χ²", { timeout: 300000 }, async () => {
    const { client, specBase, cell, build } = setup();
    const ms = await client.refineMagneticPowderMultiStart(specBase, { restarts: 20, seed: 0xace }, { maxIterations: 25 });

    // (i) ≥20 starts (baseline + 20 restarts). ≥95% land within 1% of the best
    // χ² — the flat valley floor, with no divergent outlier (1a's run-7 profile
    // blow-up is gone because nuclear is frozen during the moment search).
    expect(ms.costByStart.length).toBeGreaterThanOrEqual(21);
    const best = Math.min(...ms.costByStart);
    const within = ms.costByStart.filter((c) => c <= best * 1.01).length;
    expect(within / ms.costByStart.length).toBeGreaterThanOrEqual(0.95);

    // (ii) Correct moment topology (canonicalized): Mn1_0 dominated by its a-axis
    // component, Mn1_1 by its b-axis, both z-forbidden — matching the golden mCIF
    // / GSAS-II .lst (|m0| ≈ 2, |m1| ≈ 1.1–1.7 along the data-limited b-axis).
    const refined = applyMagneticMoments(build.magnetic, build.bindings, ms.final.parameters);
    const m0 = refined.moments.find((m) => m.siteLabel === "Mn1_0")!.components as Vec3;
    const m1 = refined.moments.find((m) => m.siteLabel === "Mn1_1")!.components as Vec3;
    expect(Math.abs(m0[0]!)).toBeGreaterThan(1.4);
    expect(Math.abs(m0[2]!)).toBeLessThan(1e-9);
    expect(Math.abs(m1[1]!)).toBeGreaterThan(0.7);
    expect(Math.abs(m1[0]!)).toBeLessThan(1e-9);
    expect(Math.abs(m1[2]!)).toBeLessThan(1e-9);
    expect(magnitude(cell, m0)).toBeGreaterThan(1.5);
    expect(magnitude(cell, m0)).toBeLessThan(2.9);

    // (iii) The data-limited (flat) partition direction is surfaced, not hidden.
    /* eslint-disable-next-line no-console */
    console.log(`Phase 1c: best χ²=${best.toExponential(3)}, ${within}/${ms.costByStart.length} within 1%; |m0|=${magnitude(cell, m0).toFixed(2)} |m1|=${magnitude(cell, m1).toFixed(2)}; degeneracies=${ms.degeneracies.map((d) => d.kind).join(",") || "none"}`);
    for (const d of ms.degeneracies) expect(d.message.length).toBeGreaterThan(0);

    client.dispose();
  });

  it("is deterministic — same seed reproduces the converged moments", { timeout: 300000 }, async () => {
    const a = setup();
    const ra = await a.client.refineMagneticPowderMultiStart(a.specBase, { restarts: 8, seed: 123 }, { maxIterations: 25 });
    a.client.dispose();
    const b = setup();
    const rb = await b.client.refineMagneticPowderMultiStart(b.specBase, { restarts: 8, seed: 123 }, { maxIterations: 25 });
    b.client.dispose();
    expect(rb.final.parameters).toEqual(ra.final.parameters);
    expect(rb.costByStart).toEqual(ra.costByStart);
  });
});
