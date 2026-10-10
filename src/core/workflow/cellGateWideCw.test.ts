import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { check_cell_symmetry, parse_instrument, parse_powder_data, parse_structure } from "@/mcp/tools";

/**
 * A wide constant-wavelength pattern (Mn₃Ga 30 K, 2θ 5–130°): high-angle peaks
 * are several times broader than low-angle ones. With one Le Bail width their
 * flanks read as an unindexed peak at 120.6° and the gate failed on the right
 * cell; the width now grows with angle.
 */
describe("the cell gate on a wide 2θ range", () => {
  it("indexes every peak of the right cell", () => {
    const read = (f: string): string => readFileSync(`examples/mcp/${f}`, "utf8");
    const { structure } = parse_structure({ cif: read("mn3ga_30k_nuclear.cif") });
    const { pattern } = parse_powder_data({ text: read("mn3ga_30k_sim.xye"), filename: "mn3ga_30k_sim.xye" });
    const instrument = parse_instrument({ text: read("mn3ga_30k.instprm") });
    const gate = check_cell_symmetry({ structure, pattern, instrument });
    expect(gate.unindexedPeaks).toEqual([]);
    expect(gate.passed).toBe(true);
  });
});
