import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { exampleStructure } from "@/examples/mn3ga";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleMagnetic, magneticParameters, magneticBindings } from "@/examples/mn3gaMagnetic";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import { powderCurves, type PowderProfile } from "@/core/workflow/powder";
import { magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { powderReflectionObsCalc } from "@/core/workflow/obsCalc";

/**
 * The Rietveld obs/calc decomposition must return I_obs = I_calc when the
 * observed pattern IS the calculated one (a perfect fit) — the sanity floor for
 * an F_obs vs F_calc plot.
 */
describe("powderReflectionObsCalc (Rietveld decomposition)", () => {
  const structure = exampleStructure();
  const grid = Array.from({ length: 1400 }, (_, i) => 10 + (i * (120 - 10)) / 1399);
  const profile: PowderProfile = { shape: "gaussian" };
  const empty: PowderPattern = {
    id: "pat", name: "p", xUnit: "twoTheta",
    radiation: { kind: "neutron", wavelength: 1.54 }, wavelength: 1.54,
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const spec = buildStructureRefinement(structure, empty, {
    scale: 100, backgroundTerms: 2, width: 0.3, refineAdp: false, refinePositions: false,
  });
  const curves = powderCurves(structure, empty, spec.params, spec.bindings, profile);
  const pat: PowderPattern = { ...empty, points: grid.map((x, i) => ({ x, yObs: curves.yCalc[i] ?? 0 })) };

  it("recovers per-reflection I_obs ≈ I_calc for a self-consistent pattern", () => {
    const rows = powderReflectionObsCalc(structure, pat, spec.params, spec.bindings, profile);
    expect(rows.length).toBeGreaterThan(3);

    // Total intensity is conserved by the decomposition (obs = calc here).
    const sumObs = rows.reduce((a, r) => a + r.iObs, 0);
    const sumCalc = rows.reduce((a, r) => a + r.iCalc, 0);
    expect(Math.abs(sumObs / sumCalc - 1)).toBeLessThan(0.02);

    // The strongest, well-separated reflection matches closely.
    const strongest = rows.reduce((a, r) => (r.iCalc > a.iCalc ? r : a), rows[0]!);
    expect(Math.abs(strongest.iObs / strongest.iCalc - 1)).toBeLessThan(0.05);
  });

  it("tags every reflection nuclear when no magnetic model is given", () => {
    const rows = powderReflectionObsCalc(structure, pat, spec.params, spec.bindings, profile);
    expect(rows.every((r) => r.kind === "nuclear")).toBe(true);
  });

  it("hides reflections whose peak falls outside the fit range", () => {
    const twoThetaOf = (d: number): number => (2 * Math.asin(Math.min(1, 1.54 / (2 * d))) * 180) / Math.PI;
    const all = powderReflectionObsCalc(structure, pat, spec.params, spec.bindings, profile);
    const windowed = powderReflectionObsCalc(structure, pat, spec.params, spec.bindings, profile, null, { min: 40, max: 80 });

    // Strictly fewer reflections, and every survivor's peak is inside the window.
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThan(all.length);
    for (const r of windowed) {
      const tt = twoThetaOf(r.d);
      expect(tt).toBeGreaterThanOrEqual(40 - 0.5);
      expect(tt).toBeLessThanOrEqual(80 + 0.5);
    }
    // A reflection outside the window that exists in the full list is dropped.
    const droppedOutside = all.some((r) => twoThetaOf(r.d) < 39 && !windowed.some((w) => w.h === r.h && w.k === r.k && w.l === r.l));
    expect(droppedOutside).toBe(true);
  });
});

/**
 * Near-absent reflections (|F_calc|² ≈ 0 from a special-position cancellation,
 * not a lattice absence) must not appear in the F_obs vs F_calc list: the
 * calc-weighted apportionment pins their I_obs to ~0 regardless of the data, so
 * they would otherwise pile up at the plot origin reading a misleading
 * "F_obs = 0". Reproduced on the real Mn₃Ga POWGEN TOF dataset the app opens
 * with, where h0l reflections like (6 0 1)/(6 0 3)/(6 0 5) compute as ~0.
 */
describe("powderReflectionObsCalc — near-absent reflections excluded", () => {
  const { structure, pattern, instrument } = mn3gaPowgenExample();
  const spec = buildPowderSpec(structure, pattern, instrument, true, 4, {});
  const rows = powderReflectionObsCalc(structure, pattern, spec.params, spec.bindings, spec.profile);
  const maxCalc = Math.max(...rows.map((r) => r.iCalc));

  it("emits no reflection whose calc intensity is a negligible fraction of the strongest", () => {
    // Every returned reflection carries meaningful calc weight, so its F_obs is a
    // real apportioned measurement rather than a forced zero.
    expect(rows.every((r) => r.iCalc > maxCalc * 1e-6)).toBe(true);
  });

  it("no returned reflection floors to F_obs = 0 while F_calc is also ~0", () => {
    const bogusZero = rows.filter(
      (r) => Math.sqrt(Math.max(r.iObs, 0)) < 0.01 && Math.sqrt(Math.max(r.iCalc, 0)) < 0.01,
    );
    expect(bogusZero.length).toBe(0);
  });

  it("keeps genuinely weak-but-present reflections", () => {
    // The dataset has real weak reflections (F_calc ~ 0.4–0.8) well above the
    // near-absence floor; the filter must not remove them. With the background
    // seeded from the data's lower envelope (F1.3) the apportioned F_obs is no
    // longer inflated by background counts, so a few noise-level rows may
    // legitimately come out ≈0 or slightly negative — exactly as Rietveld
    // F_obs extraction reports them — but the population must stay present and
    // overwhelmingly positive.
    const weakReal = rows.filter((r) => {
      const fc = Math.sqrt(Math.max(r.iCalc, 0));
      return fc > 0.2 && fc < 2;
    });
    expect(weakReal.length).toBeGreaterThan(0);
    const positive = weakReal.filter((r) => r.iObs > 0).length;
    expect(positive / weakReal.length).toBeGreaterThan(0.9);
  });
});

/**
 * With *anisotropic* microstrain (Stephens) the apportioning sub-peaks must carry
 * the same hkl-dependent broadening the real pattern gives each reflection — else
 * a perfect fit reads off the F_obs = F_calc line. Build a self-consistent pattern
 * from a model with a real anisotropic strain and require I_obs ≈ I_calc.
 */
describe("powderReflectionObsCalc — anisotropic microstrain stays on the F_obs=F_calc line", () => {
  const structure = exampleStructure();
  const grid = Array.from({ length: 1600 }, (_, i) => 10 + (i * (120 - 10)) / 1599);
  const empty: PowderPattern = {
    id: "pat", name: "p", xUnit: "twoTheta",
    radiation: { kind: "neutron", wavelength: 1.54 }, wavelength: 1.54,
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const profile: PowderProfile = { shape: "pseudoVoigt", eta: 0.5 };
  const spec = buildStructureRefinement(structure, empty, {
    scale: 100, backgroundTerms: 2,
    caglioti: { u: 2, v: -2, w: 4 }, lorentzian: { x: 1, y: 2 },
    stephensStrain: true, refineAdp: false, refinePositions: false,
  });
  // Drive the Stephens S-parameters to a visibly anisotropic value.
  const params = spec.params.map((p) =>
    p.kind === "stephensStrain" ? { ...p, value: p.id.endsWith("_0") ? 8 : 3 } : p,
  );
  const curves = powderCurves(structure, empty, params, spec.bindings, profile);
  const pat: PowderPattern = { ...empty, points: grid.map((x, i) => ({ x, yObs: curves.yCalc[i] ?? 0 })) };

  it("recovers I_obs ≈ I_calc for a perfect anisotropic-strain fit", () => {
    const rows = powderReflectionObsCalc(structure, pat, params, spec.bindings, profile);
    const maxCalc = Math.max(...rows.map((r) => r.iCalc));
    const strong = rows.filter((r) => r.iCalc > 0.02 * maxCalc);
    expect(strong.length).toBeGreaterThan(5);
    // Every well-measured reflection sits on the line (pre-fix these drifted ~97%).
    const worst = strong.reduce((m, r) => Math.max(m, Math.abs(r.iObs / r.iCalc - 1)), 0);
    expect(worst).toBeLessThan(0.05);
  });
});

/**
 * With a magnetic model, the decomposition must also emit the magnetic
 * satellites (kind "magnetic"), on the same intensity scale as the nuclear
 * peaks — so an F_obs/F_calc plot can colour them distinctly.
 */
describe("powderReflectionObsCalc — magnetic satellites", () => {
  const { structure, magnetic } = exampleMagnetic();
  const grid = Array.from({ length: 600 }, (_, i) => 10 + (i * 100) / 600);
  const neutron = { kind: "neutron" as const, wavelength: 1.54 };
  const profile: PowderProfile = { shape: "gaussian" };

  // Moments (fixed) + a shared nuclear scale + magnetic-scale ratio + width.
  const params: RefinementParameter[] = [
    ...magneticParameters(magnetic).filter((p) => p.id !== "scaleN" && p.id !== "scaleM").map((p) => ({ ...p, fixed: true })),
    { id: "scaleN", label: "sN", kind: "scale", value: 1, initialValue: 1, fixed: true },
    { id: "scaleM", label: "sM", kind: "magneticScale", value: 1, initialValue: 1, fixed: true },
    { id: "width", label: "w", kind: "peakWidth", value: 0.6, initialValue: 0.6, fixed: true },
  ];
  const bindings: ParameterBinding[] = [
    ...magneticBindings(magnetic).filter((b) => b.kind !== "scale" && b.kind !== "magneticScale"),
    { parameterId: "scaleN", kind: "scale", targetId: structure.id },
    { parameterId: "scaleM", kind: "magneticScale", targetId: magnetic.id },
    { parameterId: "width", kind: "peakWidth", targetId: "pat" },
  ];

  const empty: PowderPattern = { id: "pat", name: "p", xUnit: "twoTheta", radiation: neutron, wavelength: 1.54, points: grid.map((x) => ({ x, yObs: 0 })) };
  const truth = magneticPowderComponents(structure, magnetic, empty, params, bindings);
  const pat: PowderPattern = { ...empty, points: grid.map((x, i) => ({ x, yObs: truth.yCalc[i] ?? 0 })) };

  it("emits magnetic-kind rows only when the magnetic model is passed", () => {
    const nuclearOnly = powderReflectionObsCalc(structure, pat, params, bindings, profile);
    expect(nuclearOnly.some((r) => r.kind === "magnetic")).toBe(false);

    const withMag = powderReflectionObsCalc(structure, pat, params, bindings, profile, magnetic);
    expect(withMag.some((r) => r.kind === "magnetic")).toBe(true);
    // Nuclear rows are unchanged by adding the magnetic component.
    expect(withMag.filter((r) => r.kind === "nuclear").length).toBe(nuclearOnly.length);
  });

  it("recovers I_obs ≈ I_calc for the strongest magnetic satellite (self-consistent pattern)", () => {
    const rows = powderReflectionObsCalc(structure, pat, params, bindings, profile, magnetic);
    const mag = rows.filter((r) => r.kind === "magnetic");
    expect(mag.length).toBeGreaterThan(0);
    const strongest = mag.reduce((a, r) => (r.iCalc > a.iCalc ? r : a), mag[0]!);
    expect(Math.abs(strongest.iObs / strongest.iCalc - 1)).toBeLessThan(0.1);
  });
});
