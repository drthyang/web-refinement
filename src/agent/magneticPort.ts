/**
 * The powder page's magnetic analysis step, as the Agent drives it: the same
 * controls the user has there (KSearchPanel) — the magnetic ions, the
 * propagation vector k (searched from the residual peaks, or set), the
 * magnetic space groups of the little group of k, their fit against the data,
 * the moments of the one chosen — published by the panel as a handle on the
 * powder port. The views here are plain data, built the same way by the panel
 * and by the headless page the tests use.
 */

import type { Vec3 } from "@/core/math/types";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { RefinementParameter } from "@/core/refinement/types";
import { latticeCandidateLabel, type LatticeCandidate } from "@/core/magnetic/subgroupLattice";
import { momentCartesian } from "@/core/magnetic/moment";

/** A residual peak the k-search may use (the panel's peak table row). */
export interface MagneticPeakView {
  /** The row number on the page (#n), d descending. */
  readonly n: number;
  readonly d: number;
  readonly sigmas?: number;
  /** A nuclear reflection it sits on, when it does (excluded from the search by default). */
  readonly near?: string;
  readonly included: boolean;
  readonly manual: boolean;
}

export interface KCandidateView {
  readonly k: Vec3;
  readonly label: string;
  /** Included peaks a satellite G ± k explains, of the total. */
  readonly matched: number;
  readonly total: number;
  /** RMS |Δd| over the matched peaks, Å. */
  readonly rmsd: number;
}

/** One magnetic space group of the little group of k (a conjugacy-class representative). */
export interface MagneticCandidateView {
  /** "G1", "G2", …: its place in the list for this k, the order the page shows. */
  readonly id: string;
  readonly symbol: string;
  readonly numbers?: string;
  /** The setting transformation when the group is named in a non-standard setting. */
  readonly setting?: string;
  /** Index in the grey little group (2 = maximal). */
  readonly index: number;
  readonly domains: number;
  /** Moment components the group allows on the chosen ions (0: no moment there). */
  readonly momentDims: number;
  /** The moments-only fit against the data, once ranked. */
  readonly fit?: { readonly status: "ok" | "failed" | "forbidden"; readonly wR: number | null; readonly moments: readonly { readonly site: string; readonly muB: number }[] };
}

export interface MomentView {
  readonly site: string;
  /** The split-orbit number when the group splits the site's orbit. */
  readonly orbit?: number;
  /** |M| in µB (Cartesian). */
  readonly muB: number;
  /** Components along the crystal axes (µB per axis-length unit, as stored). */
  readonly components: readonly number[];
}

export interface MagneticSelectionView {
  readonly id: string;
  readonly symbol: string;
  readonly parameters: readonly { readonly id: string; readonly label: string; readonly value: number; readonly tiedTo?: string }[];
  readonly moments: readonly MomentView[];
  /** The last moments-only fit of this group (fraction), null before one. */
  readonly fitAgreement: number | null;
}

export interface MagneticPanelState {
  readonly ions: readonly { readonly label: string; readonly element: string; readonly selected: boolean }[];
  readonly peaks: readonly MagneticPeakView[];
  /** The last k-search, best first; null before one (or after the peaks changed). */
  readonly kSearch: readonly KCandidateView[] | null;
  readonly k: Vec3;
  /** What kind of k it is (commensurate or not, arms, how moments are parameterised). */
  readonly kDescription: string;
  /** Why the moments cannot be fitted at this k, or null. */
  readonly kUnsupported: string | null;
  readonly candidates: readonly MagneticCandidateView[];
  readonly selected: MagneticSelectionView | null;
  readonly ties: { readonly sameSite: boolean; readonly magnitudes: false | "element" | "all" };
  /** The nuclear-only wR (fraction) a candidate's fit is compared with. */
  readonly baselineAgreement: number | null;
  /** The ranked candidate with the lowest wR (ties: the maximal group, fewest moment parameters). */
  readonly best: string | null;
  /** Moments can be fitted against the data on this page. */
  readonly canFit: boolean;
  /** The chosen model lets k refine with the moments (Continue with refineK). */
  readonly canRefineK: boolean;
}

export type MomentTies = MagneticPanelState["ties"];

export interface MagneticAgentHandle {
  readonly state: () => MagneticPanelState;
  /** Search k from the included residual peaks; shows the list on the page. */
  readonly searchK: () => readonly KCandidateView[];
  /** Set k (the group pick is dropped). */
  readonly setK: (k: Vec3) => void;
  readonly selectIons: (labels: readonly string[]) => void;
  readonly setTies: (ties: Partial<MomentTies>) => void;
  /** Fit every candidate that allows a moment (scope "open": the index sections open on the page). */
  readonly rank: (scope: "open" | "all") => Promise<void>;
  /** Choose a candidate by id; a ranked one starts from its fitted moments. */
  readonly choose: (id: string) => void;
  /** Fit the chosen group's moments, the nuclear model held; resolves to wR (fraction). */
  readonly refineMoments: () => Promise<number | null>;
  /** Show the chosen model on the refinement pattern (moments held), or clear it. */
  readonly apply: (show: boolean) => void;
  /** Hand the chosen model and its moment rows to the refinement page (and k, when it may refine). */
  readonly continueToRefinement: (refineK: boolean) => void;
}

/** The candidate list's id for the i-th representative (0-based), and back. */
export const candidateId = (i: number): string => `G${i + 1}`;
export function candidateIndex(id: string, count: number): number {
  const m = /^G(\d+)$/i.exec(id.trim());
  const i = m ? Number(m[1]) - 1 : -1;
  if (i < 0 || i >= count) throw new Error(`no magnetic group "${id}" for this k — the candidates are G1–G${count} (magnetic_state lists them)`);
  return i;
}

export function candidateView(
  rep: LatticeCandidate,
  i: number,
  momentDims: number,
  fit?: { readonly status: "ok" | "failed" | "forbidden"; readonly wR: number | null; readonly magnitudes: readonly { readonly label: string; readonly value: number }[] },
): MagneticCandidateView {
  const label = latticeCandidateLabel(rep);
  return {
    id: candidateId(i),
    symbol: label.symbol,
    ...(label.numbers ? { numbers: label.numbers } : {}),
    ...(label.setting ? { setting: label.setting } : {}),
    index: rep.index,
    domains: rep.domainCount,
    momentDims,
    ...(fit ? { fit: { status: fit.status, wR: fit.wR, moments: fit.magnitudes.map((m) => ({ site: m.label, muB: m.value })) } } : {}),
  };
}

export function momentViews(structure: StructureModel, magnetic: MagneticModel): MomentView[] {
  return magnetic.moments.map((m) => ({
    site: m.siteLabel,
    ...(m.orbitIndex !== undefined && m.orbitIndex > 1 ? { orbit: m.orbitIndex } : {}),
    muB: Math.hypot(...momentCartesian(structure.cell, m)),
    components: [...m.components],
  }));
}

export function selectionView(
  rep: LatticeCandidate,
  i: number,
  structure: StructureModel,
  params: readonly RefinementParameter[],
  values: Readonly<Record<string, number>>,
  applied: MagneticModel,
  fitAgreement: number | null,
): MagneticSelectionView {
  return {
    id: candidateId(i),
    symbol: latticeCandidateLabel(rep).symbol,
    parameters: params.map((p) => ({ id: p.id, label: p.label, value: values[p.id] ?? p.value, ...(p.expression ? { tiedTo: p.expression } : {}) })),
    moments: momentViews(structure, applied),
    fitAgreement,
  };
}
