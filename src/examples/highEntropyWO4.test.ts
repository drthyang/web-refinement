import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/highEntropyWO4";

/**
 * The bundled fallback structure must always parse, since it is the app's
 * default when the git-ignored data/ folder (the POWGEN pattern) is absent —
 * e.g. on a fresh deploy. Not data-gated: it exercises the embedded CIF only.
 */
describe("bundled default: high-entropy (Co,Cu,Fe,Mn,Ni,Zn)WO₄", () => {
  it("parses to the monoclinic P2/c high-entropy tungstate", () => {
    const s = exampleStructure();
    expect(s.id).toBe("highentropy");
    expect(s.spaceGroup.hermannMauguin).toBe("P 2/c");
    expect(s.spaceGroup.number).toBe(13);
    expect(s.spaceGroup.operations.length).toBe(4);
    expect(s.cell.a).toBeCloseTo(4.6757, 3);
    expect(s.cell.beta).toBeCloseTo(89.312, 3);
    expect(s.sites).toHaveLength(9);
  });

  it("has the six 3d cations disordered on one site at occ ≈ 1/6", () => {
    const s = exampleStructure();
    const cations = ["Co1", "Fe1", "Ni1", "Mn1", "Cu8", "Zn1"].map((l) => s.sites.find((x) => x.label === l));
    for (const c of cations) {
      expect(c).toBeDefined();
      expect(c!.occupancy).toBeCloseTo(0.167, 3);
      expect(c!.adp.kind).toBe("isotropic");
    }
    const p0 = cations[0]!.position;
    for (const c of cations) expect(c!.position).toEqual(p0);
  });
});
