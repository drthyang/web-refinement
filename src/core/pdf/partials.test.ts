import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { computeGofR, makeRGrid, type PdfModelParams } from "@/core/pdf/forwardModel";
import { computePartialsGofR } from "@/core/pdf/partials";
import { buildPdfSpec, pdfCurves, pdfPartialCurves } from "@/core/workflow/pdf";

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };

function p1(cell: UnitCell, sites: AtomSite[]): StructureModel {
  return { id: "s", name: "s", cell, spaceGroup: { operations: [IDENTITY_OP] }, sites };
}
function site(label: string, element: string, position: readonly [number, number, number], occupancy = 1): AtomSite {
  return { label, element, position, occupancy, adp: { kind: "isotropic", bIso: 0.4 } };
}

const CELL: UnitCell = { a: 4.1, b: 4.1, c: 4.1, alpha: 90, beta: 90, gamma: 90 };
// CsCl-like two-element cell, with a partially-occupied mixed site to exercise
// the occupancy-folded weights.
const NACL_ISH = p1(CELL, [
  site("Na1", "Na", [0, 0, 0]),
  site("Cl1", "Cl", [0.5, 0.5, 0.5], 0.9),
]);
const PARAMS: PdfModelParams = {
  scatteringType: "neutron", scale: 1.3, qdamp: 0.03, qbroad: 0.01, delta1: 0.2, delta2: 0, spdiameter: 0,
};

describe("computePartialsGofR", () => {
  const atoms = expandStructureAtoms(NACL_ISH);
  const rGrid = makeRGrid(0.5, 14, 0.02);

  it("emits one partial per unordered element pair", () => {
    const partials = computePartialsGofR(CELL, atoms, rGrid, PARAMS);
    expect(partials.map((p) => p.label).sort()).toEqual(["Cl–Cl", "Cl–Na", "Na–Na"]);
  });

  it("partials sum EXACTLY to the total G(r) (peaks, baseline shares, envelopes, scale)", () => {
    const partials = computePartialsGofR(CELL, atoms, rGrid, PARAMS);
    const total = computeGofR(CELL, atoms, rGrid, PARAMS);
    let maxDiff = 0;
    let scale = 0;
    for (let k = 0; k < rGrid.length; k++) {
      let sum = 0;
      for (const p of partials) sum += p.g[k]!;
      maxDiff = Math.max(maxDiff, Math.abs(sum - total[k]!));
      scale = Math.max(scale, Math.abs(total[k]!));
    }
    expect(maxDiff).toBeLessThan(1e-10 * Math.max(scale, 1));
  });

  it("a single-element structure yields one partial equal to the total", () => {
    const mono = p1(CELL, [site("Ni1", "Ni", [0, 0, 0])]);
    const monoAtoms = expandStructureAtoms(mono);
    const partials = computePartialsGofR(CELL, monoAtoms, rGrid, PARAMS);
    const total = computeGofR(CELL, monoAtoms, rGrid, PARAMS);
    expect(partials).toHaveLength(1);
    expect(partials[0]!.label).toBe("Ni–Ni");
    for (let k = 0; k < rGrid.length; k += 37) expect(partials[0]!.g[k]!).toBeCloseTo(total[k]!, 12);
  });

  it("the unlike-pair partial owns the nearest-neighbour peak of the rock-salt-ish cell", () => {
    const partials = computePartialsGofR(CELL, atoms, rGrid, PARAMS);
    const byLabel = new Map(partials.map((p) => [p.label, p.g]));
    // Nearest neighbour Na–Cl along the body diagonal: √3/2·a ≈ 3.55 Å; the
    // like-pair (cell-edge) distance is a = 4.1 Å.
    const at = (g: Float64Array, r: number): number => g[Math.round((r - 0.5) / 0.02)]!;
    const rNN = (Math.sqrt(3) / 2) * 4.1;
    expect(at(byLabel.get("Cl–Na")!, rNN)).toBeGreaterThan(0.1);
    // The like pair has NO peak at the unlike-pair distance — only its own
    // (negative) share of the −4πρ₀r baseline sits there.
    expect(at(byLabel.get("Na–Na")!, rNN)).toBeLessThan(0);
    expect(at(byLabel.get("Na–Na")!, 4.1)).toBeGreaterThan(0.1);
  });
});

describe("pdfPartialCurves (workflow, terminated like the total)", () => {
  it("overlays sum to the plotted calc curve, including the Qmax termination", () => {
    const rGrid = makeRGrid(0.01, 10, 0.01); // 0-aligned, oversampled → termination active
    const pattern: PdfPattern = {
      id: "p", name: "p", scatteringType: "neutron",
      points: Array.from(rGrid, (r) => ({ r, gObs: 0 })), qmax: 20, qdamp: 0.02,
    };
    const spec = buildPdfSpec(NACL_ISH, pattern);
    const curves = pdfCurves(NACL_ISH, pattern, spec.params, spec.bindings);
    const partials = pdfPartialCurves(NACL_ISH, pattern, spec.params, spec.bindings);
    expect(partials.length).toBe(3);
    let maxDiff = 0;
    for (let k = 0; k < curves.x.length; k++) {
      let sum = 0;
      for (const p of partials) sum += p.y[k]!;
      maxDiff = Math.max(maxDiff, Math.abs(sum - curves.yCalc[k]!));
    }
    expect(maxDiff).toBeLessThan(1e-9);
  });
});
