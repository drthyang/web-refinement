/**
 * The symmetry review: the LAST step of a Rietveld refinement, never the first.
 *
 * A structure is refined to the best its space group allows — profile, atoms,
 * ADPs, corrections — before the group itself is questioned. Intensity that
 * differs on the group's own reflections is what refinement fixes, not
 * evidence against the group, and absence "violations" seen before the
 * structure is refined (the Le Bail cell check) are often profile or
 * intensity misfit. Only when the refined model still leaves intensity at
 * reflections the group forbids does the data ask for a lower symmetry.
 *
 * So this reads the REFINED residual (observed − calculated, each point's σ):
 *  - the residual peaks that sit on no allowed reflection of any phase but on a
 *    forbidden one of the primary phase are the observed forbidden
 *    reflections; a forbidden reflection within 2 % in d of an allowed one
 *    cannot be told apart from that one's misfit (untestable);
 *  - each observed forbidden reflection is checked against the group's
 *    translationengleiche subgroups (same lattice, lost rotations — the glides
 *    and screws whose loss lifts an absence), and the subgroups that allow
 *    them are listed, smallest index first.
 *
 * Limits, stated in the result: klassengleiche subgroups (a lost centring, a
 * larger cell) are not enumerated — a lost centring shows as observed
 * reflections no t-subgroup allows, a larger cell as unexplained peaks between
 * every reflection. The review proposes; the user decides, and a lower group
 * means a new model (its CIF), refined again from the start of the method.
 */

import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { isReflectionAbsent } from "@/core/crystal/symmetry";
import { structuralSubgroupLattice, subgroupClassRepresentatives } from "@/core/crystal/subgroupTree";
import { identifySubgroup } from "@/core/crystal/isotropyTree";
import { residualPeaks, type AssessmentInput } from "@/core/diagnostics/assessment";

/** A residual peak within this of a forbidden reflection (relative d) is that reflection. */
const ON_FORBIDDEN = 0.005;
/** A forbidden reflection this close to an allowed one (relative d) cannot be tested. */
const OVERLAP = 0.02;
/** Subgroups enumerated, by index in the parent. */
const MAX_INDEX = 6;

export interface ObservedForbidden {
  readonly hkl: string;
  readonly d: number;
  /** The residual peak's height, in the data's counts. */
  readonly height: number;
  /** The residual peak's height over its own σ. */
  readonly sigmas: number | undefined;
}

export interface SubgroupCandidate {
  /** H-M symbol (and IT number) when identified, else the point group. */
  readonly name: string;
  readonly number?: number;
  /** [G : H]. */
  readonly index: number;
  /** Symmetry-equivalent domains (conjugate subgroups). */
  readonly domains: number;
  /** The observed forbidden reflections this subgroup allows. */
  readonly allows: readonly string[];
}

export interface SymmetryReview {
  readonly observedForbidden: readonly ObservedForbidden[];
  readonly tested: number;
  readonly untestable: number;
  /** Subgroups allowing every observed forbidden reflection, then those allowing some. */
  readonly candidates: readonly SubgroupCandidate[];
  readonly reading: string;
  readonly limits: readonly string[];
}

const hklOf = (r: { h: number; k: number; l: number }): string => `${r.h} ${r.k} ${r.l}`;

/**
 * A subgroup's full operation list: its coset representatives with the
 * parent's pure translations (a centred lattice's), which a t-subgroup keeps.
 */
function withCentring(subOps: readonly SymmetryOperation[], parentOps: readonly SymmetryOperation[]): SymmetryOperation[] {
  const isIdentity = (op: SymmetryOperation): boolean => op.rotation.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-9));
  const centring = parentOps.filter(isIdentity).map((op) => op.translation);
  if (centring.length <= 1) return [...subOps];
  return subOps.flatMap((op) => centring.map((c) => ({ ...op, translation: [op.translation[0] + c[0], op.translation[1] + c[1], op.translation[2] + c[2]] as [number, number, number] })));
}

