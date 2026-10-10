/**
 * The pages the eval scenarios run on, built from the datasets in the
 * repository so every run sees the same data: the Mn₃Ga powder demo (a
 * synthetic neutron pattern, 2θ at 1.54 Å) and the GaTa₄Se₈ PDF demo.
 */

import type { PdfAgentPort, PowderAgentPort } from "@/agent/port";
import { newSession, type Session } from "@/app/powderSession";
import { exampleStructure } from "@/examples/mn3ga";
import { generateReflections } from "@/core/diffraction/reflections";
import { pdfPort, sessionPort } from "@/testSupport/agentHeadless";
import { runPowderRefinement } from "@/workers/runPowder";
import { powderRestraints } from "@/app/powderSpec";

const WAVELENGTH = 1.54;
const twoThetaOf = (d: number): number => (2 * Math.asin(WAVELENGTH / (2 * d)) * 180) / Math.PI;

/** Seeded standard normal deviates: the same noise on every run. */
function gaussian(seed = 20261010): () => number {
  let state = seed;
  const uniform = (): number => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

/**
 * The Mn₃Ga demo as it loads (the scale and background free, the rest fixed
 * at the CIF's values, the peak width at 0.1° against a true 0.5°), with
 * seeded counting noise on the synthetic pattern: a fit converges onto the
 * noise as on real data, instead of stalling at a zero residual.
 */
export function mn3gaSession(): Session {
  const s = newSession(exampleStructure());
  const noise = gaussian();
  const points = s.pattern.points.map((p) => {
    const sigma = Math.sqrt(Math.max(p.yObs, 1));
    return { ...p, yObs: p.yObs + sigma * noise(), sigma };
  });
  return { ...s, pattern: { ...s.pattern, points } };
}

/** The demo's true peak width (FWHM, °2θ); the page starts at 0.1. */
const TRUE_WIDTH = 0.5;

/** The session with these parameters refined (and left fixed as they were): a start that fits. */
function prefit(s: Session, ids: readonly string[]): Session {
  const free = new Set(ids);
  const r = runPowderRefinement({
    type: "refinePowder",
    requestId: 0,
    structure: s.structure,
    pattern: s.pattern,
    parameters: s.powderParams.map((p) => ({ ...p, fixed: !free.has(p.id) })),
    bindings: s.powderBindings,
    shape: s.powderProfile.shape,
    restraints: powderRestraints([s.structure], s.siteTies, s.powderParams),
    options: { maxIterations: 20 },
  });
  return { ...s, powderParams: s.powderParams.map((p) => ({ ...p, value: r.parameters[p.id] ?? p.value })) };
}

/**
 * The demo with a start that is off the way a real one is — ADPs, the Mn
 * position and the peak width away from the truth — with the scale and
 * background fitted. Every reflection is where the model puts one; only
 * intensities and shapes differ: misfits, which refinement fixes, and no
 * extra peak.
 */
export function mn3gaMisfitSession(): Session {
  const s = mn3gaSession();
  const start: Record<string, number> = { B_Mn1: 2.6, B_Ga1: 0.15, pos_Mn1_0: 0.012, width: 1.25 * TRUE_WIDTH };
  const off = { ...s, powderParams: s.powderParams.map((p) => (p.id in start ? { ...p, value: start[p.id]! } : p)) };
  return prefit(off, scaleAndBackground(off));
}

const scaleAndBackground = (s: Session): string[] => s.powderParams.filter((p) => p.kind === "scale" || p.kind === "background").map((p) => p.id);

/** Where the impurity line of `mn3gaImpuritySession` sits (d, Å): in the widest gap between Mn₃Ga reflections. */
export function impurityD(): number {
  const s = mn3gaSession();
  const xs = s.pattern.points.map((p) => p.x);
  const dOf = (tt: number): number => WAVELENGTH / (2 * Math.sin((tt * Math.PI) / 360));
  const dMax = dOf(Math.min(...xs) + 5);
  const dMin = dOf(Math.max(...xs) - 5);
  const ds = [...new Set(generateReflections(s.structure.cell, s.structure.spaceGroup, Math.max(dMin, 1.2), dMax).map((r) => +r.d.toFixed(5)))].sort((a, b) => b - a);
  let best = { gap: 0, d: 0 };
  for (let i = 0; i + 1 < ds.length; i++) {
    const gap = ds[i]! / ds[i + 1]! - 1;
    if (gap > best.gap) best = { gap, d: Math.sqrt(ds[i]! * ds[i + 1]!) };
  }
  return best.d;
}

/**
 * The demo with one line of an unknown second phase added between the Mn₃Ga
 * reflections, the scale and background already fitted: what is left over is
 * that line.
 */
export function mn3gaImpuritySession(): Session {
  const s0 = mn3gaSession();
  const s = { ...s0, powderParams: s0.powderParams.map((p) => (p.id === "width" ? { ...p, value: TRUE_WIDTH } : p)) };
  const at = twoThetaOf(impurityD());
  const top = Math.max(...s.pattern.points.map((p) => p.yObs));
  const height = 0.04 * top;
  const sigma = TRUE_WIDTH / 2.355;
  const points = s.pattern.points.map((p) => {
    const y = p.yObs + height * Math.exp(-0.5 * ((p.x - at) / sigma) ** 2);
    return { ...p, yObs: y, sigma: Math.sqrt(Math.max(y, 4)) };
  });
  const withLine = { ...s, pattern: { ...s.pattern, points } };
  return prefit(withLine, scaleAndBackground(withLine));
}

export function powderPage(session: Session): PowderAgentPort {
  return sessionPort(session).port;
}

export function pdfPage(): PdfAgentPort {
  return pdfPort().port;
}
