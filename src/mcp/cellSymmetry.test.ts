import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check_cell_symmetry, parse_instrument, parse_powder_data, parse_structure, simulate_pattern } from "@/mcp/tools";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { MN3GA_CIF } from "@/examples/mn3ga";
import { dataDir } from "@/testSupport/data";

/**
 * The cell / space-group gate (core/workflow/cellSymmetryCheck.ts) on the
 * failures it exists to catch — a wrong centring, a wrong lattice — and on real
 * data, where false alarms would make it useless.
 */

const cif = (sg: string, a: number, c: number, sites: string): string => `data_t
_cell_length_a ${a}
_cell_length_b ${a}
_cell_length_c ${c}
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M '${sg}'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_U_iso_or_equiv
${sites}
`;
const CSCL_SITES = "Cs1 Cs 0 0 0 1 0.01\nCl1 Cl 0.5 0.5 0.5 1 0.01";
const structureOf = (text: string): StructureModel => parse_structure({ cif: text }).structure;

/**
 * An X-ray pattern of the phases (each scaled to its weight × 20 000 counts at
 * its strongest peak) on a sloping background, with seeded Poisson noise added
 * ONCE so each point's σ is its true noise: pseudo-Voigt peaks with Caglioti
 * widths (the app's own model), so the gate's one-width Le Bail fit meets real
 * peak-shape mismatch.
 */
function observed(...phases: readonly [StructureModel, number][]): PowderPattern {
  let seed = 12345;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gauss = (): number => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sims = phases.map(([s, w]) => {
    const sim = simulate_pattern({ structure: s, xMin: 10, xMax: 110, points: 5000 });
    const top = Math.max(...sim.curves.yCalc);
    return { x: sim.curves.x, y: sim.curves.yCalc.map((v) => (20000 * w * v) / top) };
  });
  return {
    id: "p", name: "sim", xUnit: "twoTheta", radiation: { kind: "xray", wavelength: 1.54 }, wavelength: 1.54,
    points: sims[0]!.x.map((x, i) => {
      const y = sims.reduce((sum, s) => sum + s.y[i]!, 300 - 1.5 * x);
      return { x, yObs: y + Math.sqrt(y) * gauss(), sigma: Math.sqrt(y) };
    }),
  };
}

describe("check_cell_symmetry — synthetic failures", () => {
  const cscl = structureOf(cif("P m -3 m", 4.12, 4.12, CSCL_SITES));
  const pattern = observed([cscl, 1]);

  it("passes the right cell and group", () => {
    const r = check_cell_symmetry({ structure: cscl, pattern });
    expect(r.passed).toBe(true);
    expect(r.unindexedPeaks).toEqual([]);
    expect(r.cell.a).toBeCloseTo(4.12, 3);
  });

  it("a centring the crystal lacks: CsCl declared body-centred violates h+k+l odd, 100 strongest", () => {
    const bcc = structureOf(cif("I m -3 m", 4.12, 4.12, "Cs1 Cs 0 0 0 1 0.01"));
    const r = check_cell_symmetry({ structure: bcc, pattern });
    expect(r.passed).toBe(false);
    expect(r.everyPeakIndexes).toBe(true); // every line sits on a reflection — of the forbidden kind
    expect(r.absencesConsistent).toBe(false);
    expect(r.absences.violated[0]).toMatchObject({ h: 1, k: 0, l: 0 });
    for (const v of r.absences.violated) expect((v.h + v.k + v.l) % 2).not.toBe(0);
    expect(r.absences.violated.length).toBeGreaterThanOrEqual(5);
  });

  it("a wrong lattice: a tetragonal crystal declared cubic leaves peaks unindexed", () => {
    const truth = structureOf(cif("P 4/m m m", 4.0, 4.4, CSCL_SITES));
    const cubic = structureOf(cif("P m -3 m", 4.0, 4.0, CSCL_SITES));
    const r = check_cell_symmetry({ structure: cubic, pattern: observed([truth, 1]) });
    expect(r.everyPeakIndexes).toBe(false);
    expect(r.unindexedPeaks.length).toBeGreaterThan(10);
  });

  it("a second phase's lines index once the phase is named", () => {
    // Two-phase data (CsCl + a larger NaCl-type cell), checked as CsCl alone.
    const other = structureOf(cif("F m -3 m", 5.64, 5.64, "Na1 Na 0 0 0 1 0.01\nCl1 Cl 0.5 0.5 0.5 1 0.01"));
    const mixed = observed([cscl, 1], [other, 0.5]);
    expect(check_cell_symmetry({ structure: cscl, pattern: mixed }).everyPeakIndexes).toBe(false);
    expect(check_cell_symmetry({ structure: cscl, pattern: mixed, extraPhases: [other] }).everyPeakIndexes).toBe(true);
  });

  it("reads only d ≥ dMin, and says so", () => {
    const r = check_cell_symmetry({ structure: cscl, pattern, dMin: 1.2 });
    expect(r.limits.some((l) => l.includes("d ≥ 1.2 Å"))).toBe(true);
    expect(() => check_cell_symmetry({ structure: cscl, pattern, dMin: 50 })).toThrow(/points lie at d ≥ 50/);
  });
});

