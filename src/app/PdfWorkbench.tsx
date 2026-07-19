/**
 * PDF (pair distribution function) refinement page — "real-space Rietveld"
 * (PDF_MPDF_ROADMAP P0/P1). Shares the workbench design language — SummaryCards
 * row, quality strip, the collapsible ParameterPanel, and the shared plot in its
 * signed-y mode (G(r) oscillates about zero) — and drives the real-space core
 * (`buildPdfSpec` / `buildPdfProblem` via the compute worker).
 *
 * Self-contained: owns its parameter/result state and its CSV export. The app
 * shell mounts it (keyed on the dataset) whenever a reduced `.gr` PDF is loaded.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { EngineExportsRef } from "@/app/workbenchEngine";
import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { RefinementResult } from "@/core/refinement/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { ComputeClient } from "@/workers/computeClient";
import {
  buildPdfSpec,
  buildMultiPhasePdfSpec,
  pdfCurves,
  multiPhasePdfCurves,
  pdfPartialCurves,
  pdfPhaseCurves,
  pdfPhaseBindingsFor,
  optimalPdfScale,
  correlatedMotionConflict,
} from "@/core/workflow/pdf";
import { buildDistortionModes, buildSymmetryModes, positionShiftValuesFor, withDistortionModes, type DistortionModeSet } from "@/core/crystal/distortionModes";
import { decomposeDisplacementRepresentation, type DisplaciveIrrepTerm } from "@/core/crystal/displaciveModes";
import {
  projectIsotypicModes,
  stabilizerOfField,
  identifySubgroup,
  subgroupTypeKey,
  activateDisplacementMode,
  realizeSubgroup,
  type DisplacementField,
  type SubgroupIdentity,
} from "@/core/crystal/isotropyTree";
import {
  structuralSubgroupLattice,
  subgroupClassRepresentatives,
  type SubgroupNode,
} from "@/core/crystal/subgroupTree";
import { parseCif } from "@/parsers/cif";
import { applyParameters } from "@/core/workflow/apply";

// Lazy so three.js stays out of the main bundle until the 3D view is opened.
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));
import { ParameterPanel } from "@/app/ui/ParameterPanel";
import { SummaryCards, type SummaryCardData } from "@/app/ui/SummaryCards";
import { WorkbenchPlot, type FitRangeSelection } from "@/app/ui/WorkbenchPlot";
import { SegmentedToggle } from "@/app/ui/SegmentedToggle";
import { downloadText } from "@/app/download";
import { structureToCif } from "@/core/export/cif";
import { pdfReport } from "@/core/export/pdfReport";
import { card as themeCard, color, mono, secondaryButton, uppercaseLabel, fz, toolbarBtn, resetRangeBtn } from "@/app/theme";

const DATA_ACCEPT = ".gr,.sgr,.sq,.fq,.dat,.txt,text/plain";
const noop = (): void => {};
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

/** Rw quality bands for a PDF (fraction): <15 % good · <30 % mediocre · else
 *  poor. PDF Rw runs much higher than Bragg Rwp for equally good fits — and with
 *  correlated G(r) errors it is a relative indicator, not an absolute one. */
function rwInk(rw: number): string {
  if (!Number.isFinite(rw)) return color.ink;
  if (rw < 0.15) return color.okInk;
  if (rw < 0.3) return color.noteInk;
  return color.warnInk;
}

