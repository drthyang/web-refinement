import { describe, it, expect } from "vitest";
import type { SpaceGroup, UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { magneticSatellites } from "@/core/magnetic/satellites";
import { dSpacing } from "@/core/crystal/unitCell";

const cell: UnitCell = { a: 4, b: 5, c: 6, alpha: 90, beta: 90, gamma: 90 };
const P1: SpaceGroup = { operations: ["x,y,z"].map(parseSymmetryOperation) };
const I1: SpaceGroup = { operations: ["x,y,z", "x+1/2,y+1/2,z+1/2"].map(parseSymmetryOperation) };

describe("magneticSatellites", () => {
  it("k = 0 → integer nuclear positions inside the window, multiplicities carried", () => {
    const sats = magneticSatellites(cell, P1, [0, 0, 0], 1.5, 8);
    expect(sats.length).toBeGreaterThan(0);
    for (const s of sats) {
      expect(Number.isInteger(s.h) && Number.isInteger(s.k) && Number.isInteger(s.l)).toBe(true);
      expect(s.d).toBeGreaterThanOrEqual(1.5);
      expect(s.d).toBeLessThanOrEqual(8);
      expect(s.multiplicity).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps nuclear-extinct parents — absences do not bind F_M", () => {
    const sats = magneticSatellites(cell, I1, [0, 0, 0], 1.5, 8);
    // (001) has h+k+l odd — extinct under the body centring for the NUCLEAR
    // structure factor, but a valid magnetic position (an AFM arrangement
    // breaking the centring puts its intensity exactly there).
    expect(sats.some((s) => s.h === 0 && s.k === 0 && s.l === 1)).toBe(true);
  });

  it("k ≠ 0 seeds the pure (000)±k satellite — the longest-d magnetic peak", () => {
    const sats = magneticSatellites(cell, P1, [0.5, 0, 0], 1.5, 10);
    // d(±k) = 2a = 8 Å; the parent G = (000) is never in a reflection list, so
    // only the explicit seeding can produce these arms.
    expect(sats.some((s) => Math.abs(s.h - 0.5) < 1e-12 && s.k === 0 && s.l === 0 && Math.abs(s.d - 8) < 1e-9)).toBe(true);
    expect(sats.some((s) => Math.abs(s.h + 0.5) < 1e-12 && s.k === 0 && s.l === 0)).toBe(true);
    // Every satellite is offset by ±k from an integer G, and windowed by its own d.
    for (const s of sats) {
      expect(Math.abs(Math.abs(s.h % 1) - 0.5)).toBeLessThan(1e-9);
      expect(Number.isInteger(s.k) && Number.isInteger(s.l)).toBe(true);
      expect(s.d).toBeGreaterThanOrEqual(1.5);
      expect(s.d).toBeLessThanOrEqual(10);
    }
  });

  it("finds satellites whose parent G lies outside the satellite d-window", () => {
    // Window [2, 3] Å: parent (100) has d = 4 Å (outside), but its +k satellite
    // (1.5, 0, 0) has d = 4/1.5 ≈ 2.67 Å (inside). The widened parent window
    // must recover it.
    const sats = magneticSatellites(cell, P1, [0.5, 0, 0], 2, 3);
    expect(sats.some((s) => Math.abs(s.h - 1.5) < 1e-12 && s.k === 0 && s.l === 0)).toBe(true);
    for (const s of sats) {
      expect(s.d).toBeGreaterThanOrEqual(2);
      expect(s.d).toBeLessThanOrEqual(3);
    }
  });
});

/**
 * Total satellite WEIGHT per d-group must equal the number of DISTINCT
 * reciprocal nodes at that d — the quantity a powder pattern actually sums.
 *
 * A self-conjugate k (2k a lattice vector, i.e. k = ½-type) enumerates the same
 * node set from its +k and −k arms, which previously double-counted every
 * satellite: a silent factor-2 on the whole magnetic component. The reference
 * here is a brute-force enumeration over a full hkl sphere in P1 — deliberately
 * independent of the enumerator's parent-window/seeding logic, so it cannot
 * inherit the same mistake.
 */
describe("magneticSatellites — weight equals the distinct-node count", () => {
  /** Every distinct node G ± k with d in [dMin, dMax], counted by brute force. */
  function bruteForceNodes(c: UnitCell, k: Vec3, dMin: number, dMax: number, range = 8): Map<string, number> {
    const nodes = new Map<string, number>();
    for (let h = -range; h <= range; h++) {
      for (let kk = -range; kk <= range; kk++) {
        for (let l = -range; l <= range; l++) {
          for (const sign of [1, -1]) {
            const hh = h + sign * k[0]!;
            const kx = kk + sign * k[1]!;
            const ll = l + sign * k[2]!;
            const d = dSpacing(c, hh, kx, ll);
            if (!Number.isFinite(d) || d <= 0 || d < dMin || d > dMax) continue;
            // Key on the node itself, so the two arms landing on one node (the
            // self-conjugate case) collapse to a single entry.
            nodes.set(`${hh.toFixed(6)},${kx.toFixed(6)},${ll.toFixed(6)}`, d);
          }
        }
      }
    }
    return nodes;
  }

  /** Sum of emitted weights, grouped by d. */
  function weightByD(sats: readonly { d: number; multiplicity: number }[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of sats) {
      const key = s.d.toFixed(6);
      out.set(key, (out.get(key) ?? 0) + s.multiplicity);
    }
    return out;
  }

  /** Count of distinct brute-force nodes, grouped by d. */
  function countByD(nodes: Map<string, number>): Map<string, number> {
    const out = new Map<string, number>();
    for (const d of nodes.values()) {
      const key = d.toFixed(6);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  }

  // A cubic cell keeps the brute-force sphere small while still giving many
  // multi-node d-groups; P1 means Laue multiplicity is 1 per node, so the
  // enumerator's weights and the node counts are directly comparable.
  const cubic: UnitCell = { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 };

  for (const [label, k] of [
    ["self-conjugate k = (0,0,½)", [0, 0, 0.5]],
    ["self-conjugate k = (½,½,0)", [0.5, 0.5, 0]],
    ["two-arm k = (0,0,⅓)", [0, 0, 1 / 3]],
    ["two-arm k = (0,0,¼)", [0, 0, 0.25]],
    ["incommensurate k = (0,0,0.137)", [0, 0, 0.137]],
  ] as [string, Vec3][]) {
    it(`${label}: total weight matches distinct nodes`, () => {
      const dMin = 1.6;
      const dMax = 6;
      const sats = magneticSatellites(cubic, P1, k, dMin, dMax);
      const emitted = weightByD(sats);
      const expected = countByD(bruteForceNodes(cubic, k, dMin, dMax));

      // Same set of d values, and the same total weight at each of them.
      expect([...emitted.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [d, count] of expected) {
        expect(emitted.get(d)).toBeCloseTo(count, 9);
      }
      // And the grand total, which is what a scaled powder component integrates.
      const totalEmitted = [...emitted.values()].reduce((a, b) => a + b, 0);
      const totalExpected = [...expected.values()].reduce((a, b) => a + b, 0);
      expect(totalEmitted).toBeCloseTo(totalExpected, 9);
    });
  }

  it("self-conjugate k is an exact node list: every node once, weight 1", () => {
    const sats = magneticSatellites(cubic, P1, [0, 0, 0.5], 1.6, 20);
    expect(sats.every((s) => s.multiplicity === 1)).toBe(true);
    // No node appears twice — the dedup is global across arms and families.
    const keys = sats.map((s) => `${s.h.toFixed(6)},${s.k.toFixed(6)},${s.l.toFixed(6)}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Two-arm k keeps the representative × parent-multiplicity convention.
    const third = magneticSatellites(cubic, P1, [0, 0, 1 / 3], 1.6, 20);
    expect(third.slice(0, 2).map((s) => s.multiplicity)).toEqual([1, 1]); // (000)±k seeds
  });

  it("multi-axis self-conjugate k in a rich Laue group is exact (the constant-arm-weight trap)", () => {
    // Pmmm, k = (½,½,½): the +k arm of one Laue family coincides with the −k
    // arm of a DIFFERENT family (G′ = G + 2k), and the families have different
    // multiplicities — so no constant arm weight is correct (a ½ weight gave
    // per-d errors of 1.25–1.75×). The exact node enumeration must match the
    // brute-force sphere for every d-group.
    const OPS = ["x,y,z", "-x,-y,-z", "-x,y,z", "x,-y,z", "x,y,-z", "x,-y,-z", "-x,y,-z", "-x,-y,z"];
    const pmmm: SpaceGroup = { hermannMauguin: "P m m m", operations: OPS.map(parseSymmetryOperation) };
    const ortho: UnitCell = { a: 4, b: 5, c: 6, alpha: 90, beta: 90, gamma: 90 };

    for (const k of [[0.5, 0.5, 0.5], [0.5, 0.5, 0], [0.5, 0, 0]] as Vec3[]) {
      // Brute-force distinct nodes over the full sphere.
      const nodes = new Map<string, number>();
      for (let h = -8; h <= 8; h++) for (let kk = -8; kk <= 8; kk++) for (let l = -8; l <= 8; l++) {
        for (const s of [1, -1]) {
          const hh = h + s * k[0]!, kx = kk + s * k[1]!, ll = l + s * k[2]!;
          const d = dSpacing(ortho, hh, kx, ll);
          if (Number.isFinite(d) && d > 0 && d >= 1.6 && d <= 8) nodes.set(`${hh.toFixed(6)},${kx.toFixed(6)},${ll.toFixed(6)}`, d);
        }
      }
      const trueByD = new Map<string, number>();
      for (const d of nodes.values()) { const key = d.toFixed(6); trueByD.set(key, (trueByD.get(key) ?? 0) + 1); }

      const sats = magneticSatellites(ortho, pmmm, k, 1.6, 8);
      const emitByD = new Map<string, number>();
      for (const s of sats) { const key = s.d.toFixed(6); emitByD.set(key, (emitByD.get(key) ?? 0) + s.multiplicity); }

      expect([...emitByD.keys()].sort()).toEqual([...trueByD.keys()].sort());
      for (const [d, count] of trueByD) expect(emitByD.get(d)).toBeCloseTo(count, 9);
    }
  });

  it("k = 0 is unaffected (single arm, integer nodes, full multiplicity)", () => {
    const sats = magneticSatellites(cubic, P1, [0, 0, 0], 1.6, 6);
    expect(sats.length).toBeGreaterThan(0);
    expect(sats.every((s) => s.multiplicity >= 1)).toBe(true);
  });
});
