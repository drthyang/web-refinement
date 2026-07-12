import { describe, it, expect } from "vitest";
import { refineStaged, refineStagedAsync } from "@/core/refinement/staged";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";

/**
 * Staged controller guards (roadmap F1.4): a stage may not carry forward
 * parameter additions that make the model worse. A parameter that duplicates
 * an existing one is the canonical pathology — the pair is perfectly
 * degenerate, the solver flags a singular direction / |ρ| ≈ 1 — and the
 * controller must re-fix the newcomer while KEEPING the stage's other gains.
 */
describe("staged controller guards", () => {
  const structure = exampleStructure();
  const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 0.2, v: -0.04, w: 0.02, x: 0.3, y: 0.05 };

  function fixture(): { params: RefinementParameter[]; bindings: ParameterBinding[]; build: (ps: readonly RefinementParameter[]) => ReturnType<typeof buildPowderProblem> } {
    const grid = Array.from({ length: 900 }, (_, i) => 10 + (i * 80) / 899);
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 2, {});
    const sim = powderCurves(structure, pattern, spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), spec0.bindings, spec0.profile);
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + 20 })) };
    const spec = buildPowderSpec(structure, pattern, inst, true, 2, {});
    // A DUPLICATE position-mode parameter: positionShift bindings ACCUMULATE
    // (X = X₀ + Σ value·axis), so a second binding with the same site + axis
    // is a genuinely degenerate pair — two identical Jacobian columns. The
    // solver flags one of them singular; the guard must leave the newcomer
    // fixed whichever member gets named.
    const posBinding = spec.bindings.find((b) => b.kind === "positionShift")!;
    const dup: RefinementParameter = { id: "pos_dup", label: "dup", kind: "positionShift", value: 0, initialValue: 0, fixed: false };
    const params = [
      ...spec.params.map((p) => ({
        ...p,
        value: p.kind === "scale" ? 9 : p.value,
        // Unlock the real position mode so the base stage frees it and the
        // duplicate genuinely pairs with it (spec fixes positions on load).
        fixed: p.kind === "positionShift" ? false : p.fixed,
      })),
      dup,
    ];
    const bindings: ParameterBinding[] = [...spec.bindings, { ...posBinding, parameterId: "pos_dup" }];
    return { params, bindings, build: (ps) => buildPowderProblem(structure, pattern, ps, bindings, spec.profile) };
  }

  const stages = [
    { name: "base", select: (p: RefinementParameter) => p.kind === "scale" || p.kind === "background" || (p.kind === "positionShift" && p.id !== "pos_dup") },
    { name: "duplicate", select: (p: RefinementParameter) => p.id === "pos_dup" },
  ];

  it("re-fixes a degenerate addition and keeps the stage's other gains", () => {
    const { params, build } = fixture();
    const out = refineStaged(params, build, stages, { maxIterations: 10 });
    const dupStage = out.stages.find((s) => s.name === "duplicate")!;
    // Either the whole stage was rejected or the duplicate was re-fixed —
    // both leave the duplicate fixed at its pre-stage value.
    const flagged = dupStage.rejected !== undefined || (dupStage.refixed ?? []).some((r) => r.id === "pos_dup");
    expect(flagged).toBe(true);
    const dupParam = out.parameters.find((p) => p.id === "pos_dup")!;
    expect(dupParam.fixed).toBe(true);
    expect(dupParam.value).toBe(0);
    // The first stage's fit survives as the accepted final state.
    expect(out.final).toBeDefined();
  });

  it("guards can be disabled explicitly", async () => {
    const { params, build } = fixture();
    const out = await refineStagedAsync(params, build, stages, { maxIterations: 10 }, undefined, { enabled: false });
    const dupStage = out.stages.find((s) => s.name === "duplicate")!;
    expect(dupStage.rejected).toBeUndefined();
    expect(dupStage.refixed).toBeUndefined();
  });
});
