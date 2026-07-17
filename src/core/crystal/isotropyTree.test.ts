/**
 * Gates for the Γ isotropy machinery (subgroup tree, Phase 3a):
 *  - isotypic projector dimensions match the decomposition (mult·dim);
 *  - the stabilizer of a z-polar field on cubic BaTiO₃ is P4mm, identified as
 *    IT #99 by DIRECT op-set match; the x-polar variant identifies as #99 via
 *    a PERMUTED SETTING — the textbook OP-direction dependence;
 *  - realizeSubgroup reproduces the textbook Wyckoff splitting
 *    (Pm-3m O 3c → P4mm 1b + 2c: apical vs equatorial oxygens);
 *  - activateDisplacementMode end-to-end: the seeded mode enters active, the
 *    zero-amplitude child reproduces the parent, and a synthetic-G(r)
 *    refinement recovers a frozen amplitude — the full requirement-(3) loop.
 */
import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { refine } from "@/core/refinement/engine";
import { applyParameters } from "@/core/workflow/apply";
import { buildPdfSpec, buildPdfProblem } from "@/core/workflow/pdf";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { decomposeDisplacementRepresentation } from "@/core/crystal/displaciveModes";
import { withDistortionModes } from "@/core/crystal/distortionModes";
import {
  projectIsotypicModes,
  stabilizerOfField,
  identifySubgroup,
  realizeSubgroup,
  activateDisplacementMode,
  type DisplacementField,
} from "@/core/crystal/isotropyTree";

const CUBIC: UnitCell = { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 };

function site(label: string, element: string, position: readonly [number, number, number]): AtomSite {
  return { label, element, position, occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } };
}

function batio3(): StructureModel {
  return {
    id: "bto", name: "BaTiO3", cell: CUBIC,
    spaceGroup: buildSpaceGroup(221),
    sites: [
      site("Ba1", "Ba", [0, 0, 0]),
      site("Ti1", "Ti", [0.5, 0.5, 0.5]),
      site("O1", "O", [0, 0.5, 0.5]),
    ],
  };
}

/** A polar field along `dir`: Ba +0.3, Ti +1, all three O −0.5 (arbitrary
 *  distinct magnitudes — any generic polar OP along one axis). */
function polarField(dir: 0 | 1 | 2): DisplacementField {
  const u = (m: number): Vec3 => {
    const v: [number, number, number] = [0, 0, 0];
    v[dir] = m;
    return v;
  };
  return {
    atoms: [
      { position: [0, 0, 0], u: u(0.3) },
      { position: [0.5, 0.5, 0.5], u: u(1) },
      { position: [0, 0.5, 0.5], u: u(-0.5) },
      { position: [0.5, 0, 0.5], u: u(-0.5) },
      { position: [0.5, 0.5, 0], u: u(-0.5) },
    ],
  };
}

describe("isotypic projector dimensions", () => {
  const s = batio3();
  const dec = decomposeDisplacementRepresentation(s);

  it("each term's isotypic basis has multiplicity·dim vectors (Σ = 15)", () => {
    let total = 0;
    for (const term of dec.terms) {
      const modes = projectIsotypicModes(s, undefined, term, s.spaceGroup.operations);
      expect(modes).toHaveLength(term.multiplicity * (term.irrep.dim ?? 1));
      total += modes.length;
    }
    expect(total).toBe(15);
  });
});

describe("stabilizer + subgroup identification (OP-direction dependence)", () => {
  const s = batio3();

  it("a z-polar field's isotropy subgroup is P4mm (#99), matched DIRECTLY", () => {
    const subOps = stabilizerOfField(polarField(2), s.spaceGroup.operations);
    // 4mm about z: 8 point operations survive of Pm-3m's 48.
    expect(subOps).toHaveLength(8);
    const id = identifySubgroup(subOps, s.spaceGroup.operations);
    expect(id.number).toBe(99);
    expect(id.pointGroup).toBe("4mm");
    expect(id.index).toBe(6);
    expect(id.method).toBe("direct");
  });

  it("an x-polar field also identifies as #99, via a PERMUTED SETTING", () => {
    const subOps = stabilizerOfField(polarField(0), s.spaceGroup.operations);
    expect(subOps).toHaveLength(8);
    const id = identifySubgroup(subOps, s.spaceGroup.operations);
    expect(id.number).toBe(99);
    expect(id.method).toBe("permuted-setting");
  });
});

