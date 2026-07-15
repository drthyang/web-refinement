import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";

/**
 * Cross-site |M| tie: same moment SIZE on every sublattice of an element,
 * each keeping its own symmetry-fixed direction. Test bed: point group 222 —
 * a site on the 2z axis carries Mz only, a site on the 2x axis carries Mx
 * only, so a tied amplitude gives equal-magnitude moments along DIFFERENT
 * axes (exactly the "same size, different orientation" constraint).
 */
const ops222 = ["x,y,z", "-x,-y,z", "-x,y,-z", "x,-y,-z"].map((s) => parseSymmetryOperation(s));
const iso = { kind: "isotropic", bIso: 0.4 } as const;

const twoMn: StructureModel = {
  id: "t",
  name: "t",
  cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 2 2 2", operations: ops222 },
  sites: [
    // On the 2z axis → moment along z only (1 dof).
    { label: "Mn1", element: "Mn", oxidationState: 2, position: [0, 0, 0.3], occupancy: 1, adp: iso },
    // On the 2x axis → moment along x only (1 dof).
    { label: "Mn2", element: "Mn", oxidationState: 2, position: [0.3, 0, 0], occupancy: 1, adp: iso },
  ],
};

const norm = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);

describe("buildMagneticModel — equal-|M| tie across sites", () => {
  it("is off by default (independent amplitudes per site)", () => {
    const b = buildMagneticModel(twoMn, [0, 0, 0], ["Mn1", "Mn2"], ops222, { moment: 2 });
    expect(b.params.map((p) => p.id).sort()).toEqual(["mom_Mn1_0", "mom_Mn2_0"]);
    expect(b.magnitudeTies).toEqual([]);
  });

  it("ties the amplitudes: one shared parameter, same |M|, different directions", () => {
    const b = buildMagneticModel(twoMn, [0, 0, 0], ["Mn1", "Mn2"], ops222, { moment: 2, tieEqualMagnitude: true });
    // Mn2 shares Mn1's amplitude parameter — no mom_Mn2_0 row.
    expect(b.params.map((p) => p.id)).toEqual(["mom_Mn1_0"]);
    expect(b.params[0]!.label).toContain("=|M|");
    expect(b.magnitudeTies).toHaveLength(1);
    expect(b.magnitudeTies[0]!.element).toBe("Mn");
    expect(b.magnitudeTies[0]!.reference).toBe("Mn1");
    expect(b.magnitudeTies[0]!.members.map((m) => m.key)).toEqual(["Mn2"]);
    expect(b.magnitudeTies[0]!.skipped).toEqual([]);

    const applied = applyMagneticMoments(b.magnetic, b.bindings, { mom_Mn1_0: 3 });
    const m1 = applied.moments.find((m) => m.siteLabel === "Mn1")!.components;
    const m2 = applied.moments.find((m) => m.siteLabel === "Mn2")!.components;
    // Same size (orthorhombic cell → component norm = Cartesian norm)…
    expect(norm(m1)).toBeCloseTo(3, 6);
    expect(norm(m2)).toBeCloseTo(3, 6);
    // …along different symmetry-fixed axes.
    expect(Math.abs(m1[2]!)).toBeCloseTo(3, 6); // Mn1 ‖ z
    expect(Math.abs(m2[0]!)).toBeCloseTo(3, 6); // Mn2 ‖ x
  });

  it("flip makes a tied sublattice antiparallel without a new parameter", () => {
    const b = buildMagneticModel(twoMn, [0, 0, 0], ["Mn1", "Mn2"], ops222, {
      moment: 2, tieEqualMagnitude: true, flippedUnits: ["Mn2"],
    });
    expect(b.params).toHaveLength(1);
    expect(b.magnitudeTies[0]!.members[0]!.flipped).toBe(true);
    const applied = applyMagneticMoments(b.magnetic, b.bindings, { mom_Mn1_0: 3 });
    const m2 = applied.moments.find((m) => m.siteLabel === "Mn2")!.components;
    const seed2 = b.magnetic.moments.find((m) => m.siteLabel === "Mn2")!.components;
    // Sign flipped relative to the unflipped build (same axis, opposite sense).
    expect(norm(m2)).toBeCloseTo(3, 6);
    expect(Math.sign(m2[0]!)).toBe(-1 * Math.sign(3));
    expect(Math.sign(seed2[0]!)).toBe(-1); // seed carries the flip too
  });

  it("skips sublattices with incompatible mode geometry (different dof)", () => {
    const withGeneric: StructureModel = {
      ...twoMn,
      sites: [
        ...twoMn.sites,
        // General position → 3 dof; cannot be linearly tied to a 1-dof site.
        { label: "Mn3", element: "Mn", oxidationState: 2, position: [0.11, 0.23, 0.37], occupancy: 1, adp: iso },
      ],
    };
    const b = buildMagneticModel(withGeneric, [0, 0, 0], ["Mn1", "Mn2", "Mn3"], ops222, { moment: 2, tieEqualMagnitude: true });
    // Mn2 ties to Mn1; Mn3 keeps its own three amplitudes and is reported.
    expect(b.params.filter((p) => p.id.startsWith("mom_Mn3")).length).toBe(3);
    expect(b.params.some((p) => p.id === "mom_Mn2_0")).toBe(false);
    expect(b.magnitudeTies[0]!.members.map((m) => m.key)).toEqual(["Mn2"]);
    expect(b.magnitudeTies[0]!.skipped.map((s) => s.label)).toEqual(["Mn3"]);
  });

  it("does not tie across elements in the per-element scope", () => {
    const mixed: StructureModel = {
      ...twoMn,
      sites: [
        twoMn.sites[0]!,
        { ...twoMn.sites[1]!, label: "Fe1", element: "Fe", oxidationState: 3 },
      ],
    };
    const b = buildMagneticModel(mixed, [0, 0, 0], ["Mn1", "Fe1"], ops222, { moment: 2, tieEqualMagnitude: true });
    expect(b.params.map((p) => p.id).sort()).toEqual(["mom_Fe1_0", "mom_Mn1_0"]);
    expect(b.magnitudeTies).toEqual([]);
  });

  it('scope "all" ties across elements (the high-entropy case)', () => {
    const mixed: StructureModel = {
      ...twoMn,
      sites: [
        twoMn.sites[0]!,
        { ...twoMn.sites[1]!, label: "Fe1", element: "Fe", oxidationState: 3 },
      ],
    };
    const b = buildMagneticModel(mixed, [0, 0, 0], ["Mn1", "Fe1"], ops222, { moment: 2, tieEqualMagnitude: "all" });
    expect(b.params.map((p) => p.id)).toEqual(["mom_Mn1_0"]);
    expect(b.magnitudeTies).toHaveLength(1);
    expect(b.magnitudeTies[0]!.element).toBe("all sites");
    expect(b.magnitudeTies[0]!.reference).toBe("Mn1");
    expect(b.magnitudeTies[0]!.members.map((m) => m.key)).toEqual(["Fe1"]);
    const applied = applyMagneticMoments(b.magnetic, b.bindings, { mom_Mn1_0: 4 });
    const mn = applied.moments.find((m) => m.siteLabel === "Mn1")!.components;
    const fe = applied.moments.find((m) => m.siteLabel === "Fe1")!.components;
    expect(norm(mn)).toBeCloseTo(4, 6);
    expect(norm(fe)).toBeCloseTo(4, 6);
    expect(Math.abs(mn[2]!)).toBeCloseTo(4, 6); // Mn1 ‖ z
    expect(Math.abs(fe[0]!)).toBeCloseTo(4, 6); // Fe1 ‖ x — own direction, same size
  });

  it('scope "element" is exactly the boolean-true behaviour', () => {
    const a = buildMagneticModel(twoMn, [0, 0, 0], ["Mn1", "Mn2"], ops222, { moment: 2, tieEqualMagnitude: true });
    const b = buildMagneticModel(twoMn, [0, 0, 0], ["Mn1", "Mn2"], ops222, { moment: 2, tieEqualMagnitude: "element" });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
