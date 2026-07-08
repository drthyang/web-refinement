import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/highEntropyWO4";
import { magneticIonCandidates, siteIonId } from "@/core/magnetic/magneticIons";
import type { StructureModel } from "@/core/crystal/types";

describe("magnetic-ion detection", () => {
  it("selects the magnetic 3d cations of AWO4 and excludes Zn / W / O", () => {
    const cands = magneticIonCandidates(exampleStructure());
    const labels = cands.map((c) => c.siteLabel).sort();
    // Co, Fe, Ni, Mn, Cu are magnetic (in the ⟨j0⟩ table); Zn²⁺ (d¹⁰), W, O are not.
    expect(labels).toEqual(["Co1", "Cu8", "Fe1", "Mn1", "Ni1"]);
    expect(labels).not.toContain("Zn1");
    expect(labels).not.toContain("W1");
    expect(labels).not.toContain("O1");
  });

  it("derives the ion id from element + oxidation state (default 2+)", () => {
    const site = { label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } } as const;
    expect(siteIonId(site)).toBe("Fe3");
    const { oxidationState: _ox, ...site2 } = site; // no oxidation state → default 2+
    expect(siteIonId(site2)).toBe("Fe2");
  });

  it("returns nothing for a purely non-magnetic structure", () => {
    const nacl: StructureModel = {
      id: "nacl", name: "NaCl",
      cell: { a: 5.64, b: 5.64, c: 5.64, alpha: 90, beta: 90, gamma: 90 },
      spaceGroup: { operations: [] },
      sites: [
        { label: "Na1", element: "Na", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
        { label: "Cl1", element: "Cl", position: [0.5, 0.5, 0.5], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
      ],
    };
    expect(magneticIonCandidates(nacl)).toHaveLength(0);
  });
});
