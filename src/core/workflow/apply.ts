/**
 * Apply a flat parameter-value record onto a domain model, using parameter
 * bindings. This is the bridge between the crystallography-blind engine and the
 * StructureModel / auxiliary scalars the calculators need.
 */

import type { AtomSite, StructureModel, UnitCell } from "@/core/crystal/types";
import type { ParameterBinding } from "@/core/refinement/types";

export interface AppliedModel {
  readonly model: StructureModel;
  readonly scale: number;
  readonly magneticScale: number;
  /** Background polynomial coefficients by ascending power. */
  readonly background: number[];
  /** Single peak-width parameter (FWHM proxy / Caglioti W). */
  readonly peakWidth: number;
  /** Moment-magnitude scale applied to magnetic moments. */
  readonly momentScale: number;
}

type MutableCell = { -readonly [K in keyof UnitCell]: UnitCell[K] };

export function applyParameters(
  model: StructureModel,
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
): AppliedModel {
  const cell: MutableCell = { ...model.cell };
  const sites: AtomSite[] = model.sites.map((s) => ({ ...s, position: [...s.position] as [number, number, number] }));
  const byLabel = new Map(sites.map((s) => [s.label, s]));

  let scale = 1;
  let magneticScale = 1;
  let momentScale = 1;
  let peakWidth = 0.1;
  const background: number[] = [];

  for (const binding of bindings) {
    const v = values[binding.parameterId];
    if (v === undefined) continue;

    switch (binding.kind) {
      case "scale":
        scale = v;
        break;
      case "magneticScale":
        magneticScale = v;
        break;
      case "peakWidth":
        peakWidth = v;
        break;
      case "background": {
        const idx = binding.targetKey ? Number(binding.targetKey) : 0;
        background[idx] = v;
        break;
      }
      case "cellLength":
      case "cellAngle": {
        if (binding.targetKey && binding.targetKey in cell) {
          (cell as Record<string, number>)[binding.targetKey] = v;
        }
        break;
      }
      case "atomX":
      case "atomY":
      case "atomZ": {
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site) {
          const idx = binding.kind === "atomX" ? 0 : binding.kind === "atomY" ? 1 : 2;
          (site.position as [number, number, number])[idx] = v;
        }
        break;
      }
      case "occupancy": {
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site) (site as { occupancy: number }).occupancy = v;
        break;
      }
      case "bIso": {
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site && site.adp.kind === "isotropic") {
          (site as { adp: { kind: "isotropic"; bIso: number } }).adp = { kind: "isotropic", bIso: v };
        }
        break;
      }
      case "momentX":
      case "momentY":
      case "momentZ":
        momentScale = v; // moment vector edits handled by magnetic workflow
        break;
      case "zeroShift":
        break;
    }
  }

  const appliedModel: StructureModel = { ...model, cell, sites };
  return {
    model: appliedModel,
    scale,
    magneticScale,
    momentScale,
    peakWidth,
    background: background.length ? background.map((c) => c ?? 0) : [],
  };
}