describe("realizeSubgroup — textbook Wyckoff splitting", () => {
  it("Pm-3m O 3c splits into apical + equatorial under z-P4mm (2 + 1)", () => {
    const s = batio3();
    const subOps = stabilizerOfField(polarField(2), s.spaceGroup.operations);
    const child = realizeSubgroup(s, subOps, identifySubgroup(subOps, s.spaceGroup.operations));
    expect(child.spaceGroup.hermannMauguin).toBeDefined();
    // Ba and Ti orbits (1 atom each) do not split; O 3c → two classes.
    const labels = child.sites.map((q) => q.label).sort();
    expect(labels).toEqual(["Ba1", "O1a", "O1b", "Ti1"]);
    const mults = child.sites
      .filter((q) => q.label.startsWith("O1"))
      .map((q) => siteMultiplicity(child.spaceGroup.operations, q.position))
      .sort();
    expect(mults).toEqual([1, 2]); // equatorial pair + apical single
    // Child cell contents unchanged: 5 atoms total.
    const total = child.sites.reduce((n, q) => n + siteMultiplicity(child.spaceGroup.operations, q.position), 0);
    expect(total).toBe(5);
  });
});

describe("activateDisplacementMode — the full requirement-(3) loop", () => {
  const parent = batio3();
  const { child, identity, modeSet } = activateDisplacementMode(parent, polarField(2), "Γ4− polar → P4mm");

  it("leading mode is active and labelled; complement inactive; gauge excluded", () => {
    expect(identity.number).toBe(99);
    const lead = modeSet.modes[0]!;
    expect(lead.active).toBe(true);
    expect(lead.label).toBe("Γ4− polar → P4mm");
    for (const m of modeSet.modes.slice(1)) expect(m.active).toBe(false);
    // In P4mm every site can follow a z translation → 1 acoustic exclusion.
    expect(modeSet.acousticExcluded ?? 0).toBeGreaterThanOrEqual(1);
    // The mode set spans the child's remaining DOF: parentized IS the child.
    expect(modeSet.parentized).toBe(child);
  });

  it("zero amplitude reproduces the parent geometry exactly", () => {
    const zero: Record<string, number> = {};
    for (const p of modeSet.parameters) zero[p.id] = 0;
    const applied = applyParameters(child, modeSet.bindings, zero).model;
    for (const s of applied.sites) {
      const src = child.sites.find((q) => q.label === s.label)!;
      for (let i = 0; i < 3; i++) expect(s.position[i]).toBeCloseTo(src.position[i]!, 12);
    }
  });

  it("a frozen amplitude is recovered from synthetic G(r) by refining mode 1 alone", () => {
    const A = 0.08; // Å whole-cell amplitude of the activated (optic) mode
    const leadId = modeSet.parameters[0]!.id;
    const truth = applyParameters(child, modeSet.bindings, { [leadId]: A }).model;
    const rGrid = makeRGrid(0.5, 10, 0.03);
    const g = computeGofR(truth.cell, expandStructureAtoms(truth), rGrid, {
      scatteringType: "neutron", scale: 1, qdamp: 0.03, qbroad: 0, delta1: 0, delta2: 0,
    });
    const pattern: PdfPattern = {
      id: "t", name: "t", scatteringType: "neutron",
      points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })), qdamp: 0.03,
    };
    const spec = buildPdfSpec(child, pattern);
    const swapped = withDistortionModes({ params: spec.params, bindings: spec.bindings }, modeSet);
    // REAL PHYSICS: the parent is centrosymmetric and this mode is polar
    // (inversion-odd), so χ²(a) = χ²(−a) — amplitude 0 is an exact stationary
    // point (±a are inversion domains with identical G(r)) and no
    // gradient-based method can leave it. Kick the amplitude off zero, as
    // every ISODISTORT-style workflow does.
    const KICK = 0.02;
    const params = swapped.params.map((p) =>
      p.id === leadId
        ? { ...p, value: KICK }
        : p.kind === "cellLength" || p.kind === "cellAngle"
          ? { ...p, fixed: true }
          : p,
    );
    // Only the activated mode is free among positions (active:true default).
    expect(params.filter((p) => !p.fixed && p.kind === "positionShift").map((p) => p.id)).toEqual([leadId]);
    const res = refine(buildPdfProblem(child, pattern, params, swapped.bindings, spec.restraints), {
      maxIterations: 40, convergenceTolerance: 1e-10,
    });
    expect(["converged", "stalled"]).toContain(res.status);
    expect(res.parameters[leadId]!).toBeCloseTo(A, 3);
    expect(res.agreement.rWeighted ?? 1).toBeLessThan(0.005);
  });
});
