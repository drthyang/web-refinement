/**
 * Magnetic propagation-vector (k) search + little-group magnetic subgroups, for
 * the commensurate single-k first pass. Self-contained over the loaded nuclear
 * structure:
 *   1. select the magnetic ion(s),
 *   2. enter a k-vector by hand OR search it from observed magnetic-peak
 *      d-spacings (FullProf-style position scoring), and
 *   3. read the allowed magnetic subgroups of the little group of k.
 *
 * The heavy lifting is in the pure core (kSearch, magneticGroups, magneticIons);
 * this is presentation only.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { isMomentParameterKind, type ParameterBinding, type RefinementParameter } from "@/core/refinement/types";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { searchPropagationVector, satelliteMatchDeltas, kLabel, type KCandidate } from "@/core/magnetic/kSearch";
import { classifyPropagation, describePropagation } from "@/core/magnetic/propagation";
import type { AnnotatedExtraPeak } from "@/core/magnetic/extraPeaks";
import { littleGroup } from "@/core/magnetic/magneticGroups";
import { magneticOperationSignature as magOpsSignature } from "@/core/magnetic/operationSignature";
import {
  magneticSubgroupLattice,
  latticeRepresentatives,
  latticeCandidateLabel as latticeLabel,
  type LatticeCandidate,
} from "@/core/magnetic/subgroupLattice";
import { decomposeMagneticRepresentation, projectIrrepModes } from "@/core/magnetic/irreps";
import { isotropySubgroup, type IrrepSelection, type IsotropyFailure } from "@/core/magnetic/isotropy";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { formatMagneticSymbol } from "@/core/magnetic/bnsOg";
import { describeMomentMode } from "@/core/magnetic/momentModel";
import { buildMagneticModel, type MagneticModelBuild } from "@/core/magnetic/momentModel";
import { fitAmplitudesToMoments } from "@/core/magnetic/amplitudeFit";
import { momentCartesian } from "@/core/magnetic/moment";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import type { MagneticModel } from "@/core/magnetic/types";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import type { PowderPhase } from "@/core/workflow/multiPhase";
import { refine } from "@/core/refinement/engine";
import type { PowderCurves, PowderProfile } from "@/core/workflow/powder";
import {
  magneticPhaseTicks,
  satellitePositionTicks,
  MAGNETIC_COLOR,
  type PhaseTicks,
} from "@/visualization/reflectionTicks";
import { WorkbenchPlot, type FitRangeSelection } from "@/app/ui/WorkbenchPlot";
import { InfoBadge } from "@/app/ui/InfoBadge";
import { momentEntriesFrom } from "@/app/ui/cellModel";
import type { ReportGroup } from "@/core/export/report";
import type { MagneticExploration } from "@/app/reportInputs";
import { structureToCif, magneticStructureToMcif } from "@/core/export/cif";
import { downloadText } from "@/app/download";
import { card as themeCard, color as theme, mono as themeMono, uppercaseLabel as themeLabel, resetRangeBtn, space, toolbarBtn } from "@/app/theme";

// Lazy so three.js stays in its own chunk (only loaded when a group is previewed).
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));
// Type-only — erased at build, so it does not pull the viewer out of its chunk.
import type { StructureExport } from "@/app/ui/StructureView";

/**
 * Parse one k component, accepting fractions ("1/2", "-1/3") as well as
 * decimals — exact fractions matter: 0.333 misses the little-group tolerance
 * where 1/3 is meant.
 */
