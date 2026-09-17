import { describe, expect, it } from "vitest";
import { exampleStructure } from "@/examples/mn3ga";
import {
  buildSyntheticPowder,
  buildSyntheticSingleCrystal,
  powderBindings,
  singleCrystalBindings,
} from "@/examples/synthetic";
import { parsePowderData } from "@/parsers/powderData";
import { parseHkl } from "@/parsers/hkl";
import { dSpacing } from "@/core/crystal/unitCell";
import {
  optimalScale,
  powderOptsFromInstrument,
  startingPowderParams,
  startingSxParams,
  isGsasReflectionList,
  loadReflectionDataset,
  describeDrops,
  structuralParameters,
} from "@/app/loadData";

describe("optimalScale", () => {
  it("returns the closed-form least-squares scale", () => {
    // obs = 2·calc exactly ⇒ scale 2.
    expect(optimalScale([2, 4, 6], [1, 2, 3])).toBeCloseTo(2, 10);
  });

  it("falls back to 1 when the calculated pattern is all zero", () => {
    expect(optimalScale([1, 2, 3], [0, 0, 0])).toBe(1);
  });
});

describe("powderOptsFromInstrument", () => {
  it("maps constant-wavelength instruments to a 2θ neutron pattern", () => {
    const opts = powderOptsFromInstrument({ kind: "constantWavelength", wavelength: 1.54 }, "id", "f.xye");
    expect(opts.xUnit).toBe("twoTheta");
    expect(opts.wavelength).toBe(1.54);
    expect(opts.radiation).toEqual({ kind: "neutron", wavelength: 1.54 });
  });

  it("preserves X-ray radiation for constant-wavelength instruments", () => {
    const opts = powderOptsFromInstrument({ kind: "constantWavelength", radiationKind: "xray", wavelength: 0.1665 }, "id", "f.dat");
    expect(opts.xUnit).toBe("twoTheta");
    expect(opts.wavelength).toBe(0.1665);
    expect(opts.radiation).toEqual({ kind: "xray", wavelength: 0.1665 });
  });

  it("maps TOF instruments to a tof pattern", () => {
    const opts = powderOptsFromInstrument({ kind: "tof", difC: 5000 }, "id", "f.dat");
    expect(opts.xUnit).toBe("tof");
    expect(opts.radiation).toEqual({ kind: "neutron-tof" });
  });
});

describe("startingPowderParams", () => {
  it("recovers the data's scale and frees scale + width", () => {
    const structure = exampleStructure();
    // buildSyntheticPowder bakes in TRUE_SCALE = 80; a correct estimate ≈ 80.
    const pattern = buildSyntheticPowder(structure);
    const bindings = powderBindings(structure, pattern.id);
    const params = startingPowderParams(structure, pattern, bindings);

    const scale = params.find((p) => p.id === "scale")!;
    const width = params.find((p) => p.id === "width")!;
    expect(scale.fixed).toBe(false);
    expect(width.fixed).toBe(false);
    // The flat background offset biases the estimate slightly high but it must
    // land in the right ballpark, not the hardcoded default.
    expect(scale.value).toBeGreaterThan(60);
    expect(scale.value).toBeLessThan(100);
  });

  it("parses a hand-written pattern and estimates a positive scale", () => {
    const structure = exampleStructure();
    const truth = buildSyntheticPowder(structure);
    // Round-trip through the text parser the UI actually uses.
    const text = truth.points.map((p) => `${p.x} ${p.yObs}`).join("\n");
    const opts = powderOptsFromInstrument({ kind: "constantWavelength", wavelength: 1.54 }, truth.id, "hand.xy");
    const parsed = parsePowderData(text, opts);
    const bindings = powderBindings(structure, parsed.id);
    const params = startingPowderParams(structure, parsed, bindings);
    expect(params.find((p) => p.id === "scale")!.value).toBeGreaterThan(0);
  });
});

