import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import { exampleStructure } from "@/examples/mn3ga";
import { exampleMagnetic } from "@/examples/mn3gaMagnetic";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { dSpacing } from "@/core/crystal/unitCell";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { nuclearPhaseTicks, magneticPhaseTicks, satellitePositionTicks } from "@/visualization/reflectionTicks";

const identity = (d: number): number => d;

describe("nuclearPhaseTicks", () => {
  const structure = exampleStructure();

  it("produces reflection ticks with hkl labels inside the d-window", () => {
    const phase = nuclearPhaseTicks(structure, 0.8, 5, identity, { id: "n", label: "Mn3Ga", color: "#000" });
    expect(phase.kind).toBe("nuclear");
    expect(phase.ticks.length).toBeGreaterThan(5);
    // Every tick's d is inside the window and carries a 3-index label.
    for (const t of phase.ticks) {
      expect(t.d).toBeGreaterThanOrEqual(0.8);
      expect(t.d).toBeLessThanOrEqual(5);
      expect(t.hkl.split(" ")).toHaveLength(3);
    }
  });

  it("maps positions through toX", () => {
    const phase = nuclearPhaseTicks(structure, 1, 5, (d) => 2 * d, { id: "n", label: "n", color: "#000" });
    // x = 2·d for each tick.
    expect(phase.ticks.every((t) => Math.abs(t.x - 2 * t.d) < 1e-9)).toBe(true);
  });

  it("drops ticks whose mapped position is non-finite", () => {
    const phase = nuclearPhaseTicks(structure, 1, 5, () => NaN, { id: "n", label: "n", color: "#000" });
    expect(phase.ticks).toHaveLength(0);
  });
});

describe("magneticPhaseTicks", () => {
  const ex = exampleMagnetic();

  it("marks reflections carrying magnetic intensity", () => {
    const phase = magneticPhaseTicks(ex.structure, ex.magnetic, 0.8, 6, identity, {
      id: "m",
      label: "magnetic",
      color: "#c2185b",
    });
    expect(phase.kind).toBe("magnetic");
    // An ordered magnetic model has at least one magnetic reflection.
    expect(phase.ticks.length).toBeGreaterThan(0);
    // Magnetic reflections sit at nuclear d-spacings (k = 0).
    for (const t of phase.ticks) expect(t.d).toBeGreaterThan(0);
  });

  it("marks AFM reflections at nuclear-extinct positions (absences don't bind F_M)", () => {
    // Body-centred cubic host, one magnetic site at the origin, and the
    // centring translation PRIMED (time reversal): the (½,½,½) image carries
    // the opposite moment. Magnetic intensity then lives exactly at the
    // nuclear-extinct h+k+l-odd positions — (001) at d = 4 — while the
    // nuclear-allowed even positions ((002) at d = 2) stay magnetically silent.
    const ops = ["x,y,z", "x+1/2,y+1/2,z+1/2"].map(parseSymmetryOperation);
    const host: StructureModel = {
      id: "i-afm", name: "i-afm",
      cell: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 },
      spaceGroup: { operations: ops },
      sites: [{ label: "M", element: "Mn", oxidationState: 2, position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.3 } }],
    };
    const magOps = [ops[0]!, { ...ops[1]!, timeReversal: -1 as const }];
    const build = buildMagneticModel(host, [0, 0, 0], ["M"], magOps, { moment: 2, tieSameSite: true });
    const amps: Record<string, number> = {};
    for (const p of build.params) amps[p.id] = p.value;
    const applied = applyMagneticMoments(build.magnetic, build.bindings, amps);
    const phase = magneticPhaseTicks(host, applied, 1.5, 6, identity, { id: "m", label: "m", color: "#c2185b" });
    expect(phase.ticks.some((t) => Math.abs(t.d - 4) < 1e-9)).toBe(true);
    expect(phase.ticks.some((t) => Math.abs(t.d - 2) < 1e-9)).toBe(false);
  });
});

describe("satellitePositionTicks", () => {
  const structure = exampleStructure();

  it("k = 0 covers every nuclear tick position", () => {
    const nuclear = nuclearPhaseTicks(structure, 1, 5, identity, { id: "n", label: "n", color: "#000" });
    const sats = satellitePositionTicks(structure, [0, 0, 0], 1, 5, identity, { id: "s", label: "s", color: "#888" });
    expect(sats.kind).toBe("magnetic");
    const satD = sats.ticks.map((t) => t.d);
    for (const t of nuclear.ticks) {
      expect(satD.some((d) => Math.abs(d - t.d) < 1e-9)).toBe(true);
    }
  });

  it("k ≠ 0 includes the pure ±k satellite and dedupes coincident positions", () => {
    const dPureK = dSpacing(structure.cell, 0.5, 0, 0);
    const sats = satellitePositionTicks(structure, [0.5, 0, 0], 1, 1.1 * dPureK, identity, { id: "s", label: "s", color: "#888" });
    // The pure (000)±k satellite (both arms collapse to one tick).
    expect(sats.ticks.filter((t) => Math.abs(t.d - dPureK) < 1e-6).length).toBe(1);
    // Deduped: strictly decreasing d (no coincident ticks).
    for (let i = 1; i < sats.ticks.length; i++) {
      expect(sats.ticks[i]!.d).toBeLessThan(sats.ticks[i - 1]!.d);
    }
  });
});
