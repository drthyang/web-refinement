import { describe, it, expect } from "vitest";
import { refineStaged, refineStagedAsync } from "@/core/refinement/staged";
import { refine } from "@/core/refinement/engine";
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

  // ── Re-fixing is honest: the kept run is a fit of the returned values ──

  const xs = Array.from({ length: 41 }, (_, i) => i * 0.1);
  /** Deterministic "noise", so wR sits well above the exact-fit floor. */
  const wiggle = (x: number): number => 0.02 * Math.sin(7 * x);
  const toy = (yObs: (x: number) => number, model: (v: Readonly<Record<string, number>>, x: number) => number) =>
    (ps: readonly RefinementParameter[]) => ({
      parameters: ps,
      observations: Float64Array.from(xs.map(yObs)),
      weights: Float64Array.from(xs.map(() => 1)),
      calculate: (v: Readonly<Record<string, number>>) => Float64Array.from(xs.map((x) => model(v, x))),
    });
  const param = (id: string, value: number): RefinementParameter => ({ id, label: id, kind: "background", value, initialValue: value, fixed: false });
  /** wR of the returned parameters, evaluated afresh (no step taken). */
  const wrOf = (build: ReturnType<typeof toy>, ps: readonly RefinementParameter[]): number | undefined =>
    refine(build(ps), { maxIterations: 0 }).agreement.rWeighted;

  it("a re-fixed stage reports the wR of the parameters it returns", async () => {
    // y = a + b·x + c·x², with d a duplicate of b. The second stage frees the
    // curvature c — which moves the best slope — together with d. The guard
    // must re-fix d AND keep a fit made without it: carrying c and b from the
    // run where d took half the slope shift describes a state never fitted.
    const build = toy((x) => 1 + 0.5 * x + 0.3 * x * x + wiggle(x), (v, x) => v.a! + (v.b! + v.d!) * x + v.c! * x * x);
    const params = [param("a", 0), param("b", 0), param("c", 0), param("d", 0)];
    const twoStages = [
      { name: "line", select: (p: RefinementParameter) => p.id === "a" || p.id === "b" },
      { name: "curve", select: (p: RefinementParameter) => p.id === "c" || p.id === "d" },
    ];
    for (const out of [
      refineStaged(params, build, twoStages, { maxIterations: 30 }),
      await refineStagedAsync(params, build, twoStages, { maxIterations: 30 }),
    ]) {
      const curve = out.stages.find((s) => s.name === "curve")!;
      expect(curve.refixed?.map((r) => r.id)).toEqual(["d"]);
      expect(curve.freeIds).toEqual(["a", "b", "c"]);
      const d = out.parameters.find((p) => p.id === "d")!;
      expect(d.fixed).toBe(true);
      expect(d.value).toBe(0);
      expect(out.final).toBe(curve.result);
      expect(out.final!.agreement.rWeighted!).toBeGreaterThan(1e-3);
      expect(wrOf(build, out.parameters)).toBeCloseTo(out.final!.agreement.rWeighted!, 12);
      expect(out.parameters.find((p) => p.id === "b")!.value).toBeCloseTo(0.5, 1);
    }
  });

  it("a degenerate set of newcomers keeps one member free", () => {
    // y = a + (b1 + b2 + b3)·x: three identical columns, two null directions.
    // Re-fixing two removes both; re-fixing all three (each is "singular")
    // would throw the slope away. The earliest-declared member stays free.
    const build = toy((x) => 1 + 0.6 * x + wiggle(x), (v, x) => v.a! + (v.b1! + v.b2! + v.b3!) * x);
    const params = [param("a", 0), param("b1", 0), param("b2", 0), param("b3", 0)];
    const out = refineStaged(params, build, [
      { name: "offset", select: (p) => p.id === "a" },
      { name: "slopes", select: (p) => p.id.startsWith("b") },
    ], { maxIterations: 30 });
    const slopes = out.stages.find((s) => s.name === "slopes")!;
    expect(slopes.refixed).toEqual([
      { id: "b2", reason: "degenerate with b1, b3" },
      { id: "b3", reason: "degenerate with b1, b2" },
    ]);
    const byId = new Map(out.parameters.map((p) => [p.id, p]));
    expect(byId.get("b1")!.fixed).toBe(false);
    expect(byId.get("b1")!.value).toBeCloseTo(0.6, 1);
    expect(byId.get("b2")!.value).toBe(0);
    expect(byId.get("b3")!.value).toBe(0);
    expect(slopes.result.diagnostics?.singularParameterIds ?? []).toEqual([]);
    expect(wrOf(build, out.parameters)).toBeCloseTo(out.final!.agreement.rWeighted!, 12);
  });

  it("keeps a degenerate set free when re-fixing it costs fit", () => {
    // y = a + e^(−k1·x) + e^(−k2·x) from equal starts: the two columns are
    // identical only while k1 = k2 — symmetry-equivalent sites refined as
    // independent parameters. The data need BOTH to move (truth k1 = k2 =
    // 0.5), so holding k2 at its start costs fit: k2 must stay free, in the
    // run that had it free.
    const build = toy((x) => 0.2 + 2 * Math.exp(-0.5 * x) + wiggle(x), (v, x) => v.a! + Math.exp(-v.k1! * x) + Math.exp(-v.k2! * x));
    const params = [param("a", 0), param("k1", 1), param("k2", 1)];
    const out = refineStaged(params, build, [
      { name: "offset", select: (p) => p.id === "a" },
      { name: "decays", select: (p) => p.id.startsWith("k") },
    ], { maxIterations: 50 });
    const decays = out.stages.find((s) => s.name === "decays")!;
    expect(decays.result.diagnostics?.singularParameterIds).toEqual(expect.arrayContaining(["k1", "k2"]));
    expect(decays.refixed).toBeUndefined();
    expect(decays.keptDegenerate?.map((r) => r.id)).toEqual(["k2"]);
    expect(decays.keptDegenerate?.[0]!.reason).toContain("re-fixing raised wR");
    const [k1, k2] = ["k1", "k2"].map((id) => out.parameters.find((p) => p.id === id)!);
    expect(k1!.fixed).toBe(false);
    expect(k2!.fixed).toBe(false);
    expect(k1!.value).toBeCloseTo(0.5, 1);
    expect(k2!.value).toBeCloseTo(k1!.value, 6);
    expect(wrOf(build, out.parameters)).toBeCloseTo(out.final!.agreement.rWeighted!, 12);
  });
});
