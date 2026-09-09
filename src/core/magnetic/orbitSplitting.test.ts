import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { expandSpinField } from "@/core/crystal/cellExpansion";
import { applyOperation } from "@/core/crystal/symmetry";
import { generateMagneticCandidatesForK, littleGroup } from "@/core/magnetic/magneticGroups";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { momentBindingKey } from "@/core/magnetic/types";
import { applyMagneticMoments } from "@/core/workflow/magnetic";

/**
 * When the magnetic group is smaller than the nuclear group (a k ≠ 0 little
 * group), it can split a site's crystallographic orbit. Each split orbit is an
 * independent magnetic sublattice and must carry its own moment — previously
 * the split-off atoms silently had NO moment (zero magnetic contribution, no
 * arrow in the viewer).
 */

const iso = { kind: "isotropic", bIso: 0.4 } as const;
const wrap = (v: number): number => ((v % 1) + 1) % 1;

// P2₁/c (order 4) with k = (0,0,1/3): only {1, c} leave k invariant, so the
// little group has order 2 and a general-position orbit (4 atoms) splits into
// two G_k-orbits of 2 atoms each.
const sg = buildSpaceGroup(14);
const structure: StructureModel = {
  id: "t",
  name: "t",
  cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 100, gamma: 90 },
  spaceGroup: sg,
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }],
};
const k: Vec3 = [0, 0, 1 / 3];
const candidates = generateMagneticCandidatesForK(sg.operations, k);
const typeI = candidates.find((c) => c.isTypeI)!;

describe("orbit splitting under a k ≠ 0 little group", () => {
  it("sanity: G_k is index 2 in G and the orbit splits", () => {
    expect(sg.operations).toHaveLength(4);
    expect(littleGroup(sg.operations, k)).toHaveLength(2);
  });

  it("emits an independent moment entry (own position, own parameters) per split orbit", () => {
    const build = buildMagneticModel(structure, k, ["Fe1"], typeI.operations, { moment: 2 });
    // Two split orbits → two moment entries for the one site label.
    expect(build.magnetic.moments).toHaveLength(2);
    const [first, second] = build.magnetic.moments;
    expect(first!.orbitIndex).toBeUndefined(); // orbit 1: legacy shape
    expect(first!.position).toBeUndefined();
    expect(second!.orbitIndex).toBe(2);
    expect(second!.position).toBeDefined();
    expect(momentBindingKey(second!)).toBe("Fe1#2");
    // The orbit-2 anchor really is in the nuclear orbit but not the G_k-orbit
    // of the site position.
    const lg = littleGroup(sg.operations, k);
    const inLgOrbit = lg.some((op) => {
      const p = applyOperation(op, structure.sites[0]!.position).map(wrap);
      return p.every((v, i) => Math.abs(v - wrap(second!.position![i]!)) < 1e-3);
    });
    expect(inLgOrbit).toBe(false);
    // Parameters exist for both orbits, orbit-2 ids carry the orbit tag.
    expect(build.params.some((p) => p.id === "mom_Fe1_0")).toBe(true);
    expect(build.params.some((p) => p.id.startsWith("mom_Fe1_o2_"))).toBe(true);
  });

  it("applyMagneticMoments drives each split orbit independently", () => {
    const build = buildMagneticModel(structure, k, ["Fe1"], typeI.operations, { moment: 0 });
    const orbit1Params = build.params.filter((p) => !p.id.includes("_o2_"));
    const orbit2Params = build.params.filter((p) => p.id.includes("_o2_"));
    expect(orbit1Params.length).toBeGreaterThan(0);
    expect(orbit2Params.length).toBeGreaterThan(0);
    // Zero orbit 1, drive orbit 2 only.
    const values: Record<string, number> = {};
    for (const p of orbit1Params) values[p.id] = 0;
    for (const p of orbit2Params) values[p.id] = 0;
    values[orbit2Params[0]!.id] = 1.7;
    const applied = applyMagneticMoments(build.magnetic, build.bindings, values);
    const m1 = applied.moments.find((m) => momentBindingKey(m) === "Fe1")!;
    const m2 = applied.moments.find((m) => momentBindingKey(m) === "Fe1#2")!;
    expect(Math.hypot(...m1.components)).toBeLessThan(1e-9);
    expect(Math.hypot(...m2.components)).toBeGreaterThan(0.1);
  });

  it("a split-orbit moment contributes magnetic intensity (was silently zero)", () => {
    const build = buildMagneticModel(structure, k, ["Fe1"], typeI.operations, { moment: 0 });
    const orbit2Params = build.params.filter((p) => p.id.includes("_o2_"));
    const values: Record<string, number> = {};
    for (const p of build.params) values[p.id] = 0;
    values[orbit2Params[0]!.id] = 2;
    const applied = applyMagneticMoments(build.magnetic, build.bindings, values);
    // Satellite of (1 0 0) at +k: h,k,l = (1, 0, 1/3).
    const sf = magneticStructureFactor(structure, applied, 1, 0, 1 / 3);
    expect(sf.squared).toBeGreaterThan(1e-6);
  });

  it("k = 0 (no split) keeps the legacy single-orbit shape and parameter ids", () => {
    const k0: Vec3 = [0, 0, 0];
    const cands0 = generateMagneticCandidatesForK(sg.operations, k0);
    const build = buildMagneticModel(structure, k0, ["Fe1"], cands0[0]!.operations, { moment: 2 });
    expect(build.magnetic.moments).toHaveLength(1);
    expect(build.magnetic.moments[0]!.orbitIndex).toBeUndefined();
    expect(build.magnetic.moments[0]!.position).toBeUndefined();
    expect(build.params.every((p) => /^mom_Fe1_\d+$/.test(p.id))).toBe(true);
  });
});

