/**
 * The Agent tools of the powder page's magnetic analysis step: each one the
 * panel's own control, through its handle (magneticPort.ts). The step's
 * method is the magnetic-analysis skill: the nuclear structure refined first,
 * k from the peaks the nuclear model leaves, the magnetic groups of the
 * little group of k top-down, the moments fitted, then nuclear and magnetic
 * refined together on the refinement step.
 */

import type { Vec3 } from "@/core/math/types";
import type { PowderAgentPort } from "@/agent/port";
import type { MagneticAgentHandle, MagneticCandidateView, MagneticPanelState } from "@/agent/magneticPort";
import { sig } from "@/agent/liveCommon";

/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are validated against the spec's zod schema before a handler runs */
type Input = any;

export const MAGNETIC_SKILL = "magnetic-analysis";
const READS = new Set(["magnetic_state", "search_propagation_vector", "rank_magnetic_groups"]);
const CHANGES = new Set(["set_propagation_vector", "select_magnetic_ions", "set_moment_ties", "choose_magnetic_group", "refine_moments", "show_magnetic_model", "continue_magnetic_refinement"]);
export const isMagneticTool = (name: string): boolean => READS.has(name) || CHANGES.has(name);

function handleOf(port: PowderAgentPort): MagneticAgentHandle {
  const h = port.magnetic?.();
  if (!h) throw new Error("the magnetic analysis step is not available: load a structure with magnetic ions and a powder pattern");
  return h;
}

/** A k component as written: a number, or a fraction such as "1/2". */
export function kComponent(v: number | string): number {
  if (typeof v === "number") return v;
  const t = v.trim().replace("½", "1/2").replace("⅓", "1/3").replace("¼", "1/4");
  const frac = /^(-?\d+)\s*\/\s*(\d+)$/.exec(t);
  const x = frac ? Number(frac[1]) / Number(frac[2]) : Number(t);
  if (!Number.isFinite(x)) throw new Error(`"${v}" is not a k component (a number or a fraction such as 1/2)`);
  return x;
}

/** How simple a k is: its largest denominator, then how many components are not zero (lower is simpler). */
export function simplicity(k: readonly number[]): number {
  const den = (x: number): number => {
    for (const d of [1, 2, 3, 4, 6, 8, 12]) if (Math.abs(x * d - Math.round(x * d)) < 1e-6) return d;
    return 99;
  };
  return 10 * Math.max(...k.map(den)) + k.filter((x) => Math.abs(x) > 1e-9).length;
}

export const kText = (k: Vec3): string => `(${k.map((c) => (Math.abs(c) < 1e-12 ? "0" : sig(c, 4))).join(", ")})`;

function candidateRow(c: MagneticCandidateView): Record<string, unknown> {
  return {
    id: c.id,
    group: c.symbol,
    ...(c.numbers ? { numbers: c.numbers } : {}),
    ...(c.setting ? { setting: c.setting } : {}),
    index: c.index,
    domains: c.domains,
    momentComponents: c.momentDims,
    ...(c.fit ? { fit: c.fit.status === "ok" ? { wR: c.fit.wR !== null ? pct(c.fit.wR) : null, moments: c.fit.moments.map((m) => `${m.site} ${sig(m.muB, 3)} µB`) } : c.fit.status } : {}),
  };
}

const pct = (f: number): number => Math.round(f * 10000) / 100;

