import { describe, it, expect } from "vitest";
import type { SpaceGroup, UnitCell } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { magneticSatellites } from "@/core/magnetic/satellites";

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
