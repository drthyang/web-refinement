import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { parseCif, parseMagneticCif } from "@/parsers/cif";
import { structureToCif, magneticStructureToMcif, formatWithEsd } from "@/core/export/cif";
import { expandMagneticSupercell } from "@/core/crystal/cellExpansion";

const structure: StructureModel = {
  id: "s",
  name: "Test Phase",
  cell: { a: 5.4321, b: 5.4321, c: 8.1234, alpha: 90, beta: 90, gamma: 120 },
  spaceGroup: {
    number: 194,
    hermannMauguin: "P 63/m m c",
    operations: [
      { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" },
      { rotation: [[-1, 0, 0], [0, -1, 0], [0, 0, -1]], translation: [0, 0, 0], xyz: "-x,-y,-z" },
    ],
  },
  sites: [
    { label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
    {
      label: "O1", element: "O", position: [0.3333, 0.6667, 0.25], occupancy: 0.8,
      adp: { kind: "anisotropic", uAniso: [0.01, 0.012, 0.008, 0.005, 0, 0] },
    },
  ],
};

describe("structureToCif — round-trips through parseCif", () => {
  const cif = structureToCif(structure);
  const back = parseCif(cif);

  it("preserves the cell", () => {
    expect(back.cell.a).toBeCloseTo(structure.cell.a, 4);
    expect(back.cell.c).toBeCloseTo(structure.cell.c, 4);
    expect(back.cell.gamma).toBeCloseTo(120, 3);
  });

  it("preserves space-group metadata and operations", () => {
    expect(back.spaceGroup.number).toBe(194);
    expect(back.spaceGroup.hermannMauguin).toBe("P 63/m m c");
    expect(back.spaceGroup.operations.map((o) => o.xyz)).toEqual(["x,y,z", "-x,-y,-z"]);
  });

  it("preserves atom sites, occupancy, and B_iso (via U_iso = B/8π²)", () => {
    const fe = back.sites.find((s) => s.label === "Fe1")!;
    expect(fe.element).toBe("Fe");
    expect(fe.position).toEqual([0, 0, 0]);
    expect(fe.occupancy).toBeCloseTo(1, 4);
    expect(fe.adp.kind).toBe("isotropic");
    if (fe.adp.kind === "isotropic") expect(fe.adp.bIso).toBeCloseTo(0.5, 3);
  });

  it("preserves anisotropic U components", () => {
    const o = back.sites.find((s) => s.label === "O1")!;
    expect(o.occupancy).toBeCloseTo(0.8, 4);
    expect(o.adp.kind).toBe("anisotropic");
    if (o.adp.kind === "anisotropic") {
      expect(o.adp.uAniso[0]).toBeCloseTo(0.01, 4);
      expect(o.adp.uAniso[3]).toBeCloseTo(0.005, 4);
    }
  });
});

describe("structureToCif — writes the model's own values, never the parameters'", () => {
  // The writer takes `params` ONLY for their esds; the numbers it prints come
  // straight off the model. Callers must therefore hand it a structure with the
  // refinement already applied. Every workbench used to pass its *starting*
  // model here, so exported CIFs carried pre-refinement coordinates annotated
  // with post-refinement uncertainties. Pinning the contract in both directions.
  const params: RefinementParameter[] = [
    { id: "cell_a", label: "a", kind: "cellLength", value: 5.9, initialValue: 5.4321, fixed: false, esd: 0.0006 },
  ];
  const bindings: ParameterBinding[] = [
    { parameterId: "cell_a", kind: "cellLength", targetId: "s", targetKey: "a" },
  ];

  it("does NOT pick up a refined value the caller left in the parameters", () => {
    const cif = structureToCif(structure, { params, bindings });
    expect(cif).toContain("_cell_length_a    5.43210(60)"); // the model's 5.4321
    expect(cif).not.toContain("5.90000");
  });

  it("writes the refined value once the caller applies it to the model", () => {
    const refined: StructureModel = { ...structure, cell: { ...structure.cell, a: 5.9 } };
    const cif = structureToCif(refined, { params, bindings });
    expect(cif).toContain("_cell_length_a    5.90000(60)");
  });
});

describe("structureToCif — standard uncertainties", () => {
  it("annotates cell and position with value(su) from refined esds", () => {
    const params: RefinementParameter[] = [
      { id: "cell_a", label: "a", kind: "cellLength", value: 5.4321, initialValue: 5.4321, fixed: false, esd: 0.0006 },
      { id: "pos_O1_0", label: "O1 z", kind: "positionShift", value: 0, initialValue: 0, fixed: false, esd: 0.0012 },
    ];
    const bindings: ParameterBinding[] = [
      { parameterId: "cell_a", kind: "cellLength", targetId: "s", targetKey: "a" },
      { parameterId: "pos_O1_0", kind: "positionShift", targetId: "s", targetKey: "O1", axis: [0, 0, 1] },
    ];
    const cif = structureToCif(structure, { params, bindings });
    // su two sig figs sets the decimals: 0.0006 → 5 dp (60); O1 z axis=(0,0,1)
    // → σz=0.0012 → 4 dp (12), while x/y have no su and stay at 5 dp.
    expect(cif).toContain("_cell_length_a    5.43210(60)");
    expect(cif).toMatch(/O1 O 0\.33330 0\.66670 0\.2500\(12\)/);
    // Values still round-trip (parser strips the su).
    const back = parseCif(cif);
    expect(back.cell.a).toBeCloseTo(5.4321, 4);
  });
});

describe("magneticStructureToMcif — round-trips through parseMagneticCif", () => {
  const magStructure: StructureModel = {
    ...structure,
    spaceGroup: {
      ...structure.spaceGroup,
      operations: [
        { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z", timeReversal: 1 },
        { rotation: [[-1, 0, 0], [0, -1, 0], [0, 0, -1]], translation: [0, 0, 0], xyz: "-x,-y,-z", timeReversal: -1 },
      ],
    },
  };
  const magnetic: MagneticModel = {
    id: "m", structureId: "s", propagation: [[0, 0, 0]],
    moments: [{ siteLabel: "Fe1", frame: "crystallographic", components: [0, 0, 3.2] }],
  };
  const mcif = magneticStructureToMcif(magStructure, magnetic, { magneticLabel: "P6_3/mm'c'" });
  const back = parseMagneticCif(mcif);

  it("emits a magnetic model with the moment recovered", () => {
    expect(back.magnetic).not.toBeNull();
    const m = back.magnetic!.moments.find((q) => q.siteLabel === "Fe1")!;
    expect(m.components[2]).toBeCloseTo(3.2, 3);
    expect(m.frame).toBe("crystallographic");
  });

  it("retains time-reversal on the magnetic operations", () => {
    const ops = back.structure.spaceGroup.operations;
    expect(ops.some((o) => o.timeReversal === -1)).toBe(true);
  });

  it("re-exporting a parsed mCIF does not double the time-reversal flag", () => {
    // Regression: parsed magnetic ops stored the 4-field string in xyz, so a
    // parse → export cycle emitted "x,y,z,+1,+1" (and every further cycle
    // appended another flag).
    const again = magneticStructureToMcif(back.structure, back.magnetic!, {});
    expect(again).not.toMatch(/,[+-]1,[+-]1"/);
    expect(again).toContain('"x,y,z,+1"');
  });

  // Regression: a magnetic model built on a structure loaded from a *nuclear*
  // CIF (spatial ops carry no BNS time-reversal flag) must still export the full
  // symmetry — the exporter used to filter on `timeReversal !== undefined`, which
  // dropped every unflagged op and left external tools reading the mCIF as P1.
  it("exports full symmetry when the structure ops carry no time-reversal flag", () => {
    const nuclear: StructureModel = {
      ...structure,
      spaceGroup: {
        ...structure.spaceGroup,
        // No timeReversal on any operation — as produced by parseCif.
        operations: structure.spaceGroup.operations.map(({ timeReversal: _t, ...o }) => o),
      },
    };
    const out = magneticStructureToMcif(nuclear, magnetic, {});
    expect(out).toContain("_space_group_symop_magn_operation.xyz");
    const rows = out.match(/"[^"]*,[+-]1"/g) ?? [];
    expect(rows).toHaveLength(nuclear.spaceGroup.operations.length);
    // Unflagged spatial ops export as unitary (+1), and round-trip.
    expect(out).toContain('"x,y,z,+1"');
    expect(parseMagneticCif(out).structure.spaceGroup.operations).toHaveLength(
      nuclear.spaceGroup.operations.length,
    );
  });

  // Regression: an in-app model (buildMagneticModel) refines in a magnetic
  // SUBGROUP of the parent nuclear group, carried on `magnetic.operations`, and
  // may split a site's orbit into independent sublattices (`orbitIndex` ≥ 2).
  // The export must write the subgroup ops — not the parent's — and give each
  // split orbit its own atom-site row so the moment loop's labels resolve.
  it("writes the model's subgroup ops and split-orbit sites for an in-app model", () => {
    const parent: StructureModel = {
      ...structure,
      spaceGroup: {
        ...structure.spaceGroup,
        // Parent nuclear group: 4 unflagged ops (parseCif style).
        operations: [
          { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" },
          { rotation: [[-1, 0, 0], [0, -1, 0], [0, 0, -1]], translation: [0, 0, 0], xyz: "-x,-y,-z" },
          { rotation: [[-1, 0, 0], [0, -1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "-x,-y,z" },
          { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, -1]], translation: [0, 0, 0], xyz: "x,y,-z" },
        ],
      },
    };
    const subgroup = [
      { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const, translation: [0, 0, 0] as const, xyz: "x,y,z", timeReversal: 1 as const },
      { rotation: [[-1, 0, 0], [0, -1, 0], [0, 0, -1]] as const, translation: [0, 0, 0] as const, xyz: "-x,-y,-z", timeReversal: -1 as const },
    ];
    const magSub: MagneticModel = {
      id: "m", structureId: "s", propagation: [[0, 0, 0]],
      operations: subgroup,
      moments: [
        { siteLabel: "Fe1", frame: "crystallographic", components: [0, 0, 3.2] },
        // Split orbit: same site label, anchored at the orbit representative.
        { siteLabel: "Fe1", frame: "crystallographic", components: [0, 0, -3.2], orbitIndex: 2, position: [0.5, 0.5, 0.5] },
      ],
    };
    const out = magneticStructureToMcif(parent, magSub, {});
    // Symop loop = the 2 subgroup ops with their θ signs, not the 4 parent ops.
    const rows = out.match(/"[^"]*,[+-]1"/g) ?? [];
    expect(rows).toEqual(['"x,y,z,+1"', '"-x,-y,-z,-1"']);
    // The split orbit becomes its own atom-site row at the orbit position…
    expect(out).toMatch(/Fe1_o2 Fe 0\.50000 0\.50000 0\.50000/);
    // …and the moment loop references it.
    const back = parseMagneticCif(out);
    const labels = back.magnetic!.moments.map((m) => m.siteLabel).sort();
    expect(labels).toEqual(["Fe1", "Fe1_o2"]);
    expect(back.structure.sites.map((s) => s.label)).toContain("Fe1_o2");
  });
});

// The user's bug: a commensurate k ≠ 0 structure exported a 1×1×1 parent cell
// with the moment unmodulated (k as a comment), so external tools — and the
// numbers on the page — disagreed with the app's 3D view, which shows the k-phase
// alternation across the magnetic supercell. The exporter now writes the magnetic
// supercell (cell enlarged, atoms + moments expanded) through the SAME
// θ·det(R)·cos(2π k·(L+n))·R·m expansion the viewer draws.
describe("magneticStructureToMcif — commensurate k builds the magnetic supercell", () => {
  const I3: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const afm: StructureModel = {
    id: "sc", name: "AFM Test",
    cell: { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { number: 1, hermannMauguin: "P 1", operations: [{ rotation: I3, translation: [0, 0, 0], xyz: "x,y,z" }] },
    sites: [{ label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.3 } }],
  };
  const magK: MagneticModel = {
    id: "mk", structureId: "sc", propagation: [[0, 0, 0.5]],
    operations: [{ rotation: I3, translation: [0, 0, 0], xyz: "x,y,z", timeReversal: 1 }],
    moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: [0, 0, 3] }],
  };

  it("doubles the cell along the k-axis and records the parent + k provenance", () => {
    const mcif = magneticStructureToMcif(afm, magK, {});
    expect(mcif).toContain("_cell_length_c    10.00000"); // 5 × 2 (k = ½ along c)
    expect(mcif).toContain("_cell_length_a    4.00000"); // a, b unchanged
    expect(mcif).toContain("_parent_space_group.child_transform_Pp_abc  'a,b,2c;0,0,0'");
    expect(mcif).toContain("_parent_propagation_vector.kxkykz");
    expect(mcif).toContain("[0 0 1/2]");
    expect(mcif).toContain('_parent_space_group.name_H-M_alt  "P 1"');
  });

  it("splits the atom across the two layers with opposite moments (AFM), matching the app", () => {
    const mcif = magneticStructureToMcif(afm, magK, {});
    const back = parseMagneticCif(mcif);
    // Two Mn in the doubled cell: one at z = 0, one at z = ½.
    const zs = back.structure.sites.map((s) => s.position[2]).sort();
    expect(zs[0]).toBeCloseTo(0, 4);
    expect(zs[1]).toBeCloseTo(0.5, 4);
    // …carrying +3 and −3 µ_B (cos(2π·½·L): +1 at L=0, −1 at L=1).
    const mz = back.magnetic!.moments.map((m) => m.components[2]).sort((p, q) => p - q);
    expect(mz[0]).toBeCloseTo(-3, 3);
    expect(mz[1]).toBeCloseTo(3, 3);
  });

  it("propagates BOTH the op rotation and the k-phase into the supercell moments", () => {
    // A 2-fold about c (moment axial-rotated) AND k = (0,0,½): the four magnetic
    // atoms exercise rotation × cell-phase together. Expansion is the app's.
    const twofold: [[-1, 0, 0], [0, -1, 0], [0, 0, 1]] = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];
    const ortho: StructureModel = {
      id: "so", name: "rot",
      cell: { a: 6, b: 7, c: 8, alpha: 90, beta: 90, gamma: 90 },
      spaceGroup: {
        number: 1,
        operations: [
          { rotation: I3, translation: [0, 0, 0], xyz: "x,y,z" },
          { rotation: twofold, translation: [0, 0, 0], xyz: "-x,-y,z" },
        ],
      },
      sites: [{ label: "Mn1", element: "Mn", position: [0.2, 0.1, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.3 } }],
    };
    const mag: MagneticModel = {
      id: "m2", structureId: "so", propagation: [[0, 0, 0.5]],
      operations: [
        { rotation: I3, translation: [0, 0, 0], xyz: "x,y,z", timeReversal: 1 },
        { rotation: twofold, translation: [0, 0, 0], xyz: "-x,-y,z", timeReversal: 1 },
      ],
      moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: [1, 2, 3] }],
    };
    const exp = expandMagneticSupercell(ortho, mag)!;
    expect(exp.n).toEqual([1, 1, 2]);
    // Key each expanded moment by its supercell position (rounded) for lookup.
    const key = (p: readonly number[]): string => p.map((v) => v.toFixed(2)).join(",");
    const byPos = new Map(exp.atoms.filter((a) => a.moment).map((a) => [key(a.site.position), a.moment!]));
    const near = (pos: number[], want: number[]): void => {
      const m = byPos.get(key(pos))!;
      expect(m).toBeDefined();
      want.forEach((w, i) => expect(m[i]).toBeCloseTo(w, 6));
    };
    // Identity orbit member: +m at layer 0, −m at layer ½ (k-phase).
    near([0.2, 0.1, 0], [1, 2, 3]);
    near([0.2, 0.1, 0.5], [-1, -2, -3]);
    // 2-fold image (R·m = (−1,−2,3)): +R·m at layer 0, −R·m at layer ½.
    near([0.8, 0.9, 0], [-1, -2, 3]);
    near([0.8, 0.9, 0.5], [1, 2, -3]);
  });

  it("k = 0 keeps the 1×1×1 parent cell (no supercell)", () => {
    expect(expandMagneticSupercell(afm, { ...magK, propagation: [[0, 0, 0]] })).toBeNull();
  });
});

describe("formatWithEsd", () => {
  it("renders the su to two significant figures at the value's last place", () => {
    expect(formatWithEsd(5.4321, 0.0006, 5)).toBe("5.43210(60)");
    expect(formatWithEsd(0.25, 0.0012, 5)).toBe("0.2500(12)");
    expect(formatWithEsd(1.234, 0.05, 4)).toBe("1.234(50)");
  });
  it("falls back to fixed decimals with no su", () => {
    expect(formatWithEsd(0.3333, undefined, 5)).toBe("0.33330");
    expect(formatWithEsd(0.3333, 0, 5)).toBe("0.33330");
  });
});
