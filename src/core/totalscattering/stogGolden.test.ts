/**
 * REAL-data external golden (data-gated; `data/` is git-ignored): RMCProfile's
 * StoG Fortran program run on the FeCoSn 199 K neutron S(Q), against MATERIA's
 * operator with StoG's own settings.
 *
 * StoG's `.gr` output is g(r) (→ 1 at large r), so the comparison maps through
 * G(r) = 4πρ₀r·[g(r) − 1] with ρ₀ from the run's own input deck. Its transform
 * is the trapezoid rule plus the omitted-low-Q term (S(Q) linear to 0 below
 * Qmin) — `lowQ: "linear"`. Without that term the curves differ by a smooth
 * ≈ (2/π)(S₀ − 1)·r·Q₀³/3 ramp, which the last case pins so nobody "fixes" the
 * default to match StoG silently.
 *
 * Also exercises the loader on StoG's naming: its S(Q) lives in `scale.fq`.
 */
import { describe, it, expect } from "vitest";
import { dataExists, readData } from "@/testSupport/data";
import { parsePdfData } from "@/parsers/pdfData";
import { sineTransform, sineTransformOperator, reducedStructureFunction } from "@/core/totalscattering/fourier";

const DIR = "StoG/199K";
const FILES = ["scale.fq", "scale.gr", "scale_ft.sq", "scale_ft.gr", "stog_input.dat"];

/** Numeric rows of a StoG table (skips the count line and the text headers). */
function table(text: string): number[][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((t) => t.length >= 2 && t.every(Number.isFinite));
}

describe.skipIf(!FILES.every((f) => dataExists(`${DIR}/${f}`)))("REAL FeCoSn 199 K — RMCProfile StoG S(Q) → G(r)", () => {
  it("reproduces StoG's g(r) for the unfiltered and the Fourier-filtered S(Q)", () => {
    // StoG input deck, by position: line 3 = "Qmin Qmax", line 11 = ρ₀ (Å⁻³).
    const deck = readData(`${DIR}/stog_input.dat`).split(/\r?\n/).map((l) => l.trim());
    const [qmin, qmax] = deck[2]!.split(/\s+/).map(Number) as [number, number];
    const rho0 = Number(deck[10]);
    expect([qmin, qmax, rho0]).toEqual([0.5, 26, 0.057329]);

    for (const [sqFile, grFile] of [["scale.fq", "scale.gr"], ["scale_ft.sq", "scale_ft.gr"]] as const) {
      const pattern = parsePdfData(readData(`${DIR}/${sqFile}`), { filename: sqFile });
      expect(pattern.sourceKind).toBe("sq"); // StoG's .fq holds S(Q) — see classifyReducedKind
      const { q, f } = reducedStructureFunction(pattern.reciprocal!);
      const op = sineTransformOperator(q, { qmin, qmax, lowQ: "linear" });
      const ref = table(readData(`${DIR}/${grFile}`));
      const r = ref.map((row) => row[0]!);
      const g = sineTransform(op, f, r).g;
      for (let j = 0; j < r.length; j++) {
        const gr = 1 + g[j]! / (4 * Math.PI * r[j]! * rho0);
        // Below 0.05 Å the REFERENCE is the less accurate side: StoG (and
        // pystog, which matches it there to 1e-13) evaluate the low-Q integral
        // I_2 in closed form at V = Q₀r ≤ 0.025, where it cancels to 7e-7
        // relative at 0.01 Å (pinned against mpmath in fourier.test.ts); ours is a series. In G that
        // is ≤ 7e-12; g divides it by 4πρ₀r ≈ 0.007.
        if (r[j]! >= 0.05) expect(Math.abs(gr - ref[j]![1]!)).toBeLessThan(1e-12);
        else expect(Math.abs(g[j]! - 4 * Math.PI * r[j]! * rho0 * (ref[j]![1]! - 1))).toBeLessThan(1e-11);
      }
    }
  });

  it("without the low-Q term the difference is the omitted 0 → Qmin region, not noise", () => {
    const pattern = parsePdfData(readData(`${DIR}/scale.fq`), { filename: "scale.fq" });
    const { q, f } = reducedStructureFunction(pattern.reciprocal!);
    const r = [1, 2, 3];
    const withLow = sineTransform(sineTransformOperator(q, { qmin: 0.5, qmax: 26, lowQ: "linear" }), f, r).g;
    const plain = sineTransform(sineTransformOperator(q, { qmin: 0.5, qmax: 26 }), f, r).g;
    // Small-Q·r limit of G_low with S linear from 0 to S₀ at Q₀ (sin Qr ≈ Qr):
    // (2/π)·r·[S₀·Q₀³/4 − Q₀³/3].
    const q0 = q[0]!;
    const s0 = f[0]! / q0 + 1;
    r.forEach((rr, j) => {
      const approx = (2 / Math.PI) * rr * (s0 * q0 ** 3 / 4 - q0 ** 3 / 3);
      expect((withLow[j]! - plain[j]!) / approx).toBeCloseTo(1, 0);
      expect(Math.abs(withLow[j]! - plain[j]!)).toBeGreaterThan(0.01);
    });
  });
});
