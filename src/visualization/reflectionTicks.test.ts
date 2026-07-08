import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/mn3ga";
import { exampleMagnetic } from "@/examples/mn3gaMagnetic";
import { nuclearPhaseTicks, magneticPhaseTicks } from "@/visualization/reflectionTicks";

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
});
