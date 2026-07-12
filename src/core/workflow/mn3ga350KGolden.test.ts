import { describe, it, expect } from "vitest";
import type { Vec3 } from "@/core/math/types";
import { parseMagneticCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { buildPowderSpec } from "@/app/powderSpec";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { refine } from "@/core/refinement/engine";
import { dataExists, readData } from "@/testSupport/data";
import type { RefinementParameter } from "@/core/refinement/types";
import type { UnitCell } from "@/core/crystal/types";

/**
 * Golden-data validation against the user's GSAS-II refinement of the Mn₃Ga
 * 350 K magnetic structure (data/Mn3Ga_POWGEN_350K/):
 *
 *  - `Mn3Ga-mag_53_350K_Final_ortho.cif` — the refined magnetic structure in
 *    the BNS group C m' c m' (orthohexagonal setting of the P6₃/mmc parent):
 *    Mn1_0 (8g-type, site symmetry m'(z)) with m = (1.60, −1.35, 0) µ_B and
 *    Mn1_1 (4c-type, m'm'2(y)) with m = (0, 2.10, 0) µ_B.
 *  - `PG3_45598_Bank1.fxye` + `.instprm` — the POWGEN TOF histogram and
 *    calibration extracted from the .gpx (GSAS-II: wR = 5.65% over three
 *    phases incl. a ~5% MnO impurity we do not model here).
 *
 * Part A pins the magnetic symmetry machinery to GSAS-II's site-symmetry
 * analysis; part B refines the moments against the real histogram and checks
 * the result is consistent with the golden structure. Skips when the
 * git-ignored data/ folder is absent.
 */
const DIR = "Mn3Ga_POWGEN_350K";
const hasCif = dataExists(`${DIR}/Mn3Ga-mag_53_350K_Final_ortho.cif`);
const hasData = hasCif && dataExists(`${DIR}/PG3_45598_Bank1.fxye`) && dataExists(`${DIR}/PG3_45598_Bank1.instprm`);

/** Cartesian dot of two crystal-axis moment vectors. */
const dot = (cell: UnitCell, a: Vec3, b: Vec3): number => {
  const ca = crystalComponentsToCartesian(cell, a);
  const cb = crystalComponentsToCartesian(cell, b);
  return ca[0]! * cb[0]! + ca[1]! * cb[1]! + ca[2]! * cb[2]!;
};

describe.skipIf(!hasCif)("Mn3Ga 350K golden — magnetic symmetry vs GSAS-II", () => {
  const load = () => parseMagneticCif(readData(`${DIR}/Mn3Ga-mag_53_350K_Final_ortho.cif`), "mn3ga350");

  it("parses the full BNS symmetry (16 ops, half with time reversal)", () => {
    const { structure } = load();
    const ops = structure.spaceGroup.operations;
    expect(ops).toHaveLength(16);
    expect(ops.filter((o) => o.timeReversal === -1)).toHaveLength(8);
    expect(ops.filter((o) => o.timeReversal === 1)).toHaveLength(8);
  });

  it("reproduces GSAS-II's site multiplicities (Mn1_0: 8, Mn1_1: 4)", () => {
    const { structure } = load();
    const ops = structure.spaceGroup.operations;
    const site = (l: string) => structure.sites.find((s) => s.label === l)!;
    expect(siteMultiplicity(ops, site("Mn1_0").position)).toBe(8);
    expect(siteMultiplicity(ops, site("Mn1_1").position)).toBe(4);
    expect(siteMultiplicity(ops, site("Ga1").position)).toBe(4);
  });

  it("reproduces GSAS-II's site symmetry: Mn1_0 m'(z) → (Mx, My, 0)", () => {
    const { structure } = load();
    const pos = structure.sites.find((s) => s.label === "Mn1_0")!.position;
    const allowed = allowedMomentDirections(structure.spaceGroup.operations, pos, [0, 0, 0]);
    expect(allowed.dimension).toBe(2);
    // In-plane: every basis vector has zero z; the two span x AND y.
    for (const b of allowed.basis) expect(Math.abs(b[2]!)).toBeLessThan(1e-9);
    const det2 = allowed.basis[0]![0]! * allowed.basis[1]![1]! - allowed.basis[0]![1]! * allowed.basis[1]![0]!;
    expect(Math.abs(det2)).toBeGreaterThan(1e-9);
  });

  it("reproduces GSAS-II's site symmetry: Mn1_1 m'm'2(y) → (0, My, 0)", () => {
    const { structure } = load();
    // The refined x = 0.50005 sits 5×10⁻⁵ off the special position — the
    // stabilizer detection must tolerate real-world refined coordinates.
    const pos = structure.sites.find((s) => s.label === "Mn1_1")!.position;
    const allowed = allowedMomentDirections(structure.spaceGroup.operations, pos, [0, 0, 0]);
    expect(allowed.dimension).toBe(1);
    const b = allowed.basis[0]!;
    expect(Math.abs(b[0]!)).toBeLessThan(1e-9);
    expect(Math.abs(b[2]!)).toBeLessThan(1e-9);
    expect(Math.abs(b[1]!)).toBeGreaterThan(0.9);
  });

  it("the golden refined moments lie in the allowed subspaces", () => {
    const { structure, magnetic } = load();
    expect(magnetic).not.toBeNull();
    const byLabel = new Map(magnetic!.moments.map((m) => [m.siteLabel, m]));
    // Golden values from the mCIF.
    expect(byLabel.get("Mn1_0")!.components).toEqual([1.6, -1.35, 0]);
    expect(byLabel.get("Mn1_1")!.components).toEqual([0, 2.1, 0]);
    // Ga carries no moment (zero rows are dropped by the parser).
    expect(byLabel.has("Ga1")).toBe(false);
    // Each moment reprojects exactly onto its allowed basis (residual ≈ 0).
    for (const label of ["Mn1_0", "Mn1_1"]) {
      const pos = structure.sites.find((s) => s.label === label)!.position;
      const { basis } = allowedMomentDirections(structure.spaceGroup.operations, pos, [0, 0, 0]);
      const m = byLabel.get(label)!.components as Vec3;
      const residual = [...m] as [number, number, number];
      for (const b of basis) {
        const a = dot(structure.cell, m, b) / dot(structure.cell, b, b);
        for (let i = 0; i < 3; i++) residual[i] = residual[i]! - a * b[i]!;
      }
      expect(Math.hypot(...residual)).toBeLessThan(1e-9);
    }
  });

  it("buildMagneticModel exposes exactly GSAS-II's moment degrees of freedom (2 + 1)", () => {
    const { structure } = load();
    const build = buildMagneticModel(structure, [0, 0, 0], ["Mn1_0", "Mn1_1"], structure.spaceGroup.operations);
    const modes = build.params.filter((p) => p.kind === "momentMode");
    expect(modes.filter((p) => p.id.startsWith("mom_Mn1_0"))).toHaveLength(2);
    expect(modes.filter((p) => p.id.startsWith("mom_Mn1_1"))).toHaveLength(1);
    expect(modes).toHaveLength(3);
    expect(build.activeSites.sort()).toEqual(["Mn1_0", "Mn1_1"]);
  });
});

describe.skipIf(!dataExists(`${DIR}/gsas2_mag_refl.txt`) || !hasCif)("Mn3Ga 350K golden — per-reflection |F_M|² vs GSAS-II", () => {
  // GSAS-II's calculated magnetic reflection list (h k l mult d Fcsq),
  // extracted from the .gpx reflection lists at the converged .lst moment
  // state: Mn1_0 (2.296, −0.559, 0), Mn1_1 (0, 1.118, 0), metallic Mn0 ⟨j0⟩.
  // GSAS-II Fcsq is in (10⁻¹² cm)²; ours is fm² → factor 100.
  it("matches GSAS-II's |F_M|² on all 82 reflections (±5%, zeros exact)", () => {
    const { structure, magnetic } = parseMagneticCif(readData(`${DIR}/Mn3Ga-mag_53_350K_Final_ortho.cif`), "mn3ga350");
    const lst: Record<string, Vec3> = { Mn1_0: [2.296, -0.559, 0], Mn1_1: [0, 1.118, 0] };
    const mag = { ...magnetic!, moments: magnetic!.moments.map((m) => ({ ...m, formFactorId: "Mn0", components: lst[m.siteLabel]! })) };
    const rows = readData(`${DIR}/gsas2_mag_refl.txt`).trim().split("\n").map((ln) => ln.trim().split(/\s+/).map(Number));
    expect(rows).toHaveLength(82);
    let compared = 0;
    for (const [h, k, l, , , gsas] of rows) {
      const ours = magneticStructureFactor(structure, mag, h!, k!, l!).squared / 100;
      if (gsas! < 1e-3) {
        // Symmetry-forbidden (or negligible) in GSAS-II — must be ≈ 0 here too.
        expect(ours).toBeLessThan(5e-3);
      } else {
        expect(ours / gsas!).toBeGreaterThan(0.95);
        expect(ours / gsas!).toBeLessThan(1.05);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });
});

describe.skipIf(!hasData)("Mn3Ga 350K golden — moment refinement against the POWGEN histogram", () => {
  // GSAS-II's fit window (µs) from the .gpx Limits.
  const TOF_MIN = 12158.9;
  const TOF_MAX = 118441.4;

  it("refines the moments to a structure consistent with the golden mCIF", { timeout: 60000 }, () => {
    const { structure } = parseMagneticCif(readData(`${DIR}/Mn3Ga-mag_53_350K_Final_ortho.cif`), "mn3ga350");
    const inst = parseInstrumentParameters(readData(`${DIR}/PG3_45598_Bank1.instprm`));
    const full = parseGsasHistogramPattern(readData(`${DIR}/PG3_45598_Bank1.fxye`), "pg45598", "Mn3Ga 350K", { radiation: { kind: "neutron-tof" } });
    const pattern = { ...full, points: full.points.filter((p) => p.x >= TOF_MIN && p.x <= TOF_MAX) };
    expect(pattern.points.length).toBeGreaterThan(2500); // GSAS-II fit 2849 observations

    // Nuclear spec (TOF back-to-back-exponential from the .instprm) + the
    // symmetry-allowed moment modes (2 on Mn1_0, 1 on Mn1_1 — part A).
    const spec = buildPowderSpec(structure, pattern, inst, true, 6, {});
    const build = buildMagneticModel(structure, [0, 0, 0], ["Mn1_0", "Mn1_1"], structure.spaceGroup.operations);
    const modes = build.params.filter((p) => p.kind === "momentMode");
    // Reference amplitudes = projection of GSAS-II's converged moments for THIS
    // histogram (the final .lst cycle, net-zero-moment constrained:
    // 8·(−0.559) + 4·1.118 = 0) onto the unit modes. The mCIF's (1.60, −1.35)/
    // (0, 2.10) state carries an uncompensated net moment of −2.4 µ_B/cell —
    // ferromagnetic intensity on every nuclear peak — and fits run 45598
    // measurably worse; it is validated structurally in part A instead.
    const golden = new Map<string, number>();
    const momentOf: Record<string, Vec3> = { Mn1_0: [2.296, -0.559, 0], Mn1_1: [0, 1.118, 0] };
    for (const p of modes) {
      const b = build.bindings.find((x) => x.parameterId === p.id)!.momentBasis! as Vec3;
      const site = p.id.startsWith("mom_Mn1_0") ? "Mn1_0" : "Mn1_1";
      golden.set(p.id, dot(structure.cell, momentOf[site]!, b) / dot(structure.cell, b, b));
    }

    // Rietveld staging (what the app's guided mode does): converge scale +
    // background + profile with the moments held, then free the moments. A flat
    // all-at-once co-refinement from a bad moment start can collapse the scale
    // against exploding moments (the scale·|m|² valley).
    const bindingsAll = [...spec.bindings, ...build.bindings];
    const freeKinds = new Set(["scale", "background", "tofProfile"]);
    // Each evaluation is itself staged — scale + background first, then the
    // TOF profile: freeing the profile from raw seeds against a strong (held)
    // magnetic signal can diverge in a single flat pass.
    const wrOf = (params: RefinementParameter[]): { wr: number; values: Record<string, number> } => {
      const pass1 = params.map((p) => (p.kind === "tofProfile" || (p.kind === "momentMode" && !p.fixed) ? { ...p, fixed: true } : { ...p }));
      const r1 = refine(buildMagneticPowderProblem(structure, build.magnetic, pattern, pass1, bindingsAll, { shape: "tof" }), { maxIterations: 20 });
      const pass2 = params.map((p) => ({ ...p, value: r1.parameters[p.id] ?? p.value }));
      const r = refine(buildMagneticPowderProblem(structure, build.magnetic, pattern, pass2, bindingsAll, { shape: "tof" }), { maxIterations: 30 });
      return { wr: 100 * (r.agreement.rWeighted ?? 1), values: r.parameters };
    };
    const base = [...spec.params.map((p) => ({ ...p, fixed: !freeKinds.has(p.kind) }))];
    const withMoments = (vals: Map<string, number>, fixed: boolean, from?: Record<string, number>): RefinementParameter[] => [
      ...base.map((p) => ({ ...p, ...(from && from[p.id] !== undefined ? { value: from[p.id]! } : {}) })),
      ...modes.map((p) => ({ ...p, value: vals.get(p.id) ?? 0, initialValue: vals.get(p.id) ?? 0, fixed })),
    ];

    // 1. The full staged fit from a perturbed start (right sign pattern, wrong
    //    sizes): scale + background + profile with moments held, then the
    //    moments freed — the refinement must find the golden structure on its
    //    own.
    const seed = new Map([...golden].map(([id, v]) => [id, Math.sign(v) * 1.0]));
    const stage1 = wrOf(withMoments(seed, true));
    const fit = wrOf(withMoments(seed, false, stage1.values));

    // 2./3. Model comparison AT the fit's converged profile (profile fixed,
    // scale + background re-refined): zero moments vs GSAS-II's converged
    // moments. Freeing the profile in these would launder the unmodelled
    // magnetic intensity into peak widths and blur the comparison.
    const atFitProfile = (vals: Map<string, number>): RefinementParameter[] =>
      withMoments(vals, true, fit.values).map((p) => (p.kind === "tofProfile" ? { ...p, fixed: true } : p));
    const zero = wrOf(atFitProfile(new Map()));
    const goldenFit = wrOf(atFitProfile(golden));

    // The magnetic contribution is real and our |F_M|² explains it: at one
    // shared profile, zeroing the moments measurably worsens the whole-pattern
    // wR (the signal lives in a few strong magnetic peaks among ~2850 points,
    // so a few tenths of a % is the honest scale — the per-reflection test
    // above carries the sharp intensity validation), GSAS-II's converged
    // moments fit essentially as well as ours, and the absolute wR stays
    // modest — single-phase, with the ~5% MnO impurity unmodelled; GSAS-II's
    // three-phase refinement reached 5.65%. (Calibrated: fit ≈ 9.1%,
    // zero ≈ 9.35%, golden-held ≈ 9.13%.)
    console.log(`wR: staged-fit=${fit.wr.toFixed(2)}% zero=${zero.wr.toFixed(2)}% golden-held=${goldenFit.wr.toFixed(2)}%`);
    expect(fit.wr).toBeLessThan(11);
    expect(zero.wr).toBeGreaterThan(fit.wr + 0.15);
    expect(Math.abs(goldenFit.wr - fit.wr)).toBeLessThan(0.5);

    // Refined moments: reconstruct vectors and compare against the golden
    // states. GSAS-II's own two states — mCIF (1.60, −1.35, 0)/(0, 2.10, 0) and
    // final .lst cycle (2.30, −0.56, 0)/(0, 1.12, 0) with σ(My) ≈ 2–4 µ_B —
    // differ by more than our deviation from either: the b-components are the
    // flat direction of this data. A global time-reversal flip is
    // diffraction-equivalent, so normalize Mx > 0.
    const refined = applyMagneticMoments(build.magnetic, build.bindings, fit.values);
    const m0 = refined.moments.find((m) => m.siteLabel === "Mn1_0")!.components as Vec3;
    const m1 = refined.moments.find((m) => m.siteLabel === "Mn1_1")!.components as Vec3;
    const flip = m0[0]! < 0 ? -1 : 1;
    const M0: Vec3 = [flip * m0[0]!, flip * m0[1]!, flip * m0[2]!];
    const M1: Vec3 = [flip * m1[0]!, flip * m1[1]!, flip * m1[2]!];
    expect(M0[0]).toBeGreaterThan(1.4); // dominant a-axis component (ref: 2.04)
    expect(M0[0]).toBeLessThan(2.9);
    expect(M0[1]).toBeLessThan(0.5); // flat direction; ≤ 0 within noise
    expect(Math.abs(M0[2]!)).toBeLessThan(1e-9); // symmetry-forbidden, never refined
    expect(M1[1]).toBeGreaterThan(0.7); // b-axis moment, opposite in sign to M0's My (ref: 1.56)
    expect(M1[1]).toBeLessThan(2.5);
    expect(Math.abs(M1[0]!)).toBeLessThan(1e-9);
    expect(Math.abs(M1[2]!)).toBeLessThan(1e-9);

    const mag = (v: Vec3) => Math.sqrt(dot(structure.cell, v, v));
    expect(mag(M0)).toBeGreaterThan(1.5); // |m|: mCIF 2.09, .lst 2.36, ours ≈ 2.04
    expect(mag(M0)).toBeLessThan(2.9);
  });
});
