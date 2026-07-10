/**
 * Materials reading of a refined structure — the bridge from "the fit converged"
 * to "here is what this material is doing, and what to look at next."
 *
 * An experienced materials scientist does not stop at wR: a refined occupancy is
 * a vacancy concentration or a dopant level; a refined microstrain is lattice
 * defects or residual stress; a large displacement parameter is static disorder;
 * a refined moment is a magnetic ground state. This module turns the refined
 * quantities into those structured, materials-relevant findings so an agent can
 * reason about engineering and discovery, not just fit quality.
 *
 * Pure and deterministic. It reports facts and their usual materials meaning; it
 * does not claim novelty or assert a mechanism — the caller/agent does that,
 * with a human in the loop.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { RefinementParameter } from "@/core/refinement/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { extractSizeStrain } from "@/core/diffraction/microstructure";
import { bondLengths } from "@/core/crystal/geometry";

export type MaterialsCategory =
  | "microstructure"
  | "stoichiometry"
  | "displacement"
  | "magnetism"
  | "geometry";

export interface MaterialsFinding {
  readonly category: MaterialsCategory;
  readonly summary: string;
  /** The engineering / discovery implication — what this quantity means and is worth probing. */
  readonly detail?: string;
  readonly evidence?: Readonly<Record<string, number | string>>;
}

export interface StructureInterpretation {
  readonly findings: readonly MaterialsFinding[];
  readonly summary: string;
}

export interface InterpretationInput {
  /** The refined structure (current values applied to cell / positions / occ / ADP). */
  readonly structure: StructureModel;
  /** The refinement parameters (for the profile size/strain coefficients + esds). */
  readonly parameters?: readonly RefinementParameter[];
  readonly esd?: Readonly<Record<string, number>>;
  /** Wavelength (Å) — required to convert the size coefficient to a length. */
  readonly wavelength?: number;
  /** Refined magnetic model, if any. */
  readonly magnetic?: MagneticModel | null;
}

