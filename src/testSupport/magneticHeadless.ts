/**
 * The powder page's magnetic analysis step without React, for tests and the
 * eval suite: the same core calls KSearchPanel makes (residual peaks, the
 * k-search, the magnetic subgroup lattice, the moment model, the moments-only
 * fit), behind the handle the panel publishes (agent/magneticPort.ts), over a
 * headless session.
 */

import type { Vec3 } from "@/core/math/types";
import type { Session } from "@/app/powderSession";
import { candidateId, candidateIndex, candidateView, selectionView, type KCandidateView, type MagneticAgentHandle, type MomentTies } from "@/agent/magneticPort";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { searchPropagationVector, type KCandidate } from "@/core/magnetic/kSearch";
import { classifyPropagation, describePropagation } from "@/core/magnetic/propagation";
import { centringTranslations } from "@/core/crystal/symmetry";
import { magneticSubgroupLattice, latticeRepresentatives, type LatticeCandidate } from "@/core/magnetic/subgroupLattice";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { buildMagneticModel, type MagneticModelBuild } from "@/core/magnetic/momentModel";
import { propagationKParameters } from "@/core/magnetic/refinableK";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { buildMagneticPowderProblem, magneticComponentCurve } from "@/core/workflow/magneticPowder";
import { powderCurves } from "@/core/workflow/powder";
import { refine } from "@/core/refinement/engine";
import { resolveTies } from "@/core/refinement/constraints";
import { detectExtraPeaks, annotateExtraPeaks } from "@/core/magnetic/extraPeaks";
import { generateReflections } from "@/core/diffraction/reflections";
import { momentCartesian } from "@/core/magnetic/moment";
import { isMagneticModelParameterKind } from "@/core/refinement/types";
import { axisContext, convertAxisArray } from "@/visualization/axisUnits";

interface RankEntry {
  readonly status: "ok" | "failed" | "forbidden";
  readonly wR: number | null;
  readonly values: Record<string, number>;
  readonly magnitudes: readonly { readonly label: string; readonly value: number }[];
}

/** The curves of a session, the magnetic model's contribution included. */
export function sessionCurves(s: Session): ReturnType<typeof powderCurves> {
  const curves = powderCurves(s.structure, s.pattern, s.powderParams, s.powderBindings, s.powderProfile);
  if (!s.magnetic) return curves;
  const mag = magneticComponentCurve(s.structure, s.magnetic, s.pattern, s.powderParams, s.powderBindings, s.powderProfile);
  const yCalc = curves.yCalc.map((y, i) => y + (mag[i] ?? 0));
  return { ...curves, yCalc, diff: curves.yObs.map((o, i) => o - yCalc[i]!) };
}

