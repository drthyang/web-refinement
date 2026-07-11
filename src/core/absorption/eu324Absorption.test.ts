/**
 * Real-data validation of the absorption engine against WinGX's Gaussian
 * single-crystal absorption correction, on the Eu3In2(Te/As)4 rod crystal
 * (Eu is a strong neutron absorber, λ = 1.0 Å).
 *
 * The FullProf-format .int files carry per-reflection direction cosines, and
 * gaussian_nuc.int / analytical_nuc.int are WinGX's absorption-corrected
 * intensities, so A_ref(hkl) = I_uncorrected / I_corrected is a per-reflection
 * benchmark of the transmission factor.
 *
 * This exercises the whole pure-core stack — crystal habit → transmission
 * integral — against an external tool. It reads git-ignored data/, so it
 * self-skips when the dataset is absent (keeps CI/deploy green). Analogous to
 * the ganb4se8 powder regression.
 *
 * Findings this pins:
 *  - the .int cosine convention (both stored pointing away from the crystal,
 *    so the scattering vector is their sum; incident propagation = −stored_in);
 *  - the transmission engine + rod geometry reproduce WinGX's per-reflection
 *    correction to Pearson r ≈ 0.99 once μ is right;
 *  - the 1/v Eu absorption OVER-absorbs at 1.0 Å (effective μ well below the 1/v
 *    value) — the resonance caveat (Eu ∈ RESONANCE_ABSORBERS) made concrete.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import type { UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { dSpacing } from "@/core/crystal/unitCell";
import { dot, normalize } from "@/core/math/vec3";
import { crystalHabit, faceNormalCartesian } from "@/core/absorption/habit";
import { transmissionFactor } from "@/core/absorption/transmission";
import { absorptionCrossSection, scatteringCrossSection } from "@/core/scattering/neutronAbsorption";

const DIR = "data/Eu324_fullprof/Str/";
const NUC = `${DIR}Eu3In2Te4_1p5K0T_nuc.int`;
const GAU = `${DIR}gaussian_nuc.int`;

const cell: UnitCell = { a: 6.8262, b: 16.513, c: 4.4132, alpha: 90, beta: 90, gamma: 90 };
const CELL_VOLUME = 497.461;
const WAVELENGTH = 1.0;
const CONTENTS: Record<string, number> = { Eu: 6, In: 4, As: 8 }; // Z = 2

interface Refl { hkl: Vec3; iObs: number; sInStored: Vec3; sOut: Vec3; }

/** Parse a FullProf single-crystal .int (fixed-width 3i4,2f8.2,i4,6f8.0). */
function parseInt(path: string): Refl[] {
  const out: Refl[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").slice(3)) {
    if (line.length < 80) continue;
    const num = (a: number, b: number) => parseFloat(line.slice(a, b));
    const c = [32, 40, 48, 56, 64, 72].map((s) => num(s, s + 8));
    out.push({
      hkl: [num(0, 4), num(4, 8), num(8, 12)],
      iObs: num(12, 20),
      sInStored: [c[0]!, c[2]!, c[4]!],
      sOut: [c[1]!, c[3]!, c[5]!],
    });
  }
  return out;
}

function muPerMm(): number {
  let sum = 0;
  for (const [el, n] of Object.entries(CONTENTS)) {
    sum += n * (absorptionCrossSection(el, WAVELENGTH) + scatteringCrossSection(el));
  }
  return sum / CELL_VOLUME / 10; // barn/Å³ → cm⁻¹ → mm⁻¹
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i]! - mx, dy = y[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
}

describe("Eu324 single-crystal absorption vs WinGX", () => {
  it("reproduces WinGX's Gaussian correction and pins the cosine convention", () => {
    if (!existsSync(NUC) || !existsSync(GAU)) {
      console.log("Eu324 data absent — skipping (git-ignored data/).");
      return;
    }
    const nuc = parseInt(NUC);
    const corrected = new Map(parseInt(GAU).map((r) => [r.hkl.join(","), r.iObs]));

    // (1) Direction-cosine geometry: scattering vector Q = ŝ_in + ŝ_out (stored),
    // with |Q| = λ/d and Q ∥ d*_hkl.
    for (const r of nuc.slice(0, 12)) {
      const q: Vec3 = [r.sInStored[0] + r.sOut[0], r.sInStored[1] + r.sOut[1], r.sInStored[2] + r.sOut[2]];
      const expected = WAVELENGTH / dSpacing(cell, r.hkl[0], r.hkl[1], r.hkl[2]);
      expect(Math.hypot(q[0], q[1], q[2])).toBeCloseTo(expected, 1);
      expect(Math.abs(dot(normalize(q), faceNormalCartesian(cell, r.hkl)))).toBeGreaterThan(0.999);
    }

    // (2) Square rod from the sketch: elongated along c = [001] (the common zone
    // axis of the two labelled side faces (130) and (140), since [130]×[140] ∝
    // [001]), with a {130}/{140} cross-section (~0.89 × 1.20 mm) and 4.63 mm long.
    // Faces are crystallographic, and the .int direction cosines live in the same
    // crystal frame, so we can build the habit and transmit directly (no rotation).
    const rod = crystalHabit(cell, [
      { hkl: [1, 3, 0], distance: 0.445 }, { hkl: [-1, -3, 0], distance: 0.445 },
      { hkl: [1, 4, 0], distance: 0.60 }, { hkl: [-1, -4, 0], distance: 0.60 },
      { hkl: [0, 0, 1], distance: 2.315 }, { hkl: [0, 0, -1], distance: 2.315 },
    ]);

    const geom = nuc
      .map((r) => ({ r, iCorr: corrected.get(r.hkl.join(",")) }))
      .filter((g) => g.iCorr !== undefined && g.iCorr > 0 && g.r.iObs > 0)
      .map((g) => ({
        sInProp: [-g.r.sInStored[0], -g.r.sInStored[1], -g.r.sInStored[2]] as Vec3,
        sOut: g.r.sOut,
        afp: g.r.iObs / g.iCorr!,
      }));
    expect(geom.length).toBeGreaterThan(30);

    // (3) The engine must reproduce WinGX's per-reflection pattern. Treat μ as a
    // scalar (the Eu 1/v value is an over-estimate); the geometry is what's tested.
    const fp = geom.map((g) => g.afp);
    const mu1v = muPerMm();
    let bestR = -1;
    let bestMu = 0;
    for (let scale = 0.6; scale <= 1.01; scale += 0.02) {
      const mine = geom.map((g) => transmissionFactor(rod, mu1v * scale, g.sInProp, g.sOut, { gaussPoints: 24 }));
      const r = pearson(mine, fp);
      if (r > bestR) { bestR = r; bestMu = mu1v * scale; }
    }
    console.log(`Eu324: 1/v μ=${mu1v.toFixed(2)} mm⁻¹, best-fit μ=${bestMu.toFixed(2)} mm⁻¹ (${(bestMu / mu1v).toFixed(2)}×), Pearson r=${bestR.toFixed(3)}`);

    // Geometry/engine reproduce WinGX strongly; effective μ is well below 1/v
    // (Eu resonance), confirming the resonance caveat rather than a geometry error.
    expect(bestR).toBeGreaterThan(0.95);
    expect(bestMu).toBeLessThan(mu1v);
  });
});
