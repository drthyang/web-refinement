/**
 * Magnetic space-group candidate comparison (procedure steps 5 & 7).
 *
 * For each candidate magnetic group, the allowed moment directions on each
 * magnetic site are computed (the proper symmetry constraints), moments are
 * parameterized along that allowed basis, and the model is refined against the
 * observed Bragg intensities. Candidates are ranked by weighted R — "which
 * magnetic space group fits better".
 */

import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { refine, type RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma } from "@/core/refinement/factors";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { momentCartesian } from "@/core/magnetic/moment";
import { norm } from "@/core/math/vec3";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import type { MagneticCandidate } from "@/core/magnetic/magneticGroups";

export interface CandidateFit {
  readonly candidate: MagneticCandidate;
  readonly result: RefinementResult;
  /** Weighted R (%). */
  readonly wR: number;
  /** Unweighted R (%). */
  readonly rFactor: number;
  readonly goodnessOfFit: number;
  /** Total free moment parameters across all magnetic sites. */
  readonly momentDof: number;
  /** Refined moment magnitude per magnetic site (μB, Cartesian). */
  readonly siteMoments: ReadonlyArray<{ label: string; magnitude: number }>;
}

interface SiteBasis {
  readonly label: string;
  readonly position: Vec3;
  readonly basis: Vec3[];
}

export interface CompareOptions {
  /** Labels of the asymmetric magnetic sites (e.g. the Mn sites). */
  readonly magneticSiteLabels: readonly string[];
  readonly maxIterations?: number;
  /**
   * Optional moment-size restraint (procedure step 6): pulls each site moment
   * magnitude toward `target` μB with the given weight, regularizing the
   * degeneracy of moment magnitudes under limited data. Mirrors GSAS-II's
   * "moments restraint weight factor".
   */
  readonly momentRestraint?: { readonly target: number; readonly weight: number };
}

function buildProblem(
  structure: StructureModel,
  candidate: MagneticCandidate,
  dataset: SingleCrystalDataset,
  siteBases: SiteBasis[],
  restraint: CompareOptions["momentRestraint"],
): { problem: RefinementProblem; parameters: RefinementParameter[]; siteBases: SiteBasis[] } {
  const parameters: RefinementParameter[] = [
    { id: "scaleN", label: "nuclear scale", kind: "scale", value: 1, initialValue: 1, min: 0, fixed: false },
  ];
  for (const sb of siteBases) {
    sb.basis.forEach((_, d) => {
      parameters.push({
        id: `${sb.label}__b${d}`,
        label: `${sb.label} c${d}`,
        kind: "momentX",
        value: 1.5,
        initialValue: 1.5,
        fixed: false,
      });
    });
  }

  const opsStructure: StructureModel = {
    ...structure,
    spaceGroup: { ...structure.spaceGroup, operations: candidate.operations },
  };

  const buildMagnetic = (values: Readonly<Record<string, number>>): MagneticModel => ({
    id: `${candidate.id}-mag`,
    structureId: structure.id,
    propagation: [[0, 0, 0]],
    moments: siteBases.map((sb) => {
      const comps: [number, number, number] = [0, 0, 0];
      sb.basis.forEach((bv, d) => {
        const c = values[`${sb.label}__b${d}`] ?? 0;
        comps[0] += c * bv[0];
        comps[1] += c * bv[1];
        comps[2] += c * bv[2];
      });
      return { siteLabel: sb.label, frame: "crystallographic" as const, components: comps };
    }),
  });

  const nRefl = dataset.reflections.length;
  const nRestraint = restraint ? siteBases.length : 0;

  // Observations: reflection intensities, then (optionally) moment-size targets.
  const obs = dataset.reflections.map((r) => r.iObs);
  const reflWeights = weightsFromSigma(dataset.reflections.map((r) => r.sigma));
  const observations = new Float64Array(nRefl + nRestraint);
  const weights = new Float64Array(nRefl + nRestraint);
  observations.set(obs, 0);
  weights.set(reflWeights, 0);
  if (restraint) {
    for (let i = 0; i < siteBases.length; i++) {
      observations[nRefl + i] = restraint.target;
      weights[nRefl + i] = restraint.weight;
    }
  }

  const magnitude = (mag: MagneticModel, label: string): number => {
    const m = mag.moments.find((mm) => mm.siteLabel === label);
    return m ? norm(momentCartesian(structure.cell, m)) : 0;
  };

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const scaleN = values.scaleN ?? 1;
    const mag = buildMagnetic(values);
    const out = new Float64Array(nRefl + nRestraint);
    for (let i = 0; i < nRefl; i++) {
      const r = dataset.reflections[i]!;
      const iN = scaleN * nuclearStructureFactorSquared(opsStructure, dataset.radiation, r.h, r.k, r.l);
      const iM = magneticStructureFactor(opsStructure, mag, r.h, r.k, r.l).squared;
      out[i] = iN + iM;
    }
    if (restraint) {
      for (let i = 0; i < siteBases.length; i++) {
        out[nRefl + i] = magnitude(mag, siteBases[i]!.label);
      }
    }
    return out;
  };

  return { problem: { parameters, observations, weights, calculate }, parameters, siteBases };
}

/** Refine every candidate against the data and rank by weighted R (best first). */
export function compareMagneticCandidates(
  structure: StructureModel,
  candidates: readonly MagneticCandidate[],
  dataset: SingleCrystalDataset,
  options: CompareOptions,
): CandidateFit[] {
  const fits: CandidateFit[] = [];

  for (const candidate of candidates) {
    const siteBases: SiteBasis[] = options.magneticSiteLabels
      .map((label) => {
        const site = structure.sites.find((s) => s.label === label);
        if (!site) return null;
        const allowed = allowedMomentDirections(candidate.operations, site.position);
        return { label, position: site.position, basis: allowed.basis };
      })
      .filter((sb): sb is SiteBasis => sb !== null && sb.basis.length > 0);

    const momentDof = siteBases.reduce((acc, sb) => acc + sb.basis.length, 0);
    const { problem } = buildProblem(structure, candidate, dataset, siteBases, options.momentRestraint);
    const result = refine(problem, { maxIterations: options.maxIterations ?? 25 });

    // Recover per-site moment magnitudes from the refined coefficients.
    const siteMoments = siteBases.map((sb) => {
      const comps: [number, number, number] = [0, 0, 0];
      sb.basis.forEach((bv, d) => {
        const c = result.parameters[`${sb.label}__b${d}`] ?? 0;
        comps[0] += c * bv[0];
        comps[1] += c * bv[1];
        comps[2] += c * bv[2];
      });
      // Physical magnitude uses the cell metric (normalized crystal axes), not
      // the raw component norm — important for non-orthogonal cells.
      const magnitude = norm(momentCartesian(structure.cell, { siteLabel: sb.label, frame: "crystallographic", components: comps }));
      return { label: sb.label, magnitude };
    });

    fits.push({
      candidate,
      result,
      wR: 100 * (result.agreement.rWeighted ?? 0),
      rFactor: 100 * result.agreement.rFactor,
      goodnessOfFit: result.agreement.goodnessOfFit ?? 0,
      momentDof,
      siteMoments,
    });
  }

  fits.sort((a, b) => a.wR - b.wR);
  return fits;
}