/** The step as the model reads it: compact, the candidates that can carry a moment first. */
export function magneticView(s: MagneticPanelState): Record<string, unknown> {
  const carrying = s.candidates.filter((c) => c.momentDims > 0);
  const peak = (p: MagneticPanelState["peaks"][number]): Record<string, unknown> => ({
    n: p.n,
    d: sig(p.d, 5),
    ...(p.sigmas !== undefined ? { sigmas: sig(p.sigmas, 3) } : {}),
    ...(p.near ? { near: p.near } : {}),
    ...(p.manual ? { manual: true } : {}),
  });
  // The included peaks whole; of the rest (below 5σ, or on a nuclear
  // reflection) the strongest few and a count: a TOF pattern's low-Q noise
  // can list two dozen 3σ bumps.
  const included = s.peaks.filter((p) => p.included);
  const excluded = s.peaks.filter((p) => !p.included).sort((a, b) => (b.sigmas ?? 0) - (a.sigmas ?? 0));
  return {
    ions: s.ions.map((i) => `${i.label} (${i.element})${i.selected ? " ✓" : ""}`),
    residualPeaks: {
      usedByKSearch: included.map(peak),
      ...(excluded.length > 0 ? { notUsed: `${excluded.length} (below 5σ, or on a nuclear reflection)`, strongestNotUsed: excluded.slice(0, 5).map(peak) } : {}),
    },
    ...(s.kSearch ? { kSearch: s.kSearch.map((c) => ({ k: c.label, matched: `${c.matched}/${c.total}`, rmsd: sig(c.rmsd, 3) })) } : {}),
    k: kText(s.k),
    kKind: s.kDescription,
    ...(s.kUnsupported ? { kUnsupported: s.kUnsupported } : {}),
    candidates: `${s.candidates.length} magnetic groups for this k, ${carrying.length} allowing a moment on the chosen ions`,
    groups: carrying.slice(0, 24).map(candidateRow),
    ...(s.best ? { best: s.best } : {}),
    ...(s.selected
      ? {
        chosen: {
          id: s.selected.id,
          group: s.selected.symbol,
          parameters: s.selected.parameters.map((p) => `${p.id} = ${sig(p.value, 4)}${p.tiedTo ? ` (= ${p.tiedTo})` : ""}`),
          moments: s.selected.moments.map((m) => `${m.site}${m.orbit ? `#${m.orbit}` : ""}: ${sig(m.muB, 3)} µB`),
          ...(s.selected.fitAgreement !== null ? { momentsFitWR: pct(s.selected.fitAgreement) } : {}),
        },
      }
      : {}),
    ties: { sameSite: s.ties.sameSite, magnitudes: s.ties.magnitudes || "off" },
    ...(s.baselineAgreement !== null ? { nuclearOnlyWR: pct(s.baselineAgreement) } : {}),
    canFitMoments: s.canFit,
    canRefineK: s.canRefineK,
  };
}

export async function readMagneticTool(name: string, input: Input, port: PowderAgentPort): Promise<unknown> {
  const h = handleOf(port);
  switch (name) {
    case "magnetic_state":
      return magneticView(h.state());
    case "search_propagation_vector": {
      const found = h.searchK();
      port.openStep?.(1);
      const all = found.filter((c) => c.matched === c.total);
      const simplest = [...all].sort((a, b) => simplicity(a.k) - simplicity(b.k))[0];
      return {
        candidates: found.map((c) => ({ k: c.label, components: c.k, matched: `${c.matched}/${c.total}`, rmsd: sig(c.rmsd, 3) })),
        ...(simplest ? { simplest: simplest.label } : {}),
        reading: found.length === 0
          ? "No commensurate k (denominators 2, 3, 4, 6) puts satellites on the included peaks."
          : all.length === 0
            ? `No k explains every included peak; the best, ${found[0]!.label}, explains ${found[0]!.matched} of ${found[0]!.total}. Check the peaks it misses: an impurity's lines fit no k.`
            : all.length === 1
              ? `k = ${all[0]!.label} explains every included peak (${all[0]!.total}). Set it with set_propagation_vector.`
              : `${all.length} k explain every included peak (${all.length > 4 ? `${all.slice(0, 4).map((c) => c.label).join(", ")}, …` : all.map((c) => c.label).join(", ")}): with ${all[0]!.total} peaks the search alone cannot decide. The simplest is k = ${simplest!.label} (fewest and smallest fractions), the usual first choice; if no magnetic group fits there, try the next, and say the k is not unique.`,
      };
    }
    case "rank_magnetic_groups": {
      const scope = (input.scope as "open" | "all" | undefined) ?? "open";
      port.openStep?.(1);
      await h.rank(scope);
      return { ranked: scope, ...rankView(h.state()) };
    }
    default:
      throw new Error(`${name} is not a magnetic read tool`);
  }
}

function rankView(s: MagneticPanelState): Record<string, unknown> {
  const fitted = s.candidates.filter((c) => c.fit).sort((a, b) => (a.fit!.wR ?? Infinity) - (b.fit!.wR ?? Infinity));
  return {
    groups: fitted.map(candidateRow),
    ...(s.best ? { best: s.best } : {}),
    ...(s.baselineAgreement !== null ? { nuclearOnlyWR: pct(s.baselineAgreement) } : {}),
    reading: s.best
      ? `${s.best} fits best (ties go to the maximal group with the fewest moment parameters). A powder often cannot tell several groups apart: say which fit within the noise of the best, and choose the maximal one unless the data say otherwise.`
      : "No candidate could be fitted.",
  };
}

/** Why a change would do nothing, or null. */
export function magneticNoOp(name: string, input: Input, port: PowderAgentPort): string | null {
  const s = handleOf(port).state();
  if (name === "set_propagation_vector") {
    const k = (input.k as (number | string)[]).map(kComponent);
    return k.every((c, i) => Math.abs(c - s.k[i]!) < 1e-9) ? `k is already ${kText(s.k)}` : null;
  }
  if (name === "select_magnetic_ions") {
    const want = new Set(input.sites as string[]);
    const have = new Set(s.ions.filter((i) => i.selected).map((i) => i.label));
    return want.size === have.size && [...want].every((l) => have.has(l)) ? "those ions are already the chosen ones" : null;
  }
  if (name === "choose_magnetic_group") return s.selected?.id === String(input.id).trim().toUpperCase() ? `${s.selected.id} is already chosen` : null;
  if (name === "set_moment_ties") {
    if (input.sameSite === undefined && input.magnitudes === undefined) throw new Error("pass `sameSite`, `magnitudes`, or both");
    const same = input.sameSite === undefined || input.sameSite === s.ties.sameSite;
    const mags = input.magnitudes === undefined || (input.magnitudes === "off" ? s.ties.magnitudes === false : input.magnitudes === s.ties.magnitudes);
    return same && mags ? "the moment ties are already set so" : null;
  }
  return null;
}

/** One line for the approval card. */
export function describeMagneticChange(name: string, input: Input, port: PowderAgentPort): string {
  const s = handleOf(port).state();
  switch (name) {
    case "set_propagation_vector":
      return `Propagation vector ${kText(s.k)} → ${kText((input.k as (number | string)[]).map(kComponent) as unknown as Vec3)}`;
    case "select_magnetic_ions":
      return `Magnetic ions: ${(input.sites as string[]).join(", ")}`;
    case "set_moment_ties":
      return [
        ...(input.sameSite !== undefined ? [`same-site moments ${input.sameSite ? "tied" : "independent"}`] : []),
        ...(input.magnitudes !== undefined ? [`|M| tie ${input.magnitudes}`] : []),
      ].join(" · ");
    case "choose_magnetic_group": {
      const c = s.candidates.find((x) => x.id === String(input.id).trim().toUpperCase());
      return `Magnetic group ${String(input.id)}${c ? ` (${c.symbol}, index ${c.index})` : ""}`;
    }
    case "refine_moments":
      return s.selected ? `Fit the moments of ${s.selected.symbol} (${s.selected.parameters.length} amplitude${s.selected.parameters.length === 1 ? "" : "s"}), nuclear model held` : "Fit the moments";
    case "show_magnetic_model":
      return input.show === false ? "Remove the magnetic model from the refinement pattern" : `Show ${s.selected?.symbol ?? "the chosen model"} on the refinement pattern, moments held`;
    case "continue_magnetic_refinement":
      return `Add ${s.selected?.symbol ?? "the chosen model"}'s moment rows${input.refineK ? " and k" : ""} to the refinement page`;
    default:
      return name;
  }
}

export async function changeMagnetic(name: string, input: Input, port: PowderAgentPort): Promise<string | undefined> {
  const h = handleOf(port);
  if (name !== "continue_magnetic_refinement") port.openStep?.(1);
  switch (name) {
    case "set_propagation_vector": {
      const k = (input.k as (number | string)[]).map(kComponent);
      h.setK([k[0]!, k[1]!, k[2]!]);
      return undefined;
    }
    case "select_magnetic_ions":
      h.selectIons(input.sites as string[]);
      return undefined;
    case "set_moment_ties":
      h.setTies({
        ...(input.sameSite !== undefined ? { sameSite: !!input.sameSite } : {}),
        ...(input.magnitudes !== undefined ? { magnitudes: input.magnitudes === "off" ? false : (input.magnitudes as "element" | "all") } : {}),
      });
      return undefined;
    case "choose_magnetic_group":
      h.choose(String(input.id));
      return undefined;
    case "refine_moments": {
      const wR = await h.refineMoments();
      return wR === null ? "The moments fit did not run." : `Moments fitted: wR ${pct(wR)}%.`;
    }
    case "show_magnetic_model":
      h.apply(input.show !== false);
      return undefined;
    case "continue_magnetic_refinement":
      h.continueToRefinement(!!input.refineK);
      return "The model's moment rows are on the refinement page, free; refine there fits nuclear and magnetic together.";
    default:
      throw new Error(`${name} is not a magnetic change tool`);
  }
}

/** What the step shows after a change, for the outcome. */
export function magneticOutcome(name: string, port: PowderAgentPort): Record<string, unknown> {
  const h = port.magnetic?.();
  if (!h || name === "continue_magnetic_refinement") return {};
  const v = magneticView(h.state());
  if (name === "refine_moments" || name === "choose_magnetic_group") return { chosen: v.chosen ?? null, ...(v.nuclearOnlyWR !== undefined ? { nuclearOnlyWR: v.nuclearOnlyWR } : {}) };
  if (name === "set_propagation_vector" || name === "select_magnetic_ions" || name === "set_moment_ties") return { k: v.k, kKind: v.kKind, candidates: v.candidates, groups: v.groups };
  return {};
}
