import { describe, it, expect } from "vitest";
import {
  bandLimit,
  extendGridForTermination,
  terminationActive,
  terminationMargin,
  uniformStep,
} from "@/core/pdf/termination";
import { sphereEnvelope, computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { IDENTITY3 } from "@/core/math/mat3";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };

/** 0-aligned grid r_k = h·(k0 + k), the PDFgetX3/Mantid shape. */
function grid(h: number, k0: number, n: number): Float64Array {
  return Float64Array.from({ length: n }, (_, k) => h * (k0 + k));
}

describe("uniformStep / terminationActive / margin", () => {
  it("detects the uniform step and rejects a warped grid", () => {
    expect(uniformStep([0.01, 0.02, 0.03, 0.04])).toBeCloseTo(0.01, 12);
    expect(uniformStep([0.01, 0.02, 0.035, 0.05])).toBeNull();
    expect(uniformStep([1])).toBeNull();
  });
  it("is inactive at/above the grid Nyquist π/h", () => {
    expect(terminationActive(25, 0.01)).toBe(true);
    expect(terminationActive(Math.PI / 0.01, 0.01)).toBe(false);
    expect(terminationActive(400, 0.01)).toBe(false);
    expect(terminationActive(0, 0.01)).toBe(false);
  });
  it("margin is 6 ripple periods", () => {
    expect(terminationMargin(30)).toBeCloseTo((6 * 2 * Math.PI) / 30, 12);
  });
});

describe("bandLimit — ideal low-pass on a uniform grid", () => {
  const h = 0.01;
  const n = 3000; // r ∈ (0, 30]
  const r = grid(h, 1, n);
  const qmax = 25;
  const margin = terminationMargin(qmax);

  it("is the identity at the grid Nyquist (sampled kernel = δ)", () => {
    const g = Float64Array.from(r, (x) => Math.sin(3 * x) + 0.2 * x);
    const out = bandLimit(g, r[0]!, h, Math.PI / h);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i]! - g[i]!));
    expect(maxDiff).toBe(0); // terminationActive gate → exact copy
  });

  it("passes an in-band sine untouched — including near r = 0 (odd reflection)", () => {
    const q0 = 2.0;
    const g = Float64Array.from(r, (x) => Math.sin(q0 * x));
    const out = bandLimit(g, r[0]!, h, qmax);
    // Interior: away from the top edge by the margin.
    let errInterior = 0;
    let errNearZero = 0;
    for (let i = 0; i < n; i++) {
      const x = r[i]!;
      const e = Math.abs(out[i]! - g[i]!);
      if (x <= margin) errNearZero = Math.max(errNearZero, e);
      else if (x < 30 - margin) errInterior = Math.max(errInterior, e);
    }
    expect(errInterior).toBeLessThan(5e-3);
    // Without the odd-reflection term this error is O(0.1–1); with it, small.
    expect(errNearZero).toBeLessThan(2e-2);
  });

  it("kills an out-of-band sine in the interior", () => {
    // q0 well above qmax: a windowed sine's spectrum has 1/(L·Δq) tails, so a
    // mode just past the cutoff legitimately keeps ~2/(L·Δq) in-band content —
    // the test uses a far mode where that bound is ≪ the tolerance.
    const g = Float64Array.from(r, (x) => Math.sin(100 * x)); // q0 = 100 ≫ qmax = 25
    const out = bandLimit(g, r[0]!, h, qmax);
    let errInterior = 0;
    for (let i = 0; i < n; i++) {
      const x = r[i]!;
      if (x > margin && x < 30 - margin) errInterior = Math.max(errInterior, Math.abs(out[i]!));
    }
    expect(errInterior).toBeLessThan(5e-3);
  });

  it("is (approximately) a projection: applying twice equals applying once", () => {
    // A band-limit is idempotent; the discrete edge truncation breaks that only
    // within the margin of the array ends.
    const g = Float64Array.from(r, (x) => Math.exp(-((x - 12) ** 2) / 0.02)); // sharp peak → strong ripple
    const once = bandLimit(g, r[0]!, h, qmax);
    const twice = bandLimit(once, r[0]!, h, qmax);
    let err = 0;
    for (let i = 0; i < n; i++) {
      const x = r[i]!;
      if (x > margin && x < 30 - margin) err = Math.max(err, Math.abs(twice[i]! - once[i]!));
    }
    const scale = Math.max(...once.map(Math.abs));
    expect(err).toBeLessThan(2e-3 * scale);
  });

  it("a sharp peak gains the sinc ripple: first zero at π/Qmax, negative sidelobe", () => {
    const rPeak = 12;
    const g = Float64Array.from(r, (x) => (Math.abs(x - rPeak) < h / 2 ? 1 : 0)); // ~δ at 12 Å
    const out = bandLimit(g, r[0]!, h, qmax);
    const at = (x: number): number => out[Math.round(x / h) - 1]!;
    // Main lobe positive, near-zero at the first sinc zero, negative in between.
    expect(at(rPeak)).toBeGreaterThan(0);
    const firstZero = Math.PI / qmax;
    expect(Math.abs(at(rPeak + firstZero))).toBeLessThan(0.05 * at(rPeak));
    expect(at(rPeak + 1.43 * firstZero)).toBeLessThan(0); // first sidelobe trough
  });
});

