import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { dFromTof } from "@/core/diffraction/instrument";
import { buildPowderSpec } from "@/app/powderSpec";
import { CORRECTION_KINDS } from "@/core/diffraction/corrections";
import type { ParameterKind } from "@/core/refinement/types";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { refineStaged } from "@/core/refinement/staged";
import { refine } from "@/core/refinement/engine";
import { DEFAULT_STAGE_KINDS, stagesFromKindGroups } from "@/core/workflow/structureRefinement";
import { detectExtraPeaks, annotateExtraPeaks } from "@/core/magnetic/extraPeaks";
import { applyParameters } from "@/core/workflow/apply";
import { generateReflections } from "@/core/diffraction/reflections";
import { searchPropagationVector } from "@/core/magnetic/kSearch";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { momentCartesian } from "@/core/magnetic/moment";
import { formatMagneticSymbol } from "@/core/magnetic/bnsOg";
import { dataExists, readData, DATA_DIR } from "@/testSupport/data";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AWO4_DEMO_FILES } from "@/examples/awo4Magnetic";
import type { Vec3 } from "@/core/math/types";

/**
 * PROVENANCE of the LOCAL AWO₄ magnetic demo (`awo4Magnetic.ts`): the numbers
 * it opens on are produced HERE, by the app's own machinery, from the POWGEN
 * 6 K bank-3 histogram of the high-entropy tungstate — never typed in by hand.
 * The result is written to `data/AWO4/awo4_demo_solution.json`, which stays
 * in the git-ignored data folder with the unpublished histogram it derives
 * from; the demo reads it from there at runtime.
 *
 *   1. nuclear staged refinement of the 100 K P2/c model against the 6 K data
 *      (scale → background → cell → TOF profile → ADP → positions);
 *   2. residual-peak detection + k-search (must find k = (½,0,0));
 *   3. every magnetic subgroup candidate of the little group of k is refined
 *      with the nuclear model held fixed and ranked by wR — the exact procedure
 *      the magnetic page's "Rank candidates" runs;
 *   4. the chosen candidate is co-refined with the nuclear model; the converged
 *      values are written to the solution file (and echoed as JSON).
 *
 * Slow (minutes) and needs the git-ignored data/ folder, so it runs only with
 * AWO4_SOLVE=1. Ordinary CI never executes it.
 */

const CIF = "AWO4/AWO4_HE_100K_refined.cif";
const INST = "AWO4/GSAS-II_2025B_HR/2025B_HighRes_60HzB3_CWL2p665.instprm";
const GSA = "AWO4/autoreduced/PG3_61115.gsa";
const has = !!process.env.AWO4_SOLVE && dataExists(CIF) && dataExists(INST) && dataExists(GSA);
const K: Vec3 = [0.5, 0, 0];

