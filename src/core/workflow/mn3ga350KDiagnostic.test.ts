import { describe, it } from "vitest";
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
import { dataExists, readData } from "@/testSupport/data";

/**
 * PHASE 1a DIAGNOSTIC (Improvement Plan) — characterize the powder magnetic
 * refinement instability on Mn3Ga 350K. NOT an acceptance test: it prints a
 * report from ≥20 seeded random starting moment configurations so the fix in 1b
 * can be matched to the observed failure mode.
 *
 * It runs 24 full refinements (~3 min) so it is OPT-IN behind MAG_DIAGNOSTIC=1
 * (like the GANB4SE8 gate) rather than taxing every local `npm test`. Run with:
 *
 *   npm run test:mag-diagnostic
 *
 * Skips when the git-ignored data/ folder is absent, or when the flag is unset.
 */
const DIR = "Mn3Ga_POWGEN_350K";
const hasData =
  process.env.MAG_DIAGNOSTIC === "1" &&
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
const mag = (cell: UnitCell, v: Vec3): number => Math.sqrt(dot(cell, v, v));

/** mulberry32 — same deterministic PRNG the multi-start driver uses. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!hasData)("Mn3Ga 350K — Phase 1a magnetic instability diagnostic", () => {
  it("characterizes terminal states from 24 random moment starts", { timeout: 300000 }, () => {
    const { structure } = parseMagneticCif(readData(`${DIR}/Mn3Ga-mag_53_350K_Final_ortho.cif`), "mn3ga350");
    const inst = parseInstrumentParameters(readData(`${DIR}/PG3_45598_Bank1.instprm`));
    const full = parseGsasHistogramPattern(readData(`${DIR}/PG3_45598_Bank1.fxye`), "pg45598", "Mn3Ga 350K", {
      radiation: { kind: "neutron-tof" },
    });
    const pattern = { ...full, points: full.points.filter((p) => p.x >= TOF_MIN && p.x <= TOF_MAX) };

    const spec = buildPowderSpec(structure, pattern, inst, true, 6, {});
    const build = buildMagneticModel(structure, [0, 0, 0], ["Mn1_0", "Mn1_1"], structure.spaceGroup.operations);
    const modes = build.params.filter((p) => p.kind === "momentMode");
    const bindingsAll = [...spec.bindings, ...build.bindings];
    const cell = structure.cell;

    // --- 1. Converge the nuclear scaffold once (scale + background + profile),
    //        moments held at zero. Every moment start below reuses these values,
    //        so the diagnostic isolates the moment subspace. ---
    const nucFreeKinds = new Set(["scale", "background", "tofProfile"]);
    const nucBase = spec.params.map((p) => ({ ...p, fixed: !nucFreeKinds.has(p.kind) }));
    const zeroModes = modes.map((p) => ({ ...p, value: 0, initialValue: 0, fixed: true }));
    // Stage the nuclear pre-fit exactly as the golden test does (scale+bkg, then
    // profile) so a cold TOF profile doesn't diverge.
    const nucP1 = [...nucBase, ...zeroModes].map((p) => (p.kind === "tofProfile" ? { ...p, fixed: true } : p));
    const r1 = refine(buildMagneticPowderProblem(structure, build.magnetic, pattern, nucP1, bindingsAll, { shape: "tof" }), { maxIterations: 20 });
    const nucP2 = [...nucBase, ...zeroModes].map((p) => ({ ...p, value: r1.parameters[p.id] ?? p.value }));
    const r2 = refine(buildMagneticPowderProblem(structure, build.magnetic, pattern, nucP2, bindingsAll, { shape: "tof" }), { maxIterations: 30 });
    const nucValues = r2.parameters;
    const nucConverged = nucBase.map((p) => ({ ...p, value: nucValues[p.id] ?? p.value }));

    // Reference (golden) amplitudes = GSAS-II's converged .lst moments projected
    // onto the unit modes.
    const momentOf: Record<string, Vec3> = { Mn1_0: [2.296, -0.559, 0], Mn1_1: [0, 1.118, 0] };
    const goldenAmp = new Map<string, number>();
    for (const p of modes) {
      const b = build.bindings.find((x) => x.parameterId === p.id)!.momentBasis! as Vec3;
      const site = p.id.startsWith("mom_Mn1_0") ? "Mn1_0" : "Mn1_1";
      goldenAmp.set(p.id, dot(cell, momentOf[site]!, b) / dot(cell, b, b));
    }
    const goldenModel = applyMagneticMoments(build.magnetic, build.bindings, Object.fromEntries(goldenAmp));
    const gm0 = goldenModel.moments.find((m) => m.siteLabel === "Mn1_0")!.components as Vec3;
    const gm1 = goldenModel.moments.find((m) => m.siteLabel === "Mn1_1")!.components as Vec3;

    // χ² at golden moments (nuclear held), the target basin depth.
    const wrOf = (params: RefinementParameter[], iters = 40) => {
      const r = refine(buildMagneticPowderProblem(structure, build.magnetic, pattern, params, bindingsAll, { shape: "tof" }), { maxIterations: iters });
      return r;
    };
    const goldenHeld = wrOf([...nucConverged, ...modes.map((p) => ({ ...p, value: goldenAmp.get(p.id) ?? 0, fixed: true }))], 1);
    const goldenChi = goldenHeld.history[goldenHeld.history.length - 1]?.chiSquared ?? NaN;

    // --- 2. 24 seeded random moment starts, free the moments only. ---
    const N = 24;
    const KICK = 3.0; // µ_B amplitude range for a cold random start
    const rng = mulberry32(0x5eed);
    interface Run {
      idx: number;
      chi: number;
      wr: number;
      status: string;
      m0: Vec3;
      m1: Vec3;
      cond: number;
      maxLambda: number;
      maxShift: number;
      atBounds: number;
      topCorr: string;
    }
    const runs: Run[] = [];
    for (let i = 0; i < N; i++) {
      const start = [
        ...nucConverged,
        ...modes.map((p) => ({ ...p, value: (rng() * 2 - 1) * KICK, initialValue: 0, fixed: false })),
      ];
      const r = wrOf(start, 60);
      const applied = applyMagneticMoments(build.magnetic, build.bindings, r.parameters);
      const m0 = applied.moments.find((m) => m.siteLabel === "Mn1_0")!.components as Vec3;
      const m1 = applied.moments.find((m) => m.siteLabel === "Mn1_1")!.components as Vec3;
      const d = r.diagnostics;
      const topCorr = d?.highCorrelations?.[0];
      runs.push({
        idx: i,
        chi: r.history[r.history.length - 1]?.chiSquared ?? NaN,
        wr: 100 * (r.agreement.rWeighted ?? NaN),
        status: r.status,
        m0,
        m1,
        cond: d?.conditionNumber ?? NaN,
        maxLambda: d?.maxLambda ?? NaN,
        maxShift: d?.maxParameterShift ?? NaN,
        atBounds: d?.atBounds?.length ?? 0,
        topCorr: topCorr ? `${topCorr.parameterIdA}~${topCorr.parameterIdB}=${topCorr.coefficient.toFixed(2)}` : "-",
      });
    }

    // --- 3. Canonicalize (global time-reversal: a whole-cell sign flip is
    //        diffraction-equivalent) and cluster the terminal moment vectors. ---
    const canon = (m0: Vec3, m1: Vec3): { m0: Vec3; m1: Vec3 } => {
      // Pick the sign by the dominant component of Mn1_0 (its a-axis moment).
      const s = m0[0]! < 0 ? -1 : 1;
      return { m0: [s * m0[0]!, s * m0[1]!, s * m0[2]!], m1: [s * m1[0]!, s * m1[1]!, s * m1[2]!] };
    };
    const key = (m0: Vec3, m1: Vec3): string => {
      const c = canon(m0, m1);
      const r = (x: number) => (Math.abs(x) < 0.15 ? 0 : Math.round(x * 3) / 3); // 0.33 µB bins
      return [...c.m0, ...c.m1].map(r).join(",");
    };
    const clusters = new Map<string, { count: number; chiMin: number; chiMax: number; rep: Run }>();
    for (const r of runs) {
      const k = key(r.m0, r.m1);
      const c = clusters.get(k);
      if (c) {
        c.count++;
        c.chiMin = Math.min(c.chiMin, r.chi);
        c.chiMax = Math.max(c.chiMax, r.chi);
        if (r.chi < c.rep.chi) c.rep = r;
      } else {
        clusters.set(k, { count: 1, chiMin: r.chi, chiMax: r.chi, rep: r });
      }
    }

    // Distance of each run's canonical moments from golden (Cartesian, µB).
    const distFromGolden = (r: Run): number => {
      const c = canon(r.m0, r.m1);
      const gc = canon(gm0, gm1);
      const d0: Vec3 = [c.m0[0]! - gc.m0[0]!, c.m0[1]! - gc.m0[1]!, c.m0[2]! - gc.m0[2]!];
      const d1: Vec3 = [c.m1[0]! - gc.m1[0]!, c.m1[1]! - gc.m1[1]!, c.m1[2]! - gc.m1[2]!];
      return Math.sqrt(dot(cell, d0, d0) + dot(cell, d1, d1));
    };

    // ---------------- REPORT ----------------
    const chiSorted = [...runs].sort((a, b) => a.chi - b.chi);
    const best = chiSorted[0]!;
    const nearGolden = runs.filter((r) => distFromGolden(r) < 0.4).length;
    const withinChi = runs.filter((r) => r.chi <= best.chi * 1.001).length;

    /* eslint-disable no-console */
    console.log("\n================ PHASE 1a DIAGNOSTIC: Mn3Ga 350K ================");
    console.log(`Nuclear scaffold converged (moments=0): wR = ${(100 * (r2.agreement.rWeighted ?? 0)).toFixed(3)}%`);
    console.log(`Golden moments |m0|=${mag(cell, gm0).toFixed(2)} |m1|=${mag(cell, gm1).toFixed(2)} µB, χ²(held)=${goldenChi.toExponential(4)}`);
    console.log(`Best of ${N} starts: χ²=${best.chi.toExponential(4)} wR=${best.wr.toFixed(3)}% |m0|=${mag(cell, canon(best.m0, best.m1).m0).toFixed(2)} |m1|=${mag(cell, canon(best.m0, best.m1).m1).toFixed(2)}`);
    console.log(`Starts reaching best χ² (≤+0.1%): ${withinChi}/${N} = ${((100 * withinChi) / N).toFixed(0)}%`);
    console.log(`Starts within 0.4 µB of golden (canonicalized): ${nearGolden}/${N}`);
    console.log(`Distinct clusters (after ±m canonicalization, 0.33 µB bins): ${clusters.size}`);
    console.log("\nper-run (sorted by χ²):");
    console.log("  idx  status        χ²          wR%     |m0|  |m1|  cond      maxλ     maxShift  bnd  distGold  topCorr");
    for (const r of chiSorted) {
      const c = canon(r.m0, r.m1);
      console.log(
        `  ${String(r.idx).padStart(3)}  ${r.status.padEnd(12)}  ${r.chi.toExponential(3)}  ${r.wr.toFixed(3).padStart(6)}  ${mag(cell, c.m0).toFixed(2)}  ${mag(cell, c.m1).toFixed(2)}  ${r.cond.toExponential(1)}  ${r.maxLambda.toExponential(1)}  ${r.maxShift.toExponential(1)}  ${String(r.atBounds).padStart(3)}  ${distFromGolden(r).toFixed(3).padStart(6)}    ${r.topCorr}`,
      );
    }
    console.log("\nclusters (canonical rep moments, count, χ² range):");
    for (const [k, c] of [...clusters.entries()].sort((a, b) => a[1].rep.chi - b[1].rep.chi)) {
      const cc = canon(c.rep.m0, c.rep.m1);
      console.log(
        `  n=${String(c.count).padStart(2)}  χ²∈[${c.chiMin.toExponential(3)},${c.chiMax.toExponential(3)}]  m0=(${cc.m0.map((x) => x.toFixed(2)).join(",")}) m1=(${cc.m1.map((x) => x.toFixed(2)).join(",")})  dGold=${distFromGolden(c.rep).toFixed(2)}  [${k}]`,
      );
    }
    console.log("================================================================\n");
    /* eslint-enable no-console */
  });
});
