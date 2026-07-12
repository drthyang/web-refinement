import { describe, it, expect } from "vitest";
import {
  parseSymmetryOperation,
  parseMagneticSymmetryOperation,
  applyOperation,
  siteMultiplicity,
  isReflectionAbsent,
} from "@/core/crystal/symmetry";

// The 24 general positions of P6₃/mmc, as listed in the GSAS-II CIF.
const P63MMC_XYZ = [
  "x,y,z", "x-y,x,1/2+z", "-y,x-y,z", "-x,-y,1/2+z", "y-x,-x,z", "y,y-x,1/2+z",
  "y-x,y,z", "-x,y-x,1/2+z", "-y,-x,z", "x-y,-y,1/2+z", "x,x-y,z", "y,x,1/2+z",
  "-x,-y,-z", "y-x,-x,1/2-z", "y,y-x,-z", "x,y,1/2-z", "x-y,x,-z", "-y,x-y,1/2-z",
  "x-y,-y,-z", "x,x-y,1/2-z", "y,x,-z", "y-x,y,1/2-z", "-x,y-x,-z", "-y,-x,1/2-z",
];
const P63MMC = P63MMC_XYZ.map(parseSymmetryOperation);

describe("symmetry — parsing", () => {
  it("parses a rotation+translation operation", () => {
    const op = parseSymmetryOperation("x-y,x,1/2+z");
    // First component x-y → row [1, -1, 0].
    expect(op.rotation[0]).toEqual([1, -1, 0]);
    expect(op.rotation[1]).toEqual([1, 0, 0]);
    expect(op.translation).toEqual([0, 0, 0.5]);
  });

  it("applies an operation to a coordinate", () => {
    const op = parseSymmetryOperation("-x,-y,1/2+z");
    expect(applyOperation(op, [0.1, 0.2, 0.3])).toEqual([-0.1, -0.2, 0.8]);
  });

  it("a magnetic op keeps the SPATIAL string in xyz; the flag in timeReversal", () => {
    // Regression: xyz used to store the full 4-field string ("x,-y,1/2+z,-1"),
    // so the mCIF exporter — which appends the flag — emitted "…,-1,-1" and
    // nuclear symop loops leaked a trailing ",±1".
    const op = parseMagneticSymmetryOperation("x, -y, 1/2+z, -1");
    expect(op.xyz).toBe("x,-y,1/2+z");
    expect(op.timeReversal).toBe(-1);
    expect(parseMagneticSymmetryOperation("-x,1/2+y,-z,+1").timeReversal).toBe(1);
  });
});

describe("symmetry — multiplicity (validated against GSAS-II .lst)", () => {
  it("gives Mn1 (0.167, 0.335, 0.25) multiplicity 6", () => {
    // GSAS-II lists Mn1 with mult 6 (Wyckoff 6h) in the Mn₃Ga phase.
    expect(siteMultiplicity(P63MMC, [0.16746, 0.33482, 0.25])).toBe(6);
  });

  it("gives Ga1 (1/3, 2/3, 3/4) multiplicity 2", () => {
    // GSAS-II lists Ga1 with mult 2 (Wyckoff 2d).
    expect(siteMultiplicity(P63MMC, [1 / 3, 2 / 3, 0.75])).toBe(2);
  });

  it("gives a general position multiplicity 24", () => {
    expect(siteMultiplicity(P63MMC, [0.11, 0.23, 0.37])).toBe(24);
  });
});

describe("symmetry — systematic absences", () => {
  const fCentered = [
    "x,y,z", "x,1/2+y,1/2+z", "1/2+x,y,1/2+z", "1/2+x,1/2+y,z",
  ].map(parseSymmetryOperation);

  it("marks mixed-parity reflections absent for an F lattice", () => {
    // F-centering: hkl present only if h,k,l all even or all odd.
    expect(isReflectionAbsent(fCentered, 1, 0, 0)).toBe(true);
    expect(isReflectionAbsent(fCentered, 1, 1, 0)).toBe(true);
    expect(isReflectionAbsent(fCentered, 2, 0, 0)).toBe(false);
    expect(isReflectionAbsent(fCentered, 1, 1, 1)).toBe(false);
    expect(isReflectionAbsent(fCentered, 2, 2, 0)).toBe(false);
  });
});