describe("extendGridForTermination", () => {
  it("extends by the margin both ways on the same lattice, clamped above r = 0", () => {
    const { rExt, offset } = extendGridForTermination(0.5, 0.01, 100, 30);
    const margin = terminationMargin(30); // 1.26 Å > r0 → downward extension clamps at the first grid point above 0
    expect(rExt[offset]).toBeCloseTo(0.5, 10);
    expect(rExt[0]).toBeGreaterThan(0);
    expect(rExt[0]!).toBeCloseTo(0.01, 10);
    expect(rExt[rExt.length - 1]!).toBeGreaterThanOrEqual(0.5 + 99 * 0.01 + margin - 0.011);
    // Lattice preserved: same step throughout.
    expect(rExt[1]! - rExt[0]!).toBeCloseTo(0.01, 12);
  });
  it("a grid already starting near 0 only extends up", () => {
    const { rExt, offset } = extendGridForTermination(0.01, 0.01, 100, 30);
    expect(offset).toBe(0);
    expect(rExt[0]).toBeCloseTo(0.01, 12);
    expect(rExt.length).toBeGreaterThan(100);
  });
});

describe("sphereEnvelope (spdiameter)", () => {
  it("matches the PDFfit2 characteristic function", () => {
    expect(sphereEnvelope(0, 10)).toBe(1);
    expect(sphereEnvelope(5, 10)).toBeCloseTo(1 - 1.5 * 0.5 + 0.5 * 0.125, 12);
    expect(sphereEnvelope(10, 10)).toBe(0);
    expect(sphereEnvelope(15, 10)).toBe(0);
    expect(sphereEnvelope(3, 0)).toBe(1); // disabled
  });

  it("multiplies the whole G(r): zero beyond the diameter, scaled inside", () => {
    const cell: UnitCell = { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 };
    const sites: AtomSite[] = [{ label: "A", element: "C", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.3 } }];
    const model: StructureModel = { id: "s", name: "s", cell, spaceGroup: { operations: [IDENTITY_OP] }, sites };
    const atoms = expandStructureAtoms(model);
    const rGrid = makeRGrid(0.5, 12, 0.01);
    const base = { scatteringType: "neutron" as const, scale: 1, qdamp: 0, qbroad: 0, delta1: 0, delta2: 0 };
    const bulk = computeGofR(cell, atoms, rGrid, base);
    const nano = computeGofR(cell, atoms, rGrid, { ...base, spdiameter: 8 });
    for (let k = 0; k < rGrid.length; k++) {
      const r = rGrid[k]!;
      if (r >= 8) expect(Math.abs(nano[k]!)).toBe(0);
      else expect(nano[k]).toBeCloseTo(bulk[k]! * sphereEnvelope(r, 8), 10);
    }
  });
});