describe("check_cell_symmetry — real data", () => {
  it("Mn₃Ga POWGEN 600 K (TOF): the MnO impurity's lines index once MnO is named", () => {
    const structure = structureOf(MN3GA_CIF);
    const pattern = parse_powder_data({
      text: readFileSync(resolve(__dirname, "../examples/datasets/mn3ga_powgen_600k.dat"), "utf8"),
      filename: "mn3ga_powgen_600k.dat",
    }).pattern;
    const instrument = { kind: "tof" as const, difC: 22585.8 };
    const mno = structureOf(cif("F m -3 m", 4.446, 4.446, "Mn1 Mn 0 0 0 1 0.01\nO1 O 0.5 0.5 0.5 1 0.01"));
    const at = (t: number): boolean => Math.abs(t / instrument.difC - 2.567) < 0.02; // MnO (111)
    const alone = check_cell_symmetry({ structure, pattern, instrument });
    const withMnO = check_cell_symmetry({ structure, pattern, instrument, extraPhases: [mno] });
    expect(alone.unindexedPeaks.some((p) => at(p.x))).toBe(true);
    expect(withMnO.unindexedPeaks.some((p) => at(p.x))).toBe(false);
    expect(withMnO.absencesConsistent).toBe(true); // P6₃/mmc's absences hold
    expect(withMnO.cell.a).toBeCloseTo(5.4194, 2);
  }, 30_000);

  const G = dataDir("GaNb4Se8_XRD");
  describe.skipIf(!existsSync(resolve(G, "GaNb4Se8_100K.cif")))("GaNb₄Se₈ at 28-ID (local data)", () => {
    // Read inside the tests: a skipped describe's body still runs at collection,
    // and the git-ignored data/ folder is absent on CI.
    const load = (): { structure: StructureModel; instrument: ReturnType<typeof parse_instrument>; pattern: PowderPattern } => {
      const read = (f: string): string => readFileSync(resolve(G, f), "utf8");
      const instrument = parse_instrument({ text: read("xrd_instrum.instprm") });
      const raw = parse_powder_data({ text: read("GaNb4Se8_799_T_298.8K_gsas.dat"), filename: "g.dat" }).pattern;
      const wavelength = instrument.kind === "constantWavelength" ? instrument.wavelength : 0;
      return { structure: structureOf(read("GaNb4Se8_100K.cif")), instrument, pattern: { ...raw, radiation: { kind: "xray", wavelength }, wavelength } };
    };

    it("the published F-43m passes: every peak indexes, no absence violated", () => {
      const { structure, instrument, pattern } = load();
      const r = check_cell_symmetry({ structure, pattern, instrument });
      expect(r.passed).toBe(true);
      expect(r.absences.tested).toBeGreaterThan(100);
    }, 30_000);

    it("declared Fd-3m, the d-glide's forbidden 200 and 420 are observed", () => {
      const { structure, instrument, pattern } = load();
      const fd = structureOf(cif("F d -3 m:2", structure.cell.a, structure.cell.a, "Ga1 Ga 0 0 0 1 0.01"));
      const r = check_cell_symmetry({ structure: fd, pattern, instrument });
      expect(r.absencesConsistent).toBe(false);
      const violated = r.absences.violated.map((v) => [v.h, v.k, v.l].map(Math.abs).sort().join(""));
      expect(violated).toContain("002");
      expect(violated).toContain("024");
    }, 30_000);
  });
});
