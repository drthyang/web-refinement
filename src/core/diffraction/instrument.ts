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

export type InstrumentParameters =
  | {
      readonly kind: "constantWavelength";
      readonly wavelength: number;
      /** Zero shift in degrees 2θ. */
      readonly zero?: number;
    }
  | {
      readonly kind: "tof";
      readonly difC: number;
      readonly difA?: number;
      readonly difB?: number;
      /** Zero offset in μs. */
      readonly zero?: number;
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

/** Convert the instrument's abscissa back to a d-spacing. */
export function dFromAbscissa(p: InstrumentParameters, x: number): number {
  return p.kind === "tof" ? dFromTof(p, x) : dFromTwoTheta(p, x);
}
