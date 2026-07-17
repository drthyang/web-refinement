import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import type { ExpandedAtom } from "@/core/diffraction/structureFactor";
import { enumeratePairs } from "@/core/pdf/pairEnumerator";
import { fractionalToCartesian } from "@/core/crystal/unitCell";

function atom(position: readonly [number, number, number]): ExpandedAtom {
  return { element: "Ni", position, occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } };
}

/** Brute-force reference: tile a generously oversized image block and count
 *  every pair within rMax. Slow but bound-free — the ground truth. */
function bruteForceCount(cell: UnitCell, atoms: readonly ExpandedAtom[], rMax: number, n: number): number {
  const cart = atoms.map((a) => fractionalToCartesian(cell, a.position));
  let count = 0;
  for (let t1 = -n; t1 <= n; t1++) {
    for (let t2 = -n; t2 <= n; t2++) {
      for (let t3 = -n; t3 <= n; t3++) {
        for (const ci of cart) {
          for (const cj of cart) {
            const T = fractionalToCartesian(cell, [t1, t2, t3]);
            const dx = cj[0] + T[0] - ci[0];
            const dy = cj[1] + T[1] - ci[1];
            const dz = cj[2] + T[2] - ci[2];
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 > 1e-10 && r2 <= rMax * rMax) count++;
          }
        }
      }
    }
  }
  return count;
}

describe("enumeratePairs — image-range bound on oblique cells", () => {
  // Regression: the per-axis image count was ceil(reach/|axis|), which
  // under-enumerates oblique cells (the (100) plane spacing 1/|a*| is SHORTER
  // than |a|, so the outermost contributing shell could be skipped at unlucky
  // window sizes). The bound is now ceil(reach·|a*|). Sweep windows on a
  // hexagonal cell and compare against a bound-free brute force.
  const hexCell: UnitCell = { a: 5, b: 5, c: 4, alpha: 90, beta: 90, gamma: 120 };
  const atoms = [atom([0, 0, 0]), atom([1 / 3, 2 / 3, 0.5])];

  it("finds every pair a brute-force oversized tiling finds (hexagonal)", () => {
    // rMax 53.5/58 are windows where the old axis-length bound demonstrably
    // dropped 8/12 pairs on this cell; 24 covers the everyday regime.
    for (const rMax of [24, 53.5, 58]) {
      const got = enumeratePairs(hexCell, atoms, rMax).length;
      const want = bruteForceCount(hexCell, atoms, rMax, Math.ceil(rMax / 3) + 3);
      expect(got, `rMax=${rMax}`).toBe(want);
    }
  });

  it("finds every pair on a strongly oblique triclinic cell", () => {
    // The old bound dropped 10/18 pairs at rMax 37/37.5 on this cell.
    const triclinic: UnitCell = { a: 6, b: 7, c: 5, alpha: 66, beta: 72, gamma: 115 };
    for (const rMax of [15.7, 37, 37.5]) {
      const got = enumeratePairs(triclinic, [atom([0.1, 0.2, 0.3]), atom([0.6, 0.1, 0.8])], rMax).length;
      const want = bruteForceCount(triclinic, [atom([0.1, 0.2, 0.3]), atom([0.6, 0.1, 0.8])], rMax, Math.ceil(rMax / 2) + 3);
      expect(got, `rMax=${rMax}`).toBe(want);
    }
  });
});
