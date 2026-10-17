import { extent } from "@/agent/scTools";
import { describe, it, expect } from "vitest";
import { keyOfState } from "@/agent/method";
import type { AgentReport } from "@/agent/report";
import { executor, fakeHost, singleCrystalPort } from "@/testSupport/agentHeadless";
import { singleCrystalReportChecks } from "@/agent/scTools";
import { chiralPage, corundumPage, disorderPage, hydridePage, pyridylPage } from "@/testSupport/scPages";
import { dSpacing, orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { mulVec } from "@/core/math/mat3";

const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

function page(opts: Parameters<typeof corundumPage>[0] = {}) {
  const c = corundumPage(opts);
  const { port, calls } = singleCrystalPort(c.structure, c.dataset);
  return { c, port, calls };
}

// Several of these refine real models for 2–5 s: the default 5 s leaves no margin on a loaded machine.
describe("AgentExecutor on the single-crystal page", { timeout: 30_000 }, () => {
  it("reads the page in its own terms: F², R1, wR2 and GooF, the cell fixed", async () => {
    const { port } = page();
    const { ex } = executor(fakeHost(port).host, "auto");
    const st = parse((await ex.run("get_state", {})).text);
    expect(st.technique).toBe("singleCrystal");
    const phase = st.phase as Record<string, unknown>;
    expect(phase.spaceGroup).toMatch(/R -3 c/);
    expect(phase.note).toMatch(/cell is fixed/);
    const data = st.data as Record<string, unknown>;
    expect(data.probe).toBe("neutron, constant wavelength");
    expect(data.reflectionsInFile).toBeGreaterThan(300);
    expect(Object.keys(st.agreement as object)).toEqual(expect.arrayContaining(["R1", "wR2", "GooF"]));
    // The method: the data are read first.
    const method = st.method as { stages: string[]; next: string };
    expect(method.stages[0]).toMatch(/^○ Data quality/);
  });

  it("reads the data before the model, and keeps the reading in the record", async () => {
    const { port } = page();
    const { host, records } = fakeHost(port);
    const { ex } = executor(host, "auto");
    const out = parse((await ex.run("reflection_statistics", {})).text);
    const refl = out.reflections as Record<string, number>;
    // Three equivalents of each reflection, merged in -3m.
    expect(refl.redundancy).toBeGreaterThan(2.5);
    expect(refl.rInt).toBeGreaterThan(0);
    expect(refl.rInt).toBeLessThan(10);
    expect((out.resolution as Record<string, number>).dMin).toBeCloseTo(0.6, 1);
    expect(out.friedel).toMatch(/^centrosymmetric group/);
    expect(out.absences).toMatch(/no reflection the space group forbids/);
    expect(Array.isArray(out.shells)).toBe(true);
    const record = records.get(keyOfState("singleCrystal", port.state()))!;
    expect(record.dataCheck?.summary).toMatch(/reflections, \d+ unique, R_int [\d.]+ %; d_min 0\.6/);
    const st = parse((await ex.run("get_state", {})).text);
    expect((st.method as { stages: string[] }).stages[0]).toMatch(/^✓ Data quality/);
  });

  it("refines the scale and extinction as the agent, and reports R1, wR2 and GooF before and after", async () => {
    const { port, calls } = page();
    const { ex } = executor(fakeHost(port).host, "auto");
    // Free on load, as SHELXL's OSF and EXTI.
    const free = parse((await ex.run("set_free", { free: ["scale", "extinction"] })).text);
    expect(free.unchanged).toBe(true);
    const out = parse((await ex.run("refine", {})).text);
    expect(out.refined).toBe(true);
    expect(out.status).toBe("converged");
    expect(out.wR2).toBeLessThan(out.wR2Before as number);
    expect(typeof out.R1).toBe("number");
    expect(typeof out.GooF).toBe("number");
    expect(calls).toContain("refine");
    // The assessment reads the analysis of variance and the extinction.
    const a = parse((await ex.run("assess_refinement", {})).text);
    expect(a.analysisOfVariance).toBeDefined();
    expect(String(a.extinction)).toMatch(/strongest bin K =/);
  });

  it("recovers the structure through the method's stages, positions before ADPs", async () => {
    const { port, c } = page();
    const { ex } = executor(fakeHost(port).host, "auto");
    await ex.run("set_free", { free: ["scale", "extinction"] });
    await ex.run("refine", {});
    await ex.run("set_free", { free: ["pos_*"] });
    await ex.run("refine", {});
    await ex.run("set_free", { free: ["B_*"] });
    const out = parse((await ex.run("refine", {})).text);
    expect(out.status).toBe("converged");
    // Converged by the crystallographic convention: every shift well below its esd.
    expect(out.maxShiftOverEsd as number).toBeLessThan(0.05);
    const s = port.state();
    const al = s.refinedStructure.sites.find((site) => site.label === "Al1")!;
    const o = s.refinedStructure.sites.find((site) => site.label === "O1")!;
    expect(al.position[2]).toBeCloseTo(c.truth.alZ, 3);
    expect(o.position[0]).toBeCloseTo(c.truth.oX, 3);
    // GooF ≈ 1: the σ's are the noise the page was built with.
    expect(s.agreement.goof).toBeGreaterThan(0.8);
    expect(s.agreement.goof).toBeLessThan(1.3);
  });

  it("switches to anisotropic ADPs seeded from the refined B, and says when they already are", async () => {
    const { port, calls } = page();
    const { ex } = executor(fakeHost(port).host, "auto");
    const before = port.state().agreement.wr2;
    const out = parse((await ex.run("set_adp_model", { anisotropic: true })).text);
    expect(out.unchanged).toBeUndefined();
    expect(calls).toContain("adp anisotropic");
    const u = port.state().parameters.filter((p) => p.kind === "uAniso");
    expect(u.length).toBeGreaterThan(0);
    expect(u.every((p) => p.fixed)).toBe(true);
    expect(port.state().adpModel).toBe("anisotropic");
    // Seeded with the sphere of the hexagonal cell (U12 = U/2): the fit is where it was.
    expect(port.state().agreement.wr2).toBeCloseTo(before, 10);
    const again = parse((await ex.run("set_adp_model", { anisotropic: true })).text);
    expect(again.unchanged).toBe(true);
    expect(again.note).toMatch(/already anisotropic/);
  });

  it("describes the outlier filter by what it leaves out, and sets it as a settings step", async () => {
    const { port } = page();
    const { host, steps } = fakeHost(port);
    const { ex, seen } = executor(host, "auto");
    await ex.run("set_outlier_filter", { on: true, cutoffSigma: 3 });
    const entry = seen.find((e) => e.tool === "set_outlier_filter" && e.preview);
    expect(entry?.preview).toMatch(/^Outlier filter on at 3σ: leaves out \d+ reflections? against the current model$/);
    expect(port.state().outlierFilter.on).toBe(true);
    expect(steps.at(-1)).toEqual({ kind: "settings", agent: true });
    const same = parse((await ex.run("set_outlier_filter", { on: true, cutoffSigma: 3 })).text);
    expect(same.unchanged).toBe(true);
  });

  it("compares a reflection with its equivalents, and marks the one the filter left out", async () => {
    const c = corundumPage();
    // One equivalent of 1 0 4 measured at a tenth of its intensity: a failed measurement.
    const i = c.dataset.reflections.findIndex((r) => r.h === 1 && r.k === 0 && r.l === 4);
    expect(i).toBeGreaterThanOrEqual(0);
    const reflections = c.dataset.reflections.map((r, j) => (j === i ? { ...r, iObs: r.iObs / 10 } : r));
    const { port } = singleCrystalPort(c.structure, { ...c.dataset, reflections });
    const { ex } = executor(fakeHost(port).host, "auto");
    await ex.run("refine", {});
    const out = parse((await ex.run("reflection_equivalents", { h: 1, k: 0, l: 4 })).text);
    expect(out.measured).toBe(3);
    const lines = out.measurements as string[];
    const bad = lines.find((l) => l.startsWith("1 0 4,"))!;
    expect(Number(bad.match(/(-?[\d.]+)σ from the median/)![1])).toBeLessThan(-10);
    // The others agree with each other and with Fc².
    for (const l of lines.filter((x) => x !== bad)) expect(Math.abs(Number(l.match(/(-?[\d.]+)σ from Fc²/)![1]))).toBeLessThan(5);
    await ex.run("set_outlier_filter", { on: true, cutoffSigma: 20 });
    const after = parse((await ex.run("reflection_equivalents", { h: 1, k: 0, l: 4 })).text);
    expect((after.measurements as string[]).find((l) => l.startsWith("1 0 4,"))).toMatch(/left out by the filter$/);
  });

  it("leaves out the most extinguished reflections on request, and puts them back", async () => {
    const { port } = page({ extinction: 20 });
    const { ex, seen } = executor(fakeHost(port).host, "auto");
    await ex.run("refine", {});
    const ys = port.state().rows.map((r) => r.extinction ?? 1);
    const below = ys.filter((y) => y < 0.8).length;
    expect(below).toBeGreaterThan(0);
    await ex.run("set_outlier_filter", { on: true, cutoffSigma: 1000, minExtinction: 0.8 });
    expect(seen.find((e) => e.tool === "set_outlier_filter" && e.preview)?.preview).toBe(`Outlier filter on at 1000σ and y ≥ 0.8: leaves out ${below} reflection${below === 1 ? "" : "s"} against the current model`);
    expect(port.state().outlierFilter).toMatchObject({ on: true, minExtinction: 0.8, excluded: below });
    await ex.run("set_outlier_filter", { minExtinction: null });
    expect(port.state().outlierFilter.minExtinction).toBeUndefined();
    expect(port.state().outlierFilter.excluded).toBe(0);
  });

  it("tests the extinguished reflections as probes, the page left as it was", async () => {
    const { port, calls } = page({ extinction: 20 });
    const { ex, seen } = executor(fakeHost(port).host, "auto");
    await ex.run("refine", {});
    const before = port.state();
    const below = before.rows.filter((r) => (r.extinction ?? 1) < 0.8).length;
    expect(below).toBeGreaterThan(0);
    const steps = calls.length;
    const out = parse((await ex.run("test_extinction", { below: 0.8 })).text);
    expect(seen.find((e) => e.tool === "test_extinction" && e.preview)?.preview).toMatch(new RegExp(`with and without the ${below} reflections of y < 0\\.8, and compare — the page stays as it is`));
    expect(out.leftOut).toBe(`${below} of ${before.rows.length} reflections fitted`);
    expect(out.wR2).toMatchObject({ allData: expect.stringMatching(/%$/), without: expect.stringMatching(/%$/) });
    expect(String(out.note)).toMatch(/The page is unchanged: both fits were probes\.$/);
    // Nothing on the page moved: the filter, every value, the result, and no page call.
    const after = port.state();
    expect(after.outlierFilter).toEqual(before.outlierFilter);
    expect(after.parameters).toEqual(before.parameters);
    expect(after.result).toBe(before.result);
    expect(calls.slice(steps)).toEqual([]);
  });

  it("refuses the extinction test before a refinement", async () => {
    const { port } = page({ extinction: 20 });
    const { ex } = executor(fakeHost(port).host, "auto");
    const out = await ex.run("test_extinction", {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/refine first/);
  });

  it("lists the failed measurements, refuses the report while one is fitted, and writes it once it is left out or kept", async () => {
    const failedPage = (): ReturnType<typeof page> => page({ extinction: 20, failed: { h: 1, k: 0, l: 4, factor: 0.03 } });
    for (const way of ["omit", "keep"] as const) {
      const { port } = failedPage();
      const { host, records } = fakeHost(port);
      const { ex, asked } = executor(host, "auto");
      await ex.run("refine", {});
      const listed = parse((await ex.run("assess_refinement", {})).text).failedMeasurements as string[];
      expect(listed).toEqual(["1 0 4"]);
      const refused = await ex.run("write_report", { summary: "Refined; R1 as listed." });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/a failed measurement is still fitted \(1 0 4: .*omit_reflections.*keep_reflections asks them/);
      if (way === "omit") {
        await ex.run("omit_reflections", { omit: [{ h: 1, k: 0, l: 4 }], reason: "its equivalents agree with Fc²; it reads 3 %" });
        await ex.run("refine", {});
      } else {
        // Only a listed failure can be kept, and only the user decides: the card asks even in Auto.
        expect((await ex.run("keep_reflections", { reflections: [{ h: 2, k: 0, l: 4 }], reason: "the user trusts it" })).isError).toBe(true);
        await ex.run("keep_reflections", { reflections: [{ h: 1, k: 0, l: 4 }], reason: "the user re-measured it and the value stands" });
        expect(asked.some((e) => e.tool === "keep_reflections")).toBe(true);
        // Kept in the analysis' record, so it is saved with the project (not in the page's memory).
        expect([...records.values()].flatMap((r) => r.kept ?? []).map((k) => [k.measurement, k.reason])).toEqual([["1,0,4,", "the user re-measured it and the value stands"]]);
      }
      const written = await ex.run("write_report", { summary: "Refined; R1 as listed." });
      expect(written.isError, written.text).toBe(false);
      if (way === "keep") expect(parse(written.text).checks as string[]).toContainEqual(expect.stringMatching(/^attention: Failed measurements kept — Kept in the fit at the user's word: 1 0 4 \(the user re-measured it/));
    }
  });

  it("marks each outlier by its equivalents, and omits the failed measurements by batch", async () => {
    const failed = [{ h: 1, k: 0, l: 4, factor: 0.03 }, { h: 3, k: 0, l: 12, factor: 0.5 }];
    const c = corundumPage({ extinction: 20, batches: [1, 1, 1], failed });
    const batchOf = (h: number, k: number, l: number): number => c.dataset.reflections.find((r) => r.h === h && r.k === k && r.l === l)!.batch!;
    const [b1, b2] = [batchOf(1, 0, 4), batchOf(3, 0, 12)];
    const { port } = singleCrystalPort(c.structure, c.dataset);
    const { host, steps } = fakeHost(port);
    const { ex, seen } = executor(host, "auto");
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    await ex.run("refine", {});
    // The worst failure drags the whole fit (every strong reflection reads high), yet its equivalents still single it out.
    let outliers = parse((await ex.run("assess_refinement", {})).text).outliers as string[];
    expect(outliers[0]).toMatch(new RegExp(`^1 0 4 \\(batch ${b1}\\): .* — 2 equivalents at Fo²/Fc² [\\d.]+ \\(median\\), this one 0\\.0\\d+: a failed measurement$`));
    expect(outliers.slice(1).every((o) => /the model \(or a correction\) misses the reflection$/.test(o))).toBe(true);
    const n0 = port.state().observationCount;
    await ex.run("omit_reflections", { omit: [{ h: 1, k: 0, l: 4 }], reason: "its equivalents agree with Fc²" });
    expect(seen.find((e) => e.tool === "omit_reflections" && e.preview)?.preview)
      .toBe(`Omit 1 0 4 (batch ${b1}) (its equivalents agree with Fc²) — 1 measurement omitted in all`);
    expect(port.state().omitted).toEqual([{ h: 1, k: 0, l: 4, batch: b1, reason: "its equivalents agree with Fc²" }]);
    expect(port.state().observationCount).toBe(n0 - 1);
    expect(port.state().outlierFilter.excluded).toBe(0);
    expect(steps.at(-1)).toEqual({ kind: "settings", agent: true });
    // With it out the fit recovers, and the second failure, at half its intensity, comes forward.
    await ex.run("refine", {});
    outliers = parse((await ex.run("assess_refinement", {})).text).outliers as string[];
    expect(outliers[0]).toMatch(new RegExp(`^3 0 12 \\(batch ${b2}\\): .*: a failed measurement$`));
    await ex.run("omit_reflections", { omit: [{ h: 3, k: 0, l: 12, batch: b2 }], reason: "half the intensity of its two equivalents" });
    expect(port.state().omitted.map((o) => `${o.h} ${o.k} ${o.l}/${o.batch}`)).toEqual([`1 0 4/${b1}`, `3 0 12/${b2}`]);
    expect(parse((await ex.run("omit_reflections", { omit: [{ h: 1, k: 0, l: 4, batch: b1 }] })).text).unchanged).toBe(true);
    // Only a measurement that is there, by the file's own indices and batch.
    const missing = await ex.run("omit_reflections", { omit: [{ h: 1, k: 0, l: 4, batch: 99 }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(`no measurement 1 0 4 in batch 99 in the data (it was measured in batch ${b1})`);
    const eq = parse((await ex.run("reflection_equivalents", { h: 1, k: 0, l: 4 })).text);
    expect((eq.measurements as string[]).find((l) => l.startsWith("1 0 4,"))).toMatch(/, omitted$/);
    expect((parse((await ex.run("get_state", {})).text).data as Record<string, unknown>).omitted)
      .toEqual([`1 0 4 (batch ${b1}): its equivalents agree with Fc²`, `3 0 12 (batch ${b2}): half the intensity of its two equivalents`]);
    await ex.run("omit_reflections", { restore: [{ h: 3, k: 0, l: 12 }] });
    expect(port.state().omitted.map((o) => `${o.h}${o.k}${o.l}`)).toEqual(["104"]);
    await ex.run("omit_reflections", { restore: "all" });
    expect(port.state().omitted).toEqual([]);
    expect(port.state().observationCount).toBe(n0);
  });

  it("gives a measurement that caught nothing its Fo²/Fc² as a bound, not a ratio its Fo² does not have", async () => {
    // Nothing counted for 1 0 4: its Fo² is noise about zero (negative here), the ratio floored at its σ.
    const c = corundumPage({ extinction: 20, batches: [1, 1, 1], failed: { h: 1, k: 0, l: 4, factor: 0 } });
    const { port } = singleCrystalPort(c.structure, c.dataset);
    const { ex } = executor(fakeHost(port).host, "auto");
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    await ex.run("refine", {});
    const row = port.state().rows.find((r) => r.h === 1 && r.k === 0 && r.l === 4)!;
    expect(row.foSq).toBeLessThan(row.sigma);
    const outliers = parse((await ex.run("assess_refinement", {})).text).outliers as string[];
    expect(outliers[0]).toMatch(/^1 0 4 \(batch \d\): Fo² -?[\d.]+, .* — 2 equivalents at Fo²\/Fc² [\d.]+ \(median\), this one below 0\.0\d+ \(Fo² under its σ\): a failed measurement$/);
  });

  it("calls no reflection failed whose equivalents scatter with wavelength before the extinction is refined", async () => {
    // A Laue measurement: each equivalent at its own wavelength, so before extinction is refined the strong ones scatter among themselves.
    const c = corundumPage({ extinction: 20, laue: true, failed: { h: 1, k: 0, l: 4, factor: 0.03 } });
    const { port } = singleCrystalPort(c.structure, c.dataset);
    const { ex } = executor(fakeHost(port).host, "auto");
    await ex.run("set_free", { fix: ["extinction"] });
    await ex.run("refine", {});
    const before = parse((await ex.run("assess_refinement", {})).text).outliers as string[];
    expect(before.filter((o) => !o.startsWith("1 0 4 ") && /failed measurement/.test(o))).toEqual([]);
    expect(before.some((o) => /they disagree among themselves — a correction that differs between them \(extinction or absorption/.test(o))).toBe(true);
    // With the extinction refined at each reflection's own wavelength, the one that failed stands out.
    await ex.run("set_free", { free: ["extinction", "pos_*", "B_*"] });
    await ex.run("refine", {});
    const after = parse((await ex.run("assess_refinement", {})).text).outliers as string[];
    expect(after[0]).toMatch(/^1 0 4: .*: a failed measurement$/);
    expect(after.slice(1).filter((o) => /failed measurement/.test(o))).toEqual([]);
  });

  it("switches the extinction model, restarting its parameter, and fits the extinction the crystal has", async () => {
    // Intensities computed with Becker–Coppens type I (Lorentzian), Eg = 1e-4; the page loads them under SHELXL's EXTI.
    const c = corundumPage({ extinction: 1e-4, extinctionModel: "bc-1-lorentzian" });
    const { port } = singleCrystalPort(c.structure, c.dataset);
    const { ex, seen } = executor(fakeHost(port).host, "auto");
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    await ex.run("refine", {});
    const shelx = port.state().agreement;
    expect(port.state().extinctionModel).toBe("shelx");
    await ex.run("set_extinction_model", { model: "bc-1-lorentzian" });
    expect(seen.find((e) => e.tool === "set_extinction_model" && e.preview)?.preview).toBe("Extinction model: Becker–Coppens type I, Lorentzian, in place of SHELXL EXTI — its parameter restarts at 0");
    const ext = port.state().parameters.find((p) => p.id === "extinction")!;
    expect(ext).toMatchObject({ value: 0, label: "extinction Eg (B–C type I)", fixed: false });
    expect(port.state().result).toBeNull();
    expect(parse((await ex.run("set_extinction_model", { model: "bc-1-lorentzian" })).text).unchanged).toBe(true);
    await ex.run("refine", {});
    const bc = port.state().agreement;
    // The model the intensities were made with fits them to their noise, and finds their Eg.
    expect(bc.wr2).toBeLessThan(shelx.wr2);
    expect(bc.goof).toBeLessThan(1.3);
    expect(port.state().parameters.find((p) => p.id === "extinction")!.value / 1e-4).toBeCloseTo(1, 1);
    expect(parse((await ex.run("assess_refinement", {})).text).extinctionModel).toBe("Becker–Coppens type I, Lorentzian");
  });

  it("limits the fit to a resolution range and opens it again", async () => {
    const { port } = page({ extinction: 20 });
    const { host, steps } = fakeHost(port);
    const { ex, seen } = executor(host, "auto");
    const all = port.state().observationCount;
    const outside = port.state().allRows.filter((r) => dSpacing(port.state().structure.cell, r.h, r.k, r.l) > 0.8).length;
    expect(outside).toBeGreaterThan(0);
    await ex.run("set_resolution_range", { dMax: 0.8 });
    expect(seen.find((e) => e.tool === "set_resolution_range" && e.preview)?.preview).toBe(`Resolution d ≤ 0.8 Å: leaves out ${outside} reflections`);
    expect(port.state().resolution).toEqual({ dMax: 0.8, excluded: outside });
    expect(port.state().observationCount).toBe(all - outside);
    expect(steps.at(-1)).toEqual({ kind: "settings", agent: true });
    const st = parse((await ex.run("get_state", {})).text);
    expect((st.data as Record<string, unknown>).resolution).toBe(`d ≤ 0.8 Å: ${outside} reflections outside`);
    expect(parse((await ex.run("set_resolution_range", { dMax: 0.8 })).text).unchanged).toBe(true);
    const crossed = await ex.run("set_resolution_range", { dMin: 0.9 });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toMatch(/dMin 0\.9 Å must lie below dMax 0\.8 Å/);
    await ex.run("set_resolution_range", { dMax: null });
    expect(port.state().resolution).toEqual({ excluded: 0 });
    expect(port.state().observationCount).toBe(all);
  });

  it("rides the hydrogens of an X-ray structure on their parents, idealized on request, and gives them back", async () => {
    const pyridyl = pyridylPage();
    const { port } = singleCrystalPort(pyridyl.structure, pyridyl.dataset);
    const { host, steps } = fakeHost(port);
    const { ex, seen } = executor(host, "auto");
    const hydrogenRows = (): number => new Set(port.state().bindings.filter((b) => /^H/.test(b.targetKey ?? "")).map((b) => b.parameterId)).size;
    expect(hydrogenRows()).toBe(28);
    // Refined on their own against X-ray data, the hydrogens draw a note.
    await ex.run("set_free", { free: ["pos_*"] });
    expect(String(parse((await ex.run("refine", {})).text).note)).toMatch(/^7 hydrogens refined on their own against X-ray data: .*Ride them \(set_riding_hydrogens\)/);
    await ex.run("reset_parameters", {});
    await ex.run("set_free", { fix: ["pos_*"] });
    const on = await ex.run("set_riding_hydrogens", { on: true });
    expect(seen.find((e) => e.tool === "set_riding_hydrogens" && e.preview)?.preview).toBe("Ride 7 hydrogens on their parents (SHELXL AFIX: 4 AFIX 43, 3 AFIX 137; U_iso = 1.2·U_eq of the parent (1.5 for methyl and hydroxyl)) — 28 parameters leave the fit, 1 torsion joins it");
    expect(hydrogenRows()).toBe(0);
    expect(port.state().riding).toHaveLength(7);
    expect(steps.at(-1)).toEqual({ kind: "settings", agent: true });
    // Where the difference map put them: the distances as they are, the odd ones named.
    const note = String(parse(on.text).note);
    expect(note).toMatch(/^7 hydrogens ride: 4 sp² X–H on the bisector \(AFIX 43\), X–H 0\.800–1\.101 Å, U_iso 1\.2·U_eq; 3 methyl hydrogens rotating, the torsion refined \(AFIX 137\) in 1 group, X–H 0\.980 Å, U_iso 1\.5·U_eq\./);
    expect(note).toMatch(/out of the usual range for H3 \(0\.80 Å\), H6 \(1\.10 Å\): `temperature` places each group at SHELXL's X–H/);
    expect(note).toMatch(/Free with set_free: the torsion rot_C7 \(fixed\) refines with the positions\./);
    // Idealized at SHELXL's X–H for 150 K: 0.95 Å sp², 0.98 Å methyl.
    const ideal = String(parse((await ex.run("set_riding_hydrogens", { on: true, temperature: 150 })).text).note);
    expect(ideal).toMatch(/4 sp² X–H on the bisector \(AFIX 43\), X–H 0\.950 Å, U_iso 1\.2·U_eq; 3 methyl hydrogens rotating, the torsion refined \(AFIX 137\) in 1 group, X–H 0\.980 Å/);
    expect(ideal).not.toMatch(/out of the usual range/);
    expect(parse((await ex.run("set_riding_hydrogens", { on: true, temperature: 150 })).text).unchanged).toBe(true);
    // The heavy atoms refine; the hydrogens follow, on the bisector at 0.95 Å with U_iso 1.2·U_eq.
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    const fit = parse((await ex.run("refine", {})).text);
    expect(fit.status).toBe("converged");
    expect(port.state().agreement.r1).toBeLessThan(0.04);
    const refined = port.state().refinedStructure;
    const at = (label: string) => refined.sites.find((x) => x.label === label)!;
    const m = orthogonalizationMatrix(refined.cell);
    const d = mulVec(m, [at("H4").position[0] - at("C4").position[0], at("H4").position[1] - at("C4").position[1], at("H4").position[2] - at("C4").position[2]]);
    expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(0.95, 6);
    const b = (label: string): number => { const adp = at(label).adp; return adp.kind === "isotropic" ? adp.bIso : NaN; };
    expect(b("H4") / b("C4")).toBeCloseTo(1.2, 9);
    expect(b("H7A") / b("C7")).toBeCloseTo(1.5, 9);
    // Bonds to the atoms asked for; the riding C–H set by the constraint, the C–C with an esd.
    const bonds = parse((await ex.run("bond_geometry", { atoms: ["C4"], cutoff: 1.6 })).text).bonds as { from: string; to: string; length?: string }[];
    expect(bonds.find((x) => [x.from, x.to].includes("H4"))!.length).toMatch(/^0\.9500 \(riding: set by the constraint, no esd\)$/);
    expect(bonds.filter((x) => !(x.from === "H4" || x.to === "H4")).every((x) => /^1\.\d+\(\d+\)$/.test(x.length ?? ""))).toBe(true);
    expect((await ex.run("bond_geometry", { atoms: ["C99"] })).text).toMatch(/no site C99/);
    // Against the structure as loaded: the heavy atoms only (the riding hydrogens have no parameter), each shift in Å and esds.
    const against = parse((await ex.run("structure_table", { against: "loaded" })).text).againstLoaded as Record<string, unknown>;
    expect(against.sites).toBe(8);
    expect(String(against.positions)).toMatch(/^largest shift 0\.0\d{3} Å at \w+ \(\d+(\.\d)? esd\); \d+ site\(s\) beyond 3 esd$/);
    expect(String(against.adps)).toMatch(/^refined\/loaded B /);
    // The table says which ride, on what.
    const table = parse((await ex.run("structure_table", {})).text) as { phases: { sites: { label: string; riding?: string }[] }[] };
    expect(table.phases[0]!.sites.find((x) => x.label === "H4")!.riding).toBe("rides on C4 (AFIX 43, on the bisector), U_iso = 1.2·U_eq(C4)");
    expect(table.phases[0]!.sites.find((x) => x.label === "C4")!.riding).toBeUndefined();
    // The report's geometry is the molecule's covalent bonds, with esds; the riding C–H set by the constraint.
    const bondRows = port.reportInput!().phases[0]!.bonds!;
    expect(bondRows.find((b) => b.from === "S1" && b.to === "C2")!.length).toMatch(/^1\.\d{3,4}\(\d+\)$/);
    expect(bondRows.find((b) => [b.from, b.to].includes("H4"))!.length).toBe("0.9500 (riding)");
    expect(bondRows.some((b) => b.from === "C2" && b.to === "C3")).toBe(true);
    // The report states the treatment.
    const report = port.reportInput!().data.find((r) => r.label === "Hydrogens")!.value;
    expect(report).toMatch(/^7 riding on their parents \(4 sp² X–H on the bisector \(AFIX 43\), X–H 0\.950 Å, U_iso 1\.2·U_eq; 3 methyl hydrogens rotating, the torsion refined \(AFIX 137\) in 1 group, X–H 0\.980 Å, U_iso 1\.5·U_eq\)$/);
    // The truth's hydrogens are where the riding model puts them.
    const truthH4 = pyridyl.truth.sites.find((x) => x.label === "H4")!.position;
    const off = mulVec(m, [at("H4").position[0] - truthH4[0], at("H4").position[1] - truthH4[1], at("H4").position[2] - truthH4[2]]);
    expect(Math.hypot(off[0], off[1], off[2])).toBeLessThan(0.02);
    // Back on their own: their rows return, fixed.
    await ex.run("set_riding_hydrogens", { on: false });
    expect(port.state().riding).toEqual([]);
    expect(hydrogenRows()).toBe(28);
    expect(parse((await ex.run("set_riding_hydrogens", { on: false })).text).unchanged).toBe(true);
    // A shared U names hydrogens or a geometry, and each list must hold a hydrogen that rides.
    const unknown = await ex.run("set_riding_hydrogens", { on: true, sharedU: [["H99"]] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/sharedU names H99: neither a hydrogen of the model nor a geometry \(all, aromatic, methyl/);
    const empty = await ex.run("set_riding_hydrogens", { on: true, sharedU: [["methyl"], ["hydroxyl"]] });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/sharedU \[hydroxyl\] names no hydrogen that rides here \(or only hydrogens an earlier list took\)/);
    // Corundum has no hydrogen: refused before the user is asked.
    const { port: noH } = page();
    const refused = await executor(fakeHost(noH).host, "auto").ex.run("set_riding_hydrogens", { on: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/no hydrogen atoms/);
  });

  it("weights the fit as SHELXL's WGHT, from the suggestion for the refined model, and goes back to 1/σ²", async () => {
    // A 4 % error on every Fo² that the σ do not carry.
    const pyridyl = pyridylPage({ extraError: 0.04 });
    const { port } = singleCrystalPort(pyridyl.structure, pyridyl.dataset);
    const { host, steps } = fakeHost(port);
    const { ex, seen } = executor(host, "auto");
    const early = await ex.run("set_weighting", { use: "suggested" });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/the suggestion is for a refined model: refine first/);
    await ex.run("set_riding_hydrogens", { on: true, distance: 0.95 });
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    await ex.run("refine", {});
    const sigmaOnly = port.state().agreement;
    expect(sigmaOnly.goof).toBeGreaterThan(1.3);
    const a = parse((await ex.run("assess_refinement", {})).text).weighting as Record<string, string>;
    expect(a.scheme).toBe("w = 1/σ²");
    // SHELXL's criterion leaves the GooF near √(N/(N−P)), a little above 1.
    expect(a.suggested).toMatch(/^WGHT 0\.0[34]\d* [\d.]+: GooF (1|0\.99\d*|1\.0\d*), by intensity bin/);
    await ex.run("set_weighting", { use: "suggested" });
    expect(seen.find((e) => e.tool === "set_weighting" && e.preview)?.preview).toMatch(/^Weights: WGHT 0\.0[34]\d* [\d.]+ \(w = 1\/\[σ² \+ \(0\.0[34]\d*P\)² \+ [\d.]+P\]\) \(suggested for the model as refined now: GooF (1|0\.99\d*|1\.0\d*), by intensity bin [\d., ]+\), in place of w = 1\/σ² — wR2 and GooF change, R1 does not$/);
    const scheme = port.state().weighting!;
    expect(scheme.a).toBeGreaterThan(0.03);
    expect(scheme.a).toBeLessThan(0.05);
    expect(steps.at(-1)).toEqual({ kind: "settings", agent: true });
    expect(port.state().result).toBeNull();
    const st = parse((await ex.run("get_state", {})).text);
    expect((st.data as Record<string, unknown>).weights).toMatch(/^WGHT 0\.0[34]/);
    expect(parse((await ex.run("set_weighting", { a: scheme.a, b: scheme.b })).text).unchanged).toBe(true);
    await ex.run("refine", {});
    // Weighted by it, the fit's GooF is near 1; R1 is the same fit's.
    expect(port.state().agreement.goof).toBeGreaterThan(0.9);
    expect(port.state().agreement.goof).toBeLessThan(1.1);
    expect(Math.abs(port.state().agreement.r1 - sigmaOnly.r1)).toBeLessThan(0.003);
    expect(port.reportInput!().data.find((r) => r.label === "Weights")!.value).toBe(`w = 1/[σ²(F_o²) + (${scheme.a}P)² + ${scheme.b}P], P = (F_o² + 2F_c²)/3 (SHELXL WGHT ${scheme.a} ${scheme.b})`);
    const both = await ex.run("set_weighting", { use: "sigma", a: 0.1 });
    expect(both.isError).toBe(true);
    await ex.run("set_weighting", { use: "sigma" });
    expect(port.state().weighting).toBeNull();
  });

  it("refines an inversion twin's fraction, the Flack x, with Friedel pairs and Ga's f″, and refuses laws that cannot twin the crystal", async () => {
    const chiral = chiralPage({ flack: 0.3 });
    const { port } = singleCrystalPort(chiral.structure, chiral.dataset);
    const { host, steps } = fakeHost(port);
    const { ex, seen } = executor(host, "auto");
    const data = (parse((await ex.run("get_state", {})).text).data as Record<string, unknown>);
    expect(data.anomalousScattering).toBe("f′, f″ at Mo Kα (Cromer & Liberman)");
    expect(data.twin).toBe("none");
    expect(String(parse((await ex.run("reflection_statistics", {})).text).friedel)).toMatch(/have their Friedel mate measured \(100 %\)/);
    await ex.run("set_twin", { law: "inversion" });
    expect(seen.find((e) => e.tool === "set_twin" && e.preview)?.preview).toBe("Twin law: inversion (h′ = −h) — its fraction (the Flack x) refines from 0.1");
    expect(port.state().parameters.find((p) => p.kind === "twinFraction")).toMatchObject({ id: "twin_1", value: 0.1, fixed: false });
    expect(steps.at(-1)).toEqual({ kind: "settings", agent: true });
    expect(parse((await ex.run("set_twin", { law: "inversion" })).text).unchanged).toBe(true);
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    const fit = parse((await ex.run("refine", {})).text);
    expect(fit.status).toBe("converged");
    const x = port.state().parameters.find((p) => p.id === "twin_1")!.value;
    expect(Math.abs(x - 0.3)).toBeLessThan(0.03);
    const twin = (parse((await ex.run("assess_refinement", {})).text).twinning as { laws: { law: string; flackX: string; reading: string }[] }).laws[0]!;
    expect(twin.law).toBe("inversion");
    expect(twin.flackX).toMatch(/^0\.\d+\(\d+\)$/);
    expect(twin.reading).toMatch(/^between the hands: an inversion twin, \d+ % of the crystal of the inverted hand$/);
    expect(port.reportInput!().data.find((r) => r.label === "Twinning")!.value).toMatch(/^inversion twin: Flack x = 0\.\d+\(\d+\)$/);
    // The model right, the largest misfits are what counting gives among thousands: read as chance, the ratios to three digits.
    const outliers = parse((await ex.run("assess_refinement", {})).text).outliers as string[];
    // Each reflection's only Laue-class equivalent is its Friedel mate, which is named so.
    expect(outliers[0]).toMatch(/— its Friedel mate at Fo²\/Fc² \d\.\d{2,3}, this one \d\.\d{2,3}: no more than chance — the largest of 3340 misfits reaches about 4\.\dσ with nothing wrong$/);
    // Laws that cannot twin this crystal, refused before the user is asked.
    expect((await ex.run("set_twin", { law: [[0, 1, 0], [1, 0, 0], [0, 0, -1]] })).text).toMatch(/not a symmetry of this lattice/);
    expect((await ex.run("set_twin", { law: [[-1, 0, 0], [0, -1, 0], [0, 0, 1]] })).text).toMatch(/one of the point group's own operations/);
    expect((await ex.run("set_twin", { law: [[2, 0, 0], [0, 1, 0], [0, 0, 1]] })).text).toMatch(/determinant ±1/);
    await ex.run("set_twin", { remove: true });
    expect(port.state().parameters.some((p) => p.kind === "twinFraction")).toBe(false);
    // In a centrosymmetric group there is no other hand.
    const { port: centro } = page();
    expect((await executor(fakeHost(centro).host, "auto").ex.run("set_twin", { law: "inversion" })).text).toMatch(/centrosymmetric: an inversion twin is the same crystal/);
  });

  it("refines a disorder's split as one fraction: the second occupancy one minus the first, the ADP shared (EADP)", async () => {
    const d = disorderPage({ split: 0.84 });
    const { port } = singleCrystalPort(d.structure, d.dataset);
    const { ex, seen } = executor(fakeHost(port).host, "auto");
    const phase = parse((await ex.run("get_state", {})).text).phase as { disorder: string[] };
    expect(phase.disorder).toEqual(["assembly A: part 1 Al1 at occupancy 0.700; part 2 Ga1 at occupancy 0.300 — Σ 1.000; the occupancies are not tied: tie_parameters `complement` makes them add up to one, and the split refines as one fraction"]);
    // No bond joins the two alternatives, 0.2 Å apart.
    const bonds = parse((await ex.run("bond_geometry", { atoms: ["Al1"] })).text).bonds as { from: string; to: string }[];
    expect(bonds.some((b) => [b.from, b.to].includes("Ga1"))).toBe(false);
    expect(bonds.some((b) => [b.from, b.to].includes("N2"))).toBe(true);
    const tie = parse((await ex.run("tie_parameters", { complement: ["Al1", "Ga1"], adp: ["Al1", "Ga1"] })).text);
    expect(seen.find((e) => e.tool === "tie_parameters" && e.preview)?.preview).toBe("Ga1 takes the ADP of Al1 (EADP: 1 row each) · occ_Ga1 = 1 − occ_Al1: the two alternatives add up to one, and the split refines as one fraction");
    expect(String(tie.note)).toMatch(/occ_Ga1 follows 1 − occ_Al1; Ga1's ADP follows Al1's \(EADP\); the leading rows are fixed \(occ_Al1, B_Al1\): free them with set_free/);
    expect(port.state().parameters.find((p) => p.id === "occ_Ga1")).toMatchObject({ expression: "= -1*occ_Al1+1", fixed: true });
    expect(parse((await ex.run("tie_parameters", { complement: ["occ_Al1", "occ_Ga1"] })).text).unchanged).toBe(true);
    expect((await ex.run("tie_parameters", { complement: ["Al1", "Ga2"] })).text).toMatch(/no occupancy row for Ga2 \(a site at full occupancy and in no disorder has none\)/);
    await ex.run("set_free", { free: ["occ_Al1", "B_*", "pos_*"] });
    expect(parse((await ex.run("refine", {})).text).status).toBe("converged");
    const st = port.state();
    const al = st.parameters.find((p) => p.id === "occ_Al1")!.value;
    const esd = st.result!.esd.occ_Al1!;
    expect(Math.abs(al - 0.84)).toBeLessThan(Math.max(4 * esd, 0.01));
    expect(st.parameters.find((p) => p.id === "occ_Ga1")!.value).toBeCloseTo(1 - al, 12);
    expect(st.parameters.find((p) => p.id === "B_Ga1")!.value).toBe(st.parameters.find((p) => p.id === "B_Al1")!.value);
    // The table gives the follower the leader's esd.
    const table = parse((await ex.run("structure_table", {})).text).phases as { sites: { label: string; occupancy: string }[] }[];
    const occ = (label: string): string => table[0]!.sites.find((x) => x.label === label)!.occupancy;
    expect(occ("Al1")).toMatch(/^0\.8\d+\(\d+\)$/);
    expect(occ("Ga1")).toMatch(/^0\.1\d+\(\d+\)$/);
    expect(occ("Al1").match(/\((\d+)\)/)![1]).toBe(occ("Ga1").match(/\((\d+)\)/)![1]);
    // Released, the follower keeps its value, fixed.
    await ex.run("tie_parameters", { release: ["occ_Ga1"] });
    expect(port.state().parameters.find((p) => p.id === "occ_Ga1")).toMatchObject({ fixed: true, value: 1 - al });
  });

  it("restrains a refined hydride's distance as SHELXL's DFIX and SADI do, and reads each restraint's deviation", async () => {
    const h = hydridePage();
    const { port } = singleCrystalPort(h.structure, h.dataset);
    const { ex, seen } = executor(fakeHost(port).host, "auto");
    // The hydride's position refines on its own; the methyl and the methylene ride.
    const ride = String(parse((await ex.run("set_riding_hydrogens", { on: true, refine: ["H3'"] })).text).note);
    expect(ride).toMatch(/; 1 with its position refined, only U_iso riding, X–H 1\.570 Å/);
    expect(ride).toMatch(/H3' keeps its position rows \(fixed\), to refine/);
    const add = parse((await ex.run("restrain_distances", { add: [{ kind: "dfix", pairs: [["Ga2", "H3'"]], distance: 1.43 }, { kind: "sadi", pairs: [["N1", "C1"], ["N1", "C3"]], sigma: 0.01 }] })).text);
    expect(seen.find((e) => e.tool === "restrain_distances" && e.preview)?.preview).toMatch(/^Restrain DFIX 1\.43 Å \(σ 0\.02\): Ga2–H3' 1\.\d{3} Å; SADI \(σ 0\.01\), mean 1\.47\d Å: N1–C1 1\.475, N1–C3 1\.479 Å — 2 restraints in all$/);
    expect(String(add.note)).toMatch(/^2 restraints in all \(as SHELXL counts them\)\. As the model stands: DFIX 1\.43 Å/);
    expect(port.state().distanceRestraints).toHaveLength(2);
    expect(parse((await ex.run("restrain_distances", { add: [{ kind: "dfix", pairs: [["Ga2", "H3'"]], distance: 1.43 }] })).text).unchanged).toBe(true);
    expect((await ex.run("restrain_distances", { add: [{ kind: "sadi", pairs: [["N1", "C1"]] }] })).text).toMatch(/at least two pairs/);
    expect((await ex.run("restrain_distances", { add: [{ kind: "dfix", pairs: [["Ga2", "Q9"]], distance: 1.5 }] })).text).toMatch(/no site Q9/);
    await ex.run("set_free", { free: ["pos_*", "B_*", "rot_*"] });
    const refined = parse((await ex.run("refine", {})).text);
    expect(refined.status).toBe("converged");
    // A hydride refined as asked, and restrained, draws no "ride them" note.
    expect(refined.note).toBeUndefined();
    const st = port.state();
    const m = orthogonalizationMatrix(st.refinedStructure.cell);
    const at = (label: string) => st.refinedStructure.sites.find((x) => x.label === label)!.position;
    const d = mulVec(m, [at("H3'")[0] - at("Ga2")[0], at("H3'")[1] - at("Ga2")[1], at("H3'")[2] - at("Ga2")[2]]);
    expect(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1.43)).toBeLessThan(0.06);
    const restraints = parse((await ex.run("assess_refinement", {})).text).restraints as { count: number; each: string[]; restrainedGooF: string };
    expect(restraints.count).toBe(2);
    expect(restraints.each[0]).toMatch(/^DFIX 1\.43 Å \(σ 0\.02\): Ga2–H3' 1\.\d{3} Å — the largest deviation \d+\.\d+σ$/);
    expect(Number(restraints.restrainedGooF)).toBeGreaterThan(0);
    expect(port.reportInput!().data.find((r) => r.label === "Restraints")!.value).toMatch(/^2 \(as SHELXL counts them\): DFIX 1\.43/);
    await ex.run("restrain_distances", { remove: [["C3", "N1"]] });
    expect(port.state().distanceRestraints.map((r) => r.kind)).toEqual(["dfix"]);
    await ex.run("restrain_distances", { remove: true });
    expect(port.state().distanceRestraints).toEqual([]);
    // Unrestrained, the hydride refined as asked is named, with what holds it.
    expect(String(parse((await ex.run("refine", {})).text).note)).toMatch(/^H3' refines its position as asked, with nothing holding it: .*restrain_distances/);
  });

  it("merges the equivalents as SHELXL's MERG 2 does: Friedel opposites apart without the inversion, absences out, the data still read as measured", async () => {
    const { port, c } = page();
    const { ex, seen } = executor(fakeHost(port).host, "auto");
    const before = port.state();
    expect((parse((await ex.run("get_state", {})).text).data as { merging: { fitted: string } }).merging.fitted).toMatch(/^every measurement, each equivalent apart/);
    await ex.run("omit_reflections", { omit: [{ h: before.rows[0]!.h, k: before.rows[0]!.k, l: before.rows[0]!.l }], reason: "a test" });
    expect(port.state().omitted).toHaveLength(1);
    const out = parse((await ex.run("merge_equivalents", { on: true })).text);
    expect(seen.find((e) => e.tool === "merge_equivalents" && e.preview)?.preview).toMatch(new RegExp(`^Merge the equivalents as SHELXL's MERG 2: ${c.dataset.reflections.length} measurements → \\d+ reflections, Friedel opposites merged \\(centrosymmetric\\)$`));
    const st = port.state();
    expect(st.dataset.merged).toMatchObject({ from: c.dataset.reflections.length, friedelApart: false });
    expect(st.observationCount).toBeLessThan(c.dataset.reflections.length / 2);
    expect(st.omitted).toEqual([]);
    expect(String(out.note)).toMatch(/measurements merged into \d+ reflections, the Friedel opposites merged too \(a centrosymmetric group\)\. R_int [\d.]+ %; the data reading keeps the measurement as loaded/);
    // R_int and the redundancy read the measurement as loaded, not its merge.
    expect(st.merge.redundancy).toBeGreaterThan(2);
    expect(String((parse((await ex.run("reflection_statistics", {})).text).reflections as { fitted: string }).fitted)).toMatch(/merged as SHELXL's MERG 2/);
    expect(parse((await ex.run("merge_equivalents", { on: true })).text).unchanged).toBe(true);
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    expect(parse((await ex.run("refine", {})).text).status).toBe("converged");
    await ex.run("merge_equivalents", { on: false });
    expect(port.state().observationCount).toBe(c.dataset.reflections.length);
    // Without the inversion the Friedel opposites stay apart; a time-of-flight Laue file is never merged.
    const chiral = chiralPage({ equivalents: 2 });
    const { port: cp } = singleCrystalPort(chiral.structure, chiral.dataset);
    const cx = executor(fakeHost(cp).host, "auto").ex;
    await cx.run("merge_equivalents", { on: true });
    expect(cp.state().dataset.merged).toMatchObject({ friedelApart: true });
    // The report's data line in SHELXL's terms: the measurements and what they became, R_int with the mates apart, data per parameter as SHELXL counts them.
    await cx.run("set_free", { free: ["pos_*"] });
    await cx.run("refine", {});
    const merged = cp.state();
    const line = singleCrystalReportChecks(merged).find((ch) => ch.name === "Data")!.detail;
    const free = merged.parameters.filter((p) => !p.fixed && !p.expression).length;
    expect(line).toMatch(new RegExp(`^${chiral.dataset.reflections.length} measurements merged as SHELXL's MERG 2 into ${merged.dataset.reflections.length} reflections, the Friedel opposites apart \\(R_int [\\d.]+ % with the Friedel mates apart, as SHELXL reports it \\([\\d.]+ % in the Laue class\\), R_σ [\\d.]+ %\\), d_min `));
    expect(line).toContain(`; ${Number((merged.dataset.reflections.length / free).toPrecision(3))} independent reflections per free parameter (the Friedel pairs apart, as SHELXL counts its data).`);
    const { port: tof } = page({ laue: true });
    expect((await executor(fakeHost(tof).host, "auto").ex.run("merge_equivalents", { on: true })).text).toMatch(/time-of-flight Laue measurement is not merged/);
  });

  it("reads a merged reflection's outlier against the measurements behind it, and each shell's R_int from the measurement", async () => {
    // 1 0 4 measured three times, once at 3 % of its intensity: merged, it reads low.
    const c = corundumPage({ extinction: 20, batches: [1, 1, 1], failed: [{ h: 1, k: 0, l: 4, factor: 0.03 }] });
    const { port } = singleCrystalPort(c.structure, c.dataset);
    const { ex } = executor(fakeHost(port).host, "auto");
    await ex.run("merge_equivalents", { on: true });
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    await ex.run("refine", {});
    const out = parse((await ex.run("assess_refinement", {})).text);
    const outliers = out.outliers as string[];
    const worst = outliers.find((o) => o.includes("one of them (1 0 4"));
    expect(worst).toMatch(/merged from 3 measurements at Fo²\/Fc² [\d.]+ \(median, scatter [\d.]+\), one of them \(1 0 4, batch \d+\) at 0\.0\d+: a measurement that failed inside the merge$/);
    expect(outliers.some((o) => /no equivalent measured/.test(o))).toBe(false);
    // The merged reflections are the fit's; the shells' R_int is the measurement's (three per reflection).
    const shells = (parse((await ex.run("reflection_statistics", {})).text).shells as { rInt?: number }[]);
    const report = port.reportInput!();
    expect(shells.every((sh) => sh.rInt !== undefined)).toBe(true);
    expect(report.data.find((r) => r.label === "Reflections")!.value).not.toMatch(/omitted by hand/);
  });

  it("gives the anisotropic tensor and the bond lengths with their esds", async () => {
    const { port } = page();
    const { ex } = executor(fakeHost(port).host, "auto");
    await ex.run("set_free", { free: ["pos_*", "B_*"] });
    await ex.run("refine", {});
    const bonds = parse((await ex.run("bond_geometry", {})).text).bonds as { from: string; to: string; length?: string }[];
    const alO = bonds.filter((b) => [b.from, b.to].sort().join() === "Al1,O1");
    expect(alO.length).toBeGreaterThanOrEqual(2);
    // Each length with an esd from the positions' (≈ 10⁻⁴ Å here): never one bond's length against another's.
    for (const b of alO) {
      expect(b.length).toMatch(/^1\.\d+\(\d+\)$/);
      const [, digits, esd] = b.length!.match(/^1\.(\d+)\((\d+)\)$/)!;
      expect(Number(esd) * 10 ** -digits!.length).toBeLessThan(0.002);
    }
    await ex.run("set_adp_model", { anisotropic: true });
    await ex.run("set_free", { free: ["U_*"] });
    await ex.run("refine", {});
    const table = parse((await ex.run("structure_table", {})).text) as { phases: { sites: { label: string; adp: string; u?: Record<string, string> }[] }[] };
    const o = table.phases[0]!.sites.find((x) => x.label === "O1")!;
    expect(o.adp).toMatch(/^Ueq 0\.00\d+\(\d+\)$/);
    expect(Object.keys(o.u!)).toEqual(["U11", "U22", "U33", "U12", "U13", "U23"]);
    // The site symmetry (2-fold along a) makes U12 = U22/2: both carry esds.
    expect(o.u!.U22).toMatch(/\(\d+\)$/);
    expect(o.u!.U12).toMatch(/\(\d+\)$/);
  });

  it("refuses the powder page's tools, naming the page", async () => {
    const { port } = page();
    const { ex } = executor(fakeHost(port).host, "auto");
    const out = await ex.run("set_background", { terms: 4 });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/works on the powder page only; the single-crystal page is open/);
  });

  it("writes the report with wR2, the data reading, and no number of its own", async () => {
    const { port } = page();
    const reports: AgentReport[] = [];
    const { ex } = executor(fakeHost(port).host, "auto", { onReport: (r) => reports.push(r) });
    await ex.run("reflection_statistics", {});
    await ex.run("set_free", { free: ["scale", "extinction"] });
    await ex.run("refine", {});
    const out = parse((await ex.run("write_report", { summary: "Scale and extinction refined against the merged data; positions and ADPs are next." })).text);
    expect(out.shown).toBe(true);
    const checks = out.checks as string[];
    expect(checks.some((c) => /^note: Data reading — .*R_int/.test(c))).toBe(true);
    expect(checks.some((c) => /Extinction/.test(c))).toBe(true);
    expect(out.unverifiedNumbers).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.markdown).toMatch(/\| wR2 \|/);
  });
});

describe("the range of a large file's values", () => {
  it("is read by a loop: 500 000 wavelengths do not overflow the stack", () => {
    const values = Array.from({ length: 500_000 }, (_, i) => 0.4 + (i % 1000) * 0.003);
    expect(() => Math.min(...values)).toThrow(RangeError);
    expect(extent(values)).toEqual([0.4, 0.4 + 999 * 0.003]);
  });
});

describe("set_twin's note", () => {
  it("reports the fraction each law keeps: adding the inversion to a law keeps the law's own", async () => {
    const { twinStarts } = await import("@/agent/scTools");
    const law = { matrix: [[0, 1, 0], [1, 0, 0], [0, 0, -1]] as [[number, number, number], [number, number, number], [number, number, number]] };
    const inv = { matrix: [[-1, 0, 0], [0, -1, 0], [0, 0, -1]] as typeof law.matrix };
    const both = { matrix: [[0, -1, 0], [-1, 0, 0], [0, 0, 1]] as typeof law.matrix };
    const s = { twinLaws: [law], parameters: [{ id: "twin_1", value: 0.34 }] } as unknown as Parameters<typeof twinStarts>[0];
    expect(twinStarts(s, [law, inv, both])).toEqual([
      { id: "twin_1", kept: true, value: 0.34 },
      { id: "twin_2", kept: false, value: 0.1 },
      { id: "twin_3", kept: false, value: 0.1 },
    ]);
    expect(twinStarts(s, [inv])[0]).toEqual({ id: "twin_1", kept: false, value: 0.1 });
  });
});
