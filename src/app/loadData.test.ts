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
