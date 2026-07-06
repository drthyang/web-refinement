/**
 * Build synthetic observed data from any structure, so the workbench has
 * something to refine against (a self-consistent demonstration) for both the
 * bundled example and a user-loaded CIF.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { powderCurves } from "@/core/workflow/powder";
import { singleCrystalComparison } from "@/core/workflow/singleCrystal";
import { generateReflections } from "@/core/diffraction/reflections";
import { independentCellParameters } from "@/core/crystal/cellConstraints";

const NEUTRON = { kind: "neutron" as const, wavelength: 1.54 };
const TRUE_SCALE = 80;
const TRUE_WIDTH = 0.5;

/**
 * Powder refinement bindings. Cell bindings are symmetry-reduced: one parameter
 * per independent lattice parameter, each driving all the cell fields it
 * constrains (e.g. a single `cell_a` → a,b,c for a cubic cell), so dependent
 * axes cannot be refined independently.
 */
export function powderBindings(structure: StructureModel, datasetId: string): ParameterBinding[] {
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: datasetId },
    { parameterId: "width", kind: "peakWidth", targetId: datasetId },
  ];
  for (const spec of independentCellParameters(structure)) {
    for (const target of spec.targets) {
      bindings.push({ parameterId: spec.id, kind: spec.kind, targetId: structure.id, targetKey: target });
    }
  }
  return bindings;
}

export function powderParameters(structure: StructureModel, scale = TRUE_SCALE): RefinementParameter[] {
  const params: RefinementParameter[] = [
    { id: "scale", label: "scale", kind: "scale", value: scale, initialValue: scale, min: 0, fixed: false },
    { id: "width", label: "peak FWHM (°2θ)", kind: "peakWidth", value: TRUE_WIDTH, initialValue: TRUE_WIDTH, min: 0.05, fixed: true },
  ];
  for (const spec of independentCellParameters(structure)) {
    params.push({ id: spec.id, label: spec.label, kind: spec.kind, value: spec.value, initialValue: spec.value, fixed: true });
  }
  return params;
}

export function buildSyntheticPowder(structure: StructureModel): PowderPattern {
  const grid = Array.from({ length: 500 }, (_, i) => 12 + (i * 108) / 500);
  const datasetId = `${structure.id}-powder`;
  const empty: PowderPattern = {
    id: datasetId,
    name: `${structure.name} synthetic neutron (λ=1.54 Å)`,
    xUnit: "twoTheta",
    radiation: NEUTRON,
    wavelength: 1.54,
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const truth = powderParameters(structure);
  const curves = powderCurves(structure, empty, truth, powderBindings(structure, datasetId));
  return {
    ...empty,
    points: grid.map((x, i) => {
      const y = curves.yCalc[i] ?? 0;
      return { x, yObs: y + 2, sigma: Math.sqrt(Math.max(y, 1)) + 1 };
    }),
  };
}

export function singleCrystalBindings(datasetId: string): ParameterBinding[] {
  return [{ parameterId: "scale", kind: "scale", targetId: datasetId }];
}

export function singleCrystalParameters(scale = 5): RefinementParameter[] {
  return [{ id: "scale", label: "scale", kind: "scale", value: scale, initialValue: scale, min: 0, fixed: false }];
}

export function buildSyntheticSingleCrystal(structure: StructureModel): SingleCrystalDataset {
  const datasetId = `${structure.id}-sx`;
  const reflections = generateReflections(structure.cell, structure.spaceGroup, 1.0, 5.0).slice(0, 24);
  const truth = singleCrystalParameters(5).map((p) => ({ ...p, value: 5 }));
  const comparison = singleCrystalComparison(
    structure,
    { id: datasetId, name: "sx", radiation: NEUTRON, reflections: reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, iObs: 0 })) },
    truth,
    singleCrystalBindings(datasetId),
  );
  return {
    id: datasetId,
    name: `${structure.name} synthetic single crystal`,
    radiation: NEUTRON,
    reflections: comparison.map((c) => ({ h: c.h, k: c.k, l: c.l, iObs: c.iCalc, sigma: Math.sqrt(Math.abs(c.iCalc)) + 1 })),
  };
}
