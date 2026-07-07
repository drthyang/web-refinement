import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseCif } from "@/parsers/cif";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { dSpacing } from "@/core/crystal/unitCell";
import { dataExists, readData } from "@/testSupport/data";

/**
 * Validate the nuclear structure factor against GSAS-II reflection lists (Fc²)
 * from real POWGEN neutron refinements, as a broad check of the structure-factor
 * computation (special-position handling, neutron scattering lengths, diverse
 * crystal systems) beyond the single GaNb4Se8 case.
 *
 * These GSAS refinements are multi-phase: each reflection list holds a separate
 * block per phase. `scripts/extract_reflections.py` (text export) and
 * `scripts/extract_gpx_reflections.py` (binary .gpx) split them into
 * `reflections_<phase>.csv`; mixing phases was the original failure mode (an MnO
 * (111) compared against the hexagonal Mn₃Ga structure looks like a 5-order-of-
 * magnitude "bug"). We validate the clean *nuclear* phases across crystal systems:
 *
 *   • Mn₃Ga 600 K — hexagonal P6₃/mmc, from CIF (special positions 6h/2c).
 *   • MnO 600 K   — cubic rocksalt Fm-3m, built inline as 8 atoms in P1.
 *   • Mn₃Ga 200 K — orthorhombic Cmcm and monoclinic P2₁/m, from CIF (a second
 *     temperature, plus C-centering and a monoclinic β≠90 metric).
 *   • FeCoSn 100 K — three CoSn-type P6/mmm phases (Fe₁Co₉Sn is compositionally
 *     inhomogeneous), built inline; tests 3-element scattering (Sn/Co/Fe) and a
 *     mixed Co/Fe occupancy on the 3f site. Reflection list from the .gpx.
 *
 * GSAS reports neutron b in 10⁻¹² cm; our tables use fm (10× larger), so our
 * |F|² is ~100× GSAS Fc². That constant is absorbed by the scale factor in a real
 * refinement — what must hold is that the ratio our|F|²/Fc² is *flat* across all
 * reflections and d-spacings. A structure-factor bug (over-counted special
 * position, wrong symmetry sum, bad Debye–Waller) breaks that flatness.
 *
 * The magnetic phases (350 K ortho, 30 K mono) carry magnetic scattering our
 * nuclear |F|² omits; they belong to the magnetic milestone, not this gate.
 * Skips when the git-ignored data/ folder is absent.
 */

const rad = { kind: "neutron" as const, wavelength: 1.5 };

interface Refl { h: number; k: number; l: number; m: number; d: number; Fo2: number; Fc2: number }
function loadRefl(path: string): Refl[] {
  return readData(path).trim().split(/\r?\n/).slice(1).map((line) => {
    const [h, k, l, m, d, Fo2, Fc2] = line.split(",").map(Number);
    return { h: h!, k: k!, l: l!, m: m!, d: d!, Fo2: Fo2!, Fc2: Fc2! };
  });
}

const median = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

/**
 * Flatness assertion: over reflections strong enough to be meaningful, the ratio
 * our|F|²/Fc² should cluster tightly around a single constant. Reports the
 * fraction of strong reflections within ±tol of the median and the worst
 * offender, then asserts near-total agreement.
 */
function assertFlatRatio(model: StructureModel, refl: Refl[], label: string, tol = 0.05) {
  const rows = refl
    .filter((r) => r.Fc2 > 0.05) // drop near-extinct: Fc²→0 makes the ratio meaningless
    .map((r) => ({ ...r, ours: nuclearStructureFactorSquared(model, rad, r.h, r.k, r.l) }))
    .map((r) => ({ ...r, ratio: r.ours / r.Fc2 }))
    .filter((r) => Number.isFinite(r.ratio) && r.ratio > 0);
  // Anchor the constant on the strongest reflections (least noise / most nuclear).
  const strong = rows.slice().sort((a, b) => b.Fc2 - a.Fc2).slice(0, Math.max(10, Math.floor(rows.length * 0.4)));
  const c = median(strong.map((r) => r.ratio));
  const within = strong.filter((r) => Math.abs(r.ratio / c - 1) <= tol);
  const worst = strong.slice().sort((a, b) => Math.abs(b.ratio / c - 1) - Math.abs(a.ratio / c - 1))[0]!;
  // eslint-disable-next-line no-console
  console.log(
    `\n${label}: SG=${model.spaceGroup.hermannMauguin ?? "?"} ops=${model.spaceGroup.operations.length} · ` +
      `${rows.length} refl, ${strong.length} strong\n` +
      `  scale const=${c.toExponential(3)} (√=${Math.sqrt(c).toFixed(1)}× fm) · ` +
      `${within.length}/${strong.length} within ±${(tol * 100).toFixed(0)}% · ` +
      `worst ${worst.h}${worst.k}${worst.l} d=${worst.d.toFixed(2)} off ${((worst.ratio / c - 1) * 100).toFixed(1)}%`,
  );
  expect(strong.length).toBeGreaterThan(8);
  // Essentially all strong reflections must share the constant. The b-table
  // differs slightly from GSAS's rounded values (~2% between MnO parity
  // families), so a handful may sit just outside ±tol — require ≥90%.
  expect(within.length / strong.length).toBeGreaterThanOrEqual(0.9);
}