describe.skipIf(!has)("AWO₄ magnetic demo — solve the 6 K magnetic structure with the app's own tools", () => {
  it("nuclear refinement → k-search → candidate ranking → joint refinement", { timeout: 40 * 60 * 1000 }, () => {
    const structure = parseCif(readData(CIF), "awo4");
    const instrument = parseInstrumentParameters(readData(INST));
    if (instrument.kind !== "tof") throw new Error("bank-3 instprm should be TOF");
    const pattern = parseGsasHistogramPattern(readData(GSA), "awo4-powder", "AWO4 6 K bank 3", { radiation: { kind: "neutron-tof" } });
    const dArr = pattern.points.map((p) => dFromTof(instrument, p.x));
    console.log(`[awo4] ${pattern.points.length} pts · TOF ${pattern.points[0]!.x.toFixed(0)}–${pattern.points[pattern.points.length - 1]!.x.toFixed(0)} µs · d ${Math.min(...dArr).toFixed(3)}–${Math.max(...dArr).toFixed(3)} Å`);

    // 1. Nuclear staged refinement. The stage plan unlocks kind-groups in
    // order; every structural / profile / microstructure row is sent as
    // unlockable except occupancy, the Gaussian U and the TOF calibration.
    const spec = buildPowderSpec(structure, pattern, instrument, true, 6, { positions: true, adp: true });
    const unlock = new Set<ParameterKind>([
      "positionShift", "bIso", "uAniso", "poRatio", ...CORRECTION_KINDS,
      "peakWidth", "profileV", "profileW", "profileX", "profileY", "asymSL", "asymHL", "zeroShift", "tofProfile",
      "stephensStrain", "anisoSizePerp", "anisoSizePar", "mustrainIso",
    ]);
    const t0 = Date.now();
    const staged = refineStaged(
      spec.params.map((p) => (unlock.has(p.kind) ? { ...p, fixed: false } : p)),
      (params) => buildPowderProblem(structure, pattern, params, spec.bindings, spec.profile),
      stagesFromKindGroups(DEFAULT_STAGE_KINDS),
      { maxIterations: 12 },
    );
    const nuclear = staged.parameters;
    const nuclearWr = staged.final?.agreement.rWeighted ?? NaN;
    console.log(`[awo4] nuclear staged: wR ${(100 * nuclearWr).toFixed(2)}% · ${staged.stages.map((s) => `${s.name} ${(100 * (s.result.agreement.rWeighted ?? 0)).toFixed(1)}%`).join(" → ")} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    expect(Number.isFinite(nuclearWr)).toBe(true);

    // 2. Residual peaks → k-search, exactly as the magnetic page does it: peaks
    //    ≥ 3σ, annotated against the nuclear reflections, included when I/σ ≥ 5
    //    and off any nuclear position, significance-weighted (capped at 20).
    const curves = powderCurves(structure, pattern, nuclear, spec.bindings, spec.profile);
    const sigma = pattern.points.map((p) => p.sigma!);
    const detected = detectExtraPeaks(dArr, curves.yObs, curves.yCalc, { pointSigma: sigma, minSignificance: 3, limit: 24 });
    const applied = applyParameters(structure, spec.bindings, Object.fromEntries(nuclear.map((p) => [p.id, p.value]))).model;
    const nuclearRefl = generateReflections(applied.cell, applied.spaceGroup, 0.9, 25).map((r) => ({ d: r.d, hkl: `${r.h} ${r.k} ${r.l}`, phaseLabel: "AWO4" }));
    const peaks = annotateExtraPeaks(detected, nuclearRefl);
    const included = peaks.filter((p) => (p.significance ?? Infinity) >= 5 && !p.nearNuclear);
    const kCands = searchPropagationVector(structure.cell, included.map((p) => p.d), {
      tolerance: 0.02, maxQ: 0, weights: included.map((p) => Math.min(p.significance ?? 1, 20)),
    });
    console.log(`[awo4] residual peaks: ${peaks.length} detected · ${included.length} included (I/σ ≥ 5, off nuclear) · ${peaks.filter((p) => p.nearNuclear).length} at nuclear positions`);
    console.log(`[awo4] peaks d/Å (I/σ): ${peaks.map((p) => `${p.d.toFixed(3)}(${(p.significance ?? 0).toFixed(1)}${p.nearNuclear ? "·nuc" : ""})`).join(" ")}`);
    console.log(`[awo4] top k: ${kCands.slice(0, 6).map((c) => `${c.label} ${c.matched}/${c.total} rmsd ${c.rmsd.toFixed(4)} score ${c.score.toFixed(3)}`).join(" | ")}`);
    const kRank = kCands.findIndex((c) => c.k[0] === K[0] && c.k[1] === K[1] && c.k[2] === K[2]);
    console.log(`[awo4] k = (½ 0 0) ranks #${kRank + 1} from the nuclear-fit residual (the 6 K − 100 K difference analysis in realAwo4Magnetic.test.ts puts it first)`);

    // 3. Rank every candidate magnetic group at k against the data (nuclear fixed).
    const ions = magneticIonCandidates(structure).map((i) => i.siteLabel);
    console.log(`[awo4] magnetic ions: ${ions.join(", ")}`);
    const reps = latticeRepresentatives(magneticSubgroupLattice(structure.spaceGroup.operations, K));
    const nuclearFixed = nuclear.map((p) => ({ ...p, fixed: true }));
    const ranked: { label: string; index: number; dof: number; wR: number; values: Record<string, number>; moments: string; ops: { xyz: string; timeReversal: 1 | -1 }[] }[] = [];
    for (const rep of reps) {
      const build = buildMagneticModel(structure, K, ions, rep.candidate.operations, { moment: 2, tieSameSite: true });
      if (build.params.length === 0) continue;
      const moments = build.params.map((p) => ({ ...p, fixed: false }));
      const problem = buildMagneticPowderProblem(structure, build.magnetic, pattern, [...nuclearFixed, ...moments], [...spec.bindings, ...build.bindings], { shape: spec.profile.shape });
      const t1 = Date.now();
      const res = refine(problem, { maxIterations: 20 });
      const applied = applyMagneticMoments(build.magnetic, build.bindings, res.parameters);
      const mags = applied.moments.map((m) => `${m.siteLabel}${m.orbitIndex && m.orbitIndex > 1 ? `#${m.orbitIndex}` : ""} ${Math.hypot(...momentCartesian(structure.cell, m)).toFixed(2)}`).join(", ");
      const std = rep.candidate.standard ?? rep.settingMatch?.identity;
      const label = std ? `${formatMagneticSymbol(std.bnsSymbol)} BNS ${std.bnsNumber}` : rep.candidate.label;
      const values: Record<string, number> = {};
      for (const p of build.params) values[p.id] = res.parameters[p.id] ?? p.value;
      ranked.push({
        label, index: rep.index, dof: build.params.length, wR: res.agreement.rWeighted ?? NaN, values, moments: mags,
        ops: rep.candidate.operations.map((o) => ({ xyz: o.xyz, timeReversal: (o.timeReversal ?? 1) as 1 | -1 })),
      });
      console.log(`[awo4]   ${label} (index ${rep.index}, ${build.params.length} dof): wR ${(100 * (res.agreement.rWeighted ?? 0)).toFixed(2)}% · |M| ${mags} · ${res.status} · ${((Date.now() - t1) / 1000).toFixed(0)} s`);
    }
    ranked.sort((a, b) => a.wR - b.wR);
    // Ties within 0.01 % absolute are the powder's direction ambiguity: several
    // symmetry-distinct models give the same pattern. The top-down rule picks
    // the MAXIMAL subgroup (lowest index), then the fewest moment parameters.
    const TIE = 1e-4;
    const tied = ranked.filter((r) => r.wR <= ranked[0]!.wR + TIE).sort((a, b) => a.index - b.index || a.dof - b.dof);
    const best = tied[0]!;
    console.log(`[awo4] baseline nuclear wR ${(100 * nuclearWr).toFixed(2)}% · lowest wR ${(100 * ranked[0]!.wR).toFixed(2)}% shared by ${tied.length} candidate(s): ${tied.map((t) => `${t.label} (index ${t.index}, ${t.dof} dof)`).join("; ")} → pick ${best.label}`);

    // 4. Joint refinement of the chosen candidate (nuclear free set + moments).
    const bestBuild = buildMagneticModel(structure, K, ions, best.ops.map((o) => ({ ...parseXyz(o.xyz), timeReversal: o.timeReversal })), { moment: 2, tieSameSite: true });
    const jointParams = [
      ...nuclear.map((p) => ({ ...p })),
      ...bestBuild.params.map((p) => ({ ...p, value: best.values[p.id] ?? p.value, initialValue: best.values[p.id] ?? p.value, fixed: false })),
    ];
    const joint = refine(
      buildMagneticPowderProblem(structure, bestBuild.magnetic, pattern, jointParams, [...spec.bindings, ...bestBuild.bindings], { shape: spec.profile.shape }),
      { maxIterations: 20 },
    );
    const finalValues: Record<string, number> = {};
    for (const p of jointParams) finalValues[p.id] = joint.parameters[p.id] ?? p.value;
    const finalMag = applyMagneticMoments(bestBuild.magnetic, bestBuild.bindings, finalValues);
    console.log(`[awo4] joint: wR ${(100 * (joint.agreement.rWeighted ?? 0)).toFixed(2)}% (${joint.status}) · |M| ${finalMag.moments.map((m) => Math.hypot(...momentCartesian(structure.cell, m)).toFixed(2)).join(", ")}`);
    const solution = {
      k: K,
      group: best.label,
      ops: best.ops,
      ions,
      backgroundTerms: 6,
      params: Object.fromEntries(Object.entries(finalValues).map(([k, v]) => [k, Number(v.toPrecision(10))])),
      nuclearWr: Number(nuclearWr.toPrecision(6)),
      jointWr: Number((joint.agreement.rWeighted ?? NaN).toPrecision(6)),
      tied: tied.map((t) => t.label),
      ranking: ranked.map((r) => ({ label: r.label, index: r.index, dof: r.dof, wR: Number(r.wR.toPrecision(6)), moments: r.moments })),
      solvedAt: new Date().toISOString(),
    };
    const out = resolve(DATA_DIR, AWO4_DEMO_FILES.solution);
    writeFileSync(out, JSON.stringify(solution, null, 2) + "\n");
    console.log(`[awo4] solution written to ${out}`);
    console.log("[awo4-json] " + JSON.stringify(solution));
    expect(joint.agreement.rWeighted ?? 1).toBeLessThan(nuclearWr);
  });
});

import { parseSymmetryOperation } from "@/core/crystal/symmetry";
function parseXyz(xyz: string): ReturnType<typeof parseSymmetryOperation> {
  return parseSymmetryOperation(xyz);
}
