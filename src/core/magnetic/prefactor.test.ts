import { describe, it, expect } from "vitest";
import { MAGNETIC_PREFACTOR } from "@/core/magnetic/structureFactor";

/**
 * The magnetic scattering length must be on the same fm scale as the nuclear
 * scattering lengths it shares an intensity with. p = γ_n·r_e/2 = 2.695 fm/μ_B
 * (the constant often quoted as 0.2695 × 10⁻¹² cm, which equals 2.695 fm).
 * A value of 0.2695 here would be 10× too small (100× in intensity) because
 * nuclear b is in fm. Reference: Squires; Lovesey Vol. 2.
 */
describe("magnetic scattering-length prefactor", () => {
  it("equals γ_n·r_e/2 in fm/μ_B (not the 10⁻¹² cm mantissa)", () => {
    const gamma_n = 1.91304; // neutron magnetic moment magnitude (nuclear magnetons)
    const r_e = 2.81794; // classical electron radius (fm)
    expect(MAGNETIC_PREFACTOR).toBeCloseTo((gamma_n * r_e) / 2, 2);
    expect(MAGNETIC_PREFACTOR).toBeCloseTo(2.695, 3);
  });
});
