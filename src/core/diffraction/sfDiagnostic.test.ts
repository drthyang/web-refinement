import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { dataExists, readData } from "@/testSupport/data";

/**
 * Golden validation of our nuclear structure factor against GSAS-II's own
 * reflection list for GaNb4Se8 (F-4̄3m), extracted from GaNb4Se8_goodfit.gpx to
 * gsas_reflections.csv (h,k,l,mult,d,2θ,Fo²,Fc²). This guards the special-position
 * fix: summing the structure factor over a site's DISTINCT orbit (not all 96
 * operations) so Nb/Se on 3m and Ga on -4̄3m are weighted correctly. Before the
 * fix the ratio |F|²(ours)/Fc²(GSAS) spanned 17–88 (a ~5× relative error); after,
 * it is constant to within the small 100 K-vs-298.8 K ADP difference. Skips when
 * the git-ignored data/ folder is absent.
 */

const DIR = "GaNb4Se8_XRD_28ID";
const CIF = `${DIR}/GaNb4Se8_100K.cif`;
const REFL = `${DIR}/gsas_reflections.csv`;
const has = dataExists(CIF) && dataExists(REFL);

describe.skipIf(!has)("structure factor vs GSAS-II reflection list — GaNb4Se8", () => {
  it("reproduces GSAS-II's relative Fc² across the strongest reflections", () => {
    const s = parseCif(readData(CIF), "gns");
    const rad = { kind: "xray" as const, wavelength: 0.1665 };
    const rows = readData(REFL).trim().split(/\r?\n/).slice(1).map((l) => l.split(",").map(Number));
    const strong = rows
      .map((r) => ({ h: r[0]!, k: r[1]!, l: r[2]!, Fc2: r[7]! }))
      .filter((r) => r.Fc2 > 0)
      .sort((a, b) => b.Fc2 - a.Fc2)
      .slice(0, 20);

    const ratios = strong.map((r) => nuclearStructureFactorSquared(s, rad, r.h, r.k, r.l) / r.Fc2);
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    // Relative structure factors match GSAS-II: the ratio is nearly constant.
    // (The residual < ~1.5× spread is the 100 K-vs-298.8 K Debye–Waller/ADP
    // difference, which grows mildly with angle.) A regression of the
    // special-position over-counting bug would blow this spread to ~5×.
    expect(max / min).toBeLessThan(1.6);
    expect(min).toBeGreaterThan(0);
    // The strongest reflection (400) — under-predicted ~3× before the fix.
    const f400 = nuclearStructureFactorSquared(s, rad, 4, 0, 0);
    const gsas400 = rows.find((r) => r[0] === 4 && r[1] === 0 && r[2] === 0)![7]!;
    expect(f400 / gsas400).toBeGreaterThan(0.8);
    expect(f400 / gsas400).toBeLessThan(1.3);
  });
});
