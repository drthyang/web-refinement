import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/mn3ga";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { generateMagneticCandidatesForK } from "@/core/magnetic/magneticGroups";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";

/**
 * Regression for the antiferromagnetic magnetic-structure-factor fix. Expanding a
 * moment over the *nuclear* space group with time-reversal θ = 1 is a
 * ferromagnetic arrangement: it gives **zero** intensity at k ≠ 0 satellites and
 * over-counts special positions. The fix expands over the magnetic subgroup
 * operations (θ-signed) carried on the model, deduplicating the orbit — so a
 * genuine AFM produces satellite intensity.
 *
 * Case: Mn₃Ga (P6₃/mmc), Mn on the 6h special position, k = (½,0,0).
 */
describe("antiferromagnetic magnetic structure factor (k ≠ 0, special position)", () => {
  const structure = exampleStructure();
  const k: Vec3 = [0.5, 0, 0];
  const subgroups = generateMagneticCandidatesForK(structure.spaceGroup.operations, k);
  // A genuine antiferromagnetic (type-III) subgroup — one with a time-reversed
  // operation — that allows a moment on the Mn site.
  const build = (() => {
    for (const sub of subgroups) {
      if (!sub.operations.some((op) => op.timeReversal === -1)) continue;
      const b = buildMagneticModel(structure, k, ["Mn1"], sub.operations, { moment: 3, tieSameSite: true });
      if (b.params.length > 0) return b;
    }
    throw new Error("no moment-allowing type-III subgroup found");
  })();
  const amps: Record<string, number> = {};
  for (const p of build.params) amps[p.id] = p.value;
  const applied = applyMagneticMoments(build.magnetic, build.bindings, amps);

  it("carries the magnetic subgroup operations on the model", () => {
    expect(applied.operations).toBeDefined();
    expect(applied.operations!.length).toBeGreaterThan(0);
    // At least one operation is time-reversed (θ = −1) for a type-III subgroup.
    expect(applied.operations!.some((op) => op.timeReversal === -1)).toBe(true);
  });

  it("gives NONZERO |F_M|² at the (½,0,0)-type satellites", () => {
    const sats: [number, number, number][] = [[0.5, 1, 0], [0.5, 0, 1], [0.5, 1, 1], [1.5, 0, 0]];
    const total = sats.reduce((s, [h, kk, l]) => s + magneticStructureFactor(structure, applied, h, kk, l).squared, 0);
    expect(total).toBeGreaterThan(0);
    // At least one individual satellite is clearly nonzero.
    expect(Math.max(...sats.map(([h, kk, l]) => magneticStructureFactor(structure, applied, h, kk, l).squared))).toBeGreaterThan(0.1);
  });

  it("WITHOUT the magnetic operations (legacy nuclear-op expansion) it collapses to ~zero", () => {
    // Same moments, but strip the operations → expands over the nuclear group with
    // θ = 1, the broken ferromagnetic path that motivated the fix.
    const legacy: MagneticModel = { ...applied };
    delete (legacy as { operations?: unknown }).operations;
    const sats: [number, number, number][] = [[0.5, 1, 0], [0.5, 0, 1], [0.5, 1, 1], [1.5, 0, 0]];
    const total = sats.reduce((s, [h, kk, l]) => s + magneticStructureFactor(structure, legacy, h, kk, l).squared, 0);
    expect(total).toBeLessThan(1e-6);
  });
});
