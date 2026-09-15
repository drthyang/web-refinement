import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/mn3ga";
import { buildSyntheticSingleCrystal } from "@/examples/synthetic";
import { newSession, DEFAULT_INSTRUMENT } from "@/app/powderSession";
import {
  defaultProjectTitle,
  modulatedHypothesisFrom,
  modulatedInputsFrom,
  overlaySavedParameters,
  pdfWorkspaceFrom,
  powderWorkspaceFrom,
  projectFileFor,
  restoreMomentBindings,
  restoreSingleCrystalParameters,
  sessionFromPowderWorkspace,
  singleCrystalWorkspaceFrom,
} from "@/app/projectIo";
import { parseProject, serializeProject } from "@/core/project/io";
import { buildSingleCrystalSpec } from "@/core/workflow/singleCrystalRefinement";
import { buildPdfSpec } from "@/core/workflow/pdf";
import type { PdfPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter, RefinementResult } from "@/core/refinement/types";

const structure = exampleStructure();

const someResult: RefinementResult = {
  status: "converged",
  parameters: { scale: 2 },
  esd: { scale: 0.1 },
  agreement: { rFactor: 0.1, rWeighted: 0.08 },
  history: [{ iteration: 0, chiSquared: 10, agreement: { rFactor: 0.1 } }],
};

/** Write → read through the real serializer and validator. */
function roundTrip<T>(file: T): T {
  return parseProject(serializeProject(file as never)) as unknown as T;
}

describe("powder capture / restore", () => {
  it("rebuilds an identical session from a saved workspace (real spec, real bindings)", () => {
    const session = { ...newSession(structure, DEFAULT_INSTRUMENT), anisotropicAdp: false, mustrain: "uniaxial" as const };
    session.powderParams[0]!.value = 3.5;
    session.powderParams[2]!.fixed = false;
    const view = { fitRange: { min: 20, max: 80 }, displayUnit: "q" as const, manualPeakD: [2.1, 1.7] };
    const ws = powderWorkspaceFrom(session, someResult, DEFAULT_INSTRUMENT, false, view);
    const file = roundTrip(projectFileFor({ structures: [session.structure], workspace: ws, title: "t", step: 1 }));
    expect(file.view).toEqual({ step: 1 });
    if (file.workspace.technique !== "powder") throw new Error("technique");
    const back = sessionFromPowderWorkspace(file.workspace, file.structures);
    expect(back.session).toEqual(session);
    expect(back.result).toEqual(someResult);
    expect(back.instrument).toEqual(DEFAULT_INSTRUMENT);
    expect(back.view).toEqual(view);
  });

  it("carries extra phases as structures[1..] and the magnetic model with the primary phase", () => {
    const extra = { ...structure, id: "mno", name: "MnO" };
    const magnetic: MagneticModel = {
      id: "mag", structureId: structure.id, propagation: [[0, 0, 0]],
      moments: structure.sites.slice(0, 1).map((s) => ({ siteLabel: s.label, frame: "crystallographic" as const, components: [0, 0, 2] as const })),
    };
    const session = { ...newSession(structure, DEFAULT_INSTRUMENT), extraPhases: [extra], magnetic };
    const ws = powderWorkspaceFrom(session, null, DEFAULT_INSTRUMENT, false, { fitRange: null, displayUnit: null, manualPeakD: [] });
    const file = roundTrip(projectFileFor({ structures: [structure, extra], workspace: ws, title: "t" }));
    if (file.workspace.technique !== "powder") throw new Error("technique");
    const back = sessionFromPowderWorkspace(file.workspace, file.structures);
    expect(back.session.extraPhases).toEqual([extra]);
    expect(back.session.magnetic).toEqual(magnetic);
    expect(back.view).toEqual({ fitRange: null, displayUnit: null, manualPeakD: [] });
  });
});

describe("overlaySavedParameters", () => {
  const spec: RefinementParameter[] = [
    { id: "a", label: "a", kind: "scale", value: 1, initialValue: 1, fixed: false },
    { id: "b", label: "b", kind: "bIso", value: 0.5, initialValue: 0.5, fixed: true, esd: 0.01 },
    { id: "new", label: "new in this build", kind: "occupancy", value: 1, initialValue: 1, fixed: true },
  ];
  const saved: RefinementParameter[] = [
    { id: "a", label: "a", kind: "scale", value: 7, initialValue: 6, fixed: true, esd: 0.2 },
    { id: "b", label: "b", kind: "bIso", value: 0.9, initialValue: 0.5, fixed: false },
    { id: "gone", label: "dropped kind", kind: "poRatio", value: 1, initialValue: 1, fixed: false },
    { id: "mom_Mn1_1", label: "moment", kind: "momentMode", value: 2.2, initialValue: 1, fixed: false },
  ];

  it("takes value / initialValue / fixed / esd from the file, keeps the spec's row otherwise", () => {
    const out = overlaySavedParameters(spec, saved);
    expect(out.map((p) => p.id)).toEqual(["a", "b", "new"]);
    expect(out[0]).toEqual({ id: "a", label: "a", kind: "scale", value: 7, initialValue: 6, fixed: true, esd: 0.2 });
    // A saved row without an esd clears the spec's stale one.
    expect(out[1]).toEqual({ id: "b", label: "b", kind: "bIso", value: 0.9, initialValue: 0.5, fixed: false });
    expect(out[2]).toEqual(spec[2]);
  });

  it("appends only the saved rows the caller vouches for", () => {
    const out = overlaySavedParameters(spec, saved, (p) => p.kind === "momentMode");
    expect(out.map((p) => p.id)).toEqual(["a", "b", "new", "mom_Mn1_1"]);
  });

  it("returns copies, never the spec's or the file's own objects", () => {
    const out = overlaySavedParameters(spec, saved, () => true);
    expect(out.some((p) => spec.includes(p) || saved.includes(p))).toBe(false);
  });
});

