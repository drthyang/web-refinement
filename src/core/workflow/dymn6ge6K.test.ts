import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PowderPattern } from "@/core/diffraction/types";
import type { MagneticModel, MagneticMoment } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { parseCif } from "@/parsers/cif";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { propagationKParameters } from "@/core/magnetic/refinableK";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { refine } from "@/core/refinement/engine";

/**
 * External golden for a refined propagation vector (Track B1 validation):
 * DyMn₆Ge₆ at 11 K, PSI DMC (λ = 1.7037 Å), an incommensurate conical spiral
 * with k = (0, 0, γ). FullProf, refining k on this very file
 * (`backup_files/Fullprof_examples/dy`), reports γ = 0.16509(43).
 *
 * The model mirrors FullProf's: cell, zero, Caglioti U/V/W and the 38-point
 * background from `dy.pcr` (FullProf's U, V, W are in deg², ours in
 * centideg²), and the helix written the way FullProf writes it — Dy and the
 * six Mn at their LISTED (unwrapped) positions under the identity, each with
 * the Hastings–Corliss coefficient S = ½·m⊥·(x̂ + iŷ)·e^{−2πiφ}, which is this
 * code's position convention (INCOMMENSURATE_PLAN §2.1 (a)).
 *
 * Not modelled: the cone's ferromagnetic k = 0 component (this model carries
 * one k), FullProf's Bérar–Baldinozzi asymmetry and μR absorption. None of
 * them moves a satellite, so k — fixed by satellite POSITIONS — is still a
 * fair comparison; the missing FM intensity on the fundamentals is why the
 * agreement factor is looser than FullProf's.
 */
const DIR = resolve(__dirname, "../../../data/FullProf_examples/DyMn6Ge6_Incommensurate_RepAnalysis_Calder");
const DAT = resolve(DIR, "dymn6ge6.dat");
const CIF = resolve(DIR, "dymn6ge6.cif");
const HAVE = existsSync(DAT) && existsSync(CIF);

const FULLPROF_K3 = 0.16509;
const FULLPROF_K3_ESD = 0.00043;

/** FullProf Ins = 8 (PSI DMC): 3 header lines (start step end on line 3),
 *  then the counts, then as many sigmas, 10 per line. */
function readDmc(text: string): { x: number[]; y: number[]; sigma: number[] } {
  const lines = text.split(/\r?\n/);
  const [start, step, end] = lines[2]!.trim().split(/\s+/).map(Number) as [number, number, number];
  const n = Math.round((end - start) / step) + 1;
  const values = lines.slice(3).join(" ").trim().split(/\s+/).map(Number);
  return {
    x: Array.from({ length: n }, (_, i) => start + i * step),
    y: values.slice(0, n),
    sigma: values.slice(n, 2 * n),
  };
}