export function reviewSymmetry(
  phases: readonly StructureModel[],
  residual: NonNullable<AssessmentInput["residual"]>,
): SymmetryReview {
  const primary = phases[0];
  if (!primary) throw new Error("no phase to review");
  const ds = residual.d.filter((d) => Number.isFinite(d) && d > 0);
  const dMin = Math.min(...ds);
  const dMax = Math.max(...ds);
  const allowed = residual.reflections ?? [];
  const allowedKeys = new Set(generateReflections(primary.cell, primary.spaceGroup, dMin, dMax).map(hklOf));
  const forbidden = generateReflections(primary.cell, primary.spaceGroup, dMin, dMax, { absences: false }).filter((r) => !allowedKeys.has(hklOf(r)));
  const nearAllowed = (d: number): boolean => allowed.some((r) => Math.abs(r.d / d - 1) <= OVERLAP);
  const testable = forbidden.filter((f) => !nearAllowed(f.d));
  const { between } = residualPeaks(residual);
  const observed: ObservedForbidden[] = [];
  for (const f of testable) {
    const peak = between.find((p) => Math.abs(p.d / f.d - 1) <= ON_FORBIDDEN);
    if (peak && !observed.some((o) => o.hkl === hklOf(f))) observed.push({ hkl: hklOf(f), d: f.d, height: peak.height, sigmas: peak.significance });
  }
  const limits = [
    "Translationengleiche subgroups only (same lattice): a lost centring or a larger cell is not enumerated.",
    `Subgroups up to index ${MAX_INDEX} in the parent.`,
    "A forbidden reflection within 2% in d of an allowed one is untestable: its intensity cannot be told from that reflection's misfit.",
  ];
  if (observed.length === 0) {
    return {
      observedForbidden: [], tested: testable.length, untestable: forbidden.length - testable.length, candidates: [], limits,
      reading: `No forbidden reflection of ${primary.name || "the phase"} carries intensity in the refined fit (${testable.length} tested). Nothing in the data asks for a lower symmetry: if the fit is still poor, look at the profile, the background, a missing phase or the model's chemistry, not the space group.`,
    };
  }
  const lattice = structuralSubgroupLattice(primary, { maxIndex: MAX_INDEX });
  const parentOps = primary.spaceGroup.operations;
  const candidates: SubgroupCandidate[] = subgroupClassRepresentatives(lattice)
    .filter((n) => !n.isParent && !n.isTrivial)
    .map((n) => {
      const ops = withCentring(n.operations, parentOps);
      const allows = observed.filter((o) => {
        const [h, k, l] = o.hkl.split(" ").map(Number) as [number, number, number];
        return !isReflectionAbsent(ops, h, k, l);
      }).map((o) => o.hkl);
      return { n, ops, allows };
    })
    .filter((c) => c.allows.length > 0)
    .map(({ n, ops, allows }): SubgroupCandidate => {
      // Named on the full (centred) operation set: the lattice's coset
      // representatives alone match no table entry of a centred group.
      const id = n.identity.number !== undefined ? n.identity : identifySubgroup(ops, parentOps, { originShifts: true });
      const name = id.hermannMauguin ?? `${n.pointGroup ?? "?"} (point group; index ${n.index})`;
      return { name, ...(id.number !== undefined ? { number: id.number } : {}), index: n.index, domains: n.domainCount, allows };
    })
    .sort((a, b) => b.allows.length - a.allows.length || a.index - b.index);
  const all = candidates.filter((c) => c.allows.length === observed.length);
  const list = observed.map((o) => `${o.hkl} (d ${o.d.toFixed(4)} Å)`).join(", ");
  const reading = all.length > 0
    ? `The refined fit leaves intensity at ${observed.length} reflection${observed.length === 1 ? "" : "s"} ${primary.spaceGroup.hermannMauguin ?? "the group"} forbids: ${list}. ${all.length} subgroup${all.length === 1 ? "" : "s"} of the same lattice allow${all.length === 1 ? "s" : ""} ${observed.length === 1 ? "it" : "them all"}, smallest index first. Put this to the user: a lower symmetry is a new model, refined again from the start, and is justified only if it fits these reflections without the misfit moving elsewhere.`
    : `The refined fit leaves intensity at ${observed.length} forbidden reflection${observed.length === 1 ? "" : "s"} (${list}), but no subgroup of the same lattice up to index ${MAX_INDEX} allows ${observed.length === 1 ? "it" : "them all"}${candidates.length ? ` (some allow part: listed)` : ""}. A lost centring, a larger cell, or a second phase whose lines fall there is likelier; check find_unexplained_peaks and ask the user.`;
  return { observedForbidden: observed, tested: testable.length, untestable: forbidden.length - testable.length, candidates: candidates.slice(0, 8), reading, limits };
}