/** The handle over a session the caller owns (`get` / `set`), as the panel's. */
export function magneticHandle(get: () => Session, set: (s: Session) => void, openStep: (step: 0 | 1) => void): MagneticAgentHandle {
  let selected: Set<string> | null = null;
  let k: Vec3 = [0, 0, 0];
  let results: KCandidate[] | null = null;
  let selIdx: number | null = null;
  let amps: Record<string, number> = {};
  let ties: MomentTies = { sameSite: true, magnitudes: false };
  let rank: Record<string, RankEntry> = {};
  let fitWR: number | null = null;

  const structure = () => get().structure;
  const ions = () => magneticIonCandidates(structure());
  const chosenIons = (): string[] => [...(selected ?? new Set(ions().map((i) => i.siteLabel)))];
  const reps = (): LatticeCandidate[] => latticeRepresentatives(magneticSubgroupLattice(structure().spaceGroup.operations, k));
  const dims = (list: readonly LatticeCandidate[]): number[] => {
    const sites = chosenIons().map((l) => structure().sites.find((x) => x.label === l)).filter((x): x is NonNullable<typeof x> => !!x);
    return list.map((r) => sites.reduce((n, site) => n + allowedMomentDirections(r.candidate.operations, site.position, k).dimension, 0));
  };
  const build = (r: LatticeCandidate): MagneticModelBuild =>
    buildMagneticModel(structure(), k, chosenIons(), [...r.candidate.operations], { moment: 2, tieSameSite: ties.sameSite, tieEqualMagnitude: ties.magnitudes, flippedUnits: [] });
  const resolved = (b: MagneticModelBuild): Record<string, number> => {
    const base: Record<string, number> = {};
    for (const p of b.params) base[p.id] = amps[p.id] ?? p.value;
    return resolveTies(b.params, base);
  };

  const peaks = () => {
    const s = get();
    const curves = sessionCurves(s);
    const d = convertAxisArray(curves.x, s.pattern.xUnit, "dSpacing", axisContext(s.pattern));
    const pointSigma = s.pattern.points.every((p) => p.sigma !== undefined) ? s.pattern.points.map((p) => p.sigma!) : undefined;
    const found = detectExtraPeaks(d, curves.yObs, curves.yCalc, { ...(pointSigma ? { pointSigma, minSignificance: 3 } : {}), limit: 24 });
    const finite = d.filter((v) => Number.isFinite(v) && v > 0);
    const refs = generateReflections(s.structure.cell, s.structure.spaceGroup, Math.min(...finite), Math.max(...finite))
      .map((r) => ({ d: r.d, hkl: `${r.h} ${r.k} ${r.l}`, phaseLabel: s.structure.name || s.structure.id }));
    return annotateExtraPeaks(found, refs)
      .sort((a, b) => b.d - a.d)
      .map((p, i) => ({ ...p, n: i + 1, included: (p.significance === undefined || p.significance >= 5) && !p.nearNuclear }));
  };

  const fit = (b: MagneticModelBuild, start?: Record<string, number>): { values: Record<string, number>; agreement: number | null } => {
    const s = get();
    const moments = b.params.map((p) => {
      const v = start?.[p.id] ?? p.value;
      return { ...p, value: v, initialValue: v, fixed: !!p.expression };
    });
    const nuclearFixed = s.powderParams.filter((p) => !isMagneticModelParameterKind(p.kind)).map((p) => ({ ...p, fixed: true }));
    const problem = buildMagneticPowderProblem(s.structure, b.magnetic, s.pattern, [...nuclearFixed, ...moments],
      [...s.powderBindings.filter((x) => !isMagneticModelParameterKind(x.kind)), ...b.bindings], { shape: s.powderProfile.shape, ...(s.powderProfile.eta !== undefined ? { eta: s.powderProfile.eta } : {}) });
    const result = refine(problem, { maxIterations: 20 });
    const values: Record<string, number> = {};
    for (const p of b.params) values[p.id] = result.parameters[p.id] ?? p.value;
    return { values, agreement: result.agreement.rWeighted ?? null };
  };

  const baseline = (): number | null => {
    const s = get();
    const c = powderCurves(s.structure, s.pattern, s.powderParams.filter((p) => !isMagneticModelParameterKind(p.kind)), s.powderBindings.filter((b) => !isMagneticModelParameterKind(b.kind)), s.powderProfile);
    let num = 0;
    let den = 0;
    c.yObs.forEach((o, i) => {
      const w = 1 / Math.max(s.pattern.points[i]?.sigma ?? Math.sqrt(Math.max(o, 1)), 1e-9) ** 2;
      num += w * (o - c.yCalc[i]!) ** 2;
      den += w * o * o;
    });
    return den > 0 ? Math.sqrt(num / den) : null;
  };

  const bestId = (list: readonly LatticeCandidate[], d: readonly number[]): string | null => {
    const ok = list.map((r, i) => ({ r, i, e: rank[r.candidate.id] })).filter((x) => x.e?.status === "ok" && x.e.wR !== null);
    if (ok.length === 0) return null;
    const bw = Math.min(...ok.map((x) => x.e!.wR!));
    const tied = ok.filter((x) => x.e!.wR! <= bw + 1e-4).sort((a, b) => a.r.index - b.r.index || (d[a.i] ?? 99) - (d[b.i] ?? 99));
    return candidateId(tied[0]!.i);
  };

  const kView = (c: KCandidate): KCandidateView => ({ k: [c.k[0], c.k[1], c.k[2]], label: c.label, matched: c.matched, total: c.total, rmsd: c.rmsd });

  return {
    state: () => {
      const list = reps();
      const d = dims(list);
      const chosen = selIdx !== null ? list[selIdx] : undefined;
      const b = chosen ? build(chosen) : null;
      const values = b ? resolved(b) : {};
      const kRows = b ? propagationKParameters(structure(), b.magnetic) : null;
      return {
        ions: ions().map((i) => ({ label: i.siteLabel, element: i.element, selected: chosenIons().includes(i.siteLabel) })),
        peaks: peaks().map((p) => ({ n: p.n, d: p.d, ...(p.significance !== undefined ? { sigmas: p.significance } : {}), ...(p.nearNuclear ? { near: `${p.nearNuclear.phaseLabel} ${p.nearNuclear.hkl}` } : {}), included: p.included, manual: false })),
        kSearch: results ? results.slice(0, 8).map(kView) : null,
        k: [k[0], k[1], k[2]],
        kDescription: describePropagation(classifyPropagation(k, { centrings: centringTranslations(structure().spaceGroup.operations) })),
        kUnsupported: null,
        candidates: list.map((r, i) => candidateView(r, i, d[i] ?? 0, rank[r.candidate.id])),
        selected: chosen && b ? selectionView(chosen, selIdx!, structure(), b.params, values, applyMagneticMoments(b.magnetic, b.bindings, values), fitWR) : null,
        ties,
        baselineAgreement: baseline(),
        best: bestId(list, d),
        canFit: true,
        canRefineK: !!kRows && kRows.params.length > 0,
      };
    },
    searchK: () => {
      const included = peaks().filter((p) => p.included);
      if (included.length === 0) throw new Error("no residual peak is included for the k-search");
      const weights = included.some((p) => p.significance !== undefined) ? included.map((p) => Math.min(p.significance ?? 1, 20)) : undefined;
      results = searchPropagationVector(structure().cell, included.map((p) => p.d), { tolerance: 0.02, maxQ: 0, ...(weights ? { weights } : {}) });
      openStep(1);
      return results.slice(0, 8).map(kView);
    },
    setK: (kk) => {
      k = [kk[0], kk[1], kk[2]];
      selIdx = null;
      rank = {};
      fitWR = null;
    },
    selectIons: (labels) => {
      const known = new Set(ions().map((i) => i.siteLabel));
      const unknown = labels.filter((l) => !known.has(l));
      if (unknown.length > 0) throw new Error(`not a magnetic ion site: ${unknown.join(", ")}`);
      selected = new Set(labels);
      rank = {};
    },
    setTies: (t) => {
      ties = { sameSite: t.sameSite ?? ties.sameSite, magnitudes: t.magnitudes !== undefined ? t.magnitudes : ties.magnitudes };
      rank = {};
    },
    rank: async (scope) => {
      const list = reps();
      const d = dims(list);
      rank = {};
      for (const [i, r] of list.entries()) {
        if ((d[i] ?? 0) === 0 || (scope === "open" && r.index !== 2)) continue;
        const b = build(r);
        if (b.params.length === 0) {
          rank[r.candidate.id] = { status: "forbidden", wR: null, values: {}, magnitudes: [] };
          continue;
        }
        const { values, agreement } = fit(b);
        const applied = applyMagneticMoments(b.magnetic, b.bindings, values);
        rank[r.candidate.id] = { status: "ok", wR: agreement, values, magnitudes: applied.moments.map((m) => ({ label: m.siteLabel, value: Math.hypot(...momentCartesian(structure().cell, m)) })) };
      }
    },
    choose: (id) => {
      const list = reps();
      const i = candidateIndex(id, list.length);
      const entry = rank[list[i]!.candidate.id];
      selIdx = i;
      amps = entry?.status === "ok" ? { ...entry.values } : {};
      fitWR = null;
    },
    refineMoments: async () => {
      const list = reps();
      if (selIdx === null) throw new Error("choose a magnetic group first");
      const b = build(list[selIdx]!);
      if (b.params.length === 0) throw new Error("the chosen group allows no moment on the chosen ions");
      const { values, agreement } = fit(b, resolved(b));
      amps = { ...amps, ...values };
      fitWR = agreement;
      return agreement;
    },
    apply: (show) => {
      const s = get();
      const rest = { ...s, powderParams: s.powderParams.filter((p) => !isMagneticModelParameterKind(p.kind)), powderBindings: s.powderBindings.filter((b) => !isMagneticModelParameterKind(b.kind)) };
      if (!show) {
        const { magnetic: _gone, ...without } = rest;
        set(without);
        return;
      }
      if (selIdx === null) throw new Error("choose a magnetic group first");
      const b = build(reps()[selIdx]!);
      set({ ...rest, magnetic: applyMagneticMoments(b.magnetic, b.bindings, resolved(b)) });
    },
    continueToRefinement: (withK) => {
      if (selIdx === null) throw new Error("choose a magnetic group first");
      const b = build(reps()[selIdx]!);
      const values = resolved(b);
      const kRows = withK ? propagationKParameters(structure(), b.magnetic) : null;
      if (withK && (!kRows || kRows.params.length === 0)) throw new Error(kRows?.notes.join(" ") || "k cannot refine with this model");
      const s = get();
      set({
        ...s,
        magnetic: applyMagneticMoments(b.magnetic, b.bindings, values),
        powderParams: [
          ...s.powderParams.filter((p) => !isMagneticModelParameterKind(p.kind)),
          ...b.params.map((p) => ({ ...p, value: values[p.id] ?? p.value, initialValue: values[p.id] ?? p.value, fixed: !!p.expression })),
          ...(kRows ? kRows.params : []),
        ],
        powderBindings: [...s.powderBindings.filter((x) => !isMagneticModelParameterKind(x.kind)), ...b.bindings, ...(kRows ? kRows.bindings : [])],
      });
      openStep(0);
    },
  };
}