export function PdfWorkbench({ structure, pattern, extraPhases = [], ownStructure = false, client, exportsRef, onLoadData, onLoadCif, onAddPhase, onRemovePhase, presetValues, presetFitRange }: {
  structure: StructureModel;
  pattern: PdfPattern;
  /** Additional crystallographic phases (multi-phase G(r) sum). */
  extraPhases?: readonly StructureModel[];
  /** True once the user replaced the bundled structure — the load button then
   *  appends phases instead of replacing (multi-phase entry point, as powder). */
  ownStructure?: boolean;
  /** Shared compute worker — the fit runs off the main thread, as in powder. */
  client: ComputeClient;
  exportsRef?: EngineExportsRef;
  onLoadData?: (file: File) => void;
  onLoadCif?: (file: File) => void;
  onAddPhase?: (file: File) => void;
  onRemovePhase?: (id: string) => void;
  /** Converged parameter values to open with (bundled demo snapshots). Applied
   *  as value AND initialValue, so Reset returns to the converged state. */
  presetValues?: Record<string, number>;
  /** Fit window to open with (demo snapshots refine a specific window). */
  presetFitRange?: { min: number; max: number };
}): JSX.Element {
  const multiPhase = extraPhases.length > 0;
  // Position parameterization (single-phase only): "atomic" refines the
  // symmetry-constrained per-coordinate shifts; "irreps" refines symmetry-
  // adapted distortion-mode AMPLITUDES (AMPLIMODES/ISODISTORT paradigm). The
  // mode set comes from the structure's OWN space group (`buildSymmetryModes`,
  // no second CIF needed — amplitudes seed at 0, rigid-translation gauge
  // excluded); loading a high-symmetry PARENT cif upgrades it to the observed
  // decomposition, whose mode 1 is the frozen order parameter (Å).
  const [positionMode, setPositionMode] = useState<"atomic" | "irreps">("atomic");
  const [modes, setModes] = useState<{ set: DistortionModeSet; parentName: string; fromActivation?: boolean } | null>(null);
  useEffect(() => setModes(null), [structure]);
  const symModes = useMemo(() => (multiPhase ? null : buildSymmetryModes(structure)), [structure, multiPhase]);
  // An empty symmetry set (every site pinned by symmetry) cannot replace the
  // position rows — fall back to atomic (the toggle is disabled in that case).
  const modeSet =
    !multiPhase && positionMode === "irreps"
      ? modes?.set ?? (symModes && symModes.modes.length > 0 ? symModes : null)
      : null;
  // The mode parameters are anchored on the parentized structure; everything
  // downstream (spec, curves, worker refine, 3D view, CIF export) uses it.
  const fitStructure = modeSet ? modeSet.parentized : structure;
  // Mode selected in the 3D card's table: its eigenvector (unit-amplitude
  // displacement field) is drawn as green arrows on the 3D model. Click the
  // row to toggle; any mode-set change invalidates the selection.
  const [shownModeId, setShownModeId] = useState<string | null>(null);
  useEffect(() => setShownModeId(null), [modeSet]);
  const shownMode = (shownModeId !== null ? modeSet?.modes.find((m) => m.id === shownModeId) : undefined) ?? null;
  const phases = useMemo(
    () => [{ structure: fitStructure, id: fitStructure.id }, ...extraPhases.map((s) => ({ structure: s, id: s.id }))],
    [fitStructure, extraPhases],
  );
  // Default fit window: above the reduction's low-r validity limit, and capped
  // at 30 Å — files often carry G(r) to 100 Å, and modeling the whole grid on
  // load would hang the page (the model is only ever computed in the window;
  // drag the right handle out to fit further).
  const defaultRange = useMemo((): FitRangeSelection => {
    const rFirst0 = pattern.points[0]?.r ?? 0;
    const rLast0 = pattern.points[pattern.points.length - 1]?.r ?? 1;
    if (presetFitRange) {
      return { min: Math.max(presetFitRange.min, rFirst0), max: Math.min(presetFitRange.max, rLast0) };
    }
    return {
      min: Math.min(Math.max(pattern.rpoly ?? 1.5, rFirst0), rLast0),
      max: Math.min(rLast0, 30),
    };
  }, [pattern, presetFitRange]);
  // Parameter spec: PDF scale/envelope + the symmetry-reduced structural set,
  // with the phase scale(s) seeded from the least-squares optimum of the
  // starting model (exact for one linear scale; split evenly across phases).
  const spec = useMemo(() => {
    const base = multiPhase ? buildMultiPhasePdfSpec([fitStructure, ...extraPhases], pattern) : buildPdfSpec(fitStructure, pattern);
    // Swap per-coordinate position rows for mode amplitudes when a parent has
    // been decomposed (fixed on entry except the frozen mode, per core policy).
    const raw = modeSet
      ? { ...base, ...withDistortionModes({ params: base.params, bindings: base.bindings }, modeSet) }
      : base;
    // Demo preset values are keyed by the PARENT-setting parameter ids. After
    // a subgroup-tree activation the spec lives in the CHILD setting, where
    // colliding ids (U modes, cell rows) mean different symmetry modes —
    // stamping the parent values would silently corrupt the fit. The child
    // self-seeds from the refined (baked) anchor instead; setting-independent
    // values carry over by id in the spec-swap effect.
    const preset = modeSet !== null && modes?.fromActivation ? undefined : presetValues;
    // κ-seeding the phase scale(s) costs a full forward G(r) calculation —
    // skip it when a preset (demo snapshot) supplies every scale anyway.
    const presetCoversScale =
      preset !== undefined &&
      raw.params.every((p) => p.kind !== "pdfScale" || preset[p.id] !== undefined);
    let params = raw.params;
    if (!presetCoversScale) {
      const start = multiPhase
        ? multiPhasePdfCurves(phases, pattern, raw.params, raw.bindings, defaultRange)
        : pdfCurves(fitStructure, pattern, raw.params, raw.bindings, defaultRange);
      const kappa = optimalPdfScale(
        start.yObs.filter((_, i) => start.x[i]! >= defaultRange.min && start.x[i]! <= defaultRange.max),
        start.yCalc.filter((_, i) => start.x[i]! >= defaultRange.min && start.x[i]! <= defaultRange.max),
      ) / (multiPhase ? phases.length : 1);
      params = params.map((p) =>
        p.kind === "pdfScale" ? { ...p, value: kappa, initialValue: kappa } : p,
      );
    }
    // Demo snapshots open converged: preset values win over the κ seed, and
    // become the reset anchor too. (Suppressed for activation specs — see
    // `preset` above.)
    if (preset) {
      params = params.map((p) => (preset[p.id] !== undefined ? { ...p, value: preset[p.id]!, initialValue: preset[p.id]! } : p));
    }
    return { ...raw, params };
  }, [fitStructure, modeSet, extraPhases, multiPhase, phases, pattern, defaultRange, presetValues]);

  const [params, setParams] = useState<readonly RefinementParameter[]>(spec.params);
  const [result, setResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Live calculated curve streamed from the worker during a refinement.
  const [live, setLive] = useState<number[] | null>(null);
  // Plot-card view: the fit, or the refined 3D structure (per phase).
  const [viewTab, setViewTab] = useState<"fit" | "model3d" | "subgroups">("fit");
  const [viewPhase, setViewPhase] = useState(0);
  const [focusFitToken, setFocusFitToken] = useState(0);
  // Spec-swap reset, with FIT PRESERVATION across a position-parameterization
  // flip: when the same structure+pattern merely changed parameterization
  // (atomic ↔ irreps, or a parent-CIF decomposition arriving), the current
  // geometry is realized under the OLD bindings and re-seeded EXACTLY onto the
  // new position parameters (`positionShiftValuesFor` — an interpolation, not
  // a fit), and every non-position value/free-flag carries over by id. Any
  // other spec change (new structure, new data, phases) is a full reset.
  const paramsRef = useRef<readonly RefinementParameter[]>(params);
  paramsRef.current = params;
  // Latest spec, for staleness checks: a worker refinement that resolves AFTER
  // a parameterization flip must be discarded — its parameter ids belong to
  // the old spec and would stamp garbage onto (or silently miss) the new rows.
  const specRef = useRef(spec);
  specRef.current = spec;
  const prevSpecCtx = useRef<{
    structure: StructureModel;
    pattern: PdfPattern;
    multiPhase: boolean;
    anchor: StructureModel;
    bindings: readonly ParameterBinding[];
  } | null>(null);
  // Set by actions that deliberately CHANGE the model geometry (subgroup-tree
  // activation with its starting kick): the next spec swap keeps the spec's
  // own POSITION seeds (the kick) instead of re-deriving them from the
  // previous fit's geometry, while the id-keyed carryover of non-position
  // values (scale, δ, Qdamp/Qbroad, occupancies, matching cell rows) still
  // runs — those hold the live refined state and their ids are
  // setting-independent.
  const skipPositionCarryoverOnce = useRef(false);
  useEffect(() => {
    const prev = prevSpecCtx.current;
    const prevParams = paramsRef.current;
    const skipPos = skipPositionCarryoverOnce.current;
    skipPositionCarryoverOnce.current = false;
    let next = spec.params;
    if (prev && prev.structure === structure && prev.pattern === pattern && !multiPhase && !prev.multiPhase) {
      const values: Record<string, number> = {};
      for (const p of prevParams) values[p.id] = p.value;
      const realized = skipPos ? null : applyParameters(prev.anchor, prev.bindings, values).model;
      const posSeed = realized ? positionShiftValuesFor(fitStructure, spec.bindings, realized) : null;
      const prevById = new Map(prevParams.map((p) => [p.id, p]));
      // On an activation swap (skipPos) the parameter SETTING changed: ids of
      // setting-dependent kinds (U modes, cell rows) collide across settings
      // while meaning different symmetry modes — carrying them by id would
      // stamp parent-mode amplitudes onto different child modes. Carry only
      // the setting-independent problem-level kinds; the child spec already
      // seeds the structural ones from the refined (baked) anchor.
      const settingFree = new Set(["pdfScale", "qdamp", "qbroad", "delta1", "delta2", "sratio", "rcut", "spdiameter", "occupancy", "scale"]);
      next = spec.params.map((p) => {
        if (p.kind === "positionShift") {
          if (!posSeed) return p; // activation: keep the spec's seed (the kick)
          const v = posSeed[p.id] ?? 0;
          // Rows carrying real displacement enter free (they hold the fit);
          // the rest keep the spec's deliberate-activation default.
          return { ...p, value: v, fixed: Math.abs(v) > 1e-8 ? false : p.fixed };
        }
        if (skipPos && !settingFree.has(p.kind)) return p;
        const old = prevById.get(p.id);
        return old ? { ...p, value: old.value, fixed: old.fixed } : p;
      });
    }
    setParams(next);
    setResult(null);
    setLive(null);
    prevSpecCtx.current = { structure, pattern, multiPhase, anchor: fitStructure, bindings: spec.bindings };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spec is the sole trigger; the rest is read-at-fire context
  }, [spec]);

  // A spec swap (new structure / new mode set) resets `params` in the effect
  // above — one render AFTER the memos below run. Mixing the stale params with
  // the new spec's bindings would stamp the previous structure's values onto
  // the new one — worst case the 1 Å placeholder cell onto a real structure,
  // whose 30 Å pair enumeration then hangs the page for good. Until the state
  // catches up, every consumer pairs spec.bindings with the spec's own params.
  const specParamIds = useMemo(() => new Set(spec.params.map((p) => p.id)), [spec]);
  const activeParams =
    params.length === spec.params.length && params.every((p) => specParamIds.has(p.id))
      ? params
      : spec.params;

  // The 3D view tracks the refinement: apply the current parameter values so
  // the viewer shows the refined cell/positions/ADPs, not the loaded CIF.
  const viewStructure = useMemo(() => {
    const phase = phases[Math.min(viewPhase, phases.length - 1)]!;
    const values: Record<string, number> = {};
    for (const p of activeParams) values[p.id] = p.value;
    const phaseBindings = multiPhase ? pdfPhaseBindingsFor(spec.bindings, phase.id) : spec.bindings;
    return applyParameters(phase.structure, phaseBindings, values).model;
  }, [phases, viewPhase, activeParams, spec.bindings, multiPhase]);

  // Fit window over r (drag the plot handles). Starts at the default window;
  // the model is only computed inside it, so widening it costs compute.
  const rFirst = pattern.points[0]?.r ?? 0;
  const rLast = pattern.points[pattern.points.length - 1]?.r ?? 1;
  const [fitRange, setFitRange] = useState<FitRangeSelection>(defaultRange);
  useEffect(() => setFitRange(defaultRange), [defaultRange]);

  const curves = useMemo(
    () =>
      multiPhase
        ? multiPhasePdfCurves(phases, pattern, activeParams, spec.bindings, fitRange)
        : pdfCurves(fitStructure, pattern, activeParams, spec.bindings, fitRange),
    [multiPhase, phases, fitStructure, pattern, activeParams, spec.bindings, fitRange],
  );

  // Decomposition overlays (P3): per-phase contributions on a multi-phase fit,
  // element-pair (Faber–Ziman) partials on a single-phase fit with ≥2 elements.
  const nElements = useMemo(() => new Set(structure.sites.map((s) => s.element)).size, [structure]);
  const canOverlay = multiPhase || nElements >= 2;
  const [showPartials, setShowPartials] = useState(false);
  const partials = useMemo(() => {
    if (!showPartials || !canOverlay) return null;
    return multiPhase
      ? pdfPhaseCurves(phases, pattern, activeParams, spec.bindings, fitRange)
      : pdfPartialCurves(fitStructure, pattern, activeParams, spec.bindings, fitRange);
  }, [showPartials, canOverlay, multiPhase, phases, fitStructure, pattern, activeParams, spec.bindings, fitRange]);
  const plotCurves = useMemo(() => {
    if (!live) return curves;
    const yCalc = live;
    return { ...curves, yCalc, diff: curves.yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
  }, [curves, live]);

  // Rw over G(r) inside the fit window — computed from the PLOTTED curves so
  // it ticks live while a refinement streams its per-cycle calc. Uniform
  // weights, Rw = √(Σ(o−c)² / Σo²): a relative indicator only (correlated
  // G(r) errors; see core/workflow/pdf.ts).
  const rw = useMemo(() => {
    let num = 0;
    let den = 0;
    for (let i = 0; i < plotCurves.x.length; i++) {
      const r = plotCurves.x[i]!;
      if (r < fitRange.min || r > fitRange.max) continue;
      const d = plotCurves.yObs[i]! - plotCurves.yCalc[i]!;
      num += d * d;
      den += plotCurves.yObs[i]! * plotCurves.yObs[i]!;
    }
    return den > 0 ? Math.sqrt(num / den) : NaN;
  }, [plotCurves, fitRange]);

  const nFree = params.filter((p) => !p.fixed && !p.expression).length;
  const motionConflict = useMemo(() => correlatedMotionConflict(params), [params]);

  async function runRefine(): Promise<void> {
    setBusy(true);
    const specAtCall = specRef.current;
    try {
      const start = [...params];
      const res = await client.refinePdfParallel(
        {
          structure: fitStructure,
          ...(multiPhase ? { extraPhases: [...extraPhases] } : {}),
          pattern,
          parameters: start,
          bindings: [...spec.bindings],
          restraints: spec.restraints,
          fitRange,
          options: { maxIterations: 30 },
        },
        (yCalc) => setLive(yCalc),
      );
      if (specRef.current !== specAtCall) {
        // The parameterization (or the whole problem) changed mid-run; the
        // result's ids belong to the old spec — drop it rather than mixing.
        console.info("[status] refinement result discarded — the parameter spec changed while it ran");
        return;
      }
      setParams((ps) => ps.map((p) => ({ ...p, value: res.parameters[p.id] ?? p.value })));
      setResult(res);
    } catch (e) {
      console.error(`[status] PDF refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLive(null);
      setBusy(false);
    }
  }

  // Multi-start (one engine, two faces, as powder): a cold start gets the wide
  // "Prefit" search; once a fit exists it's a lighter "Escape min" nudge out of
  // the current basin. Keeps the lowest-χ² of baseline + restarts.
  async function runMultiStart(): Promise<void> {
    setBusy(true);
    const specAtCall = specRef.current;
    try {
      const escape = result !== null;
      const ms = await client.refinePdfMultiStart(
        {
          structure: fitStructure,
          ...(multiPhase ? { extraPhases: [...extraPhases] } : {}),
          pattern,
          parameters: [...params],
          bindings: [...spec.bindings],
          restraints: spec.restraints,
          fitRange,
          options: { maxIterations: 25 },
        },
        escape ? { restarts: 4, escapeSigma: 2 } : { restarts: 8 },
        (yCalc) => setLive(yCalc),
      );
      if (specRef.current !== specAtCall) {
        console.info("[status] multi-start result discarded — the parameter spec changed while it ran");
        return;
      }
      setParams((ps) => ps.map((p) => ({ ...p, value: ms.final.parameters[p.id] ?? p.value })));
      setResult(ms.final);
      console.info(
        `[status] PDF multi-start (${escape ? "escape" : "prefit"}): best of ${ms.restartsRun + 1} starts` +
        `${ms.bestStartIndex > 0 ? ` (restart ${ms.bestStartIndex} won)` : " (baseline held)"} · Rw ${(100 * (ms.final.agreement.rWeighted ?? 0)).toFixed(2)}%`,
      );
    } catch (e) {
      console.error(`[status] PDF multi-start failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLive(null);
      setBusy(false);
    }
  }

  function onParamChange(id: string, patch: Partial<RefinementParameter>): void {
    setParams((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  // ---- Subgroup tree (Γ potential distortion modes, requirement 3) --------
  // The displacive decomposition of the LOADED structure's own space group:
  // which irreps could carry a symmetry-breaking distortion, and — per irrep —
  // which isotropy subgroups its modes lead to. Computed only when the 3D
  // Model card (which hosts the tree) is visible; single-phase only.
  // The tree enumerates the PARENT's irreps, so it is only offered from the
  // pristine parent state — an active mode set (activation or parent-CIF)
  // lives in a different setting whose irreps/labels would not match; the
  // user clears it (✕) first. Acoustic-only terms (optic = 0) are dropped:
  // their entire content is a rigid translation the gauge projection would
  // discard, making activation a guaranteed no-op.
  const subgroupTree = useMemo(() => {
    if (multiPhase || viewTab !== "model3d" || modes !== null) return null;
    const dec = decomposeDisplacementRepresentation(structure);
    if (!dec.available) return null;
    const terms = dec.terms
      .filter((t) => !t.trivial && t.multiplicity - t.acoustic > 0)
      .map((term) => {
        const fields = projectIsotypicModes(structure, undefined, term, structure.spaceGroup.operations);
        // Group candidate modes by the subgroup they lead to — the tree view.
        // The key must distinguish subgroups that share point group and index
        // but differ in translation content (Pm vs Pc), hence the
        // setting-invariant op-set key fallback.
        const bySub = new Map<string, { identity: SubgroupIdentity; field: DisplacementField; count: number }>();
        for (const f of fields) {
          const subOps = stabilizerOfField(f, structure.spaceGroup.operations);
          const id = identifySubgroup(subOps, structure.spaceGroup.operations);
          const key = id.number !== undefined ? `#${id.number}` : subgroupTypeKey(subOps);
          const e = bySub.get(key);
          if (e) e.count++;
          else bySub.set(key, { identity: id, field: f, count: 1 });
        }
        return { term, subgroups: [...bySub.values()] };
      });
    return { dec, terms };
  }, [multiPhase, viewTab, structure, modes]);

  // ---- Structural subgroup lattice (the "Subgroups" page) ------------------
  // The full translationengleiche group–subgroup tree of the loaded space group
  // (every t-subgroup named, with covering/Bärnighausen edges and conjugacy
  // grouping) — the "search for subgroups" step: pick a target subgroup and
  // activate the distortion modes it permits. Computed only when the Subgroups
  // tab is visible; single-phase. Independent of `modes` (it is the parent's
  // lattice, unchanged by an active distortion).
  const subgroupLattice = useMemo(
    () => (multiPhase || viewTab !== "subgroups" ? null : structuralSubgroupLattice(structure)),
    [multiPhase, viewTab, structure],
  );
  const subgroupLevels = useMemo(() => {
    if (!subgroupLattice) return [];
    const reps = subgroupClassRepresentatives(subgroupLattice);
    const byIndex = new Map<number, SubgroupNode[]>();
    for (const n of reps) {
      const list = byIndex.get(n.index);
      if (list) list.push(n);
      else byIndex.set(n.index, [n]);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, nodes]) => ({ index, nodes }));
  }, [subgroupLattice]);

  // Activate a chosen SUBGROUP (subgroup-driven, the inverse of the irrep-driven
  // path): realize the child (split Wyckoff orbits) from the current refined
  // geometry, then load the full symmetry-allowed displacement catalog of that
  // child — every Γ distortion the subgroup permits — as amplitudes seeded at 0
  // and fixed. The user frees the ones to refine (a polar mode needs a nudge off
  // its χ² stationary point — Prefit escapes it).
  function onActivateSubgroup(node: SubgroupNode): void {
    const name = node.identity.hermannMauguin ?? node.identity.pointGroup ?? "subgroup";
    const label = node.identity.number !== undefined ? `${name} #${node.identity.number}` : `${name} (index ${node.index})`;
    const values: Record<string, number> = {};
    for (const p of paramsRef.current) values[p.id] = p.value;
    const refined = applyParameters(fitStructure, spec.bindings, values).model;
    const child = realizeSubgroup(refined, node.operations, node.identity);
    const set = buildSymmetryModes(child);
    if (set.modes.length === 0) {
      console.error(`[status] ${label}: this subgroup leaves every site symmetry-pinned — no refinable distortion modes`);
      return;
    }
    skipPositionCarryoverOnce.current = true; // fresh child setting — carry nothing
    setModes({ set, parentName: label, fromActivation: true });
    setPositionMode("irreps");
    console.info(
      `[status] lowered to ${label}: ${child.sites.length} child site(s) · ${set.modes.length} distortion mode(s) — free the rows to refine (Positions group)`,
    );
  }

  // Activate one symmetry-breaking mode: realize the isotropy-subgroup child
  // (split Wyckoff orbits — parent ops would re-symmetrize the displacement
  // into a wrong orbit) and enter irreps mode with the activated field as the
  // leading free amplitude. The amplitude gets a small starting KICK: for an
  // inversion-odd (polar) mode of a centrosymmetric parent, amplitude 0 is an
  // exact stationary point of χ² (±a are inversion domains with identical
  // G(r)), so a gradient refinement could never leave it.
  const ACTIVATION_KICK = 0.05; // Å whole-cell starting amplitude
  function onActivateMode(term: DisplaciveIrrepTerm, sub: { identity: SubgroupIdentity; field: DisplacementField }): void {
    const subName = sub.identity.hermannMauguin ?? sub.identity.pointGroup ?? "subgroup";
    const label = `${term.irrep.label} → ${subName}`;
    // Activate from the CURRENT refined geometry, not the loaded CIF: baking
    // the refined cell/ADPs/positions into the anchor means the child spec
    // self-seeds the refined values in ITS OWN setting — the parent-setting
    // preset/param ids (U modes, cell rows) do not survive a symmetry change,
    // so re-seeding from ids alone would silently revert the fit.
    const values: Record<string, number> = {};
    for (const p of paramsRef.current) values[p.id] = p.value;
    const refined = applyParameters(fitStructure, spec.bindings, values).model;
    // Re-derive the chosen field on the refined anchor (atom positions moved
    // with the fit, so the display tree's field cannot be reused verbatim):
    // match by irrep label, then by the resulting subgroup identity.
    const dec = decomposeDisplacementRepresentation(refined);
    const termNow = dec.terms.find((t) => t.irrep.label === term.irrep.label && !t.trivial);
    let fieldNow: DisplacementField | null = null;
    if (termNow) {
      for (const f of projectIsotypicModes(refined, undefined, termNow, refined.spaceGroup.operations)) {
        const id = identifySubgroup(stabilizerOfField(f, refined.spaceGroup.operations), refined.spaceGroup.operations);
        const sameName = id.number !== undefined ? id.number === sub.identity.number : id.pointGroup === sub.identity.pointGroup && id.index === sub.identity.index;
        if (sameName) {
          fieldNow = f;
          break;
        }
      }
    }
    if (!fieldNow) {
      console.error(`[status] activation failed: ${label} not found on the refined structure (did the fit lower the effective symmetry?)`);
      return;
    }
    const act = activateDisplacementMode(refined, fieldNow, label);
    // The seed survives only if it has optic (non-gauge) content — a pure
    // acoustic field is projected away by buildSymmetryModes. Target the kick
    // by the ACTIVE mode's id, never by index: with a dropped seed, index 0
    // would be an unrelated fixed complement mode.
    const activeId = act.modeSet.modes.find((m) => m.active)?.id;
    if (activeId === undefined) {
      console.error(`[status] activation of ${label} produced no refinable mode (the field is pure rigid translation) — nothing to do`);
      return;
    }
    const set: DistortionModeSet = {
      ...act.modeSet,
      parameters: act.modeSet.parameters.map((p) =>
        p.id === activeId ? { ...p, value: ACTIVATION_KICK, initialValue: ACTIVATION_KICK, fixed: false } : p,
      ),
    };
    skipPositionCarryoverOnce.current = true; // keep the kick; carry the rest by id
    setModes({ set, parentName: label, fromActivation: true });
    setPositionMode("irreps");
    console.info(
      `[status] activated ${label}${sub.identity.number !== undefined ? ` (#${sub.identity.number})` : ""}: ` +
      `${act.child.sites.length} child site(s) · starting amplitude ${ACTIVATION_KICK} Å`,
    );
  }

  // Decompose the current (child) structure against a HIGH-SYMMETRY parent CIF
  // into refinable distortion-mode amplitudes. The seeded amplitudes reproduce
  // the loaded structure exactly, so activating modes never changes the curve.
  async function onLoadParentCif(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parent = parseCif(text, `parent-${Date.now().toString(36)}`);
      const set = buildDistortionModes(parent, structure);
      if (set.modes.length === 0) {
        console.error("[status] distortion modes: no child site could be paired with the parent structure — check that both CIFs share the same lattice/setting.");
        return;
      }
      setModes({ set, parentName: parent.name || file.name.replace(/\.[^.]+$/, "") });
      setPositionMode("irreps");
      console.info(`[status] distortion modes: ${set.modes.length} mode(s), total |A| = ${set.totalAmplitude.toFixed(4)} Å${set.unpaired.length ? ` · unpaired: ${set.unpaired.join(", ")}` : ""}`);
    } catch (e) {
      console.error(`[status] parent CIF failed to parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function reset(): void {
    setParams(spec.params);
    setResult(null);
    setLive(null);
  }

  // Exports published to the app header (engine contract): the output triple —
  // refined curves (CSV), refined structure(s) (CIF with esds + Rw meta), and
  // the markdown report.
  const exportCsvRef = useRef<() => void>(noop);
  exportCsvRef.current = (): void => {
    const rows = curves.x.map((r, i) => `${r},${curves.yObs[i]},${curves.yCalc[i]},${curves.diff[i]}`);
    downloadText(`${pattern.id}.csv`, `r,Gobs,Gcalc,diff\n${rows.join("\n")}\n`, "text/csv");
  };
  const exportCifRef = useRef<() => void>(noop);
  exportCifRef.current = (): void => {
    const withEsd = params.map((p) => {
      const esd = result?.esd[p.id] ?? p.esd;
      return esd !== undefined ? { ...p, esd } : { ...p };
    });
    const meta = {
      rwp: rw * 100,
      nRef: curves.x.filter((r) => r >= fitRange.min && r <= fitRange.max).length,
      nParam: nFree,
    };
    for (const phase of phases) {
      const cif = structureToCif(phase.structure, { params: withEsd, bindings: spec.bindings, refinement: meta });
      downloadText(`${phase.structure.name || phase.id}_pdf.cif`, cif, "chemical/x-cif");
    }
  };
  const exportReportRef = useRef<() => void>(noop);
  exportReportRef.current = (): void => {
    const conflict = motionConflict;
    const text = pdfReport({
      phases: phases.map((p) => p.structure),
      pattern,
      parameters: params,
      result,
      rw,
      fitRange,
      ...(conflict ? { warnings: [conflict] } : {}),
    });
    downloadText(`${pattern.id}_report.md`, text, "text/markdown");
  };
  useEffect(() => {
    if (!exportsRef) return;
    exportsRef.current = {
      csv: () => exportCsvRef.current(),
      cif: () => exportCifRef.current(),
      report: () => exportReportRef.current(),
    };
    return () => { exportsRef.current = null; };
  }, [exportsRef]);

  const probeLabel = pattern.scatteringType === "neutron" ? "Neutron" : "X-ray";
  const summaryCards: SummaryCardData[] = [
    {
      label: "Structure",
      // Once the user owns the structure, the button appends phases (multi-phase
      // G(r) sum) instead of replacing — mirroring the powder card's behaviour.
      loadLabel: ownStructure && onAddPhase ? "Add CIF…" : "Load CIF…",
      accept: ".cif,.mcif,text/plain",
      onFile: (ownStructure && onAddPhase ? onAddPhase : onLoadCif) ?? noop,
      chip: multiPhase ? `✓ ${phases.length} phases` : "✓ parsed",
      title: multiPhase
        ? phases.map((p) => p.structure.name || p.id).join(" + ")
        : `${structure.name || "structure"} · ${structure.spaceGroup.hermannMauguin ?? "—"}`,
      meta: `a ${structure.cell.a.toFixed(4)} · b ${structure.cell.b.toFixed(4)} · c ${structure.cell.c.toFixed(4)} Å · ${structure.sites.length} sites`,
      ...(multiPhase && onRemovePhase
        ? {
            phaseBadges: phases.map((p, i) => ({ id: p.id, label: p.structure.name || p.id, removable: i > 0 })),
            onRemovePhase,
          }
        : {}),
    },
    {
      label: "Data · PDF G(r)",
      loadLabel: "Load data…",
      accept: DATA_ACCEPT,
      onFile: onLoadData ?? noop,
      chip: "✓ reduced G(r)",
      title: pattern.name,
      meta:
        `${probeLabel} · r ${rFirst.toFixed(2)}–${rLast.toFixed(2)} Å · ${pattern.points.length} pts` +
        (pattern.qmax !== undefined ? ` · Qmax ${pattern.qmax.toFixed(1)} Å⁻¹` : "") +
        (pattern.sourceKind === "sq" ? " · from S(Q)" : pattern.sourceKind === "fq" ? " · from F(Q)" : "") +
        (pattern.composition ? ` · ${pattern.composition}` : ""),
    },
  ];

  // Mirrors the powder page's "Magnetic analysis →" slot; enabled when mPDF
  // (roadmap P4) lands.
  const refineActions = (
    <button
      style={{ ...secondaryButton, flex: "0 0 auto", padding: "10px 13px", fontSize: 13, opacity: 0.5, cursor: "default" }}
      disabled
      title="Magnetic PDF (mPDF) — moment refinement against magnetic G(r). The core (P4) is built and validated against diffpy.mpdf; this page arrives with the mPDF UI milestone."
    >
      Magnetic PDF →
    </button>
  );

  return (
    <>
      <SummaryCards cards={summaryCards} />
      <div className="wb-work2">
        <div style={{ ...themeCard, padding: "16px 18px", display: "flex", flexDirection: "column", height: "clamp(500px, 66vh, 900px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={uppercaseLabel}>
              {viewTab === "fit" ? "PDF pattern — G(r)" : viewTab === "model3d" ? "Crystal structure — unit cell" : "Group–subgroup tree"}
            </span>
            {viewTab === "fit" && (
              <span style={{ display: "flex", gap: 14, fontFamily: mono, fontSize: 12.5 }}>
                <span style={{ color: color.secondary }} title="Rw over G(r) inside the fit window (uniform weights). G(r) point errors are correlated, so treat as a relative indicator.">
                  Rw <b style={{ color: rwInk(rw) }}>{Number.isFinite(rw) ? pct(rw) : "—"}</b>
                </span>
              </span>
            )}
            {viewTab === "fit" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: mono, fontSize: fz.micro, color: color.secondary }} title="The r window used for refinement (set with the blue handles). Low r below r_poly is reduction artifact.">
                fit {fitRange.min.toFixed(2)}–{fitRange.max.toFixed(2)} Å
                <button style={resetRangeBtn} onClick={() => setFitRange(defaultRange)} title="Reset to the default window">Reset range</button>
              </span>
            )}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, rowGap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {viewTab === "fit" && canOverlay && (
                <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: fz.micro, color: color.secondary, cursor: "pointer" }} title={multiPhase ? "Overlay each phase's G(r) contribution — they sum exactly to the calc curve" : "Overlay the element-pair (Faber–Ziman) partial PDFs — they sum exactly to the calc curve"}>
                  <input type="checkbox" checked={showPartials} onChange={(e) => setShowPartials(e.target.checked)} style={{ accentColor: color.primary }} />
                  {multiPhase ? "phases" : "partials"}
                </label>
              )}
              {viewTab === "fit" && (
                <button
                  style={{ ...toolbarBtn, display: "inline-flex", alignItems: "center", gap: 5 }}
                  title="Zoom the plot onto the active fit window"
                  onClick={() => setFocusFitToken((t) => t + 1)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  optimize view
                </button>
              )}
              <SegmentedToggle
                options={[
                  { id: "fit", label: "Refinement", title: "Observed vs calculated G(r)" },
                  { id: "model3d", label: "3D Model", title: "3D crystal-structure model" },
                  { id: "subgroups", label: "Subgroups", title: "Group–subgroup tree — pick a target subgroup to activate the distortion modes it permits" },
                ] as const}
                value={viewTab}
                onChange={setViewTab}
              />
            </div>
          </div>
          {viewTab === "fit" ? (
            <>
              <WorkbenchPlot
                curves={plotCurves}
                xLabel="r (Å)"
                yLabel="G(r) (Å⁻²)"
                signedY
                showBackground={false}
                fitRange={fitRange}
                onFitRangeChange={setFitRange}
                focusFitToken={focusFitToken}
                {...(partials ? { overlays: partials } : {})}
              />
              <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, color: color.secondary }}>
                Drag across the plot to zoom, blue handles to set the fit window. Qdamp/Qbroad are instrument constants — hold them fixed once calibrated on a standard.
              </p>
              {motionConflict && (
                <div style={{ marginTop: 6, fontSize: 12, color: color.warnInk }}>⚠ {motionConflict}</div>
              )}
            </>
          ) : viewTab === "model3d" ? (
            <>
              {multiPhase && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: color.secondary }}>phase</span>
                  <span style={{ display: "inline-flex", border: `1px solid ${color.border}`, borderRadius: 6, overflow: "hidden" }}>
                    {phases.map((ph, i) => (
                      <button
                        key={ph.id}
                        onClick={() => setViewPhase(i)}
                        style={{ border: "none", padding: "1px 9px", fontSize: 11.5, fontFamily: "inherit", cursor: "pointer", background: i === viewPhase ? color.primary : "#fff", color: i === viewPhase ? "#fff" : color.ink }}
                      >
                        {ph.structure.name || `phase ${i + 1}`}
                      </button>
                    ))}
                  </span>
                </div>
              )}
              {/* The viewer and the panels below share a FIXED-height card, so
                  both regions are explicit flex partners: the viewer flexes but
                  never bleeds (overflow hidden), the mode/tree stack scrolls
                  internally. Before this, the wrapper shrank to its 360 px
                  minimum while the viewer's own chrome (toolbar, view row,
                  legend) overflowed it — painting over the modes table. */}
              <div style={{ flex: "1 1 auto", minHeight: 320, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <Suspense fallback={<div style={{ flex: 1, display: "grid", placeItems: "center", color: color.secondary, fontSize: 13 }}>Loading 3D viewer…</div>}>
                  <StructureView
                    key={viewStructure.id + viewPhase}
                    structure={viewStructure}
                    minCanvasHeight={200}
                    {...(shownMode ? { displacements: shownMode.axes } : {})}
                  />
                </Suspense>
              </div>
              {!multiPhase && (
                <div style={{ flex: "0 1 auto", minHeight: 90, maxHeight: 300, overflowY: "auto", marginTop: 6 }}>
                  {modeSet ? (
                    <>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                        <span style={uppercaseLabel}>Distortion modes</span>
                        <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.secondary }}>
                          {modes ? `vs ${modes.parentName}` : `from ${structure.spaceGroup.hermannMauguin ?? "own space group"}`}
                          {" · total |A| = "}
                          {Math.sqrt(
                            modeSet.modes.reduce((s, m) => {
                              const v = params.find((p) => p.id === m.id)?.value ?? 0;
                              return s + v * v;
                            }, 0),
                          ).toFixed(4)}{" "}
                          Å
                          {(modeSet.acousticExcluded ?? 0) > 0 ? ` · ${modeSet.acousticExcluded} acoustic excluded` : ""}
                        </span>
                        {shownMode && (
                          <span style={{ fontFamily: mono, fontSize: fz.micro, color: "#15803d" }}>
                            ▸ green arrows: {shownMode.label}
                          </span>
                        )}
                        <button
                          style={resetRangeBtn}
                          onClick={() => {
                            setModes(null);
                            setPositionMode("atomic");
                          }}
                          title="Back to per-coordinate position parameters"
                        >
                          ✕ clear
                        </button>
                      </div>
                      <div style={{ marginTop: 4, border: `1px solid ${color.border}`, borderRadius: 6 }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: fz.micro }}>
                          <thead>
                            <tr style={{ color: color.secondary, textAlign: "left" }}>
                              <th style={{ padding: "3px 8px", fontWeight: 500 }}>mode</th>
                              <th style={{ padding: "3px 8px", fontWeight: 500, textAlign: "right" }}>A (Å)</th>
                              <th style={{ padding: "3px 8px", fontWeight: 500, textAlign: "right" }}>esd</th>
                              <th style={{ padding: "3px 8px", fontWeight: 500 }}>state</th>
                            </tr>
                          </thead>
                          <tbody>
                            {modeSet.modes.map((m, i) => {
                              const p = params.find((q) => q.id === m.id);
                              const esd = result?.esd[m.id] ?? p?.esd;
                              const shown = m.id === shownModeId;
                              return (
                                <tr
                                  key={m.id}
                                  onClick={() => setShownModeId(shown ? null : m.id)}
                                  title="Click to show/hide this mode's displacement pattern in the 3D model (green arrows, unit amplitude — the eigenvector, not the refined magnitude)"
                                  style={{
                                    borderTop: `1px solid ${color.border}`,
                                    cursor: "pointer",
                                    background: shown ? "rgba(22, 163, 74, 0.1)" : i === 0 ? "rgba(90, 130, 255, 0.06)" : "transparent",
                                  }}
                                >
                                  <td style={{ padding: "3px 8px", color: shown ? "#15803d" : i === 0 ? color.primary : color.ink }}>
                                    {shown ? "▸ " : ""}{m.label}
                                  </td>
                                  <td style={{ padding: "3px 8px", textAlign: "right" }}>{(p?.value ?? 0).toFixed(5)}</td>
                                  <td style={{ padding: "3px 8px", textAlign: "right", color: color.secondary }}>{esd !== undefined ? esd.toFixed(5) : "—"}</td>
                                  <td style={{ padding: "3px 8px", color: color.secondary }}>{p?.fixed ? "fixed" : "free"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12, color: color.secondary }}>
                        {modes
                          ? "Amplitudes are whole-cell displacement norms (Å); mode 1 is the frozen distortion — its fitted amplitude is the order parameter. Free/fix rows in the parameter panel (Positions group)."
                          : "Amplitudes are whole-cell displacement norms (Å), enumerated from the structure's own space group (symmetry-conserving Γ modes; rigid-translation gauge excluded). All seed at 0 — free the rows you want active in the parameter panel (Positions group), or load a parent CIF for the observed order-parameter decomposition."}
                        {" Click a row to draw the mode's eigenvector on the 3D model (green arrows)."}
                      </p>
                    </>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={uppercaseLabel}>Distortion modes</span>
                      <label
                        style={{ border: `1px solid ${color.border}`, borderRadius: 6, padding: "2px 10px", fontSize: fz.micro, color: color.ink, cursor: "pointer" }}
                        title="Decompose this structure against a high-symmetry parent CIF (same lattice/setting) into refinable symmetry-mode amplitudes — refine one order parameter instead of many coordinates"
                      >
                        Load parent CIF…
                        <input
                          type="file"
                          accept=".cif,text/plain"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void onLoadParentCif(f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      <span style={{ fontSize: fz.micro, color: color.secondary }}>
                        or flip Positions → “Irreps (modes)” in the parameter panel — modes come from the loaded space group, no second CIF needed
                      </span>
                    </div>
                  )}
                  {subgroupTree && subgroupTree.terms.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                        <span style={uppercaseLabel}>Potential Γ modes · subgroup tree</span>
                        <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.secondary }}>
                          {structure.spaceGroup.hermannMauguin ?? "parent"} ·{" "}
                          {subgroupTree.terms.length} symmetry-breaking irrep{subgroupTree.terms.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div style={{ marginTop: 4, border: `1px solid ${color.border}`, borderRadius: 6 }}>
                        {subgroupTree.terms.map(({ term, subgroups }) => {
                          const dim = term.irrep.dim ?? 1;
                          const optic = term.multiplicity - term.acoustic;
                          return (
                            <div key={term.irrep.label} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "5px 8px", borderTop: `1px solid ${color.subtle2}` }}>
                              <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.ink, minWidth: 128 }}>
                                {term.irrep.label} · dim {dim} · {optic} optic mode{optic === 1 ? "" : "s"}
                                {term.acoustic > 0 ? ` (+${term.acoustic} acoustic)` : ""}
                              </span>
                              {subgroups.map((sub, si) => (
                                <button
                                  key={si}
                                  style={{ ...resetRangeBtn, ...(busy ? { opacity: 0.55, cursor: "not-allowed" } : {}) }}
                                  disabled={busy}
                                  onClick={() => onActivateMode(term, sub)}
                                  title={`Activate this distortion: the space group lowers to the isotropy subgroup (Wyckoff orbits split), the mode enters the Positions group free with a ${ACTIVATION_KICK} Å starting amplitude — a polar mode of a centrosymmetric parent sits at an exact χ² stationary point at amplitude 0, so it must start off zero.`}
                                >
                                  Activate → {sub.identity.hermannMauguin ?? sub.identity.pointGroup ?? "?"}
                                  {sub.identity.number !== undefined ? ` #${sub.identity.number}` : ` (index ${sub.identity.index})`}
                                  {sub.count > 1 ? ` ·${sub.count}` : ""}
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                      <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12, color: color.secondary }}>
                        Cell-preserving (Γ) distortions of the loaded group only — zone-boundary (cell-multiplying) modes need projective small representations and are deliberately not enumerated. Oblique order-parameter directions arrive via a parent-CIF decomposition.
                      </p>
                    </div>
                  )}
                </div>
              )}
              <p style={{ marginTop: 4, fontSize: 12, color: color.secondary }}>
                {viewStructure.name || "Structure"}
                {viewStructure.spaceGroup.hermannMauguin ? ` · ${viewStructure.spaceGroup.hermannMauguin}` : ""}
                {` · ${viewStructure.sites.length} site${viewStructure.sites.length === 1 ? "" : "s"} · refined values applied · drag to rotate, scroll to zoom.`}
              </p>
            </>
          ) : (
            <>
              {multiPhase ? (
                <div style={{ flex: 1, display: "grid", placeItems: "center", textAlign: "center", color: color.secondary, fontSize: 13, padding: 20 }}>
                  Subgroup analysis is single-phase — the group–subgroup tree is built from one structure's space group.
                </div>
              ) : !subgroupLattice ? (
                <div style={{ flex: 1, display: "grid", placeItems: "center", color: color.secondary, fontSize: 13 }}>
                  No space-group operations to analyze.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                    <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.secondary }}>
                      {structure.spaceGroup.hermannMauguin ?? "parent"} · {subgroupLattice.nodes.length} translationengleiche subgroups ·{" "}
                      {subgroupLevels.reduce((s, l) => s + l.nodes.length, 0)} distinct types
                    </span>
                  </div>
                  {modes?.fromActivation && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6, padding: "5px 9px", borderRadius: 6, background: "rgba(90, 130, 255, 0.08)", border: `1px solid ${color.border}`, fontSize: fz.micro }}>
                      <span style={{ color: color.primary, fontFamily: mono }}>▼ lowered to {modes.parentName}</span>
                      <span style={{ color: color.secondary }}>
                        {modeSet?.modes.length ?? 0} distortion mode{(modeSet?.modes.length ?? 0) === 1 ? "" : "s"} in the Positions group — free the rows to refine
                      </span>
                      <button
                        style={{ ...resetRangeBtn, marginLeft: "auto" }}
                        onClick={() => { setModes(null); setPositionMode("atomic"); }}
                        title="Discard the distortion and return to the parent's per-coordinate positions"
                      >
                        ✕ clear
                      </button>
                    </div>
                  )}
                  <div style={{ overflowY: "auto", border: `1px solid ${color.border}`, borderRadius: 6, flex: 1, minHeight: 120 }}>
                    {subgroupLevels.map(({ index, nodes }) => (
                      <div key={index}>
                        <div style={{ position: "sticky", top: 0, padding: "3px 8px", background: color.subtle, borderTop: `1px solid ${color.border}`, borderBottom: `1px solid ${color.subtle2}`, fontFamily: mono, fontSize: fz.micro, color: color.secondary }}>
                          index {index}{index === 1 ? " · parent group" : ""}
                        </div>
                        {nodes.map((n) => (
                          <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "4px 8px", borderTop: `1px solid ${color.subtle2}` }}>
                            <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.ink, minWidth: 140 }}>
                              {n.identity.hermannMauguin ?? n.pointGroup ?? "?"}
                              {n.identity.hermannMauguin && n.pointGroup ? <span style={{ color: color.secondary }}> ({n.pointGroup})</span> : null}
                              {n.identity.number !== undefined ? <span style={{ color: color.secondary }}> #{n.identity.number}</span> : null}
                            </span>
                            {n.domainCount > 1 && (
                              <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.secondary }} title="symmetry-equivalent domains (conjugate subgroups of the same type)">
                                ×{n.domainCount} domains
                              </span>
                            )}
                            {n.identity.number === undefined && !n.isTrivial && (
                              <span style={{ fontSize: fz.micro, color: color.secondary }} title="named by point group only — the origin-shifted/translation setting is not resolved yet">
                                approx.
                              </span>
                            )}
                            {!n.isParent && !n.isTrivial && (
                              <button
                                style={{ ...resetRangeBtn, marginLeft: "auto", ...(busy || modes !== null ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}
                                disabled={busy || modes !== null}
                                onClick={() => onActivateSubgroup(n)}
                                title={modes !== null ? "Clear the active distortion first" : "Lower to this subgroup: split the Wyckoff orbits and load the Γ distortion modes it permits into the Positions group as refinable amplitudes."}
                              >
                                Activate ↓
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12, color: color.secondary }}>
                    Translationengleiche (lattice-preserving) subgroups only. Activating one splits the Wyckoff orbits and exposes the Γ distortion modes that subgroup allows as amplitudes (all seed at 0 — a polar mode sits at a χ² stationary point, so free it and use Prefit to escape zero). Cell-multiplying (klassengleiche) subgroups arrive with the zone-boundary engine.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <ParameterPanel
          params={params}
          esd={result?.esd}
          onChange={onParamChange}
          onRefine={() => void runRefine()}
          onThorough={() => void runMultiStart()}
          thoroughMode={result ? "escape" : "prefit"}
          prefitTitle="Prefit from a cold start: a broad set of perturbed restarts of the free parameters, keeping the best — lands the model in a good basin before you refine. (No Le Bail stage — that extracts Bragg intensities, which real-space G(r) doesn't have.)"
          onReset={reset}
          busy={busy}
          result={result}
          title="PDF parameters"
          extraActions={refineActions}
          groupInfo={{
            // Each PDF group is a distinct physical effect — the "?" badge spells
            // it out on hover so the physics stays off the resting parameter rows.
            Instrument: (
              <span>
                Instrument Q-space resolution: <b>Qdamp</b> damps G(r) by a Gaussian
                envelope, <b>Qbroad</b> broadens peaks ∝ r. Calibrate on a standard
                (Ni/Si) and hold fixed — free only deliberately.
              </span>
            ),
            "Correlated motion": (
              <span>
                Near-neighbor correlated thermal motion sharpens low-r peaks.{" "}
                <b>δ1</b> (1/r) and <b>δ2</b> (1/r²) are the smooth laws;{" "}
                <b>sratio/rcut</b> step-sharpens below a cutoff instead — refine one
                family, not both.
              </span>
            ),
            "Particle shape": (
              <span>
                Finite-size envelope for nanoparticles: the spherical-particle
                diameter attenuates G(r) toward high r. 0 = bulk; set a starting Ø
                by hand before freeing it (it cannot climb up from 0).
              </span>
            ),
          }}
          // The atomic ↔ irreps switch reshapes the whole parameter set (the
          // Positions group swaps per-coordinate rows for whole-cell mode
          // amplitudes), so it lives at panel level, not inside one group.
          frameworkControls={
            multiPhase || !symModes || (symModes.modes.length === 0 && !modes)
              ? undefined
              : (
                  <>
                    <span style={uppercaseLabel}>Parameterization</span>
                    <SegmentedToggle
                      options={[
                        {
                          id: "atomic",
                          label: "Constrained atomic",
                          title: "Per-coordinate symmetry-allowed shifts — one row per free coordinate of each site",
                        },
                        {
                          id: "irreps",
                          label: "Irreps (modes)",
                          title:
                            "Symmetry-adapted distortion-mode amplitudes (whole-cell Å) computed from the structure's own space group — no parent CIF needed. Modes seed at 0 and enter fixed; free the ones you want active. The unobservable rigid-translation (acoustic) combinations are excluded, so freeing every mode stays well-posed.",
                        },
                      ]}
                      value={positionMode}
                      // Guard the input side of the mid-refine race too: a
                      // flip while the worker runs would swap the spec under
                      // the in-flight result (which the staleness check in
                      // runRefine would then discard — better not to invite it).
                      onChange={(id) => {
                        if (!busy) setPositionMode(id);
                      }}
                    />
                    {positionMode === "irreps" && modeSet && (
                      <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.secondary }}>
                        {modes
                          ? `vs ${modes.parentName}`
                          : `from ${structure.spaceGroup.hermannMauguin ?? "own space group"}`}
                        {` · ${modeSet.modes.length} mode${modeSet.modes.length === 1 ? "" : "s"}`}
                        {(modeSet.acousticExcluded ?? 0) > 0
                          ? ` · ${modeSet.acousticExcluded} acoustic (translation) excluded`
                          : ""}
                      </span>
                    )}
                  </>
                )
          }
        />
      </div>
    </>
  );
}
