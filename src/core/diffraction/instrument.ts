/**
 * Instrument parameters and the abscissa ↔ d-spacing conversion needed to place
 * calculated peaks on a real diffractogram (procedure step 2).
 *
 * Time-of-flight (GSAS-II convention):
 *   TOF = Zero + difC·d + difA·d² + difB/d          (μs)
 * Constant wavelength:
 *   2θ = 2·asin(λ / 2d)                              (degrees, + zero shift)
 *
 * The inverse (d from the abscissa) uses a couple of Newton iterations for TOF
 * (the difA·d²/difB·d⁻¹ terms are small) and the closed form for 2θ.
 */

import type { KAlpha2, PowderPattern, Radiation } from "@/core/diffraction/types";

export type InstrumentParameters =
  | {
      readonly kind: "constantWavelength";
      /** Beamline name recognised from the file header, e.g. "D1B". */
      readonly name?: string;
      /** Facility label for display, e.g. "ILL · ILL, France". */
      readonly facility?: string;
      /** Radiation family from GSAS-II Type (PXC = X-ray CW, PNC = neutron CW). */
      readonly radiationKind?: "xray" | "neutron";
      readonly wavelength: number;
      /** Zero shift in degrees 2θ. */
      readonly zero?: number;
      /** Caglioti Gaussian width coefficients (GSAS-II, centidegrees²). */
      readonly u?: number;
      readonly v?: number;
      readonly w?: number;
      /** Lorentzian size/strain broadening (GSAS-II X, Y — the instrument's
       *  calibrated Lorentzian; Γ_L = X/cosθ + Y·tanθ, centidegrees). */
      readonly x?: number;
      readonly y?: number;
      /** Polarization fraction (GSAS-II `Polariz.`), for the Lp correction. */
      readonly polarization?: number;
      /** A lab tube's Kα₂ line (GSAS-II Lam2, I(L2)/I(L1)); absent ⇒ monochromatic. */
      readonly kAlpha2?: KAlpha2;
    }
  | {
      readonly kind: "tof";
      /** Beamline name recognised from the file header, e.g. "POWGEN". */
      readonly name?: string;
      /** Facility label for display, e.g. "SNS · ORNL, USA". */
      readonly facility?: string;
      readonly difC: number;
      readonly difA?: number;
      readonly difB?: number;
      /** Zero offset in μs. */
      readonly zero?: number;
      /**
       * Back-to-back-exponential shape coefficients, when the file carries them
       * (a GSAS-II `.instprm` does): α = alpha/d (rising edge, µs⁻¹),
       * β = beta0 + beta1/d⁴ + betaQ/d² (falling edge), σ² = sig0 + sig1·d² +
       * sig2·d⁴ + sigQ·d (Gaussian variance, µs²; GSAS-II getTOFsig — sig-q is
       * LINEAR in d, not 1/d²). Instrument-calibrated
       * profile seeds, so a loaded TOF pattern fits on load instead of
       * starting from ballparks.
       */
      readonly alpha?: number;
      readonly beta0?: number;
      readonly beta1?: number;
      readonly betaQ?: number;
      readonly sig0?: number;
      readonly sig1?: number;
      readonly sig2?: number;
      readonly sigQ?: number;
    };

export function tofFromD(p: Extract<InstrumentParameters, { kind: "tof" }>, d: number): number {
  const difA = p.difA ?? 0;
  const difB = p.difB ?? 0;
  const zero = p.zero ?? 0;
  return zero + p.difC * d + difA * d * d + (d !== 0 ? difB / d : 0);
}

export function dFromTof(p: Extract<InstrumentParameters, { kind: "tof" }>, tof: number): number {
  const difA = p.difA ?? 0;
  const difB = p.difB ?? 0;
  const zero = p.zero ?? 0;
  // Initial guess ignoring the small correction terms.
  let d = (tof - zero) / p.difC;
  for (let i = 0; i < 8; i++) {
    const f = zero + p.difC * d + difA * d * d + (d !== 0 ? difB / d : 0) - tof;
    const df = p.difC + 2 * difA * d - (d !== 0 ? difB / (d * d) : 0);
    if (Math.abs(df) < 1e-12) break;
    const step = f / df;
    d -= step;
    if (Math.abs(step) < 1e-10) break;
  }
  return d;
}

