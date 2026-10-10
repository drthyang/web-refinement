import { describe, it, expect } from "vitest";
import { parse_structure } from "@/mcp/tools";
import { generateReflections } from "@/core/diffraction/reflections";
import { reviewSymmetry } from "@/core/diagnostics/symmetryReview";

/**
 * The symmetry review (the method's last step) on a refined residual: a
 * spinel declared Fd-3m whose residual keeps intensity at the d-glide's
 * forbidden 200 points to F-43m; residual on its allowed reflections — the
 * intensity misfit refinement fixes — points nowhere.
 */

const SPINEL = `data_t
_cell_length_a 8.08
_cell_length_b 8.08
_cell_length_c 8.08
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'F d -3 m:2'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_U_iso_or_equiv
Mg1 Mg 0.125 0.125 0.125 1 0.01
`;

const phase = parse_structure({ cif: SPINEL }).structure;

/** A flat refined fit with small deterministic noise, plus residual peaks at the given d. */
function residual(peaksAt: readonly number[]) {
  const n = 4000;
  const d = Array.from({ length: n }, (_, i) => 1.2 + (4.8 * i) / (n - 1));
  const yCalc = d.map(() => 1000);
  const yObs = d.map((di, i) => 1000 + 8 * Math.sin(i * 1.7) + peaksAt.reduce((s, p) => s + 400 * Math.exp(-0.5 * ((di - p) / 0.004) ** 2), 0));
  const reflections = generateReflections(phase.cell, phase.spaceGroup, 1.2, 6).map((r) => ({ d: r.d, hkl: `${r.h} ${r.k} ${r.l}`, phaseLabel: "spinel" }));
  return { d, yObs, yCalc, sigma: yCalc.map((y) => Math.sqrt(y)), reflections };
}

const family = (hkl: string): string => hkl.split(" ").map((v) => Math.abs(Number(v))).sort().join("");

describe("the symmetry review", () => {
  it("reads intensity left at a forbidden reflection and names the subgroups that allow it", () => {
    const d200 = 8.08 / 2;
    const review = reviewSymmetry([phase], residual([d200]));
    expect(review.observedForbidden.map((o) => family(o.hkl))).toEqual(["002"]);
    expect(review.observedForbidden[0]!.sigmas).toBeGreaterThan(5);
    // F-43m keeps the lattice and drops the d-glide: it allows 200, at index 2.
    const f43m = review.candidates.find((c) => c.number === 216);
    expect(f43m).toMatchObject({ index: 2, allows: [review.observedForbidden[0]!.hkl] });
    expect(review.candidates[0]!.index).toBeLessThanOrEqual(2);
    // Every candidate allows what it claims to; none keeps the d-glide's absence.
    expect(review.candidates.every((c) => c.allows.length > 0)).toBe(true);
    expect(review.candidates.some((c) => c.number === 203)).toBe(false); // Fd-3 keeps the d-glide
    expect(review.reading).toMatch(/Put this to the user: a lower symmetry is a new model, refined again from the start/);
  });

  it("does not read intensity misfit on allowed reflections as a reason to lower the symmetry", () => {
    const d111 = 8.08 / Math.sqrt(3);
    const d311 = 8.08 / Math.sqrt(11);
    const review = reviewSymmetry([phase], residual([d111, d311]));
    expect(review.observedForbidden).toEqual([]);
    expect(review.candidates).toEqual([]);
    expect(review.tested).toBeGreaterThan(5);
    expect(review.reading).toMatch(/^No forbidden reflection of .* carries intensity in the refined fit .*Nothing in the data asks for a lower symmetry/);
  });
});
