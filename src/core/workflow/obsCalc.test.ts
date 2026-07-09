import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { exampleStructure } from "@/examples/mn3ga";
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
