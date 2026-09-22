/**
 * Minimal, hand-built example projects — one per technique — used by the tests
 * and as the reference for the file format. Each is deliberately tiny (bcc
 * iron, one site, a handful of observations) and carries no calculated result:
 * just enough to exercise construction, validation and the JSON round-trip.
 */

import type { StructureModel } from "@/core/crystal/types";
import {
  PROJECT_SCHEMA_VERSION,
  type PdfWorkspace,
  type PowderWorkspace,
  type ProjectFile,
  type ProjectMetadata,
  type SingleCrystalWorkspace,
} from "@/core/project/types";

const FE_STRUCTURE: StructureModel = {
  id: "struct-fe",
  name: "bcc Fe",
  cell: { a: 2.8665, b: 2.8665, c: 2.8665, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: {
    number: 229,
    hermannMauguin: "I m -3 m",
    operations: [
      { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" },
      { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0.5, 0.5, 0.5], xyz: "x+1/2,y+1/2,z+1/2" },
    ],
  },
  sites: [{ label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } }],
};

function metadata(title: string): ProjectMetadata {
  return {
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    appVersion: "0.0.0",
    notes: "Reference fixture; not a validated refinement.",
  };
}

const POWDER_WORKSPACE: PowderWorkspace = {
  technique: "powder",
  pattern: {
    id: "data-fe-powder",
    name: "fe_cw.xye",
    xUnit: "twoTheta",
    radiation: { kind: "neutron", wavelength: 1.54 },
    wavelength: 1.54,
    points: [
      { x: 40.0, yObs: 12.1, sigma: 3.5 },
      { x: 42.0, yObs: 15.4, sigma: 3.9 },
      { x: 44.0, yObs: 310.2, sigma: 17.6 },
      { x: 46.0, yObs: 22.0, sigma: 4.7 },
      { x: 48.0, yObs: 11.8, sigma: 3.4 },
    ],
  },
  instrument: { kind: "constantWavelength", radiationKind: "neutron", wavelength: 1.54 },
  instrumentLoaded: false,
  profile: { shape: "gaussian", lorentz: true },
  backgroundTerms: 2,
  siteTies: { positions: true, adp: true },
  source: "fe_cw.xye",
  refinement: {
    parameters: [
      { id: "scale", label: "scale", kind: "scale", value: 1.2, initialValue: 1, min: 0, fixed: false },
      { id: "bkg0", label: "background 0", kind: "background", value: 10, initialValue: 10, fixed: false },
      { id: "bkg1", label: "background 1", kind: "background", value: 0, initialValue: 0, fixed: false },
      { id: "cell_a", label: "a (Å)", kind: "cellLength", value: 2.8665, initialValue: 2.8665, min: 1, fixed: true },
      { id: "width", label: "peak width", kind: "peakWidth", value: 0.1, initialValue: 0.1, min: 0.001, fixed: true },
    ],
    bindings: [
      { parameterId: "scale", kind: "scale", targetId: "data-fe-powder" },
      { parameterId: "bkg0", kind: "background", targetId: "data-fe-powder", targetKey: "0" },
      { parameterId: "bkg1", kind: "background", targetId: "data-fe-powder", targetKey: "1" },
      { parameterId: "cell_a", kind: "cellLength", targetId: "struct-fe", targetKey: "a" },
      { parameterId: "width", kind: "peakWidth", targetId: "data-fe-powder" },
    ],
  },
  fitRange: { min: 41, max: 47 },
};

const SINGLE_CRYSTAL_WORKSPACE: SingleCrystalWorkspace = {
  technique: "singleCrystal",
  dataset: {
    id: "data-fe-hkl",
    name: "fe.hkl",
    radiation: { kind: "neutron", wavelength: 1.54 },
    reflections: [
      { h: 1, k: 1, l: 0, iObs: 100, sigma: 3 },
      { h: 2, k: 0, l: 0, iObs: 42, sigma: 2 },
      { h: 2, k: 1, l: 1, iObs: 61, sigma: 2.5 },
    ],
  },
  probe: "neutron",
  refinement: {
    parameters: [
      { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, min: 0, fixed: false },
      { id: "Fe1_Biso", label: "Fe1 B (Å²)", kind: "bIso", value: 0.5, initialValue: 0.5, min: 0, fixed: false },
    ],
    bindings: [
      { parameterId: "scale", kind: "scale", targetId: "data-fe-hkl" },
      { parameterId: "Fe1_Biso", kind: "bIso", targetId: "struct-fe", targetKey: "Fe1" },
    ],
  },
  outlierFilter: { on: false, cutoffSigma: 6 },
};

const PDF_WORKSPACE: PdfWorkspace = {
  technique: "pdf",
  pattern: {
    id: "data-fe-pdf",
    name: "fe.gr",
    scatteringType: "xray",
    qmax: 25,
    points: [
      { r: 1.5, gObs: -0.4 },
      { r: 2.0, gObs: 0.1 },
      { r: 2.5, gObs: 2.7 },
      { r: 3.0, gObs: 0.6 },
      { r: 3.5, gObs: -0.9 },
    ],
  },
  refinement: {
    parameters: [
      { id: "pdfScale", label: "scale", kind: "pdfScale", value: 0.9, initialValue: 1, min: 0, fixed: false },
      { id: "qdamp", label: "Qdamp (Å⁻¹)", kind: "qdamp", value: 0.03, initialValue: 0.03, min: 0, fixed: true },
      { id: "delta2", label: "δ₂ (Å²)", kind: "delta2", value: 2.1, initialValue: 0, min: 0, fixed: false },
    ],
    bindings: [
      { parameterId: "pdfScale", kind: "pdfScale", targetId: "data-fe-pdf" },
      { parameterId: "qdamp", kind: "qdamp", targetId: "data-fe-pdf" },
      { parameterId: "delta2", kind: "delta2", targetId: "data-fe-pdf" },
    ],
  },
  fitRange: { min: 1.5, max: 3.5 },
  positionMode: "atomic",
  boxcar: { plan: { width: 5, step: 1, direction: "up", randomStart: false, restarts: 4 } },
};

export function makeExamplePowderProject(): ProjectFile {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: metadata("Example: bcc iron — powder"),
    structures: [FE_STRUCTURE],
    workspace: POWDER_WORKSPACE,
    view: { step: 0 },
  };
}

export function makeExampleSingleCrystalProject(): ProjectFile {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: metadata("Example: bcc iron — single crystal"),
    structures: [FE_STRUCTURE],
    workspace: SINGLE_CRYSTAL_WORKSPACE,
  };
}

export function makeExamplePdfProject(): ProjectFile {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: metadata("Example: bcc iron — PDF"),
    structures: [FE_STRUCTURE],
    workspace: PDF_WORKSPACE,
  };
}

/** All three, for tests that must hold for every technique. */
export function makeExampleProjects(): readonly ProjectFile[] {
  return [makeExamplePowderProject(), makeExampleSingleCrystalProject(), makeExamplePdfProject()];
}