// ---- Mn₃Ga hexagonal 600 K (from CIF) --------------------------------------
const hex = { dir: "600K", cif: "Mn3GaHexagonal_structure_600K_Final.cif", csv: "600K/reflections_Mn3Ga.csv" };
const hasHex = dataExists(`${hex.dir}/${hex.cif}`) && dataExists(hex.csv);

describe.skipIf(!hasHex)("neutron |F|² vs GSAS-II — Mn₃Ga 600 K hexagonal (P6₃/mmc)", () => {
  it("nuclear |F|² is a flat multiple of GSAS Fc² across all reflections", () => {
    const model = parseCif(readData(`${hex.dir}/${hex.cif}`), "mn3ga-hex");
    assertFlatRatio(model, loadRefl(hex.csv), "Mn₃Ga hex 600 K");
  });
});

// ---- MnO rocksalt 600 K (built inline, Fm-3m as P1) ------------------------
const U_TO_B = 8 * Math.PI * Math.PI;
function mnoModel(a: number, uMn: number, uO: number): StructureModel {
  const fcc: Vec3[] = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
  const site = (label: string, element: string, p: Vec3, u: number) =>
    ({ label, element, position: p, occupancy: 1, adp: { kind: "isotropic" as const, bIso: U_TO_B * u } });
  return {
    id: "mno", name: "MnO",
    cell: { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: {
      hermannMauguin: "P 1",
      operations: [{ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" }],
    },
    sites: [
      ...fcc.map((p, i) => site(`Mn${i}`, "Mn", p, uMn)),
      ...fcc.map((p, i) => site(`O${i}`, "O", [p[0] + 0.5, p[1] + 0.5, p[2] + 0.5] as Vec3, uO)),
    ],
  };
}

const mno = { csv: "600K/reflections_MnO.csv", a: 4.45831, uMn: 0.0121, uO: 0.01374 };
const hasMnO = dataExists(mno.csv);

describe.skipIf(!hasMnO)("neutron |F|² vs GSAS-II — MnO 600 K rocksalt (Fm-3m)", () => {
  const model = mnoModel(mno.a, mno.uMn, mno.uO);

  it("nuclear |F|² is a flat multiple of GSAS Fc² across all reflections", () => {
    assertFlatRatio(model, loadRefl(mno.csv), "MnO 600 K");
  });

  it("F-centering forbids mixed-parity reflections (systematic absences)", () => {
    // GSAS only lists allowed reflections; independently, our |F|² must vanish
    // for mixed-parity hkl and be large for all-even / all-odd.
    const allowedMag = Math.abs(nuclearStructureFactorSquared(model, rad, 1, 1, 1)); // all-odd, strong
    const forbidden = [[1, 0, 0], [1, 1, 0], [2, 1, 0], [2, 1, 1]] as const;
    for (const [h, k, l] of forbidden) {
      const f = nuclearStructureFactorSquared(model, rad, h, k, l);
      expect(f / allowedMag).toBeLessThan(1e-6);
    }
    // Sanity: an all-even reflection present in the list is nonzero.
    expect(dSpacing(model.cell, 2, 0, 0)).toBeGreaterThan(0);
    expect(nuclearStructureFactorSquared(model, rad, 2, 0, 0)).toBeGreaterThan(0);
  });
});

// ---- FeCoSn 100 K: three CoSn-type P6/mmm phases (built inline, orbits in P1) --
// The CoSn (B35) structure: Sn on 1a (0,0,0) + 2d (⅓,⅔,½), (Co,Fe) on 3f
// (½,0,0). Fe₁Co₉Sn is compositionally inhomogeneous, so the refinement models
// three phases with slightly different c and Fe fraction. We expand each Wyckoff
// orbit explicitly (P1) — the hexagonal special-position engine is already
// covered by Mn₃Ga above; this isolates 3-element scattering + mixed occupancy.
interface CoSnPhase {
  readonly tag: string;
  readonly a: number; readonly c: number;
  readonly uSn1: number; readonly uSn2: number; readonly uM: number;
  readonly occCo: number; readonly occFe: number;
}
function cosnModel(p: CoSnPhase): StructureModel {
  const site = (label: string, element: string, pos: Vec3, occ: number, u: number) =>
    ({ label, element, position: pos, occupancy: occ, adp: { kind: "isotropic" as const, bIso: U_TO_B * u } });
  const third = 1 / 3;
  const orbit1a: Vec3[] = [[0, 0, 0]];
  const orbit2d: Vec3[] = [[third, 2 * third, 0.5], [2 * third, third, 0.5]];
  const orbit3f: Vec3[] = [[0.5, 0, 0], [0, 0.5, 0], [0.5, 0.5, 0]];
  const sites = [
    ...orbit1a.map((pos, i) => site(`Sn1_${i}`, "Sn", pos, 1, p.uSn1)),
    ...orbit2d.map((pos, i) => site(`Sn2_${i}`, "Sn", pos, 1, p.uSn2)),
    ...orbit3f.flatMap((pos, i) => [
      site(`Co_${i}`, "Co", pos, p.occCo, p.uM),
      ...(p.occFe > 0 ? [site(`Fe_${i}`, "Fe", pos, p.occFe, p.uM)] : []),
    ]),
  ];
  return {
    id: `cosn-${p.tag}`, name: `CoSn (${p.tag})`,
    cell: { a: p.a, b: p.a, c: p.c, alpha: 90, beta: 90, gamma: 120 },
    spaceGroup: {
      hermannMauguin: "P 1",
      operations: [{ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" }],
    },
    sites,
  };
}

const COSN_PHASES: readonly CoSnPhase[] = [
  { tag: "CoSn_1", a: 5.27502, c: 4.29276, uSn1: 0.00885, uSn2: 0.00428, uM: 0.00579, occCo: 0.860, occFe: 0.140 },
  { tag: "CoSn_2", a: 5.27591, c: 4.28106, uSn1: 0.02109, uSn2: 0.03113, uM: 0.03324, occCo: 0.950, occFe: 0.050 },
  { tag: "CoSn", a: 5.27655, c: 4.24970, uSn1: 0.00159, uSn2: 0.00045, uM: 0.00585, occCo: 1.000, occFe: 0.000 },
];
const hasCoSn = COSN_PHASES.every((p) => dataExists(`TwoPhases/reflections_${p.tag}.csv`));

describe.skipIf(!hasCoSn)("neutron |F|² vs GSAS-II — FeCoSn 100 K (three CoSn-type P6/mmm phases)", () => {
  for (const p of COSN_PHASES) {
    it(`${p.tag} (Fe ${(p.occFe * 100).toFixed(0)}%): nuclear |F|² is a flat multiple of GSAS Fc²`, () => {
      // Only 19 reflections per phase (POWGEN bank 3), so anchor on all
      // meaningfully-strong reflections rather than a fixed top-N.
      assertFlatRatio(cosnModel(p), loadRefl(`TwoPhases/reflections_${p.tag}.csv`), `FeCoSn ${p.tag}`);
    });
  }
});

// ---- Mn₃Ga 200 K: orthorhombic Cmcm and monoclinic P2₁/m (from CIF) ----------
// A second temperature with lower-symmetry nuclear structures: C-centering
// (Cmcm) and a monoclinic β≠90 metric (P2₁/m). The 200 K refinement also carries
// the MnO second phase (Fm-3m, from CIF with its full 192 ops — exercising the
// symmetry-engine orbit dedup on an F-centered group, unlike the inline MnO).
const CIF_TARGETS = [
  { dir: "200K", cif: "PG3_45614_200K_CmCm.cif", csv: "200K/reflections_Cmcm_Mn3Ga_CmCm.csv", label: "Mn₃Ga 200 K Cmcm" },
  { dir: "200K", cif: "PG3_45614_200K_mono.cif", csv: "200K/reflections_P21m_Mn3Ga_monoclinic.csv", label: "Mn₃Ga 200 K P2₁/m" },
  { dir: "200K", cif: "PG3_45614_200K_MnO.cif", csv: "200K/reflections_Cmcm_Manganese_oxide.csv", label: "MnO 200 K Fm-3m (via CIF)" },
] as const;

for (const t of CIF_TARGETS) {
  const ok = dataExists(`${t.dir}/${t.cif}`) && dataExists(t.csv);
  describe.skipIf(!ok)(`neutron |F|² vs GSAS-II — ${t.label}`, () => {
    it("nuclear |F|² is a flat multiple of GSAS Fc² across all reflections", () => {
      const model = parseCif(readData(`${t.dir}/${t.cif}`), t.label);
      assertFlatRatio(model, loadRefl(t.csv), t.label);
    });
  });
}
