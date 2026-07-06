import type { Complex } from "@/core/math/types";

export const ZERO: Complex = { re: 0, im: 0 };

export function add(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function scale(a: Complex, s: number): Complex {
  return { re: a.re * s, im: a.im * s };
}

/** e^{iθ} = cosθ + i·sinθ. */
export function expι(theta: number): Complex {
  return { re: Math.cos(theta), im: Math.sin(theta) };
}

export function modulusSquared(a: Complex): number {
  return a.re * a.re + a.im * a.im;
}

export function modulus(a: Complex): number {
  return Math.hypot(a.re, a.im);
}