describe("startingSxParams", () => {
  it("recovers the reflection dataset's scale and frees it", () => {
    const structure = exampleStructure();
    const dataset = buildSyntheticSingleCrystal(structure); // TRUE scale = 5
    const bindings = singleCrystalBindings(dataset.id);
    const params = startingSxParams(structure, dataset, bindings);
    const scale = params.find((p) => p.id === "scale")!;
    expect(scale.fixed).toBe(false);
    expect(scale.value).toBeCloseTo(5, 1);
  });

  it("accepts a parsed HKL list", () => {
    const structure = exampleStructure();
    const dataset = buildSyntheticSingleCrystal(structure);
    const text = dataset.reflections.map((r) => `${r.h} ${r.k} ${r.l} ${r.iObs} ${r.sigma ?? 1}`).join("\n");
    const reflections = parseHkl(text);
    expect(reflections.length).toBe(dataset.reflections.length);
    const parsed = { ...dataset, reflections };
    const params = startingSxParams(structure, parsed, singleCrystalBindings(dataset.id));
    expect(params.find((p) => p.id === "scale")!.value).toBeCloseTo(5, 1);
  });
});

describe("loadReflectionDataset", () => {
  it("detects GSAS-II reflection lists", () => {
    expect(isGsasReflectionList("  h k l m d-space TOF wid Fo**2 Fc**2")).toBe(true);
    expect(isGsasReflectionList("1 0 0 12.3 0.4")).toBe(false);
  });

  it("keeps phase reflections and drops those from another cell", () => {
    const structure = exampleStructure();
    const d = (h: number, k: number, l: number) => dSpacing(structure.cell, h, k, l);
    // GSAS-format rows: h k l m d TOF wid Fo2 Fc2 Icorr. Two match the cell, one
    // has a wilfully wrong d-spacing (a different phase) and must be dropped.
    const text = [
      "PWDR foo Reflection List",
      "   h   k   l   m   d-space  TOF  wid  Fo**2  Fc**2  Icorr",
      `   1   0   0   6   ${d(1, 0, 0).toFixed(5)}  1000  1  5.0  4.8  100`,
      `   1   1   0   6   ${d(1, 1, 0).toFixed(5)}  900   1  3.0  3.1  80`,
      `   1   1   1   8   2.57401  800   1  9.0  8.9  100`, // impurity d, not this cell
    ].join("\n");
    const loaded = loadReflectionDataset(text, structure, "ds", "foo.dat");
    expect(loaded.format).toBe("gsas");
    expect(loaded.kept).toBe(2);
    expect(loaded.dropped).toBe(1);
    expect(loaded.dataset.reflections[0]!.iObs).toBe(5.0); // Fo**2 used as iObs
  });
});

describe("structuralParameters", () => {
  it("builds a freed scale plus a freed isotropic B per site", () => {
    const structure = exampleStructure();
    const dataset = buildSyntheticSingleCrystal(structure);
    const { parameters, bindings } = structuralParameters(structure, dataset);
    const scale = parameters.find((p) => p.id === "scale")!;
    expect(scale.fixed).toBe(false);
    // One B parameter per site, all freed, bound to bIso.
    const bParams = parameters.filter((p) => p.kind === "bIso");
    expect(bParams.length).toBe(structure.sites.length);
    expect(bParams.every((p) => !p.fixed)).toBe(true);
    expect(bindings.filter((b) => b.kind === "bIso").length).toBe(structure.sites.length);
  });
});

