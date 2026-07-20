import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine } from "@/core/refinement/engine";
import { samplePosterior } from "@/core/refinement/bayes/sampler";
import { sampleNuts } from "@/core/refinement/bayes/nuts";
import { buildPdfProblem, buildPdfSpec } from "@/core/workflow/pdf";
import { PDFFIT2_GOLDEN } from "@/core/pdf/pdffit2Golden";

/**
 * End-to-end gate (b) for the posterior sampler: on the Ni PDFfit2 golden, the
 * posterior over envelope parameters must center on the LM minimum, and the
 * MARGINALIZED noise model must reproduce the linearized ESDs in this
 * well-conditioned Gaussian limit (esdRatio ≈ 1). This validates the entire
 * chain — likelihood, error-scale marginalization, transforms, diagnostics —
 * against the engine's frequentist uncertainty machinery on a real problem.
 */

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };

function niProblemParts() {
  const c = PDFFIT2_GOLDEN.find((g) => g.name === "ni_neutron")!;
  const cell: UnitCell = { a: c.a, b: c.a, c: c.a, alpha: 90, beta: 90, gamma: 90 };
  const sites: AtomSite[] = c.sites.map(([el, x, y, z, u], i) => ({
    label: `${el}${i + 1}`,
    element: el,
    position: [x, y, z],
    occupancy: 1,
    adp: { kind: "isotropic", bIso: 8 * Math.PI * Math.PI * u },
  }));
  const structure: StructureModel = {
    id: "ni",
    name: "ni",
    cell,
    spaceGroup: { operations: [IDENTITY_OP] },
    sites,
  };
  const step = (c.rmax - c.rmin) / (c.n - 1);
  const pattern: PdfPattern = {
    id: c.name,
    name: c.name,
    scatteringType: c.scatteringType,
    points: c.g.map((g, i) => ({ r: c.rmin + i * step, gObs: g })),
    qmax: c.qmax,
    qdamp: c.qdamp,
    qbroad: c.qbroad,
  };
  return { c, structure, pattern };
}

describe("PDF posterior sampling — Ni golden (gate b)", () => {
  it("posterior centers on the LM minimum with esdRatio ≈ 1", () => {
    const { c, structure, pattern } = niProblemParts();
    const spec = buildPdfSpec(structure, pattern);
    // Free pdfScale + δ2 (envelope-only → the pair cache stays warm and every
    // sampler evaluation is cheap); hold the cell so this test stays fast.
    const params = spec.params.map((p) => {
      if (p.id === "delta2") return { ...p, value: c.delta2, fixed: false };
      if (p.kind === "cellLength" || p.kind === "cellAngle") return { ...p, fixed: true };
      return { ...p };
    });
    const problem = buildPdfProblem(structure, pattern, params, spec.bindings, spec.restraints, {
      min: 1.0,
    });

    // 1) LM point estimate + linearized ESDs.
    const lm = refine(problem, { maxIterations: 50, convergenceTolerance: 1e-8 });
    expect(["converged", "stalled"]).toContain(lm.status);
    const freeIds = params.filter((p) => !p.fixed).map((p) => p.id);
    expect(freeIds.sort()).toEqual(["delta2", "pdfScale"].sort());

    // 2) Sample the posterior seeded at the converged point.
    const seeded = params.map((p) =>
      p.fixed ? p : { ...p, value: lm.parameters[p.id]!, initialValue: lm.parameters[p.id]! },
    );
    const posteriorProblem = buildPdfProblem(structure, pattern, seeded, spec.bindings, spec.restraints, {
      min: 1.0,
    });
    const result = samplePosterior(posteriorProblem, {
      nSteps: 800,
      nWalkers: 12,
      burnIn: 300,
      seed: 42,
      noiseModel: "marginalized",
      linearizedEsd: lm.esd,
    });

    for (const p of result.posterior.parameters) {
      const lmValue = lm.parameters[p.id]!;
      const esd = lm.esd[p.id]!;
      expect(esd).toBeGreaterThan(0);
      // Posterior centered on the LM minimum.
      expect(Math.abs(p.median - lmValue)).toBeLessThan(0.25 * esd);
      // Marginalized noise model ⇒ posterior width ≈ linearized ESD here.
      expect(p.esdRatio).toBeDefined();
      expect(p.esdRatio!).toBeGreaterThan(0.7);
      expect(p.esdRatio!).toBeLessThan(1.4);
    }
    // Healthy mixing on a 2-parameter, well-conditioned posterior.
    expect(result.acceptanceFraction).toBeGreaterThan(0.2);
    expect(result.diagnostics.maxRHat).toBeLessThan(1.1);

    // eslint-disable-next-line no-console
    console.log(
      `[posterior:ni] ${result.posterior.parameters
        .map((p) => `${p.id}=${p.median.toPrecision(4)}±${p.std.toPrecision(2)} (esdRatio ${p.esdRatio!.toFixed(2)})`)
        .join(", ")} acc=${result.acceptanceFraction.toFixed(2)} R̂=${result.diagnostics.maxRHat.toFixed(3)}`,
    );
  }, 120_000);

  it("NUTS via gradChi2 reproduces the same posterior (esdRatio ≈ 1)", () => {
    // The gradient-based path end-to-end: the fused analytic ∂G/∂p pass feeds
    // gradChi2, the LM esds seed the mass matrix, and the resulting posterior
    // must agree with both the LM esds and (implicitly) the ensemble result.
    const { c, structure, pattern } = niProblemParts();
    const spec = buildPdfSpec(structure, pattern);
    const params = spec.params.map((p) => {
      if (p.id === "delta2") return { ...p, value: c.delta2, fixed: false };
      if (p.kind === "cellLength" || p.kind === "cellAngle") return { ...p, fixed: true };
      return { ...p };
    });
    const problem = buildPdfProblem(structure, pattern, params, spec.bindings, spec.restraints, {
      min: 1.0,
    });
    const lm = refine(problem, { maxIterations: 50, convergenceTolerance: 1e-8 });
    expect(["converged", "stalled"]).toContain(lm.status);

    const seeded = params.map((p) =>
      p.fixed ? p : { ...p, value: lm.parameters[p.id]!, initialValue: lm.parameters[p.id]! },
    );
    const posteriorProblem = buildPdfProblem(structure, pattern, seeded, spec.bindings, spec.restraints, {
      min: 1.0,
    });
    const result = sampleNuts(posteriorProblem, posteriorProblem.gradChi2, {
      nSteps: 250,
      nChains: 2,
      nWarmup: 60,
      seed: 42,
      noiseModel: "marginalized",
      linearizedEsd: lm.esd,
    });

    expect(result.nuts.divergences).toBe(0);
    for (const p of result.posterior.parameters) {
      const lmValue = lm.parameters[p.id]!;
      const esd = lm.esd[p.id]!;
      expect(Math.abs(p.median - lmValue), p.id).toBeLessThan(0.25 * esd);
      expect(p.esdRatio!, p.id).toBeGreaterThan(0.7);
      expect(p.esdRatio!, p.id).toBeLessThan(1.4);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[posterior:ni:nuts] ${result.posterior.parameters
        .map((p) => `${p.id}=${p.median.toPrecision(4)}±${p.std.toPrecision(2)} (esdRatio ${p.esdRatio!.toFixed(2)})`)
        .join(", ")} acc=${result.acceptanceFraction.toFixed(2)} R̂=${result.diagnostics.maxRHat.toFixed(3)} ` +
        `ESS=${Math.round(result.diagnostics.minEss)} gradEvals=${result.nuts.gradEvals}`,
    );
  }, 240_000);
});
