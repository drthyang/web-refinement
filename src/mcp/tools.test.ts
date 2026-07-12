import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
  evaluate_pattern,
  simulate_pattern,
  reflection_list,
  bond_geometry,
  find_unexplained_peaks,
  search_propagation_vector,
  list_magnetic_subgroups,
  allowed_moments,
  build_magnetic_model,
  refine_magnetic_powder,
  rank_next_parameters,
} from "@/mcp/tools";
import { exampleStructure } from "@/examples/mn3ga";
import { exampleMagnetic, magneticParameters, magneticBindings } from "@/examples/mn3gaMagnetic";
import type { RefinementParameter } from "@/core/refinement/types";

const DATA = resolve(__dirname, "../../data/GaNb4Se8_XRD");
const read = (f: string): string => readFileSync(resolve(DATA, f), "utf8");
// The GaNb4Se8 regression dataset lives in the git-ignored `data/` folder —
// present in a local checkout, absent on CI / a fresh clone — so the file-backed
// integration tests skip when it isn't there (the repo's convention for
// data/-dependent tests). The judgment logic itself is covered without any data
// files in src/core/diagnostics/*.test.ts.
const HAVE_DATA = existsSync(resolve(DATA, "GaNb4Se8_100K.cif"));

describe("MCP tool handlers", () => {
  it("parse_powder_data rejects single-crystal reflection lists with a clear error", () => {
    const hkl = "   1   0   0   100.0   2.0\n   1   1   0   250.0   3.0\n   2   0   0   80.0   2.5\n";
    expect(() => parse_powder_data({ text: hkl, filename: "x.hkl" })).toThrow(/single-crystal/i);
  });

  // The full expert loop an agent would run, on the real GaNb4Se8 XRD dataset.
  describe.skipIf(!HAVE_DATA)("expert loop on the GaNb4Se8 dataset", () => {
    it("parse_structure reads a CIF into a structure", () => {
      const { structure } = parse_structure({ cif: read("GaNb4Se8_100K.cif") });
      expect(structure.sites.length).toBeGreaterThan(0);
      expect(structure.spaceGroup.operations.length).toBeGreaterThan(0);
    });

    it("runs parse → build → refine → assess → suggest and produces an expert judgment", async () => {
      const { structure } = parse_structure({ cif: read("GaNb4Se8_100K.cif") });
      const instrument = parse_instrument({ text: read("xrd_instrum.instprm") });
      const { pattern } = parse_powder_data({ text: read("GaNb4Se8_799_T_298.8K_gsas.dat"), filename: "GaNb4Se8.dat" });

      const built = build_refinement({ structure, pattern, instrument });
      expect(built.parameters.length).toBeGreaterThan(0);

      const refined = await refine_powder({ structure, pattern, parameters: built.parameters, bindings: built.bindings, profile: built.profile, instrument });
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
  });
});

describe("MCP analysis primitives (no data files needed)", () => {
  const structure = exampleStructure(); // hexagonal Mn3Ga, P6₃/mmc

  it("simulate → evaluate on its own output is self-consistent (wR ≈ 0)", () => {
    const sim = simulate_pattern({ structure, xMin: 20, xMax: 90, points: 2000 });
    expect(sim.xUnit).toBe("twoTheta");
    expect(sim.curves.yCalc.length).toBe(2000);
    expect(Math.max(...sim.curves.yCalc)).toBeGreaterThan(0);

    // Feed the simulation back as "observed" data with the same model.
    const pattern = {
      id: "p", name: "sim", xUnit: "twoTheta" as const,
      radiation: { kind: "xray" as const, wavelength: 1.54 },
      points: sim.curves.x.map((x, i) => ({ x, yObs: sim.curves.yCalc[i]! })),
    };
    const built = build_refinement({ structure, pattern, backgroundTerms: 1 });
    const params = built.parameters.map((p) =>
      p.kind === "scale" ? { ...p, value: 1 } : p.kind === "background" ? { ...p, value: 0 } : p,
    );
    const ev = evaluate_pattern({ structure, pattern, parameters: params, bindings: built.bindings, profile: built.profile });
    expect(ev.agreement.wR).toBeLessThan(0.5);
    // The exactly-zero background plateau of a noise-free simulation trips the
    // sentinel-plateau exclusion mask (its job on GSAS-style masked data), so
    // the count covers the peak-bearing region, not all grid points.
    expect(ev.observationCount).toBeGreaterThan(1000);
    expect(ev.observationCount).toBeLessThanOrEqual(2000);
  });

  it("reflection_list returns families with d + multiplicity; absences:false adds extinct ones", () => {
    const withAbs = reflection_list({ structure, dMin: 1.0, dMax: 5 });
    expect(withAbs.count).toBeGreaterThan(5);
    for (const r of withAbs.reflections) {
      expect(r.d).toBeGreaterThanOrEqual(1.0);
      expect(r.multiplicity).toBeGreaterThan(0);
    }
    // P6₃/mmc has systematic absences (e.g. (00l) l odd) — keeping them grows the list.
    const noAbs = reflection_list({ structure, dMin: 1.0, dMax: 5, absences: false });
    expect(noAbs.count).toBeGreaterThan(withAbs.count);
    // Instrument-frame positions when a calibration is passed.
    const withX = reflection_list({ structure, dMin: 1.0, dMax: 5, instrument: { kind: "tof", difC: 22000 } });
    expect(withX.reflections[0]!.x).toBeCloseTo(22000 * withX.reflections[0]!.d, 3);
  });

  it("bond_geometry returns sorted nearest-neighbour distances", () => {
    const { bonds, shortest } = bond_geometry({ structure, cutoff: 3.2 });
    expect(bonds.length).toBeGreaterThan(0);
    expect(shortest).not.toBeNull();
    // Sorted ascending, and no physically absurd contact in this real structure.
    for (let i = 1; i < bonds.length; i++) expect(bonds[i]!.distance).toBeGreaterThanOrEqual(bonds[i - 1]!.distance);
    expect(shortest!.distance).toBeGreaterThan(1.5);
  });

  it("rank_next_parameters points at the group carrying the model error", () => {
    const grid = Array.from({ length: 800 }, (_, i) => 10 + (i * 80) / 799);
    const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 60, v: -12, w: 230, x: 8, y: 2 };
    let pattern = { id: "p", name: "s", xUnit: "twoTheta" as const, radiation: { kind: "neutron" as const, wavelength: 1.54 }, points: grid.map((x) => ({ x, yObs: 0 })) };
    const probe = build_refinement({ structure, pattern, instrument: inst, backgroundTerms: 3 });
    const sim = evaluate_pattern({ structure, pattern, parameters: probe.parameters.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), bindings: probe.bindings, profile: probe.profile });
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.curves.yCalc[i] ?? 0) + 15 })) };
    const built = build_refinement({ structure, pattern, instrument: inst, backgroundTerms: 3 });
    const params = built.parameters.map((p) => ({
      ...p,
      fixed: !(p.kind === "scale" || p.kind === "background"),
      value: p.kind === "bIso" ? p.value + 2.5 : p.kind === "scale" ? 4 : p.value,
    }));
    const out = rank_next_parameters({ structure, pattern, parameters: params, bindings: built.bindings, profile: built.profile });
    expect(out.groups.length).toBeGreaterThan(1);
    expect(out.groups[0]!.group).toBe("ADP");
    expect(out.groups[0]!.predictedWr).toBeLessThan(out.wrNow);
  });

  it("the magnetic solution loop closes: subgroups → allowed moments → build → refine recovers the truth", async () => {
    // 1. Candidate magnetic subgroups of the hexagonal Mn3Ga parent at k = 0.
    const subs = list_magnetic_subgroups({ structure, k: [0, 0, 0], maxIndex: 6 });
    expect(subs.candidates.length).toBeGreaterThan(2);
    const cand = subs.candidates.find((c) => (c.bns ?? "").replace(/\s/g, "") === "Cm'cm'")!;
    expect(cand).toBeDefined();

    // 2. Site-symmetry analysis under that subgroup: Mn1 carries an in-plane
    //    2-D allowed space (the golden-validated Cm'cm' result).
    const am = allowed_moments({ structure, operations: cand.operations, siteLabels: ["Mn1"] });
    expect(am.sites).toHaveLength(1);
    expect(am.sites[0]!.dimension).toBe(2);

    // 3. Build the symmetry-allowed model: 2 modes on orbit 1 + 1 on the split
    //    orbit, first mode of each orbit seeded at 2 µ_B.
    const truth = build_magnetic_model({ structure, ionLabels: ["Mn1"], operations: cand.operations, moment: 2 });
    const modes = truth.parameters.filter((p) => p.kind === "momentMode");
    expect(modes).toHaveLength(3);

    // 4. Simulate the nuclear + magnetic truth and feed it back as data
    //    (same neutron CW instrument on both sides — LP factors must match).
    const neutron = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const };
    const sim = simulate_pattern({ structure, magnetic: truth.magnetic, instrument: neutron, xMin: 15, xMax: 95, points: 1200 });
    expect(Math.max(...(sim.curves.yMagnetic ?? [0]))).toBeGreaterThan(0);
    const pattern = {
      id: "p", name: "sim", xUnit: "twoTheta" as const,
      radiation: { kind: "neutron" as const, wavelength: 1.54 },
      points: sim.curves.x.map((x, i) => ({ x, yObs: (sim.curves.yCalc[i] ?? 0) + 5 })),
    };

    // 5. Refine from perturbed moment amplitudes (truth: 2 / 0 / 2).
    const nuclear = build_refinement({ structure, pattern, instrument: neutron, backgroundTerms: 1 });
    const startAmps: Record<string, number> = {};
    truth.parameters.forEach((p, i) => { startAmps[p.id] = [1.0, 0.5, 1.0][i]!; });
    // Nuclear parameters sit at the truth: hold everything except scale +
    // background so the closed loop isolates the moment refinement.
    const params = [
      ...nuclear.parameters.map((p) => (["scale", "background"].includes(p.kind) ? p : { ...p, fixed: true })),
      ...truth.parameters.map((p) => ({ ...p, value: startAmps[p.id]!, fixed: false })),
    ];
    const out = await refine_magnetic_powder({
      structure, magnetic: truth.magnetic, pattern,
      parameters: params, bindings: [...nuclear.bindings, ...truth.bindings],
      profile: nuclear.profile, maxIterations: 25,
    });
    const wR = 100 * (out.result.agreement.rWeighted ?? 1);
    expect(wR).toBeLessThan(3);
    // What this powder DETERMINES: the total magnetic scattering. The split of
    // moment between the two interleaved in-plane sublattices sits in a broad,
    // shallow valley (the classic hexagonal in-plane indeterminacy — the case
    // where crystallographers impose an equal-|m| prior), so per-orbit |m| is
    // deliberately NOT asserted here; the golden datasets cover determinable
    // cases. The refined magnetic component must reproduce the truth's.
    const c = out.components;
    expect(Math.max(...c.yMagnetic)).toBeGreaterThan(0);
    const truthMag = sim.curves.yMagnetic!;
    const rms = (xs: number[]): number => Math.sqrt(xs.reduce((a, v) => a + v * v, 0) / xs.length);
    const diffRms = rms(c.yMagnetic.map((v, i) => v - truthMag[i]!));
    expect(diffRms).toBeLessThan(0.15 * rms(truthMag));

    // Well-posed variant: hold all but ONE mode at truth — the pipeline must
    // recover its amplitude exactly (truth 2 µ_B from a 1 µ_B start).
    const oneFree = [
      ...nuclear.parameters.map((p) => (["scale", "background"].includes(p.kind) ? p : { ...p, fixed: true })),
      ...truth.parameters.map((p, i) => (i === 0 ? { ...p, value: 1.0, fixed: false } : { ...p, fixed: true })),
    ];
    const single = await refine_magnetic_powder({
      structure, magnetic: truth.magnetic, pattern,
      parameters: oneFree, bindings: [...nuclear.bindings, ...truth.bindings],
      profile: nuclear.profile, maxIterations: 25,
    });
    const recovered = Math.abs(single.result.parameters[truth.parameters[0]!.id] ?? 0);
    expect(recovered).toBeGreaterThan(1.9);
    expect(recovered).toBeLessThan(2.1);

    // 6. The residual-hunting entry point works on the same loop: a
    //    nuclear-only calc leaves the magnetic peaks as unexplained residual.
    const nuclearOnly = evaluate_pattern({ structure, pattern, parameters: nuclear.parameters.map((p) => (p.kind === "scale" ? { ...p, value: 1 } : p.kind === "background" ? { ...p, value: 5 } : p)), bindings: nuclear.bindings, profile: nuclear.profile });
    const dGrid = pattern.points.map((pt) => 1.54 / (2 * Math.sin(((pt.x / 2) * Math.PI) / 180)));
    const peaks = find_unexplained_peaks({ residual: { d: dGrid, yObs: nuclearOnly.curves.yObs, yCalc: nuclearOnly.curves.yCalc } });
    expect(peaks.count).toBeGreaterThan(0);
    const ks = search_propagation_vector({ structure, peakD: peaks.peaks.map((p) => p.d) });
    expect(ks.candidates.length).toBeGreaterThan(0);
    expect(ks.candidates[0]!.score).toBeGreaterThanOrEqual(ks.candidates[ks.candidates.length - 1]!.score);
  });

  it("evaluate_pattern with a magnetic model separates nuclear and magnetic components", () => {
    const ex = exampleMagnetic();
    const grid = Array.from({ length: 500 }, (_, i) => 10 + (i * 80) / 499);
    const pattern = {
      id: "p", name: "m", xUnit: "twoTheta" as const,
      radiation: { kind: "neutron" as const, wavelength: 2.41 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const params = magneticParameters(ex.magnetic);
    const bindings = magneticBindings(ex.magnetic);
    const scale: RefinementParameter = { id: "scale", label: "scale", kind: "scale", value: 5, initialValue: 5, fixed: false };
    const ev = evaluate_pattern({
      structure: ex.structure, pattern,
      parameters: [scale, ...params],
      bindings: [{ parameterId: "scale", kind: "scale", targetId: ex.structure.id }, ...bindings],
      profile: { shape: "gaussian" },
      magnetic: ex.magnetic,
    });
    expect(ev.curves.yNuclear).toBeDefined();
    expect(ev.curves.yMagnetic).toBeDefined();
    expect(Math.max(...ev.curves.yMagnetic!)).toBeGreaterThan(0);
    // Total = nuclear + magnetic.
    for (let i = 0; i < 500; i += 50) {
      expect(ev.curves.yCalc[i]!).toBeCloseTo(ev.curves.yNuclear![i]! + ev.curves.yMagnetic![i]!, 6);
    }
  });
});
