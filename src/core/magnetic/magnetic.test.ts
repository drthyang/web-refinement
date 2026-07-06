import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import { perpendicularMoment, qCartesian, momentCartesian } from "@/core/magnetic/moment";
import { dot, norm } from "@/core/math/vec3";

const cubic: UnitCell = { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 };

describe("magnetic — perpendicular-moment projection", () => {
  it("removes the component parallel to Q", () => {
    // Moment along x, Q along x → M⊥ = 0.
    const mPerp = perpendicularMoment([2, 0, 0], [1, 0, 0]);
    expect(norm(mPerp)).toBeCloseTo(0, 10);
  });

  it("keeps a moment fully when perpendicular to Q", () => {
    // Moment along y, Q along x → M⊥ = M.
    const mPerp = perpendicularMoment([0, 3, 0], [1, 0, 0]);
    expect(mPerp).toEqual([0, 3, 0]);
  });

  it("produces a result orthogonal to Q in the general case", () => {
    const q: [number, number, number] = [1, 2, 3];
    const mPerp = perpendicularMoment([4, -1, 2], q);
    expect(dot(mPerp, q)).toBeCloseTo(0, 10);
  });
});

describe("magnetic — Q and moment frames", () => {
  it("computes |Q| = 2π/d for a cubic (100) reflection", () => {
    const q = qCartesian(cubic, 1, 0, 0);
    expect(norm(q)).toBeCloseTo((2 * Math.PI) / 4, 8);
  });

  it("treats crystallographic == cartesian for an orthogonal cell", () => {
    const m = momentCartesian(cubic, { siteLabel: "X", frame: "crystallographic", components: [1, 2, 3] });
    expect(m[0]).toBeCloseTo(1, 10);
    expect(m[1]).toBeCloseTo(2, 10);
    expect(m[2]).toBeCloseTo(3, 10);
  });
});
