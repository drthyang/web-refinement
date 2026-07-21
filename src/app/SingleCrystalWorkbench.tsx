/**
 * Single-crystal F² refinement page (Roadmap M7 UI). Shares the powder
 * workbench's design language — SummaryCards row, a themed quality rail, and the
 * collapsible ParameterPanel — but drives the single-crystal core against
 * integrated Bragg intensities (`buildSingleCrystalSpec`,
 * `buildSingleCrystalRefinementProblem`, `singleCrystalRefinementComparison`).
 *
 * Self-contained: it owns its parameter/result state and its own CIF export, so
 * the powder path in App is untouched. The root mounts it (keyed on the dataset)
 * whenever single-crystal data is loaded.
 */

import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EngineExportsRef } from "@/app/workbenchEngine";
import type { StructureModel } from "@/core/crystal/types";
import type { Radiation, SingleCrystalDataset } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ComputeClient } from "@/workers/computeClient";
import { mergeEquivalents } from "@/core/diffraction/merge";
import {
  buildSingleCrystalSpec,
  guidedSingleCrystalParams,
  singleCrystalRefinementComparison,
} from "@/core/workflow/singleCrystalRefinement";
import { normalProbabilityPlot } from "@/core/refinement/diagnostics";
import { dSpacing } from "@/core/crystal/unitCell";
import { isMomentParameterKind } from "@/core/refinement/types";
import type { ParameterBinding } from "@/core/refinement/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { applyMagneticMoments, magneticComparison } from "@/core/workflow/magnetic";
import { applyParameters } from "@/core/workflow/apply";
import { KSearchPanel, type MagneticFit } from "@/components/KSearchPanel";
import { FobsFcalc, NormalProb } from "@/app/ui/QualityPlots";
import { ParameterPanel } from "@/app/ui/ParameterPanel";
import { SummaryCards, type SummaryCardData } from "@/app/ui/SummaryCards";
import { structureToCif, type CifRefinementMeta } from "@/core/export/cif";
import { writeFullProfInt } from "@/parsers/fullprofInt";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { expandStructureToSupercell, buildModulatedMomentModel, mergeToMagneticSupercell, type ModulatedIon } from "@/core/magnetic/magneticSupercell";
import type { MomentDegeneracy } from "@/core/magnetic/canonicalize";
import { downloadText } from "@/app/download";
import { card as themeCard, color, mono, fz, uppercaseLabel, secondaryButton } from "@/app/theme";

// Lazy so three.js stays out of the main bundle until the 3D view is opened.
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));

const DATA_ACCEPT = ".xye,.xy,.dat,.txt,.gr,.hkl,.fcf,.int,.csv,.gsa,.gss,.fxye,text/plain";
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const noop = (): void => {};

/** Parse one k component: a fraction ("1/4", "-1/3") or a decimal. */
function parseKComponent(s: string): number {
  const frac = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) { const den = Number(frac[2]); return den === 0 ? 0 : Number(frac[1]) / den; }
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

/** R1 quality bands (fraction): <8 % good · <15 % mediocre · else poor. */
function r1Ink(r1: number): string {
  if (!Number.isFinite(r1)) return color.ink;
  if (r1 < 0.08) return color.okInk;
  if (r1 < 0.15) return color.noteInk;
  return color.warnInk;
}

/** F-plot ↔ list selection: which reflection is spotlighted (shared with the
 *  QualityPlots' FobsFcalc so a click there highlights the matching list row). */
type Selection = { hkl: string; kind: ReflectionObsCalc["kind"]; phaseId?: string };

/** Probe the reflections were measured with. A bare .hkl / reflection list can't
 *  carry this, so the user picks it (seeded from the loaded instrument). */
type Probe = "xray" | "neutron" | "neutron-tof";

