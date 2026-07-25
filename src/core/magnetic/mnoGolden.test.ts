/**
 * MnO — the canonical mPDF validation case, cross-checked against
 * diffpy.mpdf on a REAL published magnetic structure.
 *
 * This closes the P4 gate PDF_MPDF_ROADMAP §7 named but never met: "golden MnO
 * neutron PDF+mPDF (the Frandsen & Billinge 2015 reference case)". The existing
 * mpdfGolden.test.ts gates the kernel on synthetic two-spin boxes; this gates it
 * on MAGNDATA 1.31 — 32 Mn in a 2×2×2 magnetic cell, type-II AFM, 16 up / 16
 * down — the structure the mPDF literature is built on.
 *
 * Two independent failure modes are separated on purpose:
 *   1. the KERNEL (f/d given a spin configuration), against the fixture, and
 *   2. the mCIF PARSER + symmetry expansion that has to *produce* that
 *      configuration — where magCIF's two-loop group definition lives.
 */

import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import { parseMagneticCif } from "@/parsers/cif";
import { expandSpinField } from "@/core/crystal/cellExpansion";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import {
  computeNormalizedMpdf,
  computeUnnormalizedMpdf,
  formFactorEnvelope,
  j0Profile,
  netMomentPerSpin,
  type MpdfSpin,
} from "@/core/magnetic/mpdf";
import {
  MNO_CELL, MNO_PSIGMA, MNO_RSTEP, MNO_RMIN, MNO_N,
  MNO_MSQ_AVG, MNO_MOMENT_NORM, MNO_SITES, MNO_MOMENTS, MNO_F, MNO_D,
} from "@/core/magnetic/mnoGolden";

const CELL: UnitCell = { a: MNO_CELL, b: MNO_CELL, c: MNO_CELL, alpha: 90, beta: 90, gamma: 90 };

const SPINS: MpdfSpin[] = MNO_SITES.map((p, i) => ({
  position: [...p] as [number, number, number],
  moment: [...MNO_MOMENTS[i]!] as [number, number, number],
}));

function grid(): Float64Array {
  const r = new Float64Array(MNO_N);
  for (let k = 0; k < MNO_N; k++) r[k] = MNO_RMIN + k * MNO_RSTEP;
  return r;
}

/** Pearson correlation + least-squares amplitude ratio κ (golden convention). */
function corrKappa(a: ArrayLike<number>, b: ArrayLike<number>, from: number): { corr: number; kappa: number } {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let i = from; i < a.length; i++) {
    sa += a[i]!; sb += b[i]!;
    saa += a[i]! * a[i]!; sbb += b[i]! * b[i]!; sab += a[i]! * b[i]!;
    n++;
  }
  const cov = sab - (sa * sb) / n;
  return { corr: cov / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n)), kappa: sab / sbb };
}

describe("MnO (MAGNDATA 1.31) — mPDF kernel vs diffpy.mpdf", () => {
  it("the fixture is the published type-II AFM: 32 Mn, 16 up / 16 down, 5.66 µ_B", () => {
    expect(SPINS).toHaveLength(32);
    for (const s of SPINS) expect(Math.hypot(...s.moment)).toBeCloseTo(MNO_MOMENT_NORM, 6);
    const up = SPINS.filter((s) => s.moment[2] < 0).length;
    expect(up).toBe(16); // fully compensated
    // Compensation is what makes the net-moment line vanish; if it did not, the
    // −4πrρ₀m̄² term would dominate and the f(r) gate below would be meaningless.
    expect(netMomentPerSpin(SPINS)).toBeLessThan(1e-12);
  });

  it("f(r) reproduces calculatemPDF to machine precision", () => {
    const r = grid();
    const f = computeNormalizedMpdf(CELL, SPINS, r, { psigma: MNO_PSIGMA });
    const peak = MNO_F.reduce((m, y) => Math.max(m, Math.abs(y)), 0);
    let maxDiff = 0;
    let maxDiffAway = 0; // excluding the r = 0 singularity guard
    for (let k = 0; k < MNO_N; k++) {
      const diff = Math.abs(f[k]! - MNO_F[k]!);
      maxDiff = Math.max(maxDiff, diff);
      if (r[k]! >= 0.5) maxDiffAway = Math.max(maxDiffAway, diff);
    }
    // A faithful port — same binning, same Gaussian kernel, same 3/(2N)
    // normalization — so away from r = 0 this is a floating-point-noise match
    // on a real 32-spin structure, three orders tighter than the synthetic
    // goldens' 1e-6·peak. Pin it there so a real drift cannot hide.
    expect(maxDiffAway).toBeLessThan(1e-11 * peak);
    // r = 0 exactly is the one point that differs: f has a 1/r divergence and we
    // substitute a small positive r there rather than the reference's own
    // handling. Both land at ~1e-6 against a peak of ~300, so it is bounded
    // rather than exempted.
    expect(maxDiff).toBeLessThan(1e-8 * peak);
  });

  it("d(r) reproduces calculateDr (corr/κ gate — direct quadrature vs their FFT)", () => {
    const r = grid();
    const f = computeNormalizedMpdf(CELL, SPINS, r, { psigma: MNO_PSIGMA });
    const d = computeUnnormalizedMpdf(r, f, formFactorEnvelope(j0Profile(["Mn2"]), 5, MNO_RSTEP), 1, MNO_MSQ_AVG);
    // From r = 1 Å: below that the reference's form-factor transform is
    // dominated by its FFT grid, which we deliberately replace.
    const from = Math.round((1 - MNO_RMIN) / MNO_RSTEP);
    const { corr, kappa } = corrKappa(MNO_D, d, from);
    expect(corr).toBeGreaterThan(0.9999);
    expect(Math.abs(kappa - 1)).toBeLessThan(0.005);
    const peak = MNO_D.reduce((m, y) => Math.max(m, Math.abs(y)), 0);
    let maxDiff = 0;
    for (let k = from; k < MNO_N; k++) maxDiff = Math.max(maxDiff, Math.abs(d[k]! - MNO_D[k]!));
    // Point-wise bound too, so a locally-wrong para hump cannot hide behind a
    // good global correlation.
    expect(maxDiff).toBeLessThan(0.01 * peak);
  });
});