describe("loadReflectionDataset — the 0 0 0 forward-beam row", () => {
  const structure = exampleStructure();
  const INT = [
    "Crystal",
    "(3i4,2f8.2,i4,6f8.0)",
    "1.0000 0 0",
    "   0   0   0  120.00    0.00   1 0.00000 0.00000 0.00000 0.00000 0.00000 0.00000",
    "  -4 -10   1    0.04    0.02   1-0.42101-0.15770-0.49921-0.10071-0.75733 0.98234",
    "  -3 -11   1    0.18    0.01   1-0.41794-0.01514-0.49563-0.16901-0.76136 0.98550",
    "",
  ].join("\n");

  it("drops it from a nuclear file and reports it apart from other drops", () => {
    const loaded = loadReflectionDataset(INT, structure, "ds", "x_nuc.int");
    expect(loaded.format).toBe("fullprof");
    expect(loaded.kept).toBe(2);
    expect(loaded.dropped).toBe(0);
    expect(loaded.forwardBeamSkipped).toBe(1);
    expect(loaded.dataset.reflections.some((r) => r.h === 0 && r.k === 0 && r.l === 0)).toBe(false);
    expect(describeDrops(loaded)).toBe(" (1 forward-beam 0 0 0 row skipped)");
  });

  it("keeps it in the companion magnetic file (there it is the satellite at k)", () => {
    const loaded = loadReflectionDataset(INT, structure, "ds", "x_mag.int", { role: "magnetic" });
    expect(loaded.kept).toBe(3);
    expect(loaded.forwardBeamSkipped).toBe(0);
    expect(describeDrops(loaded)).toBe("");
  });

  it("ends a free-format SHELX list at the all-zero terminator", () => {
    const loaded = loadReflectionDataset("1 0 0 100 2\n0 0 0 0 0\n", structure, "ds", "x.hkl");
    expect(loaded.format).toBe("shelx");
    expect(loaded.kept).toBe(1);
    expect(loaded.forwardBeamSkipped).toBe(0);
  });

  it("drops the forward beam from a fixed-column .hkl and keeps it for the magnetic partner", () => {
    const text = [
      "   0   0   0  120.00    1.00   1",
      "   1   0   0  253.71    3.42   1",
      "   0   0   0    0.00    0.00   0",
    ].join("\n");
    const nuclear = loadReflectionDataset(text, structure, "ds", "x_nuc.hkl");
    expect(nuclear.kept).toBe(1);
    expect(nuclear.forwardBeamSkipped).toBe(1);
    const mag = loadReflectionDataset(text, structure, "ds", "x_mag.hkl", { role: "magnetic" });
    expect(mag.kept).toBe(2);
    expect(mag.forwardBeamSkipped).toBe(0);
  });
});

/**
 * Regression: both formats used to fall through to the whitespace splitter in
 * `parsers/hkl.ts`, which reads columns 1-5 positionally. That is the wrong
 * parse for each of them, and it fails SILENTLY — a plausible h k l I σ comes
 * back, just not the file's.
 */
describe("loadReflectionDataset — fixed-column .hkl and header-ordered .fcf", () => {
  const structure = exampleStructure();

  it("reads an HKLF 4 row whose intensity fills its F8.2 field (no space before l)", () => {
    // SHELX FORMAT 3I4,2F8.2,I4. I = 10000.00 uses all eight columns, so
    // whitespace-splitting gives l = 310000 and σ = 100 as the intensity.
    const loaded = loadReflectionDataset("   1   2   310000.00  100.00   1\n", structure, "ds", "x.hkl");
    expect(loaded.format).toBe("shelx");
    expect(loaded.dataset.reflections[0]).toEqual({ h: 1, k: 2, l: 3, iObs: 10000, sigma: 100 });
    // What the generic splitter returns for the same row — the bug, pinned.
    expect(parseHkl("   1   2   310000.00  100.00   1\n")[0]).toEqual({ h: 1, k: 2, l: 310000, iObs: 100, sigma: 1 });
  });

  it("takes .fcf intensities from the loop header, not by column position", () => {
    // LIST 4 writes F²calc BEFORE F²meas, so columns 4-6 are calc, meas, sigma:
    // reading positionally makes the calculated intensity the observation.
    const text = [
      "data_x",
      "loop_",
      "_refln_index_h",
      "_refln_index_k",
      "_refln_index_l",
      "_refln_F_squared_calc",
      "_refln_F_squared_meas",
      "_refln_F_squared_sigma",
      "_refln_observed_status",
      "   1   2   3  950.00  1000.00  20.00 o",
    ].join("\n");
    const loaded = loadReflectionDataset(text, structure, "ds", "x.fcf");
    expect(loaded.format).toBe("fcf");
    expect(loaded.dataset.reflections[0]).toEqual({ h: 1, k: 2, l: 3, iObs: 1000, sigma: 20 });
  });

  it("still reads a hand-edited free-format .hkl", () => {
    const loaded = loadReflectionDataset("1 0 0 253.71 3.42\n2 0 0 118.06 2.90\n", structure, "ds", "x.hkl");
    expect(loaded.kept).toBe(2);
    expect(loaded.dataset.reflections[0]!.iObs).toBeCloseTo(253.71, 6);
  });

  it("leaves a plain h k l I σ list on the generic reader", () => {
    const loaded = loadReflectionDataset("1 0 0 253.71 3.42\n", structure, "ds", "peaks.txt");
    expect(loaded.format).toBe("list");
    expect(loaded.dataset.reflections[0]!.iObs).toBeCloseTo(253.71, 6);
  });
});