describe("single-crystal capture / restore", () => {
  const dataset = buildSyntheticSingleCrystal(structure);
  const spec = buildSingleCrystalSpec(structure, dataset, { extinction: 0 });
  const magnetic: MagneticModel = {
    id: "mag", structureId: structure.id, propagation: [[0, 0, 0]],
    moments: [{ siteLabel: structure.sites[0]!.label, frame: "crystallographic", components: [0, 0, 1] }],
  };
  const momentParam: RefinementParameter = { id: "mom_1", label: "m", kind: "momentMode", value: 1.5, initialValue: 1, fixed: false };
  const momentBinding: ParameterBinding = { parameterId: "mom_1", kind: "momentMode", targetId: "mag", targetKey: structure.sites[0]!.label, momentBasis: [0, 0, 1] };

  it("round-trips the page state, rebuilding nuclear rows from the spec and appending moment rows", () => {
    const edited = spec.params.map((p, i) => (i === 0 ? { ...p, value: 42, fixed: true } : { ...p }));
    const ws = singleCrystalWorkspaceFrom({
      dataset, magneticDataset: null, probe: "xray",
      params: [...edited, momentParam], bindings: [...spec.bindings, momentBinding], result: someResult, magnetic,
      filterOn: true, cutoffSigma: 4,
      modulated: { kText: ["1/4", "0", "1/4"], ionState: { Mn1: { on: true, dir: ["0", "0", "1"], phase: "1/4" } }, moment: 1, seed: 3, restarts: 8 },
    });
    const file = roundTrip(projectFileFor({ structures: [structure], workspace: ws, title: "sc" }));
    if (file.workspace.technique !== "singleCrystal") throw new Error("technique");
    const back = file.workspace;
    expect(back.probe).toBe("xray");
    expect(back.dataset).toEqual(dataset);
    const params = restoreSingleCrystalParameters(spec.params, back);
    expect(params[0]!.value).toBe(42);
    expect(params[0]!.fixed).toBe(true);
    expect(params.slice(1, edited.length)).toEqual(edited.slice(1));
    expect(params[params.length - 1]).toEqual(momentParam);
    expect(restoreMomentBindings(back)).toEqual([momentBinding]);
    expect(back.magnetic).toEqual(magnetic);
    expect(back.outlierFilter).toEqual({ on: true, cutoffSigma: 4 });
    expect(modulatedInputsFrom(back.modulated!)).toEqual({
      kText: ["1/4", "0", "1/4"], ionState: { Mn1: { on: true, dir: ["0", "0", "1"], phase: "1/4" } }, moment: 1, seed: 3, restarts: 8,
    });
  });

  it("does not resurrect moment rows when the file has no magnetic model", () => {
    const ws = singleCrystalWorkspaceFrom({
      dataset, magneticDataset: null, probe: "neutron",
      params: [...spec.params, momentParam], bindings: [...spec.bindings, momentBinding], result: null, magnetic: null,
      filterOn: false, cutoffSigma: 6,
      modulated: modulatedInputsFrom(modulatedHypothesisFrom({ kText: ["0", "0", "0"], ionState: {}, moment: 1, seed: 1, restarts: 8 })),
    });
    expect(restoreSingleCrystalParameters(spec.params, ws).map((p) => p.id)).toEqual(spec.params.map((p) => p.id));
    expect(restoreMomentBindings(ws)).toEqual([]);
  });
});

describe("PDF capture / restore", () => {
  const pattern: PdfPattern = {
    id: "pdf", name: "t.gr", scatteringType: "xray", qmax: 25,
    points: Array.from({ length: 60 }, (_, i) => ({ r: 1 + i * 0.1, gObs: Math.sin(i / 3) })),
  };
  const spec = buildPdfSpec(structure, pattern);

  it("round-trips the page state through the validator", () => {
    const params = spec.params.map((p) => (p.kind === "pdfScale" ? { ...p, value: 0.77 } : { ...p }));
    const ws = pdfWorkspaceFrom({
      pattern, params, bindings: spec.bindings, result: someResult, fitRange: { min: 1.5, max: 6 }, positionMode: "atomic",
      modes: null, spinModel: null, boxcarPlan: { width: 3, step: 1, direction: "both", randomStart: true, restarts: 2 }, boxcarRun: null,
    });
    const file = roundTrip(projectFileFor({ structures: [structure], workspace: ws, title: "pdf", notes: "n" }));
    expect(file.metadata.notes).toBe("n");
    if (file.workspace.technique !== "pdf") throw new Error("technique");
    expect(file.workspace.pattern).toEqual(pattern);
    expect(file.workspace.fitRange).toEqual({ min: 1.5, max: 6 });
    expect(file.workspace.boxcar).toEqual({ plan: { width: 3, step: 1, direction: "both", randomStart: true, restarts: 2 } });
    const restored = overlaySavedParameters(spec.params, file.workspace.refinement.parameters);
    expect(restored.find((p) => p.kind === "pdfScale")!.value).toBe(0.77);
    expect(restored).toEqual(params);
  });
});

describe("titles", () => {
  it("names the file after the primary phase and the technique", () => {
    expect(defaultProjectTitle(structure, "pdf")).toBe(`${structure.name} · PDF (real space)`);
    expect(defaultProjectTitle({ ...structure, name: "" }, "powder")).toBe(`${structure.id} · Rietveld (powder)`);
  });
});
