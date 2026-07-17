import type { Vec3 } from "@/core/math/types";


export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}


export function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n === 0) return [0, 0, 0];
  return scale(a, 1 / n);
}

/** Wrap fractional coordinates into [0, 1). */
export function wrapFractional(a: Vec3): Vec3 {
  const w = (x: number): number => {
    const r = x - Math.floor(x);
    // Guard against -0 and floating point landing exactly on 1.
    return r === 1 ? 0 : r;
  };
  return [w(a[0]), w(a[1]), w(a[2])];
}
