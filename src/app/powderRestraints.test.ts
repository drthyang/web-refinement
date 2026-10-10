import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { simulate_pattern } from "@/mcp/tools";
import { buildPowderSpec, powderRestraints } from "@/app/powderSpec";
import { compositionRestraints } from "@/core/workflow/structureRefinement";
import { runPowderRefinement } from "@/workers/runPowder";
import { buildPowderProblem } from "@/core/workflow/powder";
import { computeAgreementFactors } from "@/core/refinement/factors";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { PowderPattern } from "@/core/diffraction/types";

/** MgAl₂O₄ with inversion i: Al on the tetrahedral 8a site, Mg on the octahedral 16d. */
function spinel(i: number, ox: number): string {
  return `data_spinel
_cell_length_a 8.0841
_cell_length_b 8.0841
_cell_length_c 8.0841
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
Mg1 Mg 0.125 0.125 0.125 ${1 - i} 0.005
Al1 Al 0.125 0.125 0.125 ${i} 0.005
Al2 Al 0.5 0.5 0.5 ${1 - i / 2} 0.004
Mg2 Mg 0.5 0.5 0.5 ${i / 2} 0.004
O1 O ${ox} ${ox} ${ox} 1 0.0065
`;
}

const NEUTRON: InstrumentParameters = { kind: "constantWavelength", radiationKind: "neutron", wavelength: 1.5398, zero: 0, u: 20, v: -20, w: 20, x: 0, y: 1 };

describe("occupancy restraints from the site ties", () => {
  it("holds each element on two or more sites at its total in the cell", () => {
    const r = compositionRestraints(parseCif(spinel(0, 0.25)));
    expect(r.map((x) => [x.id, x.target, x.terms.map((t) => `${t.coefficient}·${t.parameterId}`)])).toEqual([
      ["comp_Mg", 8, ["8·occ_Mg1", "16·occ_Mg2"]],
      ["comp_Al", 16, ["8·occ_Al1", "16·occ_Al2"]],
    ]);
    expect(r[0]!.sigma).toBeCloseTo(0.16);
  });

  it("sends only restraints over a free occupancy, phase-prefixed when multi-phase", () => {
    const s = parseCif(spinel(0, 0.25));
    const spec = buildPowderSpec(s, { id: "p", name: "p", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 }, points: [{ x: 10, yObs: 1 }, { x: 20, yObs: 1 }] }, NEUTRON);
    const occFree = spec.params.map((p) => (p.id === "occ_Al1" ? { ...p, fixed: false } : { ...p, fixed: p.kind === "occupancy" ? true : p.fixed }));
    expect(powderRestraints([s], { composition: true }, spec.params.map((p) => ({ ...p, fixed: true })))).toEqual([]);
    expect(powderRestraints([s], { composition: true }, occFree).map((r) => r.id)).toEqual(["occ_sum_Mg1", "comp_Al"]);
    expect(powderRestraints([s], {}, occFree).map((r) => r.id)).toEqual(["occ_sum_Mg1"]);
    const multi = powderRestraints([s, s], {}, occFree.map((p) => ({ ...p, id: `p1_${p.id}` })));
    expect(multi.map((r) => [r.id, r.terms.map((t) => t.parameterId)])).toEqual([["p1_occ_sum_Mg1", ["p1_occ_Mg1", "p1_occ_Al1"]]]);
  });

  it("refines a spinel's inversion from a normal-spinel start, with the composition held", () => {
    const truth = parseCif(spinel(0.22, 0.2618));
    const sim = simulate_pattern({ structure: truth, instrument: NEUTRON, xMin: 15, xMax: 140, points: 2500 });
    const k = 5000 / Math.max(...sim.curves.yCalc);
    const pattern: PowderPattern = {
      id: "spinel", name: "spinel", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.5398 },
      points: sim.curves.x.map((x, i) => {
        const y = k * sim.curves.yCalc[i]! + 200;
        return { x, yObs: y, sigma: Math.sqrt(y) };
      }),
    };
    const start = parseCif(spinel(0, 0.2618));
    const spec = buildPowderSpec(start, pattern, NEUTRON, true, 2);
    const free = new Set(["scale", "bkg0", "occ_Mg1", "occ_Al1", "occ_Al2", "occ_Mg2"]);
    const parameters = spec.params.map((p) => ({ ...p, fixed: !free.has(p.id) }));
    const restraints = powderRestraints([start], { composition: true }, parameters);
    expect(restraints).toHaveLength(4);
    const r = runPowderRefinement({ type: "refinePowder", requestId: 0, structure: start, pattern, parameters, bindings: spec.bindings, shape: spec.profile.shape, restraints, options: { maxIterations: 30 } });
    const v = r.parameters;
    expect(v.occ_Al1).toBeCloseTo(0.22, 2);
    expect(v.occ_Mg1).toBeCloseTo(0.78, 2);
    expect(v.occ_Mg2).toBeCloseTo(0.11, 2);
    expect(v.occ_Al2).toBeCloseTo(0.89, 2);
    // The agreement factors describe the data alone, not the restraint rows.
    const plain = buildPowderProblem(start, pattern, parameters, spec.bindings, { shape: spec.profile.shape });
    const values = Object.fromEntries(parameters.map((p) => [p.id, v[p.id] ?? p.value]));
    const data = computeAgreementFactors(plain.observations, plain.calculate(values), plain.weights, free.size);
    expect(r.agreement.rWeighted! / data.rWeighted!).toBeCloseTo(1, 6);
  });
});