function parseKComponent(s: string): number {
  const frac = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const den = Number(frac[2]);
    return den === 0 ? 0 : Number(frac[1]) / den;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

/** The two equivalent symmetry frameworks for step 3 of the workflow. */
const FRAMEWORKS: readonly { id: "msg" | "irrep"; label: string }[] = [
  { id: "msg", label: "Magnetic space groups" },
  { id: "irrep", label: "Representation analysis" },
];

/** A residual peak as this panel consumes it: detected (annotated) or manually
 *  added by clicking the pattern — manual picks bypass the inclusion criteria
 *  (explicit user intent) and are removable from the table. */
export interface ResidualPeak extends AnnotatedExtraPeak {
  readonly manual?: boolean;
}

/** Stable default for the residualPeaks prop — an inline `= []` would mint a
 *  fresh array on every render and retrigger every effect keyed on it (a
 *  render loop when the prop is absent, e.g. single-crystal mode). */
const NO_PEAKS: readonly ResidualPeak[] = [];


const ISOTROPY_FAILURE_TEXT: Record<IsotropyFailure, string> = {
  "no-modes": "The selected irrep(s) carry no moment on the chosen site(s) — this order parameter is magnetically silent here.",
  "complex-irrep": "A conjugate-pair (complex) irrep is selected: its real combinations generally stabilize as anti-translation (type-IV) groups, which the bundled type-I/III table cannot name yet.",
  "multidim-irrep": "A multidimensional irrep is selected: its magnetic group depends on the order-parameter direction (kernel vs epikernels) — direction selection is the next milestone. The magnetic-space-group route covers these orderings today.",
  "complex-phase": "This k gives complex phase factors e^{2πik·L}: naming needs the type-IV / star-of-k treatment (see docs/MAGNETIC_SYMMETRY.md).",
  "primed-translation": "The stabilizer contains a primed pure translation — a type-IV magnetic group, outside the bundled type-I/III table.",
};

/**
 * Pluggable moment-refinement backend. The symmetry workflow is structure-driven
 * and identical for powder and single crystal; only the "refine moments" fit
 * differs (a powder pattern vs single-crystal reflections). Single-crystal mode
 * injects this so the same panel fits moments against F² data; powder keeps its
 * built-in pattern path (used when this is absent).
 */
export interface MagneticFit {
  /** Refine the freed moment amplitudes (nuclear model held fixed). Returns the
   *  refined values by param id and an agreement fraction for the readout. */
  refine: (
    magnetic: MagneticModel,
    momentParams: readonly RefinementParameter[],
    momentBindings: readonly ParameterBinding[],
  ) => Promise<{ values: Record<string, number>; agreement: number | null }>;
  /** Agreement readout label, e.g. "wR" (powder) or "R1" (single crystal). */
  agreementLabel: string;
}

/**
 * Everything the powder-pattern preview needs, prepared by the powder
 * workbench (which owns the axis conversions and the refined session state).
 * It is the refinement plot's own view — refined curves in the current
 * display unit, fit-range window, unit toggle, and the per-phase Bragg-tick
 * rows — so the magnetic page shows exactly the pattern being refined; this
 * panel adds the satellite / allowed / residual rows on top.
 */
export interface MagneticPatternView {
  /** Refined obs/calc/background curves in the CURRENT display unit. */
  readonly curves: PowderCurves;
  readonly xLabel: string;
  /** d-spacing (Å) → current display unit. */
  readonly dToX: (d: number) => number;
  /** Current display unit → d-spacing (Å) — for click-to-add manual peaks. */
  readonly xToD?: (x: number) => number;
  /** d-window of the pattern (floored against tiny-d tick explosions). */
  readonly dRange: { readonly min: number; readonly max: number };
  /** One Bragg-tick row per crystallographic phase (refined cells), so
   *  impurity peaks index against their own phase. */
  readonly nuclearTicks: readonly PhaseTicks[];
  /** Fit-range window in display space (same draggable handles as the
   *  refinement plot when `onFitRangeChange` is present). */
  readonly fitRange?: FitRangeSelection;
  readonly onFitRangeChange?: (r: FitRangeSelection) => void;
  /** Axis-unit segmented control, sharing the refinement page's unit state. */
  readonly unitToggle?: ReactNode;
  /**
   * The MAGNETIC contribution of a model to the calculated curve (display
   * point order, nuclear model at its current values). With it the page draws
   * the candidate being judged ON the pattern — the visual test the agreement
   * number alone cannot give. The curves above must then be nuclear-only.
   */
  readonly magneticComponent?: (magnetic: MagneticModel) => number[];
}

/** One candidate's result in the "rank against the data" table. */
interface RankEntry {
  readonly status: "ok" | "failed" | "forbidden";
  /** Agreement (fraction) of the moments-only fit; null when not fitted. */
  readonly wR: number | null;
  /** Refined amplitudes by parameter id — the seed when the row is selected. */
  readonly values: Record<string, number>;
  /** Refined moment magnitude per sublattice (µ_B, Cartesian). */
  readonly magnitudes: readonly { readonly label: string; readonly value: number }[];
}

export function KSearchPanel({
  structure,
  fitStructure,
  extraPhases = [],
  residualPeaks = NO_PEAKS,
  onAddManualPeak,
  onRemoveManualPeak,
  pattern,
  fitRange,
  patternView,
  patternQuality,
  patternFitChip,
  onFocusFit,
  focusFitToken = 0,
  nuclearParams,
  nuclearBindings,
  profile,
  magneticFit,
  onApply,
  onContinue,
  baselineAgreement = null,
  preselect = null, onReportModel,
}: {
  structure: StructureModel;
  /** The BASE (as-loaded) primary structure for the powder moments fit — the
   *  nuclear parameter values are re-applied onto it, so passing the refined
   *  `structure` would double-apply delta-style bindings (position shifts).
   *  Defaults to `structure` (correct when no structural deltas are refined). */
  fitStructure?: StructureModel;
  /** Additional (non-magnetic) crystallographic phases of the sample — their
   *  nuclear peaks join the moments-fit profile, with bindings routed per phase. */
  extraPhases?: readonly PowderPhase[];
  /** Candidate magnetic peaks auto-detected from the pattern residual (permissive
   *  base cut), annotated with significance and nearby nuclear reflections —
   *  plus any manually added picks (flagged `manual`). The panel's own criteria
   *  decide which detections feed the k-search; manual picks are always in. */
  residualPeaks?: readonly ResidualPeak[];
  /** Add a manual residual peak at this d (from a click on the pattern). */
  onAddManualPeak?: (d: number) => void;
  /** Remove a manually added peak (by its d). */
  onRemoveManualPeak?: (d: number) => void;
  /** The observed pattern + refined nuclear model, for running a moment refinement. */
  pattern?: PowderPattern;
  /** Active refinement window in the pattern's native x-unit — the moments fit
   *  masks points outside it, matching the refinement page. */
  fitRange?: { readonly min: number; readonly max: number };
  /** Curves + d→x mapping for the pattern preview with satellite/allowed tick
   *  rows — the visual check that the chosen k and magnetic space group can
   *  explain the unindexed peaks. Absent in single-crystal mode. */
  patternView?: MagneticPatternView;
  /** Live wR/GoF chips for the pattern-card toolbar. Passed separately from
   *  `patternView` on purpose: it changes every live-refinement flush, and
   *  baking it into the memoized view would churn the tick computation. */
  patternQuality?: ReactNode;
  /** Active fit-range chip (display-space label + reset). Present only while a
   *  window narrower than the pattern is set. */
  patternFitChip?: { readonly label: string; readonly onReset: () => void };
  /** "optimize view": zoom the plot onto the active fit range (bumps the shared
   *  focus token, so the refinement plot re-frames identically). */
  onFocusFit?: () => void;
  focusFitToken?: number;
  nuclearParams?: readonly RefinementParameter[];
  nuclearBindings?: readonly ParameterBinding[];
  profile?: PowderProfile;
  /** Single-crystal moment-fit backend; when present it drives "Refine moments"
   *  instead of the built-in powder-pattern path. */
  magneticFit?: MagneticFit;
  /** Push the current magnetic model onto the session so the refinement plot
   *  shows the magnetic pattern + satellite ticks (null clears it). */
  onApply?: (magnetic: MagneticModel | null) => void;
  /** Hand the magnetic model + moment params/bindings to the refinement page. */
  onContinue?: (magnetic: MagneticModel, params: readonly RefinementParameter[], bindings: readonly ParameterBinding[]) => void;
  /** The nuclear-only agreement (fraction) the candidate fits are compared against. */
  baselineAgreement?: number | null;
  /**
   * A magnetic model to open ON — the session's applied model (an mCIF load, a
   * bundled demo, a reopened project, a previous Continue). Its k is set, its
   * ions selected, the candidate whose operations match is selected (its index
   * section opened), and the amplitudes are seeded from its moments.
   */
  preselect?: MagneticModel | null;
  /**
   * Publishes what the page currently shows — the selected candidate with its
   * moments at the current amplitudes, its label, and the moments-only fit's
   * agreement — so the header's report (Export ▾ → Report) can include the
   * model under exploration. Called with null when no candidate is selected.
   */
  onReportModel?: (model: MagneticExploration | null) => void;
}): JSX.Element {
  const ions = useMemo(() => magneticIonCandidates(structure), [structure]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ions.map((i) => i.siteLabel)));
  const [kText, setKText] = useState<[string, string, string]>(["0", "0", "0"]);
  const [results, setResults] = useState<KCandidate[] | null>(null);

  // Peak-selection criteria: which detected residual peaks count as magnetic
  // input for the k-search. The significance threshold (when the data carries
  // σ) and the near-nuclear exclusion set the default; the per-peak checkboxes
  // override peak by peak. Changing a criterion drops the manual overrides so
  // the criteria stay the single explanation of what is included.
  const [minSig, setMinSig] = useState(5);
  // Draft/commit for the threshold input (same pattern as the k components):
  // clamping per keystroke would make values like "10" untypable.
  const [minSigText, setMinSigText] = useState("5");
  function commitMinSig(): void {
    const v = Number(minSigText);
    const next = Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, 3), 30) : minSig;
    setMinSigText(String(next));
    if (next !== minSig) {
      setMinSig(next);
      setPeakOverrides({});
    }
  }
  const [allowNearNuclear, setAllowNearNuclear] = useState(false);
  const [peakOverrides, setPeakOverrides] = useState<Record<string, boolean>>({});
  // Peaks with σ carry a significance; a masked bin (σ = 0) or mixed data can
  // leave individual peaks without one — those pass the threshold rather than
  // silently disabling the criterion for everyone.
  const hasSignificance = residualPeaks.some((p) => p.significance !== undefined);
  // Display rows: sorted by d descending (low Q first — left-to-right in
  // d-spacing, where magnetic peaks live) and numbered to match the ticks the
  // pattern preview draws for them.
  const peakRows = useMemo(() => {
    return [...residualPeaks]
      .sort((a, b) => b.d - a.d)
      .map((p, i) => {
        const key = p.d.toFixed(5);
        const passSig = p.significance === undefined || p.significance >= minSig;
        const passNuclear = allowNearNuclear || !p.nearNuclear;
        // Manual picks bypass the criteria — adding one IS the inclusion decision.
        const byDefault = p.manual ? true : passSig && passNuclear;
        return { ...p, idx: i + 1, key, included: peakOverrides[key] ?? byDefault };
      });
  }, [residualPeaks, minSig, allowNearNuclear, peakOverrides]);
  const includedPeaks = useMemo(() => peakRows.filter((r) => r.included), [peakRows]);
  // Content signature of the DETECTED set: residualPeaks is re-minted (fresh
  // array) by unrelated re-renders upstream (axis toggles, applying a model),
  // which must not wipe the user's curation — only a real change of the peak
  // set does.
  const peakSignature = useMemo(() => residualPeaks.map((p) => p.d.toFixed(5)).sort().join("|"), [residualPeaks]);
  // The candidate list scores a specific included-peak set; changing the
  // criteria, the overrides, or the detections invalidates it.
  const includedSignature = useMemo(() => includedPeaks.map((r) => r.key).join("|"), [includedPeaks]);
  useEffect(() => {
    setResults((r) => (r === null ? r : null));
  }, [includedSignature]);

  // k is confirmed explicitly ("Set k") so the symmetry analysis below does not
  // churn on every keystroke; the inputs hold a draft until then.
  const [k, setAppliedK] = useState<Vec3>([0, 0, 0]);
  // Arms / commensurability of the applied k: decides whether the moment
  // parameters are real amplitudes or cosine + sine (quadrature) pairs.
  const kClass = useMemo(() => classifyPropagation(k), [k]);
  const draftK: Vec3 = [parseKComponent(kText[0]), parseKComponent(kText[1]), parseKComponent(kText[2])];
  const draftPending = draftK.some((v, i) => Math.abs(v - k[i]!) > 1e-12);

  // Per-peak |Δd| to the nearest satellite G ± k of the CURRENT k — the
  // quantitative per-peak check that the applied k explains each detection.
  const kDeltas = useMemo(
    () => satelliteMatchDeltas(structure.cell, k, peakRows.map((r) => r.d)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structure, k[0], k[1], k[2], peakRows],
  );

  // Route A: the FULL lattice of candidate magnetic space groups — every
  // (subgroup H ≤ G_k, θ) pair, not only the maximal index-2 decorations —
  // grouped into conjugacy classes (one representative shown per class, with
  // its domain count), k-SUBGROUPSMAG-style. See subgroupLattice.ts for theory.
  const { reps, lgSize } = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0) return { reps: [] as LatticeCandidate[], lgSize: 0 };
    const lattice = magneticSubgroupLattice(ops, k);
    return { reps: latticeRepresentatives(lattice), lgSize: littleGroup(ops, k).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2]]);

  // Allowed-moment dimension per candidate at the selected sites' positions —
  // the quick "does this group even permit a moment here" badge.
  const repMomentDims = useMemo(() => {
    const sites = [...selected]
      .map((l) => structure.sites.find((s) => s.label === l))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    return reps.map((r) =>
      sites.reduce(
        (sum, s) => sum + allowedMomentDirections(r.candidate.operations, s.position, k).dimension,
        0,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reps, selected, structure, k[0], k[1], k[2]]);

  // Representation-analysis (irrep) route: decompose Γ_mag over G(k) into the
  // irreps of its (abelian) little co-group and project the basis modes each one
  // carries on the reference site.
  const irrepAnalysis = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0 || selected.size === 0) return null;
    const lg = littleGroup(ops, k);
    const dec = decomposeMagneticRepresentation(structure, k, [...selected], lg);
    const modes = dec.available ? dec.terms.map((t) => projectIrrepModes(structure, k, [...selected], lg, t.irrep)) : [];
    return { dec, modes, lg };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2], selected]);

  // Which symmetry framework drives the group selection: the Shubnikov
  // (magnetic space group) route or the representation-analysis (irrep) route.
  // Both converge on a magnetic space group whose moments are previewed below.
  const [framework, setFramework] = useState<"msg" | "irrep">("msg");

  // Route B selection: any combination of real irreps (SARAh-style mixing).
  // The resulting magnetic space group is the isotropy subgroup — the exact
  // stabilizer of a generic combination — identified against the BNS/OG table.
  const [chosenIrreps, setChosenIrreps] = useState<ReadonlySet<string>>(new Set());
  const combo = useMemo(() => {
    if (!irrepAnalysis || !irrepAnalysis.dec.available || chosenIrreps.size === 0) return null;
    const selections: IrrepSelection[] = irrepAnalysis.dec.terms
      .filter((t) => chosenIrreps.has(t.irrep.label))
      .map((t) => ({ irrep: t.irrep }));
    if (selections.length === 0) return null;
    return isotropySubgroup(structure, k, [...selected], irrepAnalysis.lg, selections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [irrepAnalysis, chosenIrreps, structure, k[0], k[1], k[2], selected]);

  // The isotropy subgroup expressed as one of the lattice candidates (it always
  // is one, by construction) — cross-links the two routes in the UI.
  const comboRepIdx = useMemo(() => {
    if (!combo || "failure" in combo) return null;
    const sig = magOpsSignature(combo.operations);
    const idx = reps.findIndex((r) => magOpsSignature(r.candidate.operations) === sig);
    return idx >= 0 ? idx : null;
  }, [combo, reps]);

  // Selected magnetic subgroup → symmetry-allowed moment model over the real
  // structure, with editable moment-mode amplitudes and a 3D preview.
  const [selIdx, setSelIdx] = useState<number | null>(null);
  // Collapsible index sections: only the maximal (index-2) group starts open —
  // the top-down workflow — the rest show counts until expanded.
  const [openIndices, setOpenIndices] = useState<ReadonlySet<number>>(new Set([2]));
  const [amps, setAmps] = useState<Record<string, number>>({});
  const [tieMoments, setTieMoments] = useState(true);
  // Optional |M| tie across sublattices (same size, own symmetry-fixed
  // directions) with per-sublattice antiparallel flips. Scope: within each
  // element, or across all selected sites (the high-entropy case).
  const [tieMagnitudes, setTieMagnitudes] = useState(false);
  const [tieScope, setTieScope] = useState<"element" | "all">("element");
  const [flippedUnits, setFlippedUnits] = useState<ReadonlySet<string>>(new Set());

  // The operations driving step 5, from whichever framework is active.
  const chosenOps = useMemo(() => {
    if (framework === "msg") return selIdx != null ? reps[selIdx]?.candidate.operations ?? null : null;
    return combo && !("failure" in combo) ? combo.operations : null;
  }, [framework, selIdx, reps, combo]);

  // When the chosen group's BNS identification needed a basis transformation,
  // offer its standard-setting cell as a 3D overlay (e.g. the orthohexagonal
  // C-centred cell of a Cm'cm'-type subgroup of a hexagonal parent).
  const standardCell = useMemo(() => {
    const match =
      framework === "msg"
        ? selIdx != null
          ? reps[selIdx]?.settingMatch
          : undefined
        : combo && !("failure" in combo)
          ? combo.settingMatch ?? undefined
          : undefined;
    if (!match || match.direct) return undefined;
    const { P, originShift: p } = match;
    // New cell origin in parent fractional coordinates: P·p.
    const origin: Vec3 = [
      P[0]![0]! * p[0]! + P[0]![1]! * p[1]! + P[0]![2]! * p[2]!,
      P[1]![0]! * p[0]! + P[1]![1]! * p[1]! + P[1]![2]! * p[2]!,
      P[2]![0]! * p[0]! + P[2]![1]! * p[1]! + P[2]![2]! * p[2]!,
    ];
    return { P, origin, label: formatMagneticSymbol(match.identity.bnsSymbol) };
  }, [framework, selIdx, reps, combo]);

  // True when ≥2 selected magnetic ions share one crystallographic site (disorder).
  const hasSharedMagSite = useMemo(() => {
    const sel = [...selected]
      .map((l) => structure.sites.find((s) => s.label === l))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    const coincide = (a: Vec3, b: Vec3): boolean =>
      [0, 1, 2].every((i) => { const d = Math.abs(a[i]! - b[i]!); return Math.min(d, 1 - d) < 1e-3; });
    for (let i = 0; i < sel.length; i++) for (let j = i + 1; j < sel.length; j++) {
      if (coincide(sel[i]!.position, sel[j]!.position)) return true;
    }
    return false;
  }, [selected, structure]);

  /** The moment model of a candidate's operations under the page's current
   *  options — ONE builder for the selected candidate and for ranking, so a
   *  ranked wR describes exactly the model a click on the row previews. */
  const buildFor = useCallback(
    (ops: readonly SymmetryOperation[]): MagneticModelBuild =>
      buildMagneticModel(structure, k, [...selected], [...ops], {
        moment: 2,
        tieSameSite: tieMoments,
        tieEqualMagnitude: tieMagnitudes ? tieScope : false,
        flippedUnits: [...flippedUnits],
      }),
    [structure, k, selected, tieMoments, tieMagnitudes, tieScope, flippedUnits],
  );
  const magBuild = useMemo(() => (chosenOps ? buildFor(chosenOps) : null), [chosenOps, buildFor]);

  // Whether an |M| tie could apply: ≥2 magnetic sites (the all-sites scope
  // ties across elements), or a split orbit (two sublattices of one site) —
  // the tie option only renders when it can do something.
  const canTieMagnitudes = useMemo(() => {
    if (!magBuild) return false;
    if (magBuild.activeSites.length >= 2) return true;
    return magBuild.magnetic.moments.some((m) => (m.orbitIndex ?? 1) > 1);
  }, [magBuild]);

  // Amplitude seeds waiting for the build they belong to, identified by the
  // operation-set signature: a ranked candidate's refined values when its row
  // is clicked, or the moments of a model this page was asked to open on.
  const pendingSeed = useRef<{ sig: string; values?: Record<string, number>; model?: MagneticModel } | null>(null);
  useEffect(() => {
    // A different group (or none) invalidates the previous moments-fit readout.
    setRefineWR(null);
    if (!magBuild) return;
    const seed = pendingSeed.current;
    const own = magBuild.magnetic.operations ? magOpsSignature(magBuild.magnetic.operations) : null;
    if (seed) {
      pendingSeed.current = null;
      if (own === seed.sig) {
        const values = seed.values ?? (seed.model ? fitAmplitudesToMoments(magBuild, seed.model).values : {});
        const init: Record<string, number> = {};
        for (const p of magBuild.params) init[p.id] = values[p.id] ?? p.value;
        setAmps(init);
        return;
      }
    }
    // Re-seed the amplitudes for the new parameter set, but keep the user's
    // value for any parameter that survives the rebuild (e.g. toggling a flip
    // or the |M| tie keeps the shared amplitude ids — the edited or refined
    // magnitudes must not silently reset to the seed).
    setAmps((prev) => {
      const init: Record<string, number> = {};
      for (const p of magBuild.params) init[p.id] = prev[p.id] ?? p.value;
      return init;
    });
  }, [magBuild]);

  // Open ON a model: k, ions and framework first; the matching candidate once
  // the candidate list for that k exists (it is a memo of k); its amplitudes
  // through the pending seed above once the build for it exists.
  const pendingPreselect = useRef<MagneticModel | null>(null);
  useEffect(() => {
    if (!preselect?.operations) return;
    const kk = preselect.propagation[0] ?? [0, 0, 0];
    const carrying = new Set(
      preselect.moments
        .filter((m) => m.components.some((c) => c !== 0) || (m.sinComponents?.some((c) => c !== 0) ?? false))
        .map((m) => m.siteLabel),
    );
    const known = new Set(ions.map((i) => i.siteLabel));
    const pick = [...carrying].filter((l) => known.has(l));
    if (pick.length > 0) setSelected(new Set(pick));
    setFramework("msg");
    applyK([kk[0]!, kk[1]!, kk[2]!]);
    pendingPreselect.current = preselect;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires when the model to open on changes
  }, [preselect]);
  useEffect(() => {
    const model = pendingPreselect.current;
    if (!model?.operations) return;
    const kk = model.propagation[0] ?? [0, 0, 0];
    if (![0, 1, 2].every((i) => Math.abs(k[i]! - kk[i]!) < 1e-9)) return; // the list is for another k yet
    const sig = magOpsSignature(model.operations);
    const idx = reps.findIndex((r) => magOpsSignature(r.candidate.operations) === sig);
    pendingPreselect.current = null;
    if (idx < 0) return; // not a candidate of this lattice (e.g. a non-standard setting) — leave the page open
    pendingSeed.current = { sig, model };
    setSelIdx(idx);
    setOpenIndices((s) => new Set([...s, reps[idx]!.index]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reps, k[0], k[1], k[2]]);

  // The candidate magnetic model with the current amplitudes applied — feeds
  // both the 3D moment arrows and the allowed-reflection tick row.
  const appliedMagnetic = useMemo(
    () => (magBuild ? applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps) : null),
    [magBuild, amps],
  );

  // Moment entries for the 3D view (one per site — or per split orbit when the
  // magnetic group splits a site's crystallographic orbit), with amps applied.
  const momentEntries = useMemo(
    () => (appliedMagnetic ? momentEntriesFrom(appliedMagnetic) : undefined),
    [appliedMagnetic],
  );

  // The 3D card's own download. This view is where the moments live, so it
  // writes mCIF as soon as a group is previewed: the refined nuclear structure
  // plus the magnetic symmetry and the moment loop at the current amplitudes
  // (`appliedMagnetic` — the very model drawn as arrows, so file and picture
  // agree). Before a group is picked there are no moments and it is plain CIF.
  // No `magneticLabel`: the BNS symbol is assembled inside the report export,
  // so the writer falls back to naming the parent group, as the header mCIF does.
  const viewerCifExport = useMemo<StructureExport>(() => {
    const mag = appliedMagnetic && appliedMagnetic.moments.length > 0 ? appliedMagnetic : null;
    return {
      label: mag ? "mCIF" : "CIF",
      title: mag
        ? `Download ${structure.name || structure.id} as mCIF — refined cell and sites plus the magnetic moment loop at the current amplitudes`
        : "Download the refined nuclear structure as CIF — pick a magnetic group to include the moments",
      run: () => {
        if (mag) {
          downloadText(`${structure.id}.mcif`, magneticStructureToMcif(structure, mag), "chemical/x-cif");
        } else {
          downloadText(`${structure.id}.cif`, structureToCif(structure), "chemical/x-cif");
        }
      },
    };
  }, [appliedMagnetic, structure]);

  // Tick rows for the pattern preview: every crystallographic phase (from the
  // refinement page, so impurity peaks index correctly), then where this k CAN
  // put magnetic intensity (satellite positions G ± k), where the selected
  // group actually DOES (|F_M|² > 0 with the current amplitudes), and where
  // the nuclear fit leaves unexplained intensity — the visual test of the k
  // and group choices.
  const previewTicks = useMemo<PhaseTicks[]>(() => {
    if (!patternView) return [];
    const { dRange, dToX } = patternView;
    const rows: PhaseTicks[] = [
      ...patternView.nuclearTicks,
      satellitePositionTicks(structure, k, dRange.min, dRange.max, dToX, {
        id: "k-positions",
        label: "G ± k",
        color: theme.faint,
      }),
    ];
    if (appliedMagnetic) {
      rows.push(
        magneticPhaseTicks(structure, appliedMagnetic, dRange.min, dRange.max, dToX, {
          id: "allowed",
          label: "allowed",
          color: MAGNETIC_COLOR,
        }),
      );
    }
    if (peakRows.length > 0) {
      // One numbered tick per DETECTED peak (included or not — the table's
      // checkboxes carry the distinction), so every table row has its marker
      // in the pattern and clicking a row can spotlight it.
      const ticks = peakRows
        .filter((p) => p.d >= dRange.min && p.d <= dRange.max)
        .map((p) => ({ x: dToX(p.d), hkl: `#${p.idx}`, d: p.d }))
        .filter((t) => Number.isFinite(t.x));
      rows.push({ id: "residual", label: "residual", color: theme.obs, kind: "magnetic", ticks });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternView, structure, k[0], k[1], k[2], appliedMagnetic, peakRows]);

  // Tick-click spotlight in the pattern preview (same interaction as the
  // refinement plot, local to this page). Peak-table rows spotlight their
  // numbered residual tick and zoom onto it via the local focus token.
  const [patternPick, setPatternPick] = useState<{ hkl: string; kind: "nuclear" | "magnetic"; phaseId?: string } | null>(null);
  const [peakFocusToken, setPeakFocusToken] = useState(0);
  // Armed "add a peak" mode: the next plain click on the pattern places a
  // manual residual peak at the clicked position (single-shot).
  const [addingPeak, setAddingPeak] = useState(false);
  const canAddPeak = !!(onAddManualPeak && patternView?.xToD);
  // A genuinely different peak set invalidates stale curation: overrides whose
  // peak vanished are pruned (surviving keys keep their checkbox state — adding
  // a manual peak must not reset the rest), and any residual-peak spotlight is
  // dropped (the #n numbering is positional, so a stale pick would silently
  // mark a different peak). Functional no-op updates so an unchanged state
  // doesn't schedule renders.
  useEffect(() => {
    setPeakOverrides((o) => {
      const keys = Object.keys(o);
      if (keys.length === 0) return o;
      const valid = new Set(residualPeaks.map((p) => p.d.toFixed(5)));
      const kept = keys.filter((kk) => valid.has(kk));
      if (kept.length === keys.length) return o;
      return Object.fromEntries(kept.map((kk) => [kk, o[kk]!]));
    });
    setPatternPick((p) => (p?.phaseId === "residual" ? null : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature IS the content key
  }, [peakSignature]);
  function spotlightPeak(idx: number): void {
    const hkl = `#${idx}`;
    if (patternPick?.hkl === hkl && patternPick.phaseId === "residual") {
      setPatternPick(null);
      return;
    }
    setPatternPick({ hkl, kind: "magnetic", phaseId: "residual" });
    setPeakFocusToken((t) => t + 1);
  }

  // Optional moment refinement against the loaded pattern: nuclear model held
  // fixed (the handoff convention), moment-mode amplitudes freed, shared scale.
  const [refining, setRefining] = useState(false);
  const [refineWR, setRefineWR] = useState<number | null>(null);
  // The readout describes a fit against a specific window/pattern — a changed
  // fit range (draggable from this page's own plot) or new data invalidates it.
  useEffect(() => {
    setRefineWR(null);
  }, [fitRange?.min, fitRange?.max, pattern]);
  const canPowderRefine = !!(pattern && nuclearParams && nuclearBindings && profile);
  const canRefine = !!(magBuild && magBuild.params.length > 0 && (magneticFit || canPowderRefine));
  const agreementLabel = magneticFit?.agreementLabel ?? "wR";

  // What this page shows right now, for the header's report (Export ▾ →
  // Report): the selected candidate, its label, and the moments-only fit.
  const reportGroup = useMemo<ReportGroup>(() => {
    if (framework === "msg" && selIdx != null && reps[selIdx]) {
      const r = reps[selIdx]!;
      const lbl = latticeLabel(r);
      return {
        symbol: lbl.symbol,
        ...(lbl.numbers ? { numbers: lbl.numbers } : {}),
        ...(lbl.setting ? { setting: lbl.setting } : {}),
        index: r.index,
      };
    }
    if (framework === "irrep" && combo && !("failure" in combo)) {
      const identity = combo.standard ?? combo.settingMatch?.identity ?? null;
      return {
        symbol: identity
          ? formatMagneticSymbol(identity.bnsSymbol)
          : `isotropy subgroup of ${[...chosenIrreps].sort().join(" ⊕ ")}`,
        ...(identity ? { numbers: `BNS ${identity.bnsNumber} · OG ${identity.ogNumber}` } : {}),
        ...(combo.settingMatch ? { setting: combo.settingMatch.transformation } : {}),
      };
    }
    return { symbol: "magnetic subgroup" };
  }, [framework, selIdx, reps, combo, chosenIrreps]);
  useEffect(() => {
    if (!onReportModel) return;
    if (!magBuild) {
      onReportModel(null);
      return;
    }
    onReportModel({
      magnetic: applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps),
      params: magBuild.params.map((p) => ({ ...p, value: amps[p.id] ?? p.value })),
      bindings: magBuild.bindings,
      k,
      group: reportGroup,
      agreement: refineWR,
      agreementLabel,
    });
  }, [onReportModel, magBuild, amps, k, reportGroup, refineWR, agreementLabel]);
  // Unmount (or a page switch that remounts the panel) withdraws the candidate.
  useEffect(() => () => onReportModel?.(null), [onReportModel]);

  /**
   * Fit a build's moment amplitudes against the data with the nuclear model
   * held fixed. The injected backend (powder / single crystal / PDF pages all
   * provide one, off the main thread) does the work; the in-thread powder
   * solve remains as the fallback for a page that supplies data but no backend.
   * Starting values default to the build's seeds.
   */
  const fitMoments = useCallback(
    async (build: MagneticModelBuild, start?: Record<string, number>): Promise<{ values: Record<string, number>; agreement: number | null }> => {
      const moments = build.params.map((p) => {
        const v = start?.[p.id] ?? p.value;
        return { ...p, value: v, initialValue: v, fixed: false };
      });
      if (magneticFit) return magneticFit.refine(build.magnetic, moments, build.bindings);
      if (!(pattern && nuclearParams && nuclearBindings && profile)) throw new Error("no data to fit the moments against");
      await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
      const nuclearFixed = nuclearParams.filter((p) => !isMomentParameterKind(p.kind)).map((p) => ({ ...p, fixed: true }));
      const bindings = [...nuclearBindings.filter((b) => !isMomentParameterKind(b.kind)), ...build.bindings];
      const problem = buildMagneticPowderProblem(fitStructure ?? structure, build.magnetic, pattern, [...nuclearFixed, ...moments], bindings, {
        shape: profile.shape,
        ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
      }, fitRange, extraPhases);
      const result = refine(problem, { maxIterations: 20 });
      const values: Record<string, number> = {};
      for (const p of build.params) values[p.id] = result.parameters[p.id] ?? p.value;
      return { values, agreement: result.agreement.rWeighted ?? null };
    },
    [magneticFit, pattern, nuclearParams, nuclearBindings, profile, fitStructure, structure, fitRange, extraPhases],
  );
  const canFit = !!magneticFit || canPowderRefine;

  // ── Rank the candidates against the data ─────────────────────────────────
  // Every moment-allowing candidate is fitted the same way "Refine moments"
  // fits the selected one, and the rows then carry (and sort by) the result —
  // instead of clicking candidates one at a time and remembering numbers.
  const [rank, setRank] = useState<{ running: boolean; done: number; total: number; results: Record<string, RankEntry> }>({
    running: false, done: 0, total: 0, results: {},
  });
  const rankCancel = useRef(false);
  // Anything that changes what a fit means (k, ions, tie options, structure,
  // data, fit window) invalidates the table — and stops a run in progress.
  useEffect(() => {
    rankCancel.current = true;
    setRank((r) => (r.total === 0 && !r.running ? r : { running: false, done: 0, total: 0, results: {} }));
  }, [buildFor, pattern, fitRange?.min, fitRange?.max]);
  /** Agreement ties within this much (absolute fraction, 0.01 %) are the same fit. */
  const RANK_TIE = 1e-4;
  // The ★: lowest wR — and among candidates tied with it, the MAXIMAL subgroup
  // (lowest index) with the fewest moment parameters. Ties are the rule, not the
  // exception: a powder cannot tell several symmetry-distinct models apart
  // (direction ambiguity), and the top-down Landau prescription breaks them.
  const bestRanked = useMemo<{ id: string; wR: number } | null>(() => {
    const ok = Object.entries(rank.results).filter(([, e]) => e.status === "ok" && e.wR != null);
    if (ok.length === 0) return null;
    const bw = Math.min(...ok.map(([, e]) => e.wR!));
    const meta = new Map(reps.map((r, i) => [r.candidate.id, { index: r.index, dof: repMomentDims[i] ?? 0 }]));
    const tied = ok.filter(([, e]) => e.wR! <= bw + RANK_TIE).map(([id]) => id);
    tied.sort((a, b) => (meta.get(a)?.index ?? 99) - (meta.get(b)?.index ?? 99) || (meta.get(a)?.dof ?? 99) - (meta.get(b)?.dof ?? 99));
    const id = tied[0]!;
    return { id, wR: rank.results[id]!.wR! };
  }, [rank.results, reps, repMomentDims]);
  const bestRankedId = bestRanked?.id ?? null;
  async function rankCandidates(scope: "open" | "all"): Promise<void> {
    const list = reps
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => (repMomentDims[i] ?? 0) > 0 && (scope === "all" || openIndices.has(r.index)));
    if (list.length === 0 || !canFit) return;
    rankCancel.current = false;
    setRank({ running: true, done: 0, total: list.length, results: {} });
    const results: Record<string, RankEntry> = {};
    for (const { r } of list) {
      if (rankCancel.current) break;
      const id = r.candidate.id;
      try {
        const build = buildFor(r.candidate.operations);
        if (build.params.length === 0) {
          results[id] = { status: "forbidden", wR: null, values: {}, magnitudes: [] };
        } else {
          const { values, agreement } = await fitMoments(build);
          const applied = applyMagneticMoments(build.magnetic, build.bindings, values);
          const magnitudes = applied.moments.map((m) => ({
            label: `${m.siteLabel}${m.orbitIndex !== undefined && m.orbitIndex > 1 ? `#${m.orbitIndex}` : ""}`,
            value: Math.hypot(...momentCartesian(structure.cell, m)),
          }));
          results[id] = { status: "ok", wR: agreement, values, magnitudes };
        }
      } catch {
        results[id] = { status: "failed", wR: null, values: {}, magnitudes: [] };
      }
      if (rankCancel.current) break;
      setRank((s) => ({ ...s, done: s.done + 1, results: { ...results } }));
    }
    setRank((s) => ({ ...s, running: false }));
  }

  async function runRefine(): Promise<void> {
    if (!canRefine || !magBuild) return;
    setRefining(true);
    setRefineWR(null);
    try {
      const { values, agreement } = await fitMoments(magBuild, amps);
      setAmps((a) => {
        const next: Record<string, number> = { ...a };
        for (const p of magBuild.params) next[p.id] = values[p.id] ?? next[p.id]!;
        return next;
      });
      setRefineWR(agreement);
    } finally {
      setRefining(false);
    }
  }

  /** Search candidate k-vectors from the INCLUDED residual peaks, weighted by
   *  significance (capped so one very strong peak doesn't drown the rest).
   *  maxQ is disabled: the curated checkbox list is now the authoritative
   *  criterion — a hidden low-Q cut would silently drop peaks the user ticked
   *  and desynchronize the matched counts from the "N used" chip. */
  function runKSearch(): void {
    const weights = hasSignificance ? includedPeaks.map((p) => Math.min(p.significance ?? 1, 20)) : undefined;
    setResults(searchPropagationVector(structure.cell, includedPeaks.map((p) => p.d), {
      tolerance: 0.02,
      maxQ: 0,
      ...(weights ? { weights } : {}),
    }));
  }

  function toggleIon(label: string): void {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }

  /** Confirm a k: sync the inputs, apply it, and drop the previous k's group pick. */
  const applyK = (kk: Vec3): void => {
    setKText([String(kk[0]), String(kk[1]), String(kk[2])]);
    setAppliedK([kk[0], kk[1], kk[2]]);
    setSelIdx(null);
    setChosenIrreps(new Set());
    setOpenIndices(new Set([2]));
  };

  // The candidate drawn ON the pattern: the nuclear fit plus this model's
  // magnetic contribution at the current amplitudes, the magnetic part also as
  // its own overlay — so a click on a candidate shows where its intensity goes.
  const previewMagnetic = useMemo(
    () => (patternView?.magneticComponent && appliedMagnetic && appliedMagnetic.moments.length > 0 ? patternView.magneticComponent(appliedMagnetic) : null),
    [patternView, appliedMagnetic],
  );
  const previewCurves = useMemo<PowderCurves | null>(() => {
    if (!patternView) return null;
    const base = patternView.curves;
    if (!previewMagnetic || previewMagnetic.length !== base.yCalc.length) return base;
    const yCalc = base.yCalc.map((v, i) => v + (previewMagnetic[i] ?? 0));
    return { ...base, yCalc, diff: base.yObs.map((o, i) => o - yCalc[i]!) };
  }, [patternView, previewMagnetic]);
  const kIsZero = k.every((c) => Math.abs(c) < 1e-12);
  const nearNuclearCount = peakRows.filter((r) => r.nearNuclear).length;
  const allOnNuclear = peakRows.length > 0 && nearNuclearCount === peakRows.length;

  return (
    <div className="wb-mag2">
      {/* Left rail: in powder mode the refined pattern first — the judging
          tool while clicking candidate groups on the right — then the 3D model
          (magnetic (super)cell; arrows once a group is selected), which fills
          the rest of the row. The row fills the window and the steps card on
          the right scrolls inside itself, so this rail stays in view without
          being sticky (layout rule, workbench.css). */}
      <div className="wb-mag2-left">
      {/* Pattern check: is the k / magnetic-space-group choice consistent
          with where the unexplained intensity actually sits? The same view as
          the refinement plot (refined curves, fit range, unit toggle), plus
          the satellite / allowed / residual tick rows. */}
      {patternView && (
        <section style={{ ...themeCard, padding: space.inset, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={themeLabel}>Powder pattern</span>
            <InfoBadge
              width={300}
              text={
                <>
                  The refinement plot, plus the magnetic tick rows. Per-phase Bragg rows index each
                  phase (impurities included) against its own cell; <b>G ± k</b> marks every position
                  the current k allows; <b>allowed</b> marks the reflections the selected magnetic
                  group keeps (|F<sub>M</sub>|² &gt; 0 with the current moments); <b>residual</b> marks
                  peaks the nuclear fit leaves unexplained. A plausible k puts a G ± k tick under every
                  residual peak; a plausible group keeps those peaks in the allowed row. Drag to zoom,
                  blue handles set the fit range, click a tick for its indices.
                </>
              }
            />
            {patternQuality}
            {patternFitChip && (
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: themeMono, fontSize: 12, color: theme.secondary }}
                title="The data range used for refinement (set with the blue handles)"
              >
                fit {patternFitChip.label}
                <button style={resetRangeBtn} onClick={patternFitChip.onReset} title="Refine over the full pattern again">
                  Reset range
                </button>
              </span>
            )}
            {addingPeak && (
              <span style={{ fontSize: 12, color: theme.noteInk, fontWeight: 600 }}>
                click the pattern to place the peak…
              </span>
            )}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, rowGap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {onFocusFit && (
                <button
                  style={{ ...toolbarBtn, display: "inline-flex", alignItems: "center", gap: 5, ...(patternFitChip ? {} : { opacity: 0.45, cursor: "default" }) }}
                  disabled={!patternFitChip}
                  title={patternFitChip
                    ? "Zoom the plot onto the active fit range"
                    : "Set a fit range first (blue handles), then this zooms the view onto it"}
                  onClick={onFocusFit}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  optimize view
                </button>
              )}
              {patternView.unitToggle}
            </div>
          </div>
          <div style={{ height: space.plotHeightSm, display: "flex", flexDirection: "column" }}>
            <WorkbenchPlot
              curves={previewCurves ?? patternView.curves}
              xLabel={patternView.xLabel}
              phases={previewTicks}
              {...(previewMagnetic ? { overlays: [{ label: "magnetic", y: previewMagnetic }] } : {})}
              highlight={patternPick}
              onHighlight={setPatternPick}
              focusFitToken={focusFitToken}
              focusPeakToken={peakFocusToken}
              {...(addingPeak && canAddPeak
                ? {
                    onPlotClick: (x: number) => {
                      const d = patternView.xToD!(x);
                      if (Number.isFinite(d) && d > 0) {
                        // A click on (or next to) an already-listed peak means
                        // "use that one": include it instead of minting a
                        // duplicate manual entry the merge would swallow.
                        const near = peakRows.find((r) => Math.abs(r.d - d) < 0.01);
                        if (near) setPeakOverrides((o) => ({ ...o, [near.key]: true }));
                        else onAddManualPeak!(d);
                      }
                      setAddingPeak(false);
                    },
                  }
                : {})}
              {...(patternView.fitRange ? { fitRange: patternView.fitRange } : {})}
              {...(patternView.onFitRangeChange ? { onFitRangeChange: patternView.onFitRangeChange } : {})}
            />
          </div>
        </section>
      )}

      <section className="wb-mag2-model" style={{ ...themeCard, padding: space.inset, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={themeLabel}>3D model — {magBuild ? "moment preview" : "refined structure"}</span>
          <InfoBadge
            width={280}
            text={magBuild
              ? "The magnetic unit cell with the selected group's symmetry-allowed moments (red arrows) — atoms without an arrow are moment-forbidden under this group. Directions and relative sizes are well defined; the absolute arrow length carries a display convention. Drag to rotate, scroll to zoom."
              : "The refined nuclear structure over the magnetic (super)cell of the current k. Pick a magnetic space group in step 4 to preview its symmetry-allowed moments here. Drag to rotate, scroll to zoom."}
          />
          <span style={{ marginLeft: "auto", color: theme.secondary, fontFamily: themeMono, fontSize: 12 }}>k = {kLabel(k)}</span>
        </div>
        <Suspense fallback={<div style={{ flex: 1, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>Loading 3D model…</div>}>
          <StructureView
            structure={structure}
            propagation={k}
            {...(magBuild ? { magneticOperations: magBuild.magnetic.operations ?? [] } : {})}
            {...(momentEntries ? { moments: momentEntries } : {})}
            {...(standardCell ? { standardCell } : {})}
            minCanvasHeight={240}
            exports={[viewerCifExport]}
          />
        </Suspense>
      </section>
      </div>

      {/* Right panel: the workflow controls (steps 1–5). Stretched to the row's
          height; its content scrolls inside the card, not the page. */}
      <div className="wb-mag2-steps" style={{ ...themeCard, padding: space.inset, display: "grid", gap: 14, alignContent: "start", minWidth: 0 }}>
      {/* 1. Which sites carry a moment */}
      <section>
        <StepTitle
          n="1"
          title="Magnetic ions"
          info="Tick the site(s) that carry an ordered moment. Candidates are the sites with a tabulated ⟨j0⟩ magnetic form factor; everything below runs on the refined structure from the refinement page."
        />
        {ions.length === 0 ? (
          <p style={help}>No magnetic ions in this structure (no site has a tabulated ⟨j0⟩ form factor).</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {ions.map((ion) => {
              const active = selected.has(ion.siteLabel);
              return (
                <button
                  key={ion.siteLabel}
                  onClick={() => toggleIon(ion.siteLabel)}
                  style={ionChip(active)}
                  title={active ? "Selected — click to exclude this site" : "Click to include this site"}
                >
                  {ion.siteLabel}
                  <span style={{ opacity: 0.72, fontFamily: themeMono, fontSize: 11 }}>{ion.ionId}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. k-vector: typed directly or searched from the residual peaks. The
          model is single-k, so there is exactly ONE active k — "Set k" replaces
          it (no add/remove list), and search rows apply on click. */}
      <section style={sectionDivider}>
        <StepTitle
          n="2"
          title="Propagation vector k"
          info={
            <>
              One k describes the ordering (single-k model), so setting a new k replaces the current
              one. Components accept exact fractions — 1/2, 1/3, −1/3 — or decimals (an irrational
              value is an incommensurate k: no finite magnetic cell, refined through Fourier cos/sin
              amplitudes); exact fractions matter, since 0.333 misses the little-group tolerance where
              1/3 is meant. Type and press Enter (or Set k), pick a search result below, or leave
              k = (0, 0, 0) for an ordering with the nuclear cell.
            </>
          }
          right={
            <span style={kChip} title={`The active propagation vector — steps 3–5 use it. ${describePropagation(kClass)}`}>
              k = {kLabel(k)}{kClass.kind === "incommensurate" ? " · incommensurate" : kClass.twoArms ? " · two arms ±k" : ""}
            </span>
          }
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontFamily: themeMono, fontSize: 13, color: theme.secondary }}>k = (</span>
          {[0, 1, 2].map((i) => (
            <input
              key={i}
              value={kText[i]}
              onChange={(e) => setKText((t) => { const n = [...t] as [string, string, string]; n[i] = e.target.value; return n; })}
              onKeyDown={(e) => { if (e.key === "Enter" && draftPending) applyK(draftK); }}
              placeholder={["0", "1/2", "1/3"][i]}
              style={kInput}
              aria-label={`k${["x", "y", "z"][i]}`}
            />
          ))}
          <span style={{ fontFamily: themeMono, fontSize: 13, color: theme.secondary }}>)</span>
          <button
            style={{ ...btn, marginTop: 0, opacity: draftPending ? 1 : 0.45 }}
            onClick={() => applyK(draftK)}
            disabled={!draftPending}
            title="Use this propagation vector — the symmetry analysis below re-runs on it"
          >
            Set k
          </button>
          {draftPending && (
            <span style={{ fontSize: 12, color: theme.noteInk }}>edited — press Enter or Set k</span>
          )}
        </div>
        {/* Detected residual peaks: the quantitative input to the k-search.
            Each row has a numbered tick (#n) in the pattern preview; criteria
            (and per-peak checkboxes) decide what feeds the search. */}
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span style={themeLabel}>Detected residual peaks</span>
            <InfoBadge
              width={310}
              text={
                <>
                  Peaks in the nuclear-fit residual (obs − calc): local maxima above the noise floor
                  and — when the data carries σ — at least 3σ significant. The criteria below choose
                  which detections feed the k-search: the I/σ threshold, and whether apexes sitting on
                  a nuclear reflection participate (those are usually profile misfit, e.g. an impurity
                  shoulder — though k = 0 orderings do put intensity there). Each peak is marked #n in
                  the pattern; click a row to zoom to it. <b>Δd→k</b> is the distance to the nearest
                  satellite G ± k of the current k — ≤ 20 mÅ counts as explained.
                </>
              }
            />
            {peakRows.length > 0 && (
              <span style={kChip} title="Peaks feeding the k-search / all detected. Peaks on nuclear positions stay out of a k ≠ 0 search unless included below — they are what k = 0 ordering looks like.">
                {includedPeaks.length}/{peakRows.length} in k-search{nearNuclearCount > 0 ? ` · ${nearNuclearCount} on nuclear positions` : ""}
              </span>
            )}
          </div>
          {peakRows.length === 0 ? (
            <>
              <p style={help}>
                No unexplained peaks in the residual. Refine the nuclear structure first (the residual
                then isolates magnetic intensity), type k directly above — or add a peak by hand below.
              </p>
              {canAddPeak && (
                <div style={{ marginTop: 7 }}>
                  <AddPeakButton adding={addingPeak} onToggle={() => setAddingPeak((v) => !v)} />
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14, rowGap: 5, marginTop: 7, flexWrap: "wrap", fontSize: 12, color: theme.secondary }}>
                {hasSignificance && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title="Keep peaks at least this many σ above the counting noise (3–30; commit with Enter or by leaving the field)">
                    I/σ ≥
                    <input
                      type="number"
                      min={3}
                      max={30}
                      step={0.5}
                      value={minSigText}
                      onChange={(e) => setMinSigText(e.target.value)}
                      onBlur={commitMinSig}
                      onKeyDown={(e) => { if (e.key === "Enter") commitMinSig(); }}
                      style={{ ...kInput, width: 52 }}
                    />
                  </label>
                )}
                <label
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}
                  title="A residual apex on a nuclear reflection is usually profile misfit, not magnetic — include them only for k = 0 candidates"
                >
                  <input
                    type="checkbox"
                    checked={allowNearNuclear}
                    onChange={(e) => { setAllowNearNuclear(e.target.checked); setPeakOverrides({}); }}
                  />
                  include peaks at nuclear positions
                </label>
              </div>
              <table style={{ fontSize: 12.5, borderCollapse: "collapse", width: "100%", marginTop: 6 }}>
                <thead>
                  <tr style={{ color: theme.secondary, textAlign: "left" }}>
                    <th style={{ ...th, width: 26 }} title="Include this peak in the k-search">use</th>
                    <th style={th} title="Tick label in the pattern preview">#</th>
                    <th style={th}>d (Å)</th>
                    {hasSignificance && <th style={th} title="Residual height over the counting σ at the apex">I/σ</th>}
                    <th style={th} title="Distance to the nearest satellite G ± k of the current k (≤ 20 mÅ = explained)">Δd→k (mÅ)</th>
                    <th style={th} title="Nuclear reflection within 1% in d — likely profile misfit, not a magnetic peak">near</th>
                    <th style={{ ...th, width: 20 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {peakRows.map((row, i) => {
                    const delta = kDeltas[i];
                    const explained = delta !== undefined && Number.isFinite(delta) && delta <= 0.02;
                    const picked = patternPick?.hkl === `#${row.idx}` && patternPick.phaseId === "residual";
                    return (
                      <tr
                        key={row.key}
                        onClick={() => spotlightPeak(row.idx)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); spotlightPeak(row.idx); } }}
                        tabIndex={0}
                        style={{
                          borderTop: `1px solid ${theme.border}`,
                          cursor: "pointer",
                          opacity: row.included ? 1 : 0.55,
                          background: picked ? theme.primaryTintBg : undefined,
                        }}
                        title="Show this peak in the pattern"
                      >
                        <td style={td} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={row.included}
                            onChange={() => setPeakOverrides((o) => ({ ...o, [row.key]: !row.included }))}
                            title={row.included ? "Exclude from the k-search" : "Include in the k-search"}
                          />
                        </td>
                        <td style={{ ...td, fontFamily: themeMono, color: theme.obs, fontWeight: 600 }}>#{row.idx}</td>
                        <td style={{ ...td, fontFamily: themeMono }}>{row.d.toFixed(4)}</td>
                        {hasSignificance && <td style={{ ...td, fontFamily: themeMono }}>{row.significance?.toFixed(1) ?? "—"}</td>}
                        <td style={{ ...td, fontFamily: themeMono, color: explained ? theme.okInk : theme.warnInk }}>
                          {delta !== undefined && Number.isFinite(delta) ? `${explained ? "✓ " : ""}${(delta * 1000).toFixed(0)}` : "—"}
                        </td>
                        <td style={{ ...td, fontSize: 11.5, color: theme.secondary }}>
                          {row.manual && (
                            <span style={manualChip} title="Manually added (click × to remove)">manual</span>
                          )}
                          {row.nearNuclear
                            ? <span title={`Within ${(100 * row.nearNuclear.relDelta).toFixed(2)}% of ${row.nearNuclear.phaseLabel} (${row.nearNuclear.hkl}), d = ${row.nearNuclear.d.toFixed(4)} Å`}>
                                {row.nearNuclear.phaseLabel} ({row.nearNuclear.hkl})
                              </span>
                            : ""}
                        </td>
                        <td style={{ ...td, padding: "4px 0" }} onClick={(e) => e.stopPropagation()}>
                          {row.manual && onRemoveManualPeak && (
                            <button
                              style={removePeakBtn}
                              onClick={() => onRemoveManualPeak(row.d)}
                              title="Remove this manually added peak"
                            >
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {allOnNuclear && !allowNearNuclear && (
                <div style={kZeroNote}>
                  <b>Every residual peak sits on a nuclear reflection.</b> That is what a <b>k = 0</b> ordering
                  looks like — magnetic intensity adds onto the nuclear peaks — or profile misfit; a k ≠ 0
                  search has nothing to work with here.{" "}
                  {kIsZero
                    ? <>k = (0 0 0) is set: pick a group in step 4, or rank the candidates there against the data.</>
                    : <>Set k = (0 0 0) and rank the candidates in step 4.</>}
                  <span style={{ display: "inline-flex", gap: 8, marginLeft: 10, verticalAlign: "middle" }}>
                    {!kIsZero && (
                      <button style={ghostBtn} onClick={() => applyK([0, 0, 0])} title="Use k = 0 — the ordering keeps the nuclear cell">
                        Use k = 0
                      </button>
                    )}
                    <button
                      style={ghostBtn}
                      onClick={() => { setAllowNearNuclear(true); setPeakOverrides({}); }}
                      title="Feed the peaks at nuclear positions to the k-search anyway (they will favour k = 0 and its harmonics)"
                    >
                      Include them in the k-search
                    </button>
                  </span>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
                <button
                  style={{ ...ghostBtn, opacity: includedPeaks.length === 0 ? 0.5 : 1 }}
                  onClick={runKSearch}
                  disabled={includedPeaks.length === 0}
                  title={includedPeaks.length === 0
                    ? "No peaks pass the criteria — lower the I/σ threshold or tick peaks manually"
                    : "Score candidate propagation vectors by how well their satellites G ± k reproduce the included peaks (FullProf-style position matching, significance-weighted)"}
                >
                  Search k from {includedPeaks.length} peak{includedPeaks.length === 1 ? "" : "s"}
                </button>
                {canAddPeak && <AddPeakButton adding={addingPeak} onToggle={() => setAddingPeak((v) => !v)} />}
              </div>
            </>
          )}
        </div>
        {results && (
          <div style={{ marginTop: 8 }}>
            {results.length === 0 ? (
              <p style={help}>No candidate k reproduces the detected peaks — check the nuclear fit, or set k directly above.</p>
            ) : (
              <table style={{ fontSize: 12.5, borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ color: theme.secondary, textAlign: "left" }}>
                    <th style={{ ...th, width: 22 }}></th><th style={th}>k</th><th style={th}>matched</th>
                    <th style={th} title="Which peaks of the table above this candidate explains (hover for each Δd)">explains</th>
                    <th style={th}>RMSD (Å)</th>
                  </tr>
                </thead>
                <tbody role="radiogroup" aria-label="Candidate propagation vectors">
                  {results.slice(0, 8).map((c) => {
                    const active = c.k.every((v, i) => Math.abs(v - k[i]!) < 1e-9);
                    // matches index into the searched list = includedPeaks at
                    // search time; results are invalidated when that set
                    // changes, so the mapping stays valid (guarded regardless).
                    const explained = c.matches
                      .map((m) => ({ row: includedPeaks[m.index], delta: m.delta }))
                      .filter((e): e is { row: (typeof includedPeaks)[number]; delta: number } => e.row !== undefined);
                    return (
                      <tr
                        key={c.label}
                        onClick={() => applyK(c.k)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); applyK(c.k); } }}
                        role="radio"
                        aria-checked={active}
                        tabIndex={0}
                        style={{ borderTop: `1px solid ${theme.border}`, cursor: "pointer", background: active ? theme.primaryTintBg : undefined }}
                        title="Use this propagation vector"
                      >
                        <td style={td}><span style={radioDot(active)} /></td>
                        <td style={{ ...td, fontFamily: themeMono, ...(active ? { color: theme.primary, fontWeight: 600 } : {}) }}>{c.label}</td>
                        <td style={td}>{c.matched}/{c.total}</td>
                        <td
                          style={{ ...td, fontFamily: themeMono, fontSize: 11.5, color: theme.obs }}
                          title={explained.map((e) => `#${e.row.idx}: Δd ${(e.delta * 1000).toFixed(0)} mÅ`).join(" · ") || undefined}
                        >
                          {explained.map((e) => `#${e.row.idx}`).join(" ") || "—"}
                        </td>
                        <td style={td}>{Number.isFinite(c.rmsd) ? c.rmsd.toFixed(4) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* 3. Choose the symmetry framework */}
      <section style={sectionDivider}>
        <StepTitle
          n="3"
          title="Symmetry framework"
          info={
            <>
              Two equivalent languages for the ordering the little group G(k) allows — both converge
              on a magnetic space group in step 4. <b>Magnetic space groups</b> (Shubnikov,
              k-SUBGROUPSMAG style): enumerate every subgroup H ≤ G(k) with every time-reversal
              assignment θ, grouped by index, one representative per conjugacy class.{" "}
              <b>Representation analysis</b> (SARAh / BasIreps style): decompose Γ<sub>mag</sub> into
              irreps of G(k) and pick any combination — its magnetic space group is the isotropy
              subgroup (exact stabilizer) of the mixed order parameter.
            </>
          }
          right={
            <span style={kChip} title={`Little group of k: ${lgSize} of the ${structure.spaceGroup.operations.length} parent operations leave k invariant`}>
              G(k): {lgSize}/{structure.spaceGroup.operations.length} ops
            </span>
          }
        />
        <div style={{ display: "inline-flex", gap: 2, background: theme.chipBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 2 }}>
          {FRAMEWORKS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFramework(f.id)}
              style={{
                border: "none", borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: themeMono,
                background: framework === f.id ? theme.primary : "transparent",
                color: framework === f.id ? "#fff" : theme.secondary,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </section>

      {/* 4. Magnetic space group — picked directly, or through an irrep */}
      <section style={sectionDivider}>
        <StepTitle
          n="4"
          title="Magnetic space group"
          info={framework === "msg"
            ? (
              <>
                Every candidate subgroup class (each H ≤ G(k) with each time-reversal assignment θ),
                grouped by index in the grey group and sorted by BNS number. Work top-down: the
                physical symmetry is usually a <b>maximal</b> (index-2) subgroup — descend only when
                no maximal candidate fits. The badge on each row is the moment degrees of freedom the
                group allows on your selected site(s); click a candidate to preview it in step 5.
              </>
            )
            : (
              <>
                Tick one irrep (the Landau single-irrep prescription) or any combination (SARAh-style
                mixing) — the resulting magnetic space group is the isotropy subgroup of the mixed
                order parameter, computed as the exact stabilizer of a generic combination and named
                from the standard BNS/OG table.
              </>
            )}
          {...(framework === "msg" && reps.length > 0
            ? { right: <span style={kChip}>{reps.length} class{reps.length === 1 ? "" : "es"}</span> }
            : {})}
        />
        {framework === "msg" ? (
          <>
            {reps.length > 0 && (() => {
              const allowing = reps.map((r, i) => ({ r, i })).filter(({ i }) => (repMomentDims[i] ?? 0) > 0);
              const inOpen = allowing.filter(({ r }) => openIndices.has(r.index));
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8, rowGap: 6, flexWrap: "wrap", margin: "2px 0 8px" }}>
                  <button
                    style={{ ...btn, marginTop: 0, opacity: canFit && !rank.running && inOpen.length > 0 ? 1 : 0.5 }}
                    disabled={!canFit || rank.running || inOpen.length === 0}
                    onClick={() => void rankCandidates("open")}
                    title={canFit
                      ? "Refine the moments of every moment-allowing candidate in the open index sections against the data (nuclear model held fixed) and sort the rows by agreement"
                      : "Load a dataset to rank candidates against it"}
                  >
                    {rank.running ? `Ranking ${rank.done}/${rank.total}…` : `Rank ${inOpen.length} candidate${inOpen.length === 1 ? "" : "s"} against the data`}
                  </button>
                  {!rank.running && allowing.length > inOpen.length && (
                    <button style={ghostBtn} disabled={!canFit} onClick={() => void rankCandidates("all")} title="Also the collapsed index sections — every candidate that allows a moment">
                      all {allowing.length}
                    </button>
                  )}
                  {rank.running && (
                    <button style={ghostBtn} onClick={() => { rankCancel.current = true; }} title="Stop after the current candidate; finished rows stay">
                      Cancel
                    </button>
                  )}
                  {baselineAgreement != null && (
                    <span style={kChip} title="The nuclear-only fit every candidate is compared against (Δ in the rows)">
                      nuclear only · {agreementLabel} {(100 * baselineAgreement).toFixed(2)}%
                    </span>
                  )}
                  {!rank.running && rank.total > 0 && bestRanked && (
                    <span style={{ fontSize: 12, color: theme.secondary }}>rows sorted by fit · ★ best (ties go to the maximal subgroup with the fewest parameters, marked ≈) · click a row to preview it with its refined moments</span>
                  )}
                  {!rank.running && rank.total > 0 && bestRanked && baselineAgreement != null && bestRanked.wR > baselineAgreement - 5e-4 && (
                    <span style={{ ...kZeroNote, marginTop: 0, flexBasis: "100%" }}>
                      <b>No candidate improves on the nuclear-only fit</b> (best Δ{agreementLabel}{" "}
                      {(100 * (bestRanked.wR - baselineAgreement)).toFixed(2)} %). At this k the data carry no
                      magnetic signal the model can pick up — the pattern may be paramagnetic, the moments below
                      detection, or k wrong. Check the residual (step 2) before trusting any of these moments.
                    </span>
                  )}
                </div>
              );
            })()}
            {(() => {
              const all = reps.map((r, i) => ({ r, i }));
              const indices = [...new Set(all.map(({ r }) => r.index))].sort((a, b) => a - b);
              // BNS-number sort key: labeled candidates in table order, unlabeled last.
              const bnsKey = ({ r }: { r: LatticeCandidate }): number => {
                const num = r.candidate.standard?.bnsNumber ?? r.settingMatch?.identity.bnsNumber;
                if (!num) return Number.MAX_SAFE_INTEGER;
                const [a, b] = num.split(".").map(Number);
                return (a ?? 999) * 100000 + (b ?? 0);
              };
              return (
                <div style={{ margin: "6px 0 0", display: "grid", gap: 3 }}>
                  {indices.map((idx) => {
                    // Bilbao k-SUBGROUPSMAG order: BNS number ascending within
                    // the index (matches the core lattice sort). The moment DOF
                    // each group allows on your sites is shown per row, not used
                    // to reorder.
                    const group = all
                      .filter(({ r }) => r.index === idx)
                      .sort((A, B) => bnsKey(A) - bnsKey(B) || A.r.classId - B.r.classId);
                    // Ranked rows lead, best fit first; unranked keep the BNS order after them.
                    const wrOf = (c: { r: LatticeCandidate }): number => {
                      const e = rank.results[c.r.candidate.id];
                      return e?.status === "ok" && e.wR != null ? e.wR : Infinity;
                    };
                    // Ties (same fit within RANK_TIE) sort by fewest moment parameters, then BNS.
                    const ordered = rank.total > 0
                      ? [...group].sort((A, B) => {
                          const a = wrOf(A), b = wrOf(B);
                          if (a === Infinity && b === Infinity) return bnsKey(A) - bnsKey(B);
                          if (Math.abs(a - b) > RANK_TIE) return a - b;
                          return (repMomentDims[A.i] ?? 0) - (repMomentDims[B.i] ?? 0) || bnsKey(A) - bnsKey(B);
                        })
                      : group;
                    const open = openIndices.has(idx);
                    const allowing = group.filter(({ i }) => (repMomentDims[i] ?? 0) > 0).length;
                    const holdsSelection = selIdx != null && group.some(({ i }) => i === selIdx);
                    return (
                      <div key={idx} style={{ display: "grid", gap: 3 }}>
                        <button
                          onClick={() =>
                            setOpenIndices((s) => {
                              const next = new Set(s);
                              if (next.has(idx)) next.delete(idx);
                              else next.add(idx);
                              return next;
                            })
                          }
                          style={{
                            textAlign: "left", fontSize: 11.5, fontFamily: themeMono, cursor: "pointer",
                            border: "none", background: "transparent", color: theme.secondary,
                            padding: "4px 2px", marginTop: idx === indices[0] ? 0 : 4,
                            display: "flex", alignItems: "baseline", gap: 8,
                          }}
                        >
                          <span style={{ color: theme.primary }}>{open ? "▾" : "▸"}</span>
                          <span style={{ fontWeight: 700 }}>index {idx}{idx === 2 ? " — maximal" : ""}</span>
                          <span>
                            {group.length} class{group.length === 1 ? "" : "es"} · {allowing} allow moments
                          </span>
                          {!open && holdsSelection && <span style={{ color: theme.primary }}>· selected inside</span>}
                        </button>
                        {open && ordered.map(({ r, i }) => {
                        const lbl = latticeLabel(r);
                        const dim = repMomentDims[i] ?? 0;
                        const entry = rank.results[r.candidate.id];
                        const isBest = r.candidate.id === bestRankedId;
                        const isTie = !isBest && bestRanked !== null && entry?.status === "ok" && entry.wR != null && entry.wR <= bestRanked.wR + RANK_TIE;
                        const delta = entry?.status === "ok" && entry.wR != null && baselineAgreement != null ? entry.wR - baselineAgreement : null;
                        return (
                          <button
                            key={r.candidate.id}
                            onClick={() => {
                              // A ranked row previews its refined moments; the seed is
                              // consumed once the build for this group exists.
                              if (entry?.status === "ok" && i !== selIdx) pendingSeed.current = { sig: magOpsSignature(r.candidate.operations), values: entry.values };
                              setSelIdx(i === selIdx ? null : i);
                            }}
                            style={{
                              textAlign: "left", fontSize: 12.5, padding: "5px 9px", borderRadius: 7, cursor: "pointer",
                              border: `1px solid ${i === selIdx ? theme.primary : isBest ? theme.okBorder : theme.border}`,
                              background: i === selIdx ? theme.chipBg : isBest ? theme.okBg : "#fff",
                              opacity: dim === 0 ? 0.55 : 1,
                            }}
                            title={dim === 0
                              ? "No symmetry-allowed moment on the selected site(s) under this group"
                              : entry?.status === "ok" && entry.wR != null
                                ? `Moments-only fit: ${agreementLabel} ${(100 * entry.wR).toFixed(2)}%${delta != null ? ` (${delta <= 0 ? "−" : "+"}${Math.abs(100 * delta).toFixed(2)} vs nuclear only)` : ""} · |M| ${entry.magnitudes.map((m) => `${m.label} ${m.value.toFixed(2)}`).join(", ")} µ_B${isTie ? " — same fit as the ★ candidate: the powder cannot tell them apart; the ★ is the higher-symmetry / fewer-parameter choice" : ""} — click to preview with these moments`
                                : undefined}
                          >
                            <span style={{ fontFamily: themeMono, color: theme.secondary }}>
                              {r.candidate.isTypeI ? "type I" : "type III"}
                            </span>
                            {" · "}{lbl.symbol}
                            {lbl.numbers && <span style={{ color: theme.secondary }}> · {lbl.numbers}</span>}
                            {lbl.setting && (
                              <span style={{ color: theme.noteInk }}> · setting {lbl.setting}</span>
                            )}
                            {r.domainCount > 1 && (
                              <span style={{ color: theme.secondary }}> · ×{r.domainCount} domains</span>
                            )}
                            <span style={{ float: "right", display: "inline-flex", gap: 10, alignItems: "baseline", fontFamily: themeMono, fontSize: 11.5 }}>
                              {entry?.status === "ok" && entry.wR != null && (
                                <span style={{ color: delta != null && delta < -1e-4 ? theme.okInk : theme.secondary }}>
                                  {isBest ? "★ " : isTie ? "≈ " : ""}{agreementLabel} {(100 * entry.wR).toFixed(2)}%
                                  {delta != null && <span style={{ color: theme.secondary }}> ({delta <= 0 ? "−" : "+"}{Math.abs(100 * delta).toFixed(2)})</span>}
                                  {entry.magnitudes.length > 0 && <span style={{ color: theme.secondary }}> · |M| {entry.magnitudes.map((m) => m.value.toFixed(2)).join(", ")}</span>}
                                </span>
                              )}
                              {entry?.status === "failed" && <span style={{ color: theme.warnInk }}>fit failed</span>}
                              <span style={{ color: dim === 0 ? theme.secondary : theme.primary }}>
                                {dim === 0 ? "moment forbidden" : `${dim} moment dof`}
                              </span>
                            </span>
                          </button>
                        );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </>
        ) : !irrepAnalysis ? (
          <p style={help}>Select at least one magnetic ion in step 1.</p>
        ) : !irrepAnalysis.dec.available ? (
          <p style={help}>
            This <strong>non-abelian</strong> little co-group at <strong>k ≠ 0</strong> needs the
            projective <em>small</em> representations — the remaining piece (see
            docs/MAGNETIC_SYMMETRY.md). At k = 0 the irreps are generated for any point group.
            Switch to the <strong>magnetic space groups</strong> framework above — it applies to
            every G(k).
          </p>
        ) : (
          <>
            <p style={help}>
              Γ<sub>mag</sub> ({irrepAnalysis.dec.dimension}-dim
              {irrepAnalysis.dec.method === "induced" ? ", induced point-group irreps, exact at k = 0" : ""}) ={" "}
              <span style={{ fontFamily: themeMono, color: theme.ink }}>
                {irrepAnalysis.dec.terms.map((t) => `${t.multiplicity}${t.irrep.label}`).join(" ⊕ ") || "—"}
              </span>
            </p>
            <div style={{ margin: "6px 0 0", display: "grid", gap: 3 }}>
              {irrepAnalysis.dec.terms.map((t, i) => {
                const modes = irrepAnalysis.modes[i] ?? [];
                const modeText = modes.length ? modes.map((m) => describeMomentMode(m)).join(", ") : "—";
                const active = chosenIrreps.has(t.irrep.label);
                const dim = t.irrep.dim ?? 1;
                const selectable = t.irrep.real && dim === 1;
                const blockReason = dim > 1 ? ISOTROPY_FAILURE_TEXT["multidim-irrep"] : ISOTROPY_FAILURE_TEXT["complex-irrep"];
                return (
                  <label
                    key={t.irrep.label}
                    style={{
                      textAlign: "left", fontSize: 12, padding: "4px 9px", borderRadius: 7,
                      border: `1px solid ${active ? theme.primary : theme.border}`,
                      background: active ? theme.chipBg : "#fff",
                      display: "flex", gap: 8, alignItems: "baseline", width: "100%",
                      cursor: selectable ? "pointer" : "default",
                      opacity: selectable ? 1 : 0.6,
                    }}
                    title={selectable ? undefined : blockReason}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      disabled={!selectable}
                      onChange={() =>
                        setChosenIrreps((s) => {
                          const next = new Set(s);
                          if (next.has(t.irrep.label)) next.delete(t.irrep.label);
                          else next.add(t.irrep.label);
                          return next;
                        })
                      }
                      style={{ alignSelf: "center" }}
                    />
                    <span style={{ fontFamily: themeMono, color: theme.primary, minWidth: 56 }}>{t.multiplicity} × {t.irrep.label}</span>
                    <span style={{ color: theme.secondary }}>
                      {dim > 1 ? `${dim}-dim` : t.irrep.real ? "real" : "complex"} · modes:{" "}
                      <span style={{ color: theme.ink }}>{modeText}</span>
                    </span>
                    {!selectable && (
                      <span style={{ marginLeft: "auto", fontSize: 11.5, color: theme.secondary, whiteSpace: "nowrap" }}>
                        {dim > 1 ? "multidim — direction UI pending" : "conjugate pair — type-IV territory"}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            {combo && ("failure" in combo ? (
              <p style={{ ...help, marginTop: 8, color: theme.noteInk }}>{ISOTROPY_FAILURE_TEXT[combo.failure]}</p>
            ) : (
              <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 7, border: `1px solid ${theme.primary}`, background: theme.chipBg, fontSize: 12.5 }}>
                <span style={{ color: theme.secondary }}>Isotropy subgroup of </span>
                <span style={{ fontFamily: themeMono }}>{[...chosenIrreps].sort().join(" ⊕ ")}</span>
                <span style={{ color: theme.secondary }}>: </span>
                {combo.standard ? (
                  <strong>{formatMagneticSymbol(combo.standard.bnsSymbol)}
                    <span style={{ fontWeight: 400, color: theme.secondary }}> · BNS {combo.standard.bnsNumber} · OG {combo.standard.ogNumber}</span>
                  </strong>
                ) : combo.settingMatch ? (
                  <strong>{formatMagneticSymbol(combo.settingMatch.identity.bnsSymbol)}
                    <span style={{ fontWeight: 400, color: theme.secondary }}>
                      {" "}· BNS {combo.settingMatch.identity.bnsNumber} · OG {combo.settingMatch.identity.ogNumber} · setting {combo.settingMatch.transformation}
                    </span>
                  </strong>
                ) : (
                  <strong>order-{combo.subgroupOrder} group
                    <span style={{ fontWeight: 400, color: theme.secondary }}> — no tabulated setting match (symbol withheld rather than guessed)</span>
                  </strong>
                )}
                {comboRepIdx != null && (
                  <span style={{ color: theme.secondary }}> · = candidate {comboRepIdx + 1} of the subgroup list</span>
                )}
                <div style={{ ...help, marginTop: 4 }}>
                  The moment preview in step 5 refines this group&rsquo;s symmetry-allowed modes — for a single
                  irrep these are exactly its basis modes; for a combination, the union.
                </div>
              </div>
            ))}
            {!irrepAnalysis.dec.integerConsistent && (
              <p style={{ ...help, marginTop: 6, color: theme.noteInk }}>
                Non-integer multiplicities: this non-symmorphic BZ-boundary k needs the projective
                <em> small</em> representations (ordinary irreps shown as an approximation).
              </p>
            )}
          </>
        )}
      </section>

      {/* 5. Selected subgroup: editable moments + 3D preview + handoff */}
      {magBuild && (
        <section style={sectionDivider}>
          <StepTitle
            n="5"
            title="Moments — refine & continue"
            info={
              <>
                The chosen group's symmetry-allowed moment amplitudes (µ<sub>B</sub>). Edit them, or
                let <b>Refine moments</b> fit them here against the pattern (nuclear model held
                fixed, shared scale) — the 3D model updates live. <b>Show on refinement pattern</b>{" "}
                overlays this model on the refinement plot; <b>Continue in refinement page</b> adds
                the moment parameters to the main refinement, where Refine fits nuclear + magnetic
                together.
              </>
            }
            right={
              <span style={{ fontSize: 12, color: theme.secondary, fontFamily: themeMono, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {framework === "msg" && selIdx != null && reps[selIdx]
                  ? `${latticeLabel(reps[selIdx]!).symbol} · index ${reps[selIdx]!.index}`
                  : framework === "irrep" && combo && !("failure" in combo)
                    ? `isotropy of ${[...chosenIrreps].sort().join(" ⊕ ")}`
                    : null}
              </span>
            }
          />
          {magBuild.params.length === 0 ? (
            <p style={help}>No symmetry-allowed moment on the selected ion(s) under this subgroup — the moment is forbidden here.</p>
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {magBuild.params.map((p) => (
                  <label key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                    <span style={{ color: theme.secondary }}>{p.label} (µ_B)</span>
                    <input
                      type="number"
                      step={0.1}
                      value={amps[p.id] ?? p.value}
                      onChange={(e) => setAmps((a) => ({ ...a, [p.id]: Number(e.target.value) }))}
                      style={kInput}
                    />
                  </label>
                ))}
              </div>
              {(hasSharedMagSite || canTieMagnitudes) && (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, rowGap: 6 }}>
                    {hasSharedMagSite && (
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: theme.secondary }} title="Constrain co-located (disordered) magnetic ions to the same moment vector">
                        <input type="checkbox" checked={tieMoments} onChange={(e) => setTieMoments(e.target.checked)} />
                        Same moment on shared site
                      </label>
                    )}
                    {canTieMagnitudes && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: theme.secondary, cursor: "pointer" }}>
                          <input type="checkbox" checked={tieMagnitudes} onChange={(e) => setTieMagnitudes(e.target.checked)} />
                          Equal |M|
                        </label>
                        {tieMagnitudes && (
                          <select
                            value={tieScope}
                            onChange={(e) => setTieScope(e.target.value as "element" | "all")}
                            style={tieScopeSelect}
                            title="Tie moment sizes within each element (Mn1 = Mn2), or across every selected site (the high-entropy case)"
                          >
                            <option value="element">per element</option>
                            <option value="all">all sites</option>
                          </select>
                        )}
                        <InfoBadge
                          width={300}
                          text={
                            <>
                              One shared amplitude drives every tied sublattice (site or split orbit) —
                              same moment <b>size</b>, each sublattice keeping its own symmetry-allowed
                              direction(s). Scope: <b>per element</b> ties Mn1 = Mn2 but leaves Fe free;{" "}
                              <b>all sites</b> ties every selected site regardless of element. Use the{" "}
                              <b>flip</b> toggles to make a tied sublattice antiparallel to the
                              reference. Sublattices whose allowed modes differ in number or geometry
                              cannot be tied by a linear constraint and stay independent (noted below).
                            </>
                          }
                        />
                      </span>
                    )}
                  </div>
                  {tieMagnitudes && magBuild.magnitudeTies.length === 0 && (
                    <span style={{ fontSize: 12, color: theme.secondary }}>
                      Nothing to tie under this group — no element has two magnetic sublattices here.
                    </span>
                  )}
                  {tieMagnitudes && magBuild.magnitudeTies.map((t) => (
                    <div key={t.element} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, rowGap: 5, fontSize: 12, color: theme.secondary }}>
                      <span style={{ fontFamily: themeMono }}>
                        {t.element}: |M({t.reference})|{t.members.map((m) => ` = |M(${m.label})|`).join("")}
                      </span>
                      {t.members.map((m) => (
                        <label key={m.key} style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }} title={`Make ${m.label} antiparallel to ${t.reference}`}>
                          <input
                            type="checkbox"
                            checked={flippedUnits.has(m.key)}
                            onChange={() =>
                              setFlippedUnits((s) => {
                                const next = new Set(s);
                                if (next.has(m.key)) next.delete(m.key); else next.add(m.key);
                                return next;
                              })
                            }
                          />
                          flip {m.label}
                        </label>
                      ))}
                      {t.skipped.length > 0 && (
                        <span style={{ color: theme.noteInk }}>
                          {t.skipped.map((s) => s.label).join(", ")} not tied — {t.skipped[0]!.reason}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 8, flexWrap: "wrap" }}>
                <button style={{ ...btn, marginTop: 0, opacity: canRefine && !refining ? 1 : 0.5 }} onClick={runRefine} disabled={!canRefine || refining}>
                  {refining ? "Refining…" : "Refine moments"}
                </button>
                {refineWR != null && (
                  <span style={{ fontSize: 12.5, color: theme.secondary, fontFamily: themeMono }}>{agreementLabel} = {(100 * refineWR).toFixed(1)}%</span>
                )}
                {onApply && (
                  <button
                    style={{ ...btn, marginTop: 0, background: "#fff", color: theme.primary, border: `1px solid ${theme.primary}` }}
                    onClick={() => onApply(applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps))}
                  >
                    Show on refinement pattern
                  </button>
                )}
                {onContinue && (
                  <button
                    style={{ ...btn, marginTop: 0 }}
                    onClick={() => onContinue(
                      applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps),
                      magBuild.params.map((p) => ({ ...p, value: amps[p.id] ?? p.value, initialValue: amps[p.id] ?? p.value })),
                      magBuild.bindings,
                    )}
                  >
                    Continue in refinement page →
                  </button>
                )}
                <span style={{ fontSize: 12, color: theme.secondary }} title="The HTML report (Export ▾ → Report) includes the candidate shown here, labelled as such, until you Continue.">
                  report: Export ▾
                </span>
              </div>
            </div>
          )}
        </section>
      )}
      </div>
    </div>
  );
}

/** Toggle for the click-to-add-peak mode: armed until the next plot click
 *  places the peak (or until clicked again to cancel). */
function AddPeakButton({ adding, onToggle }: { adding: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      style={{
        ...ghostBtn,
        ...(adding ? { border: `1px solid ${theme.primary}`, color: theme.primary, background: theme.primaryTintBg } : {}),
      }}
      onClick={onToggle}
      title={adding
        ? "Click the position of the missed peak in the pattern plot — or click here again to cancel"
        : "Add a peak the detector missed: arm this, then click its position in the pattern plot"}
    >
      {adding ? "Click the pattern… (cancel)" : "+ Add peak from plot"}
    </button>
  );
}

/** Numbered step header: circled number + tracked label + optional info badge
 *  and a right-aligned status chip. One consistent look for every workflow step. */
function StepTitle({ n, title, info, right }: {
  n: string;
  title: string;
  info?: ReactNode;
  right?: ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8, minWidth: 0 }}>
      <span style={stepNum}>{n}</span>
      <span style={themeLabel}>{title}</span>
      {info && <InfoBadge text={info} width={300} />}
      {right && <span style={{ marginLeft: "auto", display: "inline-flex", minWidth: 0 }}>{right}</span>}
    </div>
  );
}

const help: React.CSSProperties = { fontSize: 12, color: theme.secondary, margin: "4px 0 0", maxWidth: 560 };
/** The k = 0 explanation shown when every residual peak sits on a nuclear reflection. */
const kZeroNote: React.CSSProperties = {
  marginTop: 8, padding: "7px 10px", borderRadius: 7, fontSize: 12, lineHeight: 1.55,
  background: theme.noteBg, border: `1px solid ${theme.noteBorder}`, color: theme.noteInk, maxWidth: 640,
};
const kInput: React.CSSProperties = { width: 64, border: `1px solid ${theme.control}`, borderRadius: 7, padding: "3px 7px", fontSize: 13, fontFamily: themeMono };
const btn: React.CSSProperties = { marginTop: 6, border: "none", background: theme.primary, color: "#fff", borderRadius: 7, padding: "4px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 7, padding: "3px 12px", fontSize: 12, color: theme.ink, cursor: "pointer" };
const th: React.CSSProperties = { padding: "2px 10px 4px 0", fontWeight: 600 };
const td: React.CSSProperties = { padding: "4px 10px 4px 0" };

/** Circled step number for the workflow headers. */
const stepNum: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 17, height: 17, borderRadius: "50%", flex: "none",
  background: theme.primary, color: "#fff",
  fontSize: 10, fontWeight: 700, fontFamily: themeMono, lineHeight: 1,
};

/** Steps 2+ get a hairline divider so the panel reads as one card of stages. */
const sectionDivider: React.CSSProperties = { borderTop: `1px solid ${theme.subtle}`, paddingTop: 12 };

/** Mono status chip (active k, little-group size, class count …). */
const kChip: React.CSSProperties = {
  fontFamily: themeMono, fontSize: 11.5, color: theme.secondary,
  background: theme.chipBg, border: `1px solid ${theme.border}`,
  borderRadius: 999, padding: "1px 9px", whiteSpace: "nowrap",
};

/** Selectable magnetic-ion pill. */
function ionChip(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "3px 11px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
    border: `1px solid ${active ? theme.primary : theme.control}`,
    background: active ? theme.primaryTintBg : "#fff",
    color: active ? theme.primary : theme.secondary,
    fontWeight: active ? 600 : 400,
  };
}

/** Radio indicator for the k-search result rows (one active k at a time). */
function radioDot(active: boolean): React.CSSProperties {
  return {
    display: "inline-block", width: 11, height: 11, borderRadius: "50%",
    border: `1.5px solid ${active ? theme.primary : theme.control}`,
    background: active ? theme.primary : "#fff",
    boxShadow: active ? "inset 0 0 0 2px #fff" : undefined,
  };
}

/** Scope select for the |M| tie (per element / all sites). */
const tieScopeSelect: React.CSSProperties = {
  border: `1px solid ${theme.control}`, borderRadius: 6, padding: "1px 4px",
  fontSize: 11.5, color: theme.ink, background: "#fff",
};

/** Tiny pill marking a manually added peak row. */
const manualChip: React.CSSProperties = {
  display: "inline-block", fontSize: 10, fontFamily: themeMono, color: theme.secondary,
  border: `1px solid ${theme.border}`, borderRadius: 999, padding: "0 6px", marginRight: 5,
};

/** "×" remove control on manual peak rows. */
const removePeakBtn: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer", color: theme.secondary,
  fontSize: 14, lineHeight: 1, padding: "0 4px",
};

/** Toolbar button (blue outline) — matches the refinement plot header. */