/** FullProf's background points (dy.pcr), linearly interpolated. */
const BKG: readonly [number, number][] = [
  [3.13, 4310], [3.98, 4111], [5.11, 4111], [6.49, 3316], [7.41, 3361], [8.93, 3427], [11.1, 3471],
  [12.7, 3471], [13.2, 3471], [14.7, 3515], [17.1, 3515], [19.3, 3581], [20.1, 3626], [20.9, 3846],
  [23.2, 3891], [26.9, 3692], [29.6, 3670], [31.0, 3692], [33.4, 3692], [36.0, 3758], [39.1, 3846],
  [41.9, 3824], [42.3, 3802], [43.7, 3846], [47.3, 3846], [48.2, 3648], [48.9, 3581], [55.0, 3581],
  [55.9, 3626], [63.4, 3626], [66.8, 3648], [71.5, 3802], [75.1, 3603], [76.9, 3603], [78.7, 3515],
  [79.1, 3515], [82.5, 3581], [82.8, 3581],
];
function background(x: number): number {
  if (x <= BKG[0]![0]) return BKG[0]![1];
  for (let i = 1; i < BKG.length; i++) {
    const [x1, y1] = BKG[i]!;
    const [x0, y0] = BKG[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return BKG[BKG.length - 1]![1];
}

describe.skipIf(!HAVE)("DyMn₆Ge₆ spiral — refined k against FullProf (real incommensurate data)", () => {
  it.each([0.155, 0.175])("refines k₃ onto FullProf's 0.16509(43) from a start at %s", (start) => {
    const dmc = readDmc(readFileSync(DAT, "utf8"));
    const pattern: PowderPattern = {
      id: "dmc", name: "DyMn6Ge6 11 K", xUnit: "twoTheta",
      radiation: { kind: "neutron", wavelength: 1.7037 }, wavelength: 1.7037,
      // FullProf excludes 82.6–84°; the background is subtracted (it is FullProf's, fixed).
      points: dmc.x.map((x, i) => ({ x, yObs: dmc.y[i]! - background(x), sigma: Math.max(dmc.sigma[i]!, 1) }))
        .filter((p) => p.x < 82.6),
    };

    const parsed = parseCif(readFileSync(CIF, "utf8"), "dymn6ge6");
    const posOf: Record<string, Vec3> = {
      Dy1: [0, 0, 0], Mn1: [0.5, 0, 0.25024], Ge1: [1 / 3, 2 / 3, 0], Ge2: [1 / 3, 2 / 3, 0.5], Ge3: [0, 0, 0.34468],
    };
    const structure = {
      ...parsed,
      cell: { a: 5.206348, b: 5.206348, c: 8.149757, alpha: 90, beta: 90, gamma: 120 },
      sites: parsed.sites.map((s) => ({ ...s, position: posOf[s.label] ?? s.position, occupancy: 1, adp: { kind: "isotropic" as const, bIso: 0 } })),
    };
    expect(structure.spaceGroup.operations).toHaveLength(24);

    // FullProf's Hastings–Corliss helix: moment m, cone half-angle ψ, phase φ (cycles).
    const helix = (label: string, ff: string, position: Vec3, m: number, psiDeg: number, phi: number): MagneticMoment => {
      const mPerp = m * Math.sin((psiDeg * Math.PI) / 180);
      const c = Math.cos(2 * Math.PI * phi);
      const s = Math.sin(2 * Math.PI * phi);
      return {
        siteLabel: label, frame: "cartesian", formFactorId: ff, position,
        components: [mPerp * c, mPerp * s, 0],
        sinComponents: [-mPerp * s, mPerp * c, 0],
      };
    };
    const zMn = 0.25024;
    const mn = (p: Vec3, phi: number) => helix("Mn1", "Mn2", p, 2.096, 236.832, phi);
    const kStart: Vec3 = [0, 0, start];
    const magnetic: MagneticModel = {
      id: `${structure.id}-mag`, structureId: structure.id, propagation: [kStart],
      operations: [parseSymmetryOperation("x,y,z")],
      moments: [
        helix("Dy1", "Dy3", [0, 0, 0], 7.435, -57.309, 0),
        mn([0.5, 0, zMn], 0.515), mn([-0.5, 0, -zMn], -0.515),
        mn([0, 0.5, zMn], 0.515), mn([0, -0.5, -zMn], -0.515),
        mn([0.5, 0.5, zMn], 0.515), mn([-0.5, -0.5, -zMn], -0.515),
      ],
    };

    const kRows = propagationKParameters(structure, magnetic);
    // k ∥ c* in 6/mmm: the little group 6mm leaves only γ free.
    expect(kRows.params.map((p) => p.id)).toEqual(["prop_k3"]);

    const row = (id: string, kind: RefinementParameter["kind"], value: number, free: boolean, extra: Partial<RefinementParameter> = {}): RefinementParameter =>
      ({ id, label: id, kind, value, initialValue: value, fixed: !free, ...extra });
    const params: RefinementParameter[] = [
      row("scale", "scale", 1, true, { min: 0 }),
      row("magScale", "magneticScale", 1, true, { min: 0 }),
      row("zero", "zeroShift", 0.03988, true),
      row("U", "profileU", 1.809636e4, false),
      row("V", "profileV", -1.476507e4, false),
      row("W", "profileW", 0.446244e4, false),
      ...kRows.params.map((p) => ({ ...p, fixed: false })),
    ];
    const bindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: structure.id },
      { parameterId: "magScale", kind: "magneticScale", targetId: magnetic.id },
      { parameterId: "zero", kind: "zeroShift", targetId: pattern.id },
      { parameterId: "U", kind: "profileU", targetId: pattern.id },
      { parameterId: "V", kind: "profileV", targetId: pattern.id },
      { parameterId: "W", kind: "profileW", targetId: pattern.id },
      ...kRows.bindings,
    ];

    // Scale first (k held), so the k step starts from a sensible intensity level.
    const seed = refine(buildMagneticPowderProblem(structure, magnetic, pattern,
      params.map((p) => (p.kind === "propagationK" ? { ...p, fixed: true } : p)), bindings, { shape: "gaussian" }), { maxIterations: 20 });
    const seeded = params.map((p) => ({ ...p, value: seed.parameters[p.id] ?? p.value }));
    const result = refine(buildMagneticPowderProblem(structure, magnetic, pattern, seeded, bindings, { shape: "gaussian" }), { maxIterations: 60 });

    const k3 = result.parameters.prop_k3!;
    const esd = result.esd.prop_k3!;
    console.log(`DyMn6Ge6 (start ${start}): k3 = ${k3.toFixed(5)}(${esd.toExponential(1)}) vs FullProf ${FULLPROF_K3}(${FULLPROF_K3_ESD}); wR = ${(100 * (result.agreement.rWeighted ?? 0)).toFixed(2)}%`);
    expect(Math.abs(k3 - FULLPROF_K3)).toBeLessThan(2 * FULLPROF_K3_ESD);
    expect(esd).toBeGreaterThan(0);
    expect(esd).toBeLessThan(5 * FULLPROF_K3_ESD);
  });
});
