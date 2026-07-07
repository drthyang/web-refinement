import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { StructureModel } from "@/core/crystal/types";
import { exampleStructure } from "@/examples/mn3ga";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { buildStructureRefinement, refinePowderStructure, describePositionMode } from "@/core/workflow/structureRefinement";
import { powderCurves } from "@/core/workflow/powder";
import { computeAgreementFactors } from "@/core/refinement/factors";

const PROFILE = { shape: "gaussian" as const };
const TRUE_SCALE = 120;
const TRUE_WIDTH = 0.4;

/** Move one site along its first allowed symmetry mode by `delta` (fractional). */
function perturbSite(structure: StructureModel, label: string, delta: number): StructureModel {
  const site = structure.sites.find((s) => s.label === label)!;
  const { basis } = allowedPositionShifts(structure.spaceGroup.operations, site.position);
  const axis = basis[0]!;
  const moved = site.position.map((c, i) => c + delta * axis[i]!) as [number, number, number];
  return { ...structure, sites: structure.sites.map((s) => (s.label === label ? { ...s, position: moved } : s)) };
}

/** Build a noiseless synthetic pattern from `structure` at the true scale/width. */
function syntheticPattern(structure: StructureModel, extra: Parameters<typeof buildStructureRefinement>[2] = {}): PowderPattern {
  const grid = Array.from({ length: 500 }, (_, i) => 12 + (i * 108) / 500);
  const empty: PowderPattern = {
    id: "mn3ga-powder", name: "synthetic", xUnit: "twoTheta",
    radiation: { kind: "neutron", wavelength: 1.54 }, wavelength: 1.54,
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const spec = buildStructureRefinement(structure, empty, {
    scale: TRUE_SCALE, width: TRUE_WIDTH, backgroundTerms: 1, refineAdp: false, refinePositions: false, ...extra,
  });
  const curves = powderCurves(structure, empty, spec.params, spec.bindings, PROFILE);
  return { ...empty, points: grid.map((x, i) => ({ x, yObs: curves.yCalc[i] ?? 0, sigma: Math.sqrt(Math.max(curves.yCalc[i] ?? 0, 1)) + 1 })) };
}

function wR(structure: StructureModel, pattern: PowderPattern, spec: ReturnType<typeof buildStructureRefinement>): number {
  const curves = powderCurves(structure, pattern, spec.params, spec.bindings, PROFILE);
  const yObs = Float64Array.from(pattern.points.map((p) => p.yObs));
  const w = Float64Array.from(pattern.points.map((p) => 1 / Math.max(p.sigma! ** 2, 1e-9)));
  return 100 * (computeAgreementFactors(yObs, Float64Array.from(curves.yCalc), w, spec.params.length).rWeighted ?? 0);
}

describe("powder structure refinement", () => {
  it("recovers a displaced atomic coordinate on a special position", () => {
    const truth = exampleStructure();
    const pattern = syntheticPattern(truth);

    // Displace Mn1 along its allowed mode; the wrong structure fits the true
    // pattern poorly until the position is refined back.
    const DELTA = 0.03;
    const wrong = perturbSite(truth, "Mn1", DELTA);
    const spec = buildStructureRefinement(wrong, pattern, {
      scale: 1, width: 0.1, backgroundTerms: 1, refineAdp: false, refinePositions: true,
    });

    const wRstart = wR(wrong, pattern, spec);
    const out = refinePowderStructure(wrong, pattern, spec, PROFILE, { maxIterations: 40 });
    const refined = { ...spec, params: out.parameters };
    const wRend = wR(wrong, pattern, refined);

    // The single Mn1 positional mode is driven back by ≈ −DELTA (recovers truth).
    const pos = out.parameters.find((p) => p.id === "pos_Mn1_0")!;
    expect(pos.value).toBeCloseTo(-DELTA, 3);
    expect(pos.esd).toBeGreaterThan(0);

    // The fit collapses to (near) zero on noiseless data.
    expect(wRend).toBeLessThan(wRstart);
    expect(wRend).toBeLessThan(2);
  });

  it("emits one symmetry-adapted positional mode for the Mn1 special position", () => {
    const structure = exampleStructure();
    const spec = buildStructureRefinement(structure, syntheticPattern(structure));
    const mnModes = spec.params.filter((p) => p.kind === "positionShift" && p.id.startsWith("pos_Mn1"));
    // Mn1 at (x, 2x, 1/4): a single free coordinate, not three.
    expect(mnModes.length).toBe(1);
  });

  it("recovers a March–Dollase preferred-orientation ratio from a textured pattern", () => {
    const structure = exampleStructure();
    const axis: [number, number, number] = [0, 0, 1];
    // Synthetic pattern generated WITH texture (r=1.6); refine starting random.
    const pattern = syntheticPattern(structure, {
      scale: TRUE_SCALE, backgroundTerms: 1, refineAdp: false, refinePositions: false,
      preferredOrientation: { axis, ratio: 1.6 },
    });
    const spec = buildStructureRefinement(structure, pattern, {
      scale: 1, width: 0.1, backgroundTerms: 1, refineAdp: false, refinePositions: false,
      preferredOrientation: { axis, ratio: 1 },
    });
    const out = refinePowderStructure(structure, pattern, spec, PROFILE, { maxIterations: 40 });
    expect(out.parameters.find((p) => p.id === "po")!.value).toBeCloseTo(1.6, 1);
  });

  it("recovers a cylinder-absorption μR from an absorbing pattern", () => {
    const structure = exampleStructure();
    const pattern = syntheticPattern(structure, {
      scale: TRUE_SCALE, backgroundTerms: 1, refineAdp: false, refinePositions: false,
      absorption: 1.2, refineAbsorption: true,
    });
    const spec = buildStructureRefinement(structure, pattern, {
      scale: 1, width: 0.1, backgroundTerms: 1, refineAdp: false, refinePositions: false,
      absorption: 0.1, refineAbsorption: true,
    });
    const out = refinePowderStructure(structure, pattern, spec, PROFILE, { maxIterations: 50 });
    expect(out.parameters.find((p) => p.id === "absorption")!.value).toBeCloseTo(1.2, 1);
  });

  it("labels positional modes by direction", () => {
    expect(describePositionMode([1, 0, 0])).toBe("x");
    expect(describePositionMode([0, 1, 0])).toBe("y");
    expect(describePositionMode([0, 0, 1])).toBe("z");
    expect(describePositionMode([1, 1, 1])).toBe("x+y+z");
    expect(describePositionMode([1, -1, 0])).toBe("x−y");
    expect(describePositionMode([0.5, 1, 0])).toBe("x+2y");
  });

  it("wires the instrument Caglioti profile: U fixed, V/W/zero refinable, no single width", () => {
    const structure = exampleStructure();
    const spec = buildStructureRefinement(structure, syntheticPattern(structure), {
      caglioti: { u: -46, v: 0, w: 1.2 }, zero: 0.01,
    });
    // No single peakWidth when a Caglioti profile is supplied.
    expect(spec.params.some((p) => p.kind === "peakWidth")).toBe(false);
    // U seeded and fixed (degenerate); V, W, zero present and free.
    const u = spec.params.find((p) => p.kind === "profileU")!;
    expect(u.value).toBe(-46);
    expect(u.fixed).toBe(true);
    expect(spec.params.find((p) => p.kind === "profileW")!.fixed).toBe(false);
    expect(spec.params.find((p) => p.kind === "zeroShift")!.value).toBe(0.01);
    // The profile stage co-refines width + zero with the instrument terms.
    const profileStage = spec.stages.find((s) => s.name === "profile")!;
    expect(spec.params.filter((p) => profileStage.select(p)).map((p) => p.kind).sort())
      .toEqual(["profileU", "profileV", "profileW", "zeroShift"]);
  });
});