export function twoThetaFromD(
  p: Extract<InstrumentParameters, { kind: "constantWavelength" }>,
  d: number,
): number {
  const arg = p.wavelength / (2 * d);
  if (arg > 1) return NaN;
  return (2 * Math.asin(arg) * 180) / Math.PI + (p.zero ?? 0);
}

export function dFromTwoTheta(
  p: Extract<InstrumentParameters, { kind: "constantWavelength" }>,
  twoThetaDeg: number,
): number {
  const theta = ((twoThetaDeg - (p.zero ?? 0)) / 2) * (Math.PI / 180);
  return p.wavelength / (2 * Math.sin(theta));
}

/** Convert a d-spacing to the instrument's natural abscissa (TOF μs or 2θ deg). */
export function abscissaFromD(p: InstrumentParameters, d: number): number {
  return p.kind === "tof" ? tofFromD(p, d) : twoThetaFromD(p, d);
}


/**
 * The second line of a lab tube on a 2θ pattern: λ₂/λ₁ and the Kα₂/Kα₁
 * intensity ratio. Undefined for a monochromatic beam, another axis, or a
 * "second line" at the first one's wavelength (FullProf writes λ₂ = λ₁ for a
 * monochromator).
 */
export function secondLine(pattern: Pick<PowderPattern, "xUnit" | "radiation">): { readonly lambdaRatio: number; readonly ratio: number } | undefined {
  const r = pattern.radiation;
  if (pattern.xUnit !== "twoTheta" || r.kind !== "xray" || !r.kAlpha2) return undefined;
  const { wavelength, ratio } = r.kAlpha2;
  if (!(ratio > 0) || !(wavelength > 0) || Math.abs(wavelength - r.wavelength) <= 1e-6 * r.wavelength) return undefined;
  return { lambdaRatio: wavelength / r.wavelength, ratio };
}

/** 2θ (degrees) of the second line for a reflection whose first line is at
 *  twoTheta1 (degrees, the Bragg angle without shifts); NaN past back-scattering. */
export function secondLineTwoTheta(twoTheta1: number, lambdaRatio: number): number {
  const s = Math.sin((twoTheta1 * Math.PI) / 360) * lambdaRatio;
  return s < 1 ? (2 * Math.asin(s) * 180) / Math.PI : NaN;
}

/**
 * The radiation a constant-wavelength instrument gives: X-ray or neutron at
 * its λ, and for X-rays its polarization and a tube's Kα₂. `fallback` is the
 * kind when the file does not say.
 */
export function radiationOf(inst: Extract<InstrumentParameters, { kind: "constantWavelength" }>, fallback: "xray" | "neutron" = "neutron"): Radiation {
  if ((inst.radiationKind ?? fallback) !== "xray") return { kind: "neutron", wavelength: inst.wavelength };
  return {
    kind: "xray",
    wavelength: inst.wavelength,
    ...(inst.polarization !== undefined ? { polarization: inst.polarization } : {}),
    ...(inst.kAlpha2 ? { kAlpha2: inst.kAlpha2 } : {}),
  };
}

/** X-ray instrument constants a fit cannot determine: the polarization
 *  fraction P (Lp: (1−P)·cos²2θ + P) and the Kα₂/Kα₁ intensity ratio. */
export interface InstrumentConstants {
  readonly polarization?: number;
  readonly kAlpha2Ratio?: number;
}

/** An instrument or an X-ray radiation with these constants set (a Kα₂ ratio
 *  only where there is a Kα₂ line). */
export function withConstants<T extends { readonly polarization?: number; readonly kAlpha2?: KAlpha2 }>(x: T, update: InstrumentConstants): T {
  return {
    ...x,
    ...(update.polarization !== undefined ? { polarization: update.polarization } : {}),
    ...(update.kAlpha2Ratio !== undefined && x.kAlpha2 ? { kAlpha2: { ...x.kAlpha2, ratio: update.kAlpha2Ratio } } : {}),
  };
}
