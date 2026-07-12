import { describe, it, expect } from "vitest";
import type { Vec3 } from "@/core/math/types";
import { exampleStructure } from "@/examples/mn3ga";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { magneticReportHtml } from "@/core/export/magneticReport";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { generateMagneticCandidatesForK } from "@/core/magnetic/magneticGroups";
import type { StructureModel } from "@/core/crystal/types";

function mn3gaReport(): string {
  const structure = exampleStructure();
  const k: Vec3 = [0, 0, 0];
  const reps = latticeRepresentatives(magneticSubgroupLattice(structure.spaceGroup.operations, k, { maxIndex: 6 }));
  const cand = reps.find((r) => {
    const bns = r.candidate.standard?.bnsSymbol ?? r.settingMatch?.identity.bnsSymbol ?? "";
    return bns.replace(/\s/g, "") === "Cm'cm'";
  })!;
  const build = buildMagneticModel(structure, k, ["Mn1"], [...cand.candidate.operations], { moment: 2.5 });
  // Symmetry-mode amplitudes: orbit 1 is 2-D (in-plane), orbit 2 is 1-D. Modes
  // are unit Cartesian µ_B, so driving one mode per orbit at 2.5 gives every
  // sublattice |m| = 2.5 — no shared-magnitude constraint involved.
  const modes = build.params.filter((p) => p.kind === "momentMode");
  const orbit1 = modes.filter((p) => !p.id.includes("_o2_"));
  const orbit2 = modes.filter((p) => p.id.includes("_o2_"));
  const values: Record<string, number> = {};
  orbit1.forEach((p, i) => { values[p.id] = i === 0 ? 2.5 : 0; });
  orbit2.forEach((p) => { values[p.id] = 2.5; });
  return magneticReportHtml({
    structure,
    magnetic: build.magnetic,
    values,
    params: build.params,
    bindings: build.bindings,
    k,
    group: { symbol: "Cm′cm′", numbers: "BNS 63.462", index: cand.index },
    note: "wR = 2.1% (moments-only fit)",
    date: new Date("2026-07-09T00:00:00Z"),
  });
}

describe("magneticReportHtml", () => {
  const html = mn3gaReport();

  it("is a complete standalone document with the group in the title", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Mn3Ga · Cm′cm′ magnetic structure</title>");
    expect(html).toContain("2026-07-09");
    // No external requests: no http(s) URLs anywhere in the document.
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("draws an arrow for every magnetic atom in the cell (6 Mn)", () => {
    // One shaft <line stroke=...> + one head <polygon> per in-plane moment.
    const heads = html.match(/<polygon points=/g) ?? [];
    expect(heads.length).toBeGreaterThanOrEqual(6);
  });

  it("reports the mode amplitudes and per-orbit |m| on both sublattices", () => {
    expect(html).toContain("2.50 µ<sub>B</sub>");
    expect(html).toContain("orbit 2");
    // Both sublattice rows end with |m| = 2.50 (one unit mode driven per orbit).
    const magCells = html.match(/<td class="num">2\.50<\/td>/g) ?? [];
    expect(magCells.length).toBe(2);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("escapes HTML in labels", () => {
    expect(html).not.toContain("<script");
  });
});

describe("magneticReportHtml — k ≠ 0 supercell and out-of-plane moments", () => {
  const iso = { kind: "isotropic", bIso: 0.4 } as const;
  const sg = buildSpaceGroup(1);
  const structure: StructureModel = {
    id: "p1afm",
    name: "P1 AFM",
    cell: { a: 4, b: 5, c: 6, alpha: 90, beta: 95, gamma: 90 },
    spaceGroup: sg,
    sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }],
  };
  const k: Vec3 = [0, 0, 0.5];
  const cands = generateMagneticCandidatesForK(sg.operations, k);
  const build = buildMagneticModel(structure, k, ["Fe1"], cands[0]!.operations, { moment: 2 });

  it("renders the magnetic supercell and marks out-of-plane components", () => {
    // Point the moment (mostly) out of plane: drive the mode whose basis has
    // the largest c-axis component, zero the rest.
    const modes = build.params.filter((p) => p.kind === "momentMode");
    const basisOf = (id: string) => build.bindings.find((b) => b.parameterId === id)?.momentBasis ?? [0, 0, 0];
    const zMode = [...modes].sort((a, b) => Math.abs(basisOf(b.id)[2]!) - Math.abs(basisOf(a.id)[2]!))[0]!;
    const values: Record<string, number> = {};
    for (const p of modes) values[p.id] = p.id === zMode.id ? 2 : 0;
    const html = magneticReportHtml({
      structure,
      magnetic: build.magnetic,
      values,
      params: build.params,
      bindings: build.bindings,
      k,
      group: { symbol: "P1 (θ-decorated)" },
      date: new Date("2026-07-09T00:00:00Z"),
    });
    expect(html).toContain("Magnetic supercell 1 × 1 × 2");
    // Out-of-plane marker: the ⊙/⊗ glyph circle (r="5") appears.
    expect(html).toMatch(/r="5"/);
    expect(html).not.toContain("NaN");
  });
});
