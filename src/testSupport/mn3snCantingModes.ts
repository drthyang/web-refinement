/**
 * Two-mode-per-layer parameterization of the Mn₃Sn kagome canting for the
 * mPDF posterior work: each layer (x ≈ ¼ and x ≈ ¾ in the explicit-P1 cell)
 * carries an IN-PLANE triangle amplitude t (each site's moment along its own
 * in-plane unit direction from the mCIF) and an a-axis CANTING amplitude c
 * (every site along +x̂ — the reference script's `Cantmtrx_a` convention).
 *
 *   m_i = t_L·t̂_i + c_L·x̂     ⇒     cnt_L = atan2(c_L, t_L),  μ_L = √(t²+c²)
 *
 * The canting ANGLES are therefore pushforwards of a parameterization that is
 * LINEAR in the engine's momentMode machinery — no new kernel code. With
 * `mpdfOrdScale` pinned to the nuclear scale, the amplitudes are physical μ_B
 * (see the μ = √(ordScale/nucScale) note in the golden test).
 *
 * Everything numeric is derived from the mCIF text at runtime; this module
 * carries no data values.
 */
import type { Vec3 } from "@/core/math/types";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { readMcifMomentLoop } from "@/testSupport/mn3snMcif";

export interface CantingModeBuild {
  readonly magnetic: MagneticModel;
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  /** Site labels per layer (A = x ≈ ¼, B = x ≈ ¾), for round-trip checks. */
  readonly layers: { A: string[]; B: string[] };
}

/** Amplitudes (t, c) that reproduce a given canting angle and moment. */
export function amplitudesFor(cntDeg: number, mu: number): { t: number; c: number } {
  const rad = (cntDeg * Math.PI) / 180;
  return { t: mu * Math.cos(rad), c: mu * Math.sin(rad) };
}

/** Canting angle (deg) and moment (μ_B) from sampled amplitudes. */
export function anglesFrom(t: number, c: number): { cntDeg: number; mu: number } {
  return { cntDeg: (Math.atan2(c, t) * 180) / Math.PI, mu: Math.hypot(t, c) };
}

export function buildCantingModes(
  mcifText: string,
  structure: StructureModel,
  formFactorId: string,
  init: { tA: number; cA: number; tB: number; cB: number },
): CantingModeBuild {
  const loop = readMcifMomentLoop(mcifText);
  const magnetic: MagneticModel = {
    id: `${structure.id}-mag`,
    structureId: structure.id,
    propagation: [[0, 0, 0]],
    // Components are overwritten by the momentMode drive on every evaluation;
    // only the site list and form factor matter here.
    moments: [...loop.keys()].map((siteLabel) => ({
      siteLabel, frame: "crystallographic", components: [0, 0, 0] as Vec3, formFactorId,
    })),
  };

  const layers = { A: [] as string[], B: [] as string[] };
  const bindings: ParameterBinding[] = [];
  for (const [label, m] of loop.entries()) {
    const site = structure.sites.find((s) => s.label === label);
    if (!site) throw new Error(`mCIF moment ${label} has no matching site`);
    const layer = Math.abs(site.position[0] - 0.25) < 0.01 ? "A" : "B";
    layers[layer].push(label);
    // In-plane unit direction: the mCIF moment with its canting (x) component
    // removed — the un-canted 120° triangle pattern of this site.
    const inPlane = Math.hypot(m[1], m[2]);
    if (inPlane < 1e-8) throw new Error(`mCIF moment ${label} has no in-plane part`);
    const tHat: Vec3 = [0, m[1] / inPlane, m[2] / inPlane];
    bindings.push(
      { parameterId: `muT_${layer}`, kind: "momentMode", targetId: magnetic.id, targetKey: label, momentBasis: tHat },
      { parameterId: `muC_${layer}`, kind: "momentMode", targetId: magnetic.id, targetKey: label, momentBasis: [1, 0, 0] },
    );
  }

  // t > 0 pins the atan2 branch to (−90°, 90°); c may cross zero freely.
  const params: RefinementParameter[] = [
    { id: "muT_A", label: "layer-A in-plane μ·cos", kind: "momentMode", value: init.tA, initialValue: init.tA, min: 0.01, max: 6, fixed: false },
    { id: "muC_A", label: "layer-A canting μ·sin", kind: "momentMode", value: init.cA, initialValue: init.cA, min: -4, max: 4, fixed: false },
    { id: "muT_B", label: "layer-B in-plane μ·cos", kind: "momentMode", value: init.tB, initialValue: init.tB, min: 0.01, max: 6, fixed: false },
    { id: "muC_B", label: "layer-B canting μ·sin", kind: "momentMode", value: init.cB, initialValue: init.cB, min: -4, max: 4, fixed: false },
  ];
  return { magnetic, params, bindings, layers };
}
