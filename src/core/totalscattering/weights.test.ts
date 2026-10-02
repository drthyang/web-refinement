import { describe, it, expect } from "vitest";
import type { AtomSite, StructureModel, UnitCell } from "@/core/crystal/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { compositionWeights, pairWeight } from "@/core/totalscattering/weights";
import { computeGofR, makeRGrid, type PdfModelParams } from "@/core/pdf/forwardModel";
import { computeGofRWithColumns } from "@/core/pdf/gradients";
import { computePartialsGofR } from "@/core/pdf/partials";
import { enumeratePairs } from "@/core/pdf/pairEnumerator";

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };
const CELL: UnitCell = { a: 4.3, b: 4.6, c: 5.1, alpha: 90, beta: 95, gamma: 90 };
function site(label: string, element: string, position: readonly [number, number, number], occupancy = 1): AtomSite {
  return { label, element, position, occupancy, adp: { kind: "isotropic", bIso: 0.5 } };
}
function p1(sites: AtomSite[]): StructureModel {
  return { id: "s", name: "s", cell: CELL, spaceGroup: { operations: [IDENTITY_OP] }, sites };
}

// Gd 6.5 − 13.82i, B 5.30 − 0.213i, O 5.803 (fm).
const GD_B_O = p1([site("Gd1", "Gd", [0, 0, 0], 0.9), site("B1", "B", [0.5, 0.4, 0.3]), site("O1", "O", [0.2, 0.7, 0.6], 0.8)]);
const PARAMS: PdfModelParams = { scatteringType: "neutron", scale: 1.1, qdamp: 0.03, qbroad: 0.01, delta1: 0.2, delta2: 0, spdiameter: 0 };

describe("PDF composition weights with complex scattering lengths", () => {
  it("pair weight is Re(b_i·b_j*), the normalization |⟨b⟩|² and ⟨|b|²⟩", () => {
    const atoms = expandStructureAtoms(GD_B_O);
    const w = compositionWeights(atoms, "neutron");
    expect(w.perAtomIm).not.toBeNull();
    // Gd–Gd: 0.9²·|b|² = 0.81·(6.5² + 13.82²) — not 0.81·6.5² (≈5.5× less).
    expect(pairWeight(w, 0, 0)).toBeCloseTo(0.81 * (6.5 ** 2 + 13.82 ** 2), 10);
    // Gd–O: O is real, so only b′_Gd enters: 0.9·0.8·6.5·5.803.
    expect(pairWeight(w, 0, 2)).toBeCloseTo(0.72 * 6.5 * 5.803, 10);
    // Gd–B: b′b′ + b″b″.
    expect(pairWeight(w, 0, 1)).toBeCloseTo(0.9 * (6.5 * 5.3 + 13.82 * 0.213), 10);
    const n = 0.9 + 1 + 0.8;
    const re = (0.9 * 6.5 + 5.3 + 0.8 * 5.803) / n;
    const im = (0.9 * 13.82 + 0.213) / n;
    expect(w.bAvg).toBeCloseTo(re, 12);
    expect(w.bAvgIm).toBeCloseTo(im, 12);
    expect(w.bAvgAbs2).toBeCloseTo(re * re + im * im, 12);
    expect(w.bSqAvg).toBeCloseTo((0.9 * (6.5 ** 2 + 13.82 ** 2) + (5.3 ** 2 + 0.213 ** 2) + 0.8 * 5.803 ** 2) / n, 10);
  });

  it("a structure of real amplitudes keeps the plain real weights (no imaginary array)", () => {
    const w = compositionWeights(expandStructureAtoms(p1([site("Ni1", "Ni", [0, 0, 0]), site("O1", "O", [0.5, 0.5, 0.5])])), "neutron");
    expect(w.perAtomIm).toBeNull();
    expect(w.bAvgIm).toBe(0);
    expect(w.bAvgAbs2).toBe(w.bAvg * w.bAvg);
  });

  it("partials still sum exactly to the total G(r) (complex baseline shares)", () => {
    const atoms = expandStructureAtoms(GD_B_O);
    const rGrid = makeRGrid(0.5, 12, 0.02);
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

  it("the analytic occupancy column matches a finite difference (complex chain rule)", () => {
    const rGrid = makeRGrid(1, 10, 0.02);
    const pairs = (s: StructureModel) => enumeratePairs(CELL, expandStructureAtoms(s), 11);
    const atoms = expandStructureAtoms(GD_B_O);
    for (const target of [0, 1, 2]) {
      const dOcc = new Float64Array(atoms.length);
      dOcc[target] = 1;
      const fused = computeGofRWithColumns(CELL, atoms, rGrid, PARAMS, pairs(GD_B_O), [{ kind: "occupancy", dOcc }]);
      const eps = 1e-6;
      const bump = (d: number): Float64Array => {
        const s: StructureModel = {
          ...GD_B_O,
          sites: GD_B_O.sites.map((st, i) => (i === target ? { ...st, occupancy: st.occupancy + d } : st)),
        };
        return computeGofR(CELL, expandStructureAtoms(s), rGrid, PARAMS, pairs(s));
      };
      const up = bump(eps);
      const down = bump(-eps);
      let worst = 0;
      let maxAbs = 0;
      for (let k = 0; k < rGrid.length; k++) {
        const fd = (up[k]! - down[k]!) / (2 * eps);
        worst = Math.max(worst, Math.abs(fused.columns[0]![k]! - fd));
        maxAbs = Math.max(maxAbs, Math.abs(fd));
      }
      expect(worst / maxAbs, GD_B_O.sites[target]!.label).toBeLessThan(1e-6);
    }
  });
});
