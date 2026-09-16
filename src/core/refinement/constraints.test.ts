import { describe, it, expect } from "vitest";
import type { RefinementParameter } from "@/core/refinement/types";
import { parseTie, resolveTies, tieReferences } from "@/core/refinement/constraints";

const p = (id: string, value: number, expression?: string): RefinementParameter =>
  ({ id, label: id, kind: "momentMode", value, initialValue: value, fixed: !!expression, ...(expression ? { expression } : {}) });

describe("tie expressions", () => {
  it("parses the linear forms", () => {
    expect(parseTie("= a")).toEqual({ kind: "linear", factor: 1, refId: "a", constant: 0 });
    expect(parseTie("= -2*occ_Fe1 + 1")).toEqual({ kind: "linear", factor: -2, refId: "occ_Fe1", constant: 1 });
  });

  it("parses the magnitude form with an optional sign or factor", () => {
    expect(parseTie("= hypot(a,b)")).toEqual({ kind: "norm", factor: 1, refIds: ["a", "b"] });
    expect(parseTie("= -hypot(mom_Mn1_0, mom_Mn1_1)")).toEqual({ kind: "norm", factor: -1, refIds: ["mom_Mn1_0", "mom_Mn1_1"] });
    expect(parseTie("= 0.5*hypot(x,y,z)")).toEqual({ kind: "norm", factor: 0.5, refIds: ["x", "y", "z"] });
    expect(tieReferences("= hypot(a,b)")).toEqual(["a", "b"]);
    expect(tieReferences("= 3*a+1")).toEqual(["a"]);
  });

  it("rejects anything else, loudly", () => {
    expect(() => parseTie("hypot(a)")).toThrow(/start with/);
    expect(() => parseTie("= sqrt(a)")).toThrow(/Unsupported/);
    expect(() => parseTie("= hypot()")).toThrow(/Unsupported/);
    expect(() => parseTie("= a*b")).toThrow(/Unsupported/);
  });

  it("resolves the magnitude tie as ±√(Σ ref²) and reports a missing reference", () => {
    const params = [p("a", 3), p("b", 4), p("m", 0, "= hypot(a,b)"), p("n", 0, "= -hypot(a,b)")];
    const out = resolveTies(params, { a: 3, b: 4, m: 0, n: 0 });
    expect(out.m).toBe(5);
    expect(out.n).toBe(-5);
    expect(out.a).toBe(3); // free values pass through
    expect(() => resolveTies([p("m", 0, "= hypot(a,zz)")], { a: 1, m: 0 })).toThrow(/unknown parameter "zz"/);
  });
});