export function SingleCrystalWorkbench({ structure, dataset, magneticDataset, client, step, onStep, instrumentProbe, exportsRef, onLoadData, onLoadMagneticData, onLoadCif }: {
  structure: StructureModel;
  dataset: SingleCrystalDataset;
  /** Companion magnetic reflection file for joint co-refinement (Phase 2). When
   *  present alongside an applied magnetic model, the joint panel co-refines the
   *  nuclear + magnetic datasets with χ²_total = w_N·χ²_N + w_M·χ²_M. */
  magneticDataset?: SingleCrystalDataset | null;
  /** Shared compute worker — refinement runs off the main thread, as in powder. */
  client: ComputeClient;
  /** Active workflow step (0 = F² refinement, 1 = magnetic symmetry analysis). */
  step: number;
  /** Switch the app-level step (e.g. "continue to refinement" after applying a model). */
  onStep?: (i: number) => void;
  /** Radiation of the loaded instrument, if any — seeds the probe default so a
   *  loaded X-ray instrument selects X-ray scattering without the user asking. */
  instrumentProbe?: "xray" | "neutron";
  /** Shell-owned ref this engine publishes its header exports into
   *  (WorkbenchEngine contract) — so "Export CIF" acts on this mode's
   *  structure/params (this workbench owns them), not the powder exporter. */
  exportsRef?: EngineExportsRef;
  /** Load a different dataset — powder here switches the app back to powder mode. */
  onLoadData?: (file: File) => void;
  /** Load a companion magnetic reflection file to pair with this nuclear dataset. */
  onLoadMagneticData?: (file: File) => void;
  /** Load a different structure (CIF). */
  onLoadCif?: (file: File) => void;
}): JSX.Element {
  // Probe selection. The reflection file is hardcoded to neutron on load (it can't
  // report its own source), so the user can switch here — and the choice changes
  // the physics (neutron b vs X-ray form factors f(Q) + polarization), rebuilding
  // F_calc and the agreement factors live. Seeded from the instrument when known.
  const baseWavelength = ("wavelength" in dataset.radiation ? dataset.radiation.wavelength : undefined) ?? 1.54;
  const [probe, setProbe] = useState<Probe>(() => instrumentProbe ?? dataset.radiation.kind);
  const effectiveRadiation: Radiation = useMemo(() => {
    if (probe === "neutron-tof") return { kind: "neutron-tof" };
    if (probe === "xray") return { kind: "xray", wavelength: baseWavelength, polarization: 0.5 };
    return { kind: "neutron", wavelength: baseWavelength };
  }, [probe, baseWavelength]);
  // The dataset the physics runs against — same reflections, user-chosen radiation.
  const probedDataset = useMemo(() => ({ ...dataset, radiation: effectiveRadiation }), [dataset, effectiveRadiation]);

  const spec = useMemo(() => buildSingleCrystalSpec(structure, probedDataset, { extinction: 0 }), [structure, probedDataset]);
  const bindings = spec.bindings;
  const [params, setParams] = useState(spec.params);
  // The 3D model tracks the refinement: apply the current parameters (cell,
  // positions, ADPs) to the structure so the viewer shows the refined cell, not
  // the loaded starting structure.
  const refinedStructure = useMemo(() => {
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    return applyParameters(structure, bindings, values).model;
  }, [structure, params, bindings]);
  const [result, setResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [plotKind, setPlotKind] = useState<"fobs" | "npp">("fobs");
  // Reflection spotlighted by a click in the F_obs/F_calc plot (or null).
  const [selected, setSelected] = useState<Selection | null>(null);

  // Magnetic model applied from the (shared) symmetry analysis, with its moment
  // bindings. When present, refinement fits nuclear + moments against F² together
  // and the F_obs/F_calc plot shows the total (nuclear + magnetic) intensity.
  const [magnetic, setMagnetic] = useState<MagneticModel | null>(null);
  const [momentBindings, setMomentBindings] = useState<readonly ParameterBinding[]>([]);

  // Outlier filter: reject reflections whose standardized residual |Fo²−Fc²|/σ
  // exceeds `cutoffSigma` (SHELX-style OMIT). Off by default. The threshold is
  // applied against the *current* model, so it stays live as the fit changes.
  const [filterOn, setFilterOn] = useState(false);
  const [cutoffSigma, setCutoffSigma] = useState(6);

  // Comparison over the *full* dataset — the residuals that drive the filter.
  const fullComparison = useMemo(
    () => singleCrystalRefinementComparison(structure, probedDataset, params, bindings),
    [structure, probedDataset, params, bindings],
  );
  const activeDataset = useMemo(() => {
    if (!filterOn || cutoffSigma <= 0) return probedDataset;
    const keep = probedDataset.reflections.filter((_, i) => Math.abs(fullComparison.rows[i]?.deltaOverSigma ?? 0) <= cutoffSigma);
    return { ...probedDataset, reflections: keep };
  }, [probedDataset, filterOn, cutoffSigma, fullComparison]);
  const excluded = probedDataset.reflections.length - activeDataset.reflections.length;

  // Laue-equivalent merge report (data quality — R_int, redundancy) on the active set.
  const merge = useMemo(
    () => mergeEquivalents(
      activeDataset.reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, intensity: r.iObs, sigma: r.sigma ?? 0 })),
      structure.spaceGroup.operations,
    ),
    [activeDataset, structure],
  );

  // Live obs/calc comparison + SHELX agreement for the current parameters.
  const comparison = useMemo(
    () => (filterOn && excluded > 0 ? singleCrystalRefinementComparison(structure, activeDataset, params, bindings) : fullComparison),
    [structure, activeDataset, params, bindings, filterOn, excluded, fullComparison],
  );

  // Reuse the powder quality plots: F_obs/F_calc (√Fo² vs √Fc²) + the normal-
  // probability plot over the standardized residuals (Fo²−Fc²)/σ. With a magnetic
  // model applied, the calc is the total (nuclear + magnetic) intensity.
  const obsCalc: ReflectionObsCalc[] = useMemo(() => {
    if (magnetic) {
      return magneticComparison(structure, magnetic, activeDataset, params, [...bindings, ...momentBindings]).map((r) => ({
        kind: r.iMagnetic > r.iNuclear ? ("magnetic" as const) : ("nuclear" as const),
        h: r.h, k: r.k, l: r.l,
        d: dSpacing(structure.cell, r.h, r.k, r.l),
        iObs: r.iObs, iCalc: r.iTotal,
      }));
    }
    return comparison.rows.map((r) => ({
      kind: "nuclear" as const,
      h: r.h, k: r.k, l: r.l,
      d: dSpacing(structure.cell, r.h, r.k, r.l),
      iObs: r.foSq, iCalc: r.fcSq,
    }));
  }, [magnetic, structure, activeDataset, params, bindings, momentBindings, comparison]);
  const npp = useMemo(() => normalProbabilityPlot(comparison.rows.map((r) => r.deltaOverSigma)), [comparison]);
  const outliers = useMemo(
    () => [...comparison.rows].sort((a, b) => Math.abs(b.deltaOverSigma) - Math.abs(a.deltaOverSigma)).slice(0, 6),
    [comparison],
  );

  const nFree = params.filter((p) => !p.fixed && !p.expression).length;

  async function runRefine(guided: boolean): Promise<void> {
    setBusy(true);
    try {
      const start = guided ? guidedSingleCrystalParams(params) : params;
      // Solve off the main thread (shared worker) so the UI stays responsive,
      // matching the powder path; the σ-filtered `activeDataset` is refined.
      // With a magnetic model applied, fit nuclear + moments together (F² total).
      const res = magnetic
        ? await client.refineMagneticParallel({
            structure, magnetic, dataset: activeDataset, parameters: start, bindings: [...bindings, ...momentBindings], options: { maxIterations: 25 },
          })
        : await client.refineSingleCrystalParallel({
            structure, dataset: activeDataset, parameters: start, bindings, options: { maxIterations: 25 },
          });
      setParams(start.map((p) => ({ ...p, value: res.parameters[p.id] ?? p.value, ...(guided ? { fixed: false } : {}) })));
      setResult(res);
      if (magnetic) setMagnetic(applyMagneticMoments(magnetic, momentBindings, res.parameters));
    } catch (e) {
      console.error(`[status] Single-crystal refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Moment-fit backend handed to the (shared) symmetry panel: it fits the freed
  // moment amplitudes against this dataset's F² with the nuclear model held fixed,
  // through the same worker. This is single-crystal magnetic refinement.
  const magneticFit: MagneticFit = {
    agreementLabel: "wR2",
    refine: async (mag, momentParams, mBindings) => {
      // Local-minimum-resistant: seeded moment multi-start with the nuclear
      // scaffold frozen, then a final LM + ±m canonicalization (the merged
      // magnetic-supercell dataset and any single magnetic set benefit from it).
      const nuclearFixed = params.map((p) => ({ ...p, fixed: true }));
      // ONE scale: nuclear and magnetic Bragg peaks are the same measurement, so
      // the magnetic scale is tied to the nuclear scale (k_M = k_N). Without this
      // the magnetic block would use the default k_M = 1 while nuclear uses the
      // refined k, and the moments would come out wrong by √k. Tying it also pins
      // the moment magnitude uniquely (no k_M·|m|² degeneracy).
      const nuclearScale = params.find((p) => p.kind === "scale")?.value ?? 1;
      const scaleTie: RefinementParameter = { id: "magScale", label: "magnetic scale (= nuclear)", kind: "magneticScale", value: nuclearScale, initialValue: nuclearScale, fixed: true, expression: "= scale" };
      const scaleTieBinding: ParameterBinding = { parameterId: "magScale", kind: "magneticScale", targetId: activeDataset.id };
      const ms = await client.refineMagneticSingleCrystalMultiStart(
        { structure, magnetic: mag, dataset: activeDataset, parameters: [...nuclearFixed, scaleTie, ...momentParams], bindings: [...bindings, scaleTieBinding, ...mBindings] },
        { restarts: 8 }, { maxIterations: 20 },
      );
      const values: Record<string, number> = {};
      for (const p of momentParams) values[p.id] = ms.final.parameters[p.id] ?? p.value;
      return { values, agreement: ms.final.agreement.rWeighted ?? null };
    },
  };

  // ── Magnetic single-k supercell refinement (modulated moments) ───────────────
  // Self-contained: works from the BASE structure + the nuclear (`dataset`) and
  // magnetic (`magneticDataset`) reflection files, and on refine internally
  // expands the structure, merges the reflections, builds the k-tied modulated
  // moment model, and runs the single-dataset magnetic multi-start — WITHOUT
  // mutating App state (the shared structure/3D view stay in the base cell).
  const [kText, setKText] = useState<[string, string, string]>(["1/4", "0", "1/4"]);
  const magIons = useMemo(() => magneticIonCandidates(structure), [structure]);
  // Per-candidate hypothesis: whether it carries a moment, its direction (crystal
  // axes), and the modulation phase (0 = node pattern, π/4 = equal-moment).
  const [ionState, setIonState] = useState<Record<string, { on: boolean; dir: [string, string, string]; phase: string }>>({});
  const ionOf = (label: string) => ionState[label] ?? { on: magIons.length === 1, dir: ["0", "0", "1"] as [string, string, string], phase: "1/4" };
  const [modMoment, setModMoment] = useState(1);
  const [modSeed, setModSeed] = useState(1);
  const [modRestarts, setModRestarts] = useState(8);
  const [modBusy, setModBusy] = useState(false);
  const [modError, setModError] = useState<string | null>(null);
  const [modResult, setModResult] = useState<{
    amplitudes: { site: string; amp: number }[]; multiplicity: readonly [number, number, number];
    atoms: number; r1: number | null; degeneracies: MomentDegeneracy[];
  } | null>(null);
  const selectedIonCount = magIons.filter((c) => ionOf(c.siteLabel).on).length;
  // A new structure (CIF load) keeps this workbench mounted (keyed on the dataset
  // id), so clear the stale magnetic hypothesis + results/error for the old cell.
  useEffect(() => { setIonState({}); setModResult(null); setModError(null); }, [structure]);

  /** One-pass linear least-squares scale from the nuclear reflections (satellites
   *  carry ~0 nuclear |F|², so they don't bias it): k = Σ Fo²Fc² / Σ (Fc²)². */
  function estimateScale(struct: StructureModel, ds: SingleCrystalDataset): number {
    const sp: RefinementParameter = { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, fixed: false, min: 0 };
    const cmp = singleCrystalRefinementComparison(struct, ds, [sp], [{ parameterId: "scale", kind: "scale", targetId: ds.id }]);
    let num = 0, den = 0;
    for (const r of cmp.rows) { num += r.foSq * r.fcSq; den += r.fcSq * r.fcSq; }
    return den > 0 && num > 0 ? num / den : 1;
  }

  async function runModulated(): Promise<void> {
    if (!magneticDataset) return;
    const k = [parseKComponent(kText[0]), parseKComponent(kText[1]), parseKComponent(kText[2])] as Vec3;
    const ions: ModulatedIon[] = magIons
      .filter((c) => ionOf(c.siteLabel).on)
      .map((c) => {
        const s = ionOf(c.siteLabel);
        return { site: c.siteLabel, direction: [parseKComponent(s.dir[0]), parseKComponent(s.dir[1]), parseKComponent(s.dir[2])] as Vec3, phase: parseKComponent(s.phase) * Math.PI };
      });
    // Validate before spinning: surface the reason in the panel (App status only
    // logs to the console) instead of a silent no-op or a swallowed throw.
    if (ions.length === 0) { setModError("Tick at least one magnetic ion to carry a moment."); return; }
    if (k.every((c) => c === 0)) { setModError("Enter a non-zero propagation vector k (e.g. 1/4)."); return; }
    if (ions.some((ion) => ion.direction.every((c) => c === 0))) { setModError("Give each selected ion a non-zero moment direction."); return; }
    setModError(null);
    setModBusy(true);
    try {
      const expansion = expandStructureToSupercell(structure, k);
      const superS = expansion.structure;
      const { dataset: merged } = mergeToMagneticSupercell(probedDataset, { ...magneticDataset, radiation: effectiveRadiation }, k, `${dataset.id}-magcell`);
      const mod = buildModulatedMomentModel(expansion, k, ions, modMoment);
      const scaleStart = estimateScale(superS, merged);
      // ONE scale: nuclear + magnetic share it (same measurement); magneticScale
      // is tied to the (freed) nuclear scale, structure frozen (two-phase).
      const scaleP: RefinementParameter = { id: "scale", label: "scale (OSF)", kind: "scale", value: scaleStart, initialValue: scaleStart, fixed: false, min: 0 };
      const mscaleP: RefinementParameter = { id: "magScale", label: "magnetic scale (= nuclear)", kind: "magneticScale", value: scaleStart, initialValue: scaleStart, fixed: true, expression: "= scale" };
      const scaleB: ParameterBinding = { parameterId: "scale", kind: "scale", targetId: merged.id };
      const mscaleB: ParameterBinding = { parameterId: "magScale", kind: "magneticScale", targetId: merged.id };
      const ms = await client.refineMagneticSingleCrystalMultiStart(
        {
          structure: superS, magnetic: mod.magnetic, dataset: merged,
          parameters: [scaleP, mscaleP, ...mod.params.map((p) => ({ ...p, fixed: false }))],
          bindings: [scaleB, mscaleB, ...mod.bindings],
        },
        { restarts: modRestarts, seed: modSeed }, { maxIterations: 30 },
      );
      setModResult({
        amplitudes: ions.map((ion, i) => ({ site: ion.site, amp: Math.abs(ms.final.parameters[mod.params[i]!.id] ?? mod.params[i]!.value) })),
        multiplicity: expansion.supercell.multiplicity,
        atoms: superS.sites.length,
        r1: ms.final.agreement.rWeighted ?? null,
        degeneracies: ms.degeneracies,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[status] Magnetic supercell refinement failed: ${msg}`);
      setModError(msg);
    } finally {
      setModBusy(false);
    }
  }

  /** Download the combined magnetic-supercell `.int` (non-destructive). */
  function downloadCombinedInt(): void {
    if (!magneticDataset) return;
    const k = [parseKComponent(kText[0]), parseKComponent(kText[1]), parseKComponent(kText[2])] as Vec3;
    try {
      const wl = "wavelength" in effectiveRadiation ? effectiveRadiation.wavelength : 0;
      const { dataset: merged } = mergeToMagneticSupercell(probedDataset, { ...magneticDataset, radiation: effectiveRadiation }, k);
      downloadText(`${structure.id}_ALL_magcell.int`, writeFullProfInt(merged.reflections, { title: structure.name || structure.id, wavelength: wl }), "text/plain");
      setModError(null);
    } catch (e) {
      setModError(e instanceof Error ? e.message : String(e));
    }
  }

  // Apply a magnetic model from the symmetry step to the workbench: keep its
  // bindings and merge the (freed) moment parameters into the F² parameter set
  // so the refinement and parameter panel show them alongside the nuclear ones.
  function applyMagneticModel(mag: MagneticModel | null, momentParams: readonly RefinementParameter[] = [], mBindings: readonly ParameterBinding[] = []): void {
    setMagnetic(mag);
    setMomentBindings(mag ? mBindings : []);
    setParams((prev) => [
      ...prev.filter((p) => !isMomentParameterKind(p.kind)),
      ...(mag ? momentParams.map((p) => ({ ...p, fixed: false })) : []),
    ]);
  }

  function onParamChange(id: string, patch: Partial<RefinementParameter>): void {
    setParams((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function reset(): void {
    setParams(spec.params.map((p) => ({ ...p, value: p.initialValue })));
    setResult(null);
  }

  function exportCif(): void {
    const withEsd = params.map((p) => {
      const e = result?.esd[p.id];
      return e !== undefined ? { ...p, esd: e } : { ...p };
    });
    const meta: CifRefinementMeta = {
      r1: comparison.agreement.r1,
      wr2: comparison.agreement.wr2,
      gof: comparison.agreement.goof,
      nRef: activeDataset.reflections.length,
      nParam: nFree,
    };
    // `refinedStructure`, not `structure`: structureToCif reads coordinates and
    // cell off the model and takes the parameters only for their esds, so the
    // starting model would export pre-refinement values with refined esds.
    downloadText(`${structure.id}.cif`, structureToCif(refinedStructure, { params: withEsd, bindings, refinement: meta }), "chemical/x-cif");
  }

  // Export the reflection data as FullProf `.int`. When a joint session is loaded
  // the two files follow the pairing convention (`_nuc.int` + `_mag.int`) so they
  // reload as one co-refinement session; otherwise a single `<id>.int`.
  function exportInt(): void {
    const wl = "wavelength" in effectiveRadiation ? effectiveRadiation.wavelength : 0;
    const emit = (ds: SingleCrystalDataset, suffix: string): void =>
      downloadText(`${structure.id}${suffix}.int`, writeFullProfInt(ds.reflections, { title: structure.name || structure.id, wavelength: wl }), "text/plain");
    if (magneticDataset) {
      emit(probedDataset, "_nuc");
      emit({ ...magneticDataset, radiation: effectiveRadiation }, "_mag");
    } else {
      emit(probedDataset, "");
    }
  }

  // Publish the current exporter so the app header can drive it; clear on unmount
  // (switch back to powder) so the header never calls a stale single-crystal export.
  useEffect(() => {
    if (!exportsRef) return;
    exportsRef.current = { cif: exportCif, scInt: exportInt };
    return () => { exportsRef.current = null; };
  });

  const ag = comparison.agreement;
  const st = merge.statistics;
  const cell = structure.cell;
  const probeLabel = probe === "xray" ? "X-ray" : probe === "neutron" ? "Neutron" : "Neutron TOF";
  const wl = "wavelength" in effectiveRadiation ? ` · λ ${effectiveRadiation.wavelength} Å` : "";

  const summaryCards: SummaryCardData[] = [
    {
      label: "Structure",
      loadLabel: "Load CIF…",
      accept: ".cif,.mcif,text/plain",
      onFile: onLoadCif ?? noop,
      chip: "✓ parsed",
      title: `${structure.name || "structure"} · ${structure.spaceGroup.hermannMauguin ?? "—"}`,
      meta: `a ${cell.a.toFixed(4)} · b ${cell.b.toFixed(4)} · c ${cell.c.toFixed(4)} Å · ${structure.sites.length} sites`,
    },
    {
      label: "Data · single crystal",
      loadLabel: "Load data…",
      accept: DATA_ACCEPT,
      onFile: onLoadData ?? noop,
      chip: "✓ loaded",
      title: dataset.name,
      meta: `${probeLabel}${wl} · ${st.observations} obs → ${st.unique} unique · R_int ${pct(st.rInt)}`,
      control: <ProbeToggle probe={probe} onChange={setProbe} />,
    },
  ];

  const refineActions = (
    <>
      <button
        style={{ ...secondaryButton, padding: "7px 13px", ...(busy ? disabledStyle : {}) }}
        disabled={busy}
        onClick={() => runRefine(true)}
        title="Free all symmetry-allowed structural parameters (positions, ADPs) and refine"
      >
        Refine structure
      </button>
      <button
        style={{ ...secondaryButton, padding: "7px 13px" }}
        onClick={exportCif}
        title="Export the current structure as CIF (with esds + agreement factors)"
      >
        Export CIF
      </button>
    </>
  );

  return (
    <>
      <SummaryCards cards={summaryCards} />
      {/* Step 0 (F² refinement) and step 1 (magnetic symmetry) stay mounted; the
          step toggles visibility so each page's state survives switching. */}
      <div className="wb-sc" style={{ display: step === 1 ? "none" : undefined }}>
        {/* Quality rail: F² agreement + merge stats + F_obs/F_calc beside the 3D model. */}
        <div style={{ ...themeCard, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={uppercaseLabel}>Refinement quality — single crystal (F²)</span>
            <div style={{ display: "flex", gap: 20 }}>
              <Stat value={pct(ag.r1)} label="R1" hint={`${ag.observed}/${ag.total} obs > 2σ`} ink={r1Ink(ag.r1)} />
              <Stat value={pct(ag.wr2)} label="wR2" />
              <Stat value={ag.goof.toFixed(2)} label="GooF" />
            </div>
          </div>

          <div style={mergeStrip}>
            <Stat small value={`${st.observations}`} label={excluded > 0 ? "kept" : "observations"} />
            <Stat small value={`${st.unique}`} label="unique" />
            <Stat small value={st.redundancy.toFixed(2)} label="redundancy" />
            <Stat small value={pct(st.rInt)} label="R_int" />
            <Stat small value={pct(st.rSigma)} label="R_sigma" />
          </div>

          {/* Outlier (σ) reflection filter. */}
          <label style={filterRow} title="Reject reflections whose |Fo²−Fc²|/σ exceeds the threshold against the current model (SHELX-style OMIT)">
            <input type="checkbox" checked={filterOn} onChange={(e) => setFilterOn(e.target.checked)} style={{ accentColor: color.primary }} />
            <span style={{ color: color.secondary }}>Reject reflections with |Δ|/σ &gt;</span>
            <input
              type="number" min={2} step={0.5} value={cutoffSigma}
              disabled={!filterOn}
              onChange={(e) => setCutoffSigma(Math.max(0, Number(e.target.value) || 0))}
              style={{ ...numInput, ...(filterOn ? {} : { opacity: 0.5 }) }}
            />
            <span style={{ color: color.secondary }}>σ</span>
            {filterOn && (
              <span style={{ marginLeft: "auto", fontFamily: mono, color: excluded > 0 ? color.warnInk : color.faint }}>
                {excluded} of {dataset.reflections.length} excluded
              </span>
            )}
          </label>

          {/* One plot at a time (F_obs/F_calc ↔ normal-probability, toggled) beside
              the 3D structure model; stacks when the panel is narrow. */}
          <div className="wb-sc-plots">
            <div>
              <div style={{ display: "flex", gap: 16, marginBottom: 6 }}>
                {(["fobs", "npp"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setPlotKind(k)}
                    style={{
                      ...uppercaseLabel, background: "none", border: "none", padding: "0 0 3px", cursor: "pointer",
                      color: plotKind === k ? color.primary : color.faint,
                      borderBottom: `2px solid ${plotKind === k ? color.primary : "transparent"}`,
                    }}
                  >
                    {k === "fobs" ? "F_obs vs F_calc" : "Normal probability"}
                  </button>
                ))}
              </div>
              {plotKind === "fobs"
                ? <FobsFcalc rows={obsCalc} selected={selected} onHighlight={setSelected} />
                : <NormalProb npp={npp} />}
            </div>
            <div>
              <div style={{ ...uppercaseLabel, marginBottom: 4 }}>Crystal structure — unit cell</div>
              <Suspense fallback={<div style={{ minHeight: 320, display: "grid", placeItems: "center", color: color.secondary, fontSize: 13 }}>Loading 3D viewer…</div>}>
                <div style={{ minHeight: 320 }}><StructureView structure={refinedStructure} /></div>
              </Suspense>
            </div>
          </div>

          <div>
            <div style={{ ...uppercaseLabel, marginBottom: 6 }}>Largest outliers · (Fo²−Fc²)/σ</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: mono, fontSize: fz.small }}>
              {outliers.map((r, i) => {
                const hkl = `${r.h} ${r.k} ${r.l}`;
                const isSel = selected?.kind === "nuclear" && selected.hkl === hkl;
                return (
                  <div
                    key={`${i}:${hkl}`}
                    onClick={() => setSelected(isSel ? null : { hkl, kind: "nuclear" })}
                    style={{
                      display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, cursor: "pointer",
                      padding: "1px 4px", borderRadius: 5,
                      color: isSel ? color.ink : color.secondary,
                      background: isSel ? color.primaryTintBg : "transparent",
                    }}
                  >
                    <span>({hkl})</span>
                    <span style={{ color: color.faint }}>Fo² {r.foSq.toFixed(1)} · Fc² {r.fcSq.toFixed(1)}</span>
                    <span style={{ color: Math.abs(r.deltaOverSigma) > 4 ? color.warnInk : color.faint }}>
                      {r.deltaOverSigma >= 0 ? "+" : ""}{r.deltaOverSigma.toFixed(1)}σ
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Parameters — the shared collapsible panel, single-crystal actions. */}
        <ParameterPanel
          params={params}
          esd={result?.esd}
          onChange={onParamChange}
          onRefine={() => runRefine(false)}
          onReset={reset}
          busy={busy}
          result={result}
          title="Single-crystal parameters"
          extraActions={refineActions}
        />

        {/* Magnetic single-k supercell refinement. Self-contained: expands the
            base structure, merges the nuclear + magnetic files into the
            supercell, ties one modulated amplitude per magnetic sublattice, and
            refines with ONE shared scale (nuclear + magnetic = one measurement).
            Non-destructive: the shared structure/3D view stay in the base cell. */}
        <div style={{ ...themeCard, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={uppercaseLabel}>Magnetic single-k · supercell refinement</span>
            <label style={{ ...secondaryButton, padding: "6px 12px", cursor: "pointer" }} title="Load a companion magnetic reflection file (.int/.hkl): satellites indexed in the nuclear cell as the fundamental h k l of hkl ± k">
              {magneticDataset ? "Replace magnetic file…" : "Load magnetic .int…"}
              <input
                type="file" accept={DATA_ACCEPT} style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onLoadMagneticData?.(f); e.currentTarget.value = ""; }}
              />
            </label>
          </div>

          {!magneticDataset ? (
            <p style={{ fontSize: 13, color: color.secondary, margin: 0, lineHeight: 1.5 }}>
              Load the <strong>magnetic</strong> reflection file (the satellites, indexed in the nuclear cell as the
              fundamental h k l of hkl ± k). This page then expands the structure into the magnetic supercell, merges both
              files, and refines the k-modulated moments — the FullProf single-k workflow.
            </p>
          ) : magIons.length === 0 ? (
            <p style={{ fontSize: 13, color: color.noteInk, margin: 0 }}>
              No magnetic ion with a tabulated form factor in this structure — check the oxidation states / ion labels.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 12.5, color: color.secondary, margin: 0 }}>
                {dataset.reflections.length} nuclear + {magneticDataset.reflections.length} magnetic reflections. Enter k and
                the moment hypothesis; the structure is expanded to the supercell (magnetic ions at the nuclear positions,
                nuclear scaffold frozen) and the modulated amplitudes refine against the merged data.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: fz.small, color: color.secondary, fontFamily: mono }}>k =</span>
                {[0, 1, 2].map((i) => (
                  <input
                    key={i} value={kText[i]} onChange={(e) => setKText((t) => { const n = [...t] as [string, string, string]; n[i] = e.target.value; return n; })}
                    style={{ ...numInput, width: 54 }} title="Fractions like 1/4 or decimals" placeholder={["k₁", "k₂", "k₃"][i]}
                  />
                ))}
              </div>

              {/* One row per magnetic-ion candidate: on/off, direction (crystal axes), phase. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {magIons.map((c) => {
                  const s = ionOf(c.siteLabel);
                  const set = (patch: Partial<typeof s>) => setIonState((st) => ({ ...st, [c.siteLabel]: { ...s, ...patch } }));
                  return (
                    <div key={c.siteLabel} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: fz.small }}>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 92 }}>
                        <input type="checkbox" checked={s.on} onChange={(e) => set({ on: e.target.checked })} style={{ accentColor: color.primary }} />
                        <span style={{ fontFamily: mono }}>{c.siteLabel}</span>
                        <span style={{ color: color.faint }}>{c.ionId}</span>
                      </label>
                      {s.on && (
                        <>
                          <span style={{ color: color.secondary }}>m ∥</span>
                          {[0, 1, 2].map((i) => (
                            <input key={i} value={s.dir[i]} onChange={(e) => { const d = [...s.dir] as [string, string, string]; d[i] = e.target.value; set({ dir: d }); }}
                              style={{ ...numInput, width: 42 }} title="Moment direction, crystal axes (a,b,c)" placeholder={["a", "b", "c"][i]} />
                          ))}
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, color: color.secondary }} title="Modulation phase φ (×π). 0 = node pattern (+,0,−,0); 0.25 = equal-moment (+,+,−,−)">
                            φ/π
                            <input value={s.phase} onChange={(e) => set({ phase: e.target.value })} style={{ ...numInput, width: 46 }} />
                          </label>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fz.small, color: color.secondary }} title="Starting modulation amplitude (µB)">
                  <span style={{ fontFamily: mono }}>amp₀</span>
                  <input type="number" value={modMoment} step={0.5} min={0} onChange={(e) => setModMoment(Number(e.target.value))} style={numInput} />
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fz.small, color: color.secondary }} title="Seeded moment restarts (escape local minima)">
                  <span style={{ fontFamily: mono }}>restarts</span>
                  <input type="number" value={modRestarts} step={1} min={0} onChange={(e) => setModRestarts(Math.round(Number(e.target.value)))} style={numInput} />
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fz.small, color: color.secondary }} title="Deterministic RNG seed">
                  <span style={{ fontFamily: mono }}>seed</span>
                  <input type="number" value={modSeed} step={1} onChange={(e) => setModSeed(Math.round(Number(e.target.value)))} style={numInput} />
                </label>
                <button style={{ ...secondaryButton, padding: "7px 13px", ...(modBusy || selectedIonCount === 0 ? disabledStyle : {}) }} disabled={modBusy || selectedIonCount === 0} onClick={runModulated}
                  title={selectedIonCount === 0 ? "Tick at least one magnetic ion above" : "Expand to the supercell, merge, and refine the k-modulated moment amplitudes (one per sublattice) + shared scale"}>
                  {modBusy ? "Refining…" : "Refine magnetic supercell ↻"}
                </button>
                <button style={{ ...secondaryButton, padding: "7px 13px" }} onClick={downloadCombinedInt}
                  title="Download the combined supercell .int (FullProf single-k input) — non-destructive">
                  Download combined .int
                </button>
              </div>

              {modError && (
                <span style={{ fontSize: fz.small, color: color.warnInk }}>⚠ {modError}</span>
              )}

              {modResult && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: `1px solid ${color.subtle}`, paddingTop: 10 }}>
                  <div style={{ fontSize: 12.5, color: color.secondary }}>
                    Supercell {modResult.multiplicity.join("×")} · {modResult.atoms} atoms (P1) ·{" "}
                    {modResult.r1 != null ? <>wR = {(100 * modResult.r1).toFixed(1)}%</> : "—"}
                  </div>
                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontFamily: mono, fontSize: fz.small }}>
                    {modResult.amplitudes.map((a) => (
                      <span key={a.site} style={{ color: color.ink }}>{a.site}: amp {a.amp.toPrecision(3)} µ<sub>B</sub></span>
                    ))}
                  </div>
                  <span style={{ fontSize: fz.micro, color: color.faint }}>
                    Refined value is the modulation <em>amplitude</em>; the per-site moment is amp·cos(2πk·L+φ) — for the
                    equal-moment φ = π/4 pattern that is amp/√2.
                  </span>
                  {modResult.degeneracies.length > 0 && (
                    <div style={{ fontSize: fz.small, color: color.noteInk }}>
                      <strong>Data-limited directions:</strong>
                      <ul style={{ margin: "3px 0 0", paddingLeft: 18 }}>
                        {modResult.degeneracies.map((d, i) => <li key={i}>{d.message}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Step 1 — magnetic symmetry analysis. The workflow itself is structure-
          driven and identical to powder; only the moment fit (magneticFit) runs
          against F² reflections instead of a powder pattern. */}
      <div style={{ display: step === 1 ? "grid" : "none", gap: 14 }}>
        <div style={{ ...themeCard, padding: "14px 16px" }}>
          <div style={{ ...uppercaseLabel, marginBottom: 4 }}>Magnetic symmetry analysis — single crystal ({structure.name || "structure"})</div>
          <p style={{ fontSize: 13, color: color.secondary, margin: 0, lineHeight: 1.5 }}>
            Commensurate single-k workflow (shared with powder): magnetic ions → propagation vector k → symmetry framework → magnetic space group → refine moments.
            &ldquo;Refine moments&rdquo; fits the moment amplitudes to the F² reflections; &ldquo;Continue&rdquo; carries the model to the F² refinement to fit nuclear + magnetic together.
          </p>
        </div>
        <KSearchPanel
          structure={structure}
          magneticFit={magneticFit}
          onContinue={(m, mp, mb) => { applyMagneticModel(m, mp, mb); onStep?.(0); }}
        />
      </div>
    </>
  );
}

/** Segmented X-ray / Neutron / TOF control for the single-crystal Data card.
 *  A bare reflection file carries no probe, so this is the authoritative source. */
function ProbeToggle({ probe, onChange }: { probe: Probe; onChange: (p: Probe) => void }): JSX.Element {
  const opts: { value: Probe; label: string }[] = [
    { value: "xray", label: "X-ray" },
    { value: "neutron", label: "Neutron" },
    { value: "neutron-tof", label: "TOF" },
  ];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{ fontSize: fz.micro, color: color.faint }}
        title="The reflection file cannot report its own radiation. Pick the probe used — it selects neutron scattering lengths (b) vs X-ray form factors f(Q) + polarization, changing every F_calc."
      >
        probe
      </span>
      <span style={{ display: "inline-flex", border: `1px solid ${color.control}`, borderRadius: 6, overflow: "hidden" }}>
        {opts.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              border: "none", padding: "2px 9px", fontSize: 11.5, fontFamily: "inherit", cursor: "pointer",
              background: probe === o.value ? color.primary : "transparent",
              color: probe === o.value ? "#fff" : color.secondary,
            }}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function Stat({ value, label, hint, ink, small }: { value: string; label: string; hint?: string; ink?: string; small?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontFamily: mono, fontSize: small ? 14 : 18, fontWeight: 600, color: ink ?? color.ink }}>{value}</span>
      <span style={{ fontSize: fz.micro, color: color.secondary }}>{label}</span>
      {hint ? <span style={{ fontSize: fz.micro, color: color.faint }}>{hint}</span> : null}
    </div>
  );
}

const mergeStrip: CSSProperties = {
  display: "flex",
  gap: 22,
  flexWrap: "wrap",
  padding: "10px 2px",
  borderTop: `1px solid ${color.subtle}`,
  borderBottom: `1px solid ${color.subtle}`,
};
const filterRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, fontSize: fz.small, cursor: "pointer",
};
const numInput: CSSProperties = {
  width: 52, border: `1px solid ${color.input}`, borderRadius: 7, fontSize: 12, fontFamily: mono, padding: "2px 6px", background: "#fff",
};
const disabledStyle: CSSProperties = { opacity: 0.55, cursor: "not-allowed" };