const norm = (v: readonly number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/**
 * Read a refined structure for materials-relevant signals. Deterministic; each
 * finding pairs the measured quantity with its usual materials interpretation.
 */
export function interpretStructure(input: InterpretationInput): StructureInterpretation {
  const { structure, parameters = [], esd, wavelength, magnetic } = input;
  const findings: MaterialsFinding[] = [];

  // --- microstructure: crystallite size & microstrain --------------------
  const px = parameters.find((p) => p.kind === "profileX");
  const py = parameters.find((p) => p.kind === "profileY");
  const mustrainIso = parameters.find((p) => p.kind === "mustrainIso");
  if ((px || py) && wavelength) {
    const ss = extractSizeStrain({
      x: px?.value ?? 0,
      y: py?.value ?? 0,
      wavelength,
      ...(px && esd?.[px.id] !== undefined ? { xEsd: esd[px.id] } : {}),
      ...(py && esd?.[py.id] !== undefined ? { yEsd: esd[py.id] } : {}),
      instrument: { x: px?.initialValue ?? 0, y: py?.initialValue ?? 0 },
    });
    const size = ss.sizeNm.value;
    const ppm = ss.strainPpm.value;
    if (Number.isFinite(size) && size > 0) {
      findings.push({
        category: "microstructure",
        summary: `Crystallite size ≈ ${size.toFixed(0)} nm${ss.sizeNm.esd !== undefined ? ` ± ${ss.sizeNm.esd.toFixed(0)}` : ""}.`,
        detail: size < 100
          ? "Nanocrystalline: sub-100 nm domains broaden the peaks (Scherrer). Relevant to catalysis, battery kinetics, and any property that scales with surface-to-volume — and a size worth confirming against TEM/BET."
          : "Sizeable, well-ordered domains — size broadening is minor here.",
        evidence: { sizeNm: Number(size.toFixed(1)) },
      });
    }
    if (Number.isFinite(ppm) && ppm > 0) {
      findings.push({
        category: "microstructure",
        summary: `Microstrain ≈ ${ppm.toFixed(0)} ×10⁻⁶ (${(ppm / 1e4).toFixed(3)}%)${ss.strainPpm.esd !== undefined ? ` ± ${ss.strainPpm.esd.toFixed(0)}` : ""}.`,
        detail: ppm > 1000
          ? "Significant lattice strain — dislocations, compositional gradients, or residual stress from processing (milling, quenching, thin-film mismatch). A lever for property engineering and a candidate cause of anisotropic broadening."
          : "Low lattice strain — a well-relaxed lattice.",
        evidence: { microstrainPpm: Number(ppm.toFixed(0)) },
      });
    }
  } else if (mustrainIso) {
    const mu = Math.sqrt(Math.max(mustrainIso.value * mustrainIso.value - mustrainIso.initialValue * mustrainIso.initialValue, 0));
    if (mu > 0) {
      findings.push({
        category: "microstructure",
        summary: `Microstrain ≈ ${mu.toFixed(0)} ×10⁻⁶ (TOF isotropic).`,
        detail: mu > 1000 ? "Significant lattice strain — see processing history (defects, residual stress)." : "Low lattice strain.",
        evidence: { microstrainPpm: Number(mu.toFixed(0)) },
      });
    }
  }

  // --- stoichiometry: partial occupancy ----------------------------------
  for (const site of structure.sites) {
    if (site.occupancy < 0.98) {
      const vacancy = 1 - site.occupancy;
      findings.push({
        category: "stoichiometry",
        summary: `${site.label} (${site.element}) is ${(100 * site.occupancy).toFixed(1)}% occupied — ${(100 * vacancy).toFixed(1)}% vacant.`,
        detail: "Partial occupancy is off-stoichiometry: vacancies, a dopant/substitution, or a mixed site. It changes charge balance and carrier count — central to defect engineering (ionic conductors, thermoelectrics, non-stoichiometric oxides). Cross-check against composition (EDX/ICP) and charge neutrality.",
        evidence: { occupancy: Number(site.occupancy.toFixed(4)), element: site.element },
      });
    }
  }

  // --- displacement: large B_iso -----------------------------------------
  for (const p of parameters) {
    if (p.kind === "bIso" && p.value > 3) {
      findings.push({
        category: "displacement",
        summary: `${p.label} has a large B_iso (${p.value.toFixed(2)} Å²).`,
        detail: "A large displacement parameter is either genuine thermal motion (light atom, high T), static positional disorder, or a symptom of a wrong/partial site or missing split position. If unexpected, it is a hint to re-examine the local structure.",
        evidence: { bIso: Number(p.value.toFixed(3)), label: p.label },
      });
    }
  }

  // --- magnetism: ordered moments ----------------------------------------
  if (magnetic && magnetic.moments.length > 0) {
    const mags = magnetic.moments.map((m) => norm(m.components));
    const maxMag = Math.max(...mags);
    // Net vs cancelling: sum the vectors. A near-zero resultant with non-zero
    // moments is antiferromagnetic-like; a large resultant is ferro/ferri-like.
    const net = magnetic.moments.reduce<[number, number, number]>((acc, m) => [acc[0] + m.components[0], acc[1] + m.components[1], acc[2] + m.components[2]], [0, 0, 0]);
    const netMag = norm(net);
    const totalMag = mags.reduce((s, x) => s + x, 0);
    const order = totalMag > 1e-6 && netMag / totalMag < 0.1 ? "antiferromagnetic-like (moments largely cancel)" : netMag > 1e-6 ? "net-moment (ferro/ferrimagnetic-like)" : "no net moment";
    findings.push({
      category: "magnetism",
      summary: `Ordered magnetic structure: ${magnetic.moments.length} moment${magnetic.moments.length === 1 ? "" : "s"}, |m|max ≈ ${maxMag.toFixed(2)} µB, ${order}.`,
      detail: "The moment arrangement is the magnetic ground state — it sets whether the material is a candidate for spintronics, magnetocalorics, or multiferroics. NOTE: absolute |m| carries a convention factor and has not been cross-checked against GSAS-II; treat directions and relative sizes as robust and confirm absolute magnitudes before quoting them.",
      evidence: { maxMomentMuB: Number(maxMag.toFixed(3)), netMomentMuB: Number(netMag.toFixed(3)) },
    });
  }

  // --- geometry: bond-length sanity --------------------------------------
  const bonds = bondLengths(structure);
  if (bonds.length > 0) {
    const shortest = bonds.reduce((m, b) => (b.distance < m.distance ? b : m), bonds[0]!);
    if (shortest.distance < 1.2) {
      findings.push({
        category: "geometry",
        summary: `Suspiciously short bond ${shortest.from}–${shortest.to} at ${shortest.distance.toFixed(2)} Å.`,
        detail: "Shorter than any real chemical bond — usually a wrong atomic position, an overlapping split site, or a symmetry error. Fix the geometry before interpreting anything else.",
        evidence: { distance: Number(shortest.distance.toFixed(3)), from: shortest.from, to: shortest.to },
      });
    }
  }

  const summary = findings.length === 0
    ? "No notable materials signals — a stoichiometric, well-ordered, strain-free structure by these refined quantities."
    : `${findings.length} materials signal${findings.length === 1 ? "" : "s"}: ${[...new Set(findings.map((f) => f.category))].join(", ")}.`;

  return { findings, summary };
}