/**
 * magCIF defines a magnetic space group across TWO loops and the group is their
 * PRODUCT: `_space_group_symop_magn_operation.xyz` (coset representatives) ×
 * `_space_group_symop_magn_centering.xyz` (centering translations, including
 * anti-translations with θ = −1). Reading only the first loop silently yields a
 * fraction of the group — real MnO lists 4 operations and 32 centerings, so its
 * 32-Mn cell came out with 4 Mn, one eighth of the structure, with no error
 * raised anywhere: wrong 3D view, wrong mCIF round-trip, wrong |F_M|², wrong
 * mPDF.
 *
 * The mCIF below is a minimal C-centered black-and-white group written here
 * (not copied), sized so every symptom of dropping the centerings is visible.
 */
describe("mCIF magnetic centering operations", () => {
  const MCIF = `data_test
_cell_length_a 6.0
_cell_length_b 6.0
_cell_length_c 6.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_space_group_magn.name_BNS "C_c 2/c"

loop_
_space_group_symop_magn_operation.id
_space_group_symop_magn_operation.xyz
1 x,y,z,+1
2 -x,-y,z,+1

loop_
_space_group_symop_magn_centering.id
_space_group_symop_magn_centering.xyz
1 x,y,z,+1
2 x+1/2,y+1/2,z,+1
3 x,y,z+1/2,-1
4 x+1/2,y+1/2,z+1/2,-1

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Mn1 Mn 0.10 0.20 0.00 1

loop_
_atom_site_moment.label
_atom_site_moment.crystalaxis_x
_atom_site_moment.crystalaxis_y
_atom_site_moment.crystalaxis_z
Mn1 0.0 0.0 4.0
`;

  it("composes operations × centerings into the full group", () => {
    const { structure, magnetic } = parseMagneticCif(MCIF, "t");
    // 2 representatives × 4 centerings = 8 distinct operations. Reading only
    // the operation loop would give 2.
    expect(structure.spaceGroup.operations).toHaveLength(8);
    expect(magnetic?.operations).toHaveLength(8);
  });

  it("keeps anti-translations distinct from their θ = +1 partners", () => {
    const { magnetic } = parseMagneticCif(MCIF, "t");
    const ops = magnetic!.operations!;
    // Half the group is primed (θ = −1) — the defining feature of a
    // black-and-white lattice. Deduping without θ in the key would collapse
    // each anti-translation onto its partner and halve the group.
    expect(ops.filter((o) => o.timeReversal === -1)).toHaveLength(4);
    expect(ops.filter((o) => (o.timeReversal ?? 1) === 1)).toHaveLength(4);
  });

  it("generates the full magnetic orbit, with the anti-translation flipping the moment", () => {
    const { structure, magnetic } = parseMagneticCif(MCIF, "t");
    const box = expandSpinField(structure, magnetic!);
    const withMoment = box.atoms.filter((a) => a.moment);
    // The site sits on a general position of this group: 8 operations → 8 atoms.
    expect(withMoment).toHaveLength(8);
    const carts = withMoment.map((a) => crystalComponentsToCartesian(box.cell, a.moment!));
    const up = carts.filter((m) => m[2] > 0).length;
    // The θ = −1 centerings reverse the moment: a compensated 4-up / 4-down set.
    expect(up).toBe(4);
    expect(carts.length - up).toBe(4);
  });
});
