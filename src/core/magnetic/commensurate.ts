/**
 * Commensurability of a magnetic propagation vector — the single place the app
 * decides whether a k has a finite magnetic supercell.
 *
 * A k is *commensurate* when every component is rational with a denominator no
 * larger than `maxDenominator`: then Nᵢ = denominator(kᵢ) gives the supercell
 * (N₁a, N₂b, N₃c) in which k becomes an integer reciprocal-lattice vector, and
 * the moment field repeats. An *incommensurate* k has no such cell — the moment
 * field never repeats, so every path that needs a finite box (supercell
 * expansion, the 3D viewer, supercell mCIF export, mPDF) must handle it
 * explicitly rather than approximate it into silence.
 *
 * This module exists because that decision was previously made in two places
 * with *different and inconsistent* answers for the same input:
 *  - `magneticSupercell()` (magnetic/magneticSupercell.ts) threw on an
 *    incommensurate component, and
 *  - `magneticSupercell()` (crystal/cellExpansion.ts) silently returned
 *    denominator 1, so the 3D view and mCIF export quietly rendered/wrote a
 *    single-cell approximation of a structure that has no such cell.
 *
 * Both now resolve k through `kDenominators`, which returns `null` for
 * incommensurate and forces each caller to state what it does about it.
 */

import type { Vec3 } from "@/core/math/types";

/** Default largest denominator searched (a 12× supercell along one axis). */
export const DEFAULT_MAX_DENOMINATOR = 12;
/** Default absolute tolerance on |d·k − round(d·k)|. */
export const DEFAULT_COMMENSURATE_TOL = 1e-4;

/** Supercell resolution of a commensurate k. */
export interface KCommensurability {
  /** Per-axis denominator Nᵢ: the supercell is (N₁a, N₂b, N₃c). */
  readonly denominators: readonly [number, number, number];
  /** k in the supercell: the integer reciprocal-lattice vector Kᵢ = Nᵢ·kᵢ. */
  readonly kInteger: readonly [number, number, number];
  /** Total cells in the magnetic supercell, N₁·N₂·N₃. */
  readonly cellCount: number;
}

/**
 * Smallest denominator d ∈ [1, maxDenominator] with d·x within `tol` of an
 * integer, or 0 when x is not rational within the search. Integer x (including
 * 0) gives 1.
 */
export function componentDenominator(
  x: number,
  maxDenominator = DEFAULT_MAX_DENOMINATOR,
  tol = DEFAULT_COMMENSURATE_TOL,
): number {
  for (let d = 1; d <= maxDenominator; d++) {
    if (Math.abs(d * x - Math.round(d * x)) < tol) return d;
  }
  return 0;
}

/**
 * Resolve the magnetic supercell of `k`, or `null` when any component is
 * incommensurate within `maxDenominator`. Callers must handle `null` explicitly
 * — that is the whole point of this function.
 */
export function kDenominators(
  k: Vec3,
  maxDenominator = DEFAULT_MAX_DENOMINATOR,
  tol = DEFAULT_COMMENSURATE_TOL,
): KCommensurability | null {
  const denominators: number[] = [];
  const kInteger: number[] = [];
  for (let i = 0; i < 3; i++) {
    const n = componentDenominator(k[i] ?? 0, maxDenominator, tol);
    if (n === 0) return null;
    denominators.push(n);
    kInteger.push(Math.round(n * (k[i] ?? 0)));
  }
  return {
    denominators: denominators as unknown as readonly [number, number, number],
    kInteger: kInteger as unknown as readonly [number, number, number],
    cellCount: denominators[0]! * denominators[1]! * denominators[2]!,
  };
}

/** Whether `k` has a finite magnetic supercell within `maxDenominator`. */
export function isCommensurate(
  k: Vec3,
  maxDenominator = DEFAULT_MAX_DENOMINATOR,
  tol = DEFAULT_COMMENSURATE_TOL,
): boolean {
  return kDenominators(k, maxDenominator, tol) !== null;
}

/** True when k is the zero vector (magnetic intensity on the nuclear positions). */
export function isZeroK(k: Vec3, tol = 1e-9): boolean {
  return Math.abs(k[0] ?? 0) < tol && Math.abs(k[1] ?? 0) < tol && Math.abs(k[2] ?? 0) < tol;
}

/**
 * Every k of a model is commensurate — the precondition for any supercell-based
 * path in a multi-k model. Note this is *stronger* than each arm being
 * commensurate on its own only in that the joint supercell is the componentwise
 * LCM of the arms' denominators, which `jointDenominators` returns.
 */
export function allCommensurate(
  ks: readonly Vec3[],
  maxDenominator = DEFAULT_MAX_DENOMINATOR,
  tol = DEFAULT_COMMENSURATE_TOL,
): boolean {
  return ks.every((k) => isCommensurate(k, maxDenominator, tol));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a * b) / gcd(a, b);

/**
 * Joint supercell of several arms: the componentwise LCM of their denominators
 * (the smallest cell in which *every* arm's modulation repeats). `null` when any
 * arm is incommensurate, or when the joint cell would exceed `maxCells` — a
 * multi-k model can be individually commensurate yet jointly enormous
 * (k₁ = 1/5, k₂ = 1/7 along the same axis needs 35 cells), and a caller asking
 * for a drawable box needs that refusal rather than a runaway expansion.
 */
export function jointDenominators(
  ks: readonly Vec3[],
  maxDenominator = DEFAULT_MAX_DENOMINATOR,
  tol = DEFAULT_COMMENSURATE_TOL,
  maxCells = 4096,
): KCommensurability | null {
  if (ks.length === 0) return null;
  const denominators: [number, number, number] = [1, 1, 1];
  for (const k of ks) {
    const res = kDenominators(k, maxDenominator, tol);
    if (!res) return null;
    for (let i = 0; i < 3; i++) denominators[i] = lcm(denominators[i]!, res.denominators[i]!);
  }
  const cellCount = denominators[0] * denominators[1] * denominators[2];
  if (cellCount > maxCells) return null;
  // The joint cell is generally NOT integer-valued for an individual arm's
  // kInteger beyond its own cell, so report the first arm's integer vector
  // scaled into the joint cell: Kᵢ = Nᵢ·kᵢ stays integral because Nᵢ is a
  // multiple of that arm's own denominator.
  const first = ks[0]!;
  const kInteger: [number, number, number] = [
    Math.round(denominators[0] * (first[0] ?? 0)),
    Math.round(denominators[1] * (first[1] ?? 0)),
    Math.round(denominators[2] * (first[2] ?? 0)),
  ];
  return { denominators, kInteger, cellCount };
}
