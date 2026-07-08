import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { dFromTof } from "@/core/diffraction/instrument";
import { detectExtraPeaks } from "@/core/magnetic/extraPeaks";
import { searchPropagationVector } from "@/core/magnetic/kSearch";
import { dataExists, readData } from "@/testSupport/data";

/**
 * End-to-end magnetic propagation-vector search on **real** POWGEN neutron data
 * for the high-entropy tungstate AWO₄ (monoclinic P2/c). AWO₄ orders
 * antiferromagnetically with **k = (½,0,0)**; below T_N the pattern grows
 * satellites at half-integer h that are absent in the paramagnetic state.
 *
 * The pipeline mirrors the M2 workflow: take the 6 K (ordered) and a
 * paramagnetic reference pattern for the *same* detector bank (identical SLOG
 * TOF grid), scale the reference on the high-Q half where magnetism is
 * negligible, detect the extra (magnetic) peaks in the difference, convert their
 * TOF to d via the bank calibration, and rank candidate k. The true k = (½,0,0)
 * tops the ranking. Skips when the git-ignored data/ folder is absent.
 */

const CIF = "AWO4/AWO4_HE_100K_refined.cif";
const INST = "AWO4/GSAS-II_2025B_HR/2025B_HighRes_60HzB3_CWL2p665.instprm";
const LOW_6K = "AWO4/autoreduced/PG3_61115.gsa"; // 6.06 K, bank 3 — magnetically ordered
const PARA_100K = "AWO4/autoreduced/PG3_61133.gsa"; // 100 K, bank 3 — paramagnetic reference
const has = dataExists(CIF) && dataExists(INST) && dataExists(LOW_6K) && dataExists(PARA_100K);

describe.skipIf(!has)("real AWO₄ — magnetic k-search from 6 K POWGEN neutron data", () => {
  it("recovers k = (½,0,0) from the 6 K − paramagnetic magnetic peaks", () => {
    const s = parseCif(readData(CIF), "awo4");
    const inst = parseInstrumentParameters(readData(INST));
    expect(inst.kind).toBe("tof");
    if (inst.kind !== "tof") return;

    const low = parseGsasHistogramPattern(readData(LOW_6K), "low", "AWO4 6 K");
    const ref = parseGsasHistogramPattern(readData(PARA_100K), "ref", "AWO4 100 K");
    // Same bank ⇒ same SLOG grid, so the two patterns subtract point-for-point.
    expect(ref.points.length).toBe(low.points.length);

    const dArr = low.points.map((p) => dFromTof(inst, p.x));
    const yLow = low.points.map((p) => p.yObs);
    const yRef = ref.points.map((p) => p.yObs);

    // Scale the paramagnetic reference to the ordered pattern using the high-Q
    // half (d < 2 Å), where magnetic scattering has died off, so only the nuclear
    // intensities set the scale.
    let sumLow = 0;
    let sumRef = 0;
    for (let i = 0; i < dArr.length; i++) {
      if (dArr[i]! < 2) {
        sumLow += yLow[i]!;
        sumRef += yRef[i]!;
      }
    }
    const scale = sumRef > 0 ? sumLow / sumRef : 1;
    const yCalc = yRef.map((y) => y * scale);

    // Extra (magnetic) peaks: positive residual over the paramagnetic reference.
    const peaks = detectExtraPeaks(dArr, yLow, yCalc, { sigma: 8, minFraction: 0.05, limit: 30 });
    expect(peaks.length).toBeGreaterThan(3);

    const candidates = searchPropagationVector(s.cell, peaks.map((p) => p.d), { tolerance: 0.03 });
    // AWO₄'s propagation vector tops the ranking, explaining several satellites…
    expect(candidates[0]!.k).toEqual([0.5, 0, 0]);
    expect(candidates[0]!.matched).toBeGreaterThanOrEqual(3);
    // …and beats the other two zone-boundary axes on matched-peak count.
    const matchOf = (kx: number, ky: number, kz: number): number =>
      candidates.find((c) => c.k[0] === kx && c.k[1] === ky && c.k[2] === kz)?.matched ?? 0;
    expect(matchOf(0.5, 0, 0)).toBeGreaterThan(matchOf(0, 0.5, 0));
    expect(matchOf(0.5, 0, 0)).toBeGreaterThan(matchOf(0, 0, 0.5));
  });
});