/**
 * A magnetic model is built ONCE against the structure as it stands, then the
 * refinement moves the atoms underneath it. The split-orbit anchor must follow
 * the site: it is an orbit *identity* ("the second G_M-orbit of Fe1"), not a
 * frozen coordinate. Anchoring on the build-time coordinate made the whole
 * orbit-2 sublattice vanish the moment a refined position drifted past the
 * 1e-3 coincidence tolerance — silently, with no error and no warning, and
 * invisibly to the optimizer (the FD step h ≈ 1e-6·|p| never reaches the
 * cliff, but an LM trial step sails over it).
 */
describe("split-orbit anchors follow refined positions", () => {
  /** The same structure with Fe1 displaced by `dx` along a (fractional). */
  const shifted = (dx: number): StructureModel => ({
    ...structure,
    sites: [{ ...structure.sites[0]!, position: [0.1 + dx, 0.2, 0.3] }],
  });

  const built = buildMagneticModel(structure, k, ["Fe1"], typeI.operations, { moment: 2 });

  /** Spins the viewer/mPDF spin field puts in the magnetic box. */
  const spinCount = (s: StructureModel): number =>
    expandSpinField(s, built.magnetic).atoms.filter((a) => a.moment).length;

  it("keeps every sublattice's spins across the 1e-3 coincidence tolerance", () => {
    const n0 = spinCount(structure);
    expect(n0).toBeGreaterThan(0);
    // Just under, just over, and far past the old cliff — the spin field is a
    // function of symmetry, so the count must not move at all.
    for (const dx of [9e-4, 1.1e-3, 0.02]) {
      expect(spinCount(shifted(dx)), `dx=${dx}`).toBe(n0);
    }
  });

  it("keeps both split orbits' moments (orbit 2 did not silently drop out)", () => {
    const momentKeys = (s: StructureModel): Set<string> =>
      new Set(
        expandSpinField(s, built.magnetic)
          .atoms.map((a) => a.moment && a.site.label)
          .filter((l): l is string => Boolean(l))
          .map((l) => l.replace(/_\d+$/, "")),
      );
    expect(momentKeys(shifted(0.02))).toEqual(momentKeys(structure));
    // Both split orbits still carry a moment: half the spins would survive if
    // only orbit 1 (anchored at the site position) matched.
    expect(spinCount(shifted(0.02))).toBe(spinCount(structure));
  });

  it("leaves the powder |F_M|² with no memory of where the model was built", () => {
    // The invariant that makes refinement correct: evaluating a model built at
    // p₀ against the structure at p must equal evaluating a model built at p.
    // Anything else means the model remembers p₀ — which is precisely what a
    // frozen split-orbit anchor does.
    const dx = 0.02;
    const rebuilt = buildMagneticModel(shifted(dx), k, ["Fe1"], typeI.operations, { moment: 2 });
    expect(rebuilt.params.map((p) => p.id)).toEqual(built.params.map((p) => p.id));

    // Drive BOTH sublattices: either one alone translates rigidly under this
    // shift and |F|² cannot see a rigid translation. The two orbits move
    // oppositely (the orbit-2 anchor is inversion-related), so it is their
    // interference that carries the signal.
    const values: Record<string, number> = {};
    built.params.forEach((p, i) => { values[p.id] = 1.3 + 0.4 * i; });
    const sq = (b: typeof built): number =>
      magneticStructureFactor(shifted(dx), applyMagneticMoments(b.magnetic, b.bindings, values), 1, 0, 1 / 3).squared;

    expect(sq(rebuilt)).toBeGreaterThan(1e-6);
    expect(sq(built)).toBeCloseTo(sq(rebuilt), 12);
  });

  it("is a no-op at zero shift (goldens stay bit-identical)", () => {
    const values: Record<string, number> = {};
    for (const p of built.params) values[p.id] = 0.7;
    const applied = applyMagneticMoments(built.magnetic, built.bindings, values);
    expect(magneticStructureFactor(shifted(0), applied, 1, 0, 1 / 3).squared).toBe(
      magneticStructureFactor(structure, applied, 1, 0, 1 / 3).squared,
    );
  });
});
