import { describe, it, expect } from "vitest";
import { computeAgreementFactors } from "@/core/refinement/factors";

/**
 * Degrees of freedom N − P must count only *contributing* observations (positive
 * weight), not the raw array length — masked/excluded points (fit range, sentinel
 * plateau) carry weight 0 and would otherwise inflate N, making R_exp too large
 * and GoF/χ² (and the ESDs scaled by reduced χ²) optimistic (Toby 2006).
 */
describe("agreement factors — excluded points and N − P", () => {
  const obs = Float64Array.from([10, 12, 11, 9, 10, 8]);
  const calc = Float64Array.from([10.5, 11.4, 11.1, 9.2, 9.8, 8.3]);

  it("drops zero-weight points from N in R_exp", () => {
    // Two points masked (weight 0). N_used = 4, P = 1 ⇒ dof = 3.
    const w = Float64Array.from([1, 1, 1, 1, 0, 0]);
    const af = computeAgreementFactors(obs, calc, w, 1);
    let sumWObs2 = 0;
    for (let i = 0; i < 4; i++) sumWObs2 += obs[i]! * obs[i]!;
    expect(af.rExpected!).toBeCloseTo(Math.sqrt(3 / sumWObs2), 10);
  });

  it("reports goodness of fit as S = R_wp/R_exp (unsquared), so χ² = S²", () => {
    const w = Float64Array.from([1, 1, 1, 1, 1, 1]);
    const af = computeAgreementFactors(obs, calc, w, 2);
    expect(af.goodnessOfFit!).toBeCloseTo(af.rWeighted! / af.rExpected!, 12);
  });

  it("all-included case is unaffected (N = array length)", () => {
    const w = Float64Array.from([1, 1, 1, 1, 1, 1]);
    const af = computeAgreementFactors(obs, calc, w, 1);
    let sumWObs2 = 0;
    for (let i = 0; i < 6; i++) sumWObs2 += obs[i]! * obs[i]!;
    expect(af.rExpected!).toBeCloseTo(Math.sqrt(5 / sumWObs2), 10);
  });
});
