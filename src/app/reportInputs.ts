/**
 * Report assembly — turns each workbench's live state into the technique-
 * agnostic `ReportInput` that `core/export/report.ts` renders. This is the
 * UI-side glue (it knows about sessions, display units and the magnetic page);
 * the report itself stays a pure renderer. One builder per technique, plus the
 * shared magnetic section, which prefers the model applied to the refinement
 * and otherwise reports the candidate under exploration on the magnetic page,
 * always saying which of the two it is.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { MergeStatistics } from "@/core/diffraction/merge";
import type { PdfPattern, Radiation, SingleCrystalDataset } from "@/core/diffraction/types";
import { isMomentParameterKind, type ParameterBinding, type RefinementParameter, type RefinementResult } from "@/core/refinement/types";
import { resolveTies } from "@/core/refinement/constraints";
import type { PowderProfile } from "@/core/workflow/powder";
import { formatMagneticSymbol, identifyMagneticGroupAnySetting } from "@/core/magnetic/bnsOg";
import { magneticOperationSignature } from "@/core/magnetic/operationSignature";
import { latticeCandidateLabel, latticeRepresentatives, magneticSubgroupLattice } from "@/core/magnetic/subgroupLattice";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { kLabel } from "@/core/magnetic/kSearch";
import type { ReportGroup, ReportInput, ReportMagnetic, ReportPhase, ReportRow, ReportStat } from "@/core/export/report";
import type { FigureCurves, FigureTickRow, FobsFcalcPoint } from "@/core/export/reportFigures";
import type { Session } from "@/app/powderSession";
import { APP_VERSION } from "@/app/constants";

/** What the magnetic page is showing right now, as published by KSearchPanel. */
export interface MagneticExploration {
  /** The candidate with its moments applied at the current amplitudes. */
  readonly magnetic: MagneticModel;
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly k: Vec3;
  readonly group: ReportGroup;
  /** The moments-only fit's agreement (fraction), when "Refine moments" ran. */
  readonly agreement: number | null;
  readonly agreementLabel: string;
}

/** `<name>_report.html`, the name reduced to a safe token (the id when nothing is left). */
export function reportFileName(structure: StructureModel): string {
  const token = (structure.name || structure.id).normalize("NFKD").replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${token.length >= 2 ? token : structure.id}_report.html`;
}

/** Parameters with the last result's esds merged in (the CIF export's `withEsd`). */
export function withEsds(params: readonly RefinementParameter[], result: RefinementResult | null | undefined): RefinementParameter[] {
  // A tied row (e.g. "= hypot(…)") reports what its tie evaluates to.
  let resolved: Record<string, number> | null = null;
  if (params.some((p) => p.expression)) {
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    try { resolved = resolveTies(params, values); } catch { resolved = null; }
  }
  return params.map((p) => {
    const e = result?.esd[p.id];
    const value = p.expression && resolved ? resolved[p.id] ?? p.value : p.value;
    return { ...p, value, ...(e !== undefined && Number.isFinite(e) ? { esd: e } : {}) };
  });
}

const pct = (v: number | null | undefined, d = 2): string => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(100 * v).toFixed(d)} %`);
const num = (v: number, d: number): string => v.toFixed(d);

/**
 * Name a magnetic group from its operations the way the magnetic page names
 * it: find the candidate with the same operation set in the parent's subgroup
 * lattice at this k (the page's own enumeration, so labels agree), else fall
 * back to identifying the operations in any setting, else an honest generic.
 */
export function groupOfOperations(structure: StructureModel, model: MagneticModel): ReportGroup {
  const list = model.operations;
  if (!list || list.length === 0) return { symbol: "nuclear-symmetry expansion (no magnetic group chosen)" };
  const k = model.propagation[0] ?? [0, 0, 0];
  const sig = magneticOperationSignature(list);
  try {
    const reps = latticeRepresentatives(magneticSubgroupLattice(structure.spaceGroup.operations, k as Vec3));
    const hit = reps.find((r) => magneticOperationSignature(r.candidate.operations) === sig);
    if (hit) {
      const lbl = latticeCandidateLabel(hit);
      return {
        symbol: lbl.symbol,
        ...(lbl.numbers ? { numbers: lbl.numbers } : {}),
        ...(lbl.setting ? { setting: lbl.setting } : {}),
        index: hit.index,
      };
    }
  } catch {
    // An unusual parent (or an incommensurate k) may not enumerate; fall through.
  }
  const any = identifyMagneticGroupAnySetting(list);
  if (any) {
    return {
      symbol: formatMagneticSymbol(any.identity.bnsSymbol),
      numbers: `BNS ${any.identity.bnsNumber} · OG ${any.identity.ogNumber}`,
      ...(any.direct ? {} : { setting: any.transformation }),
    };
  }
  return { symbol: "magnetic subgroup", numbers: `${list.length} operations (not in the type I/III table)` };
}

/** |m| range over the carried sublattices, e.g. "2.57 µB" or "1.8–2.6 µB". */
function momentRange(structure: StructureModel, magnetic: MagneticModel): string | null {
  const mags = magnetic.moments
    .filter((m) => m.components.some((c) => c !== 0))
    .map((m) => {
      const c = crystalComponentsToCartesian(structure.cell, m.components);
      return Math.hypot(c[0]!, c[1]!, c[2]!);
    });
  if (mags.length === 0) return null;
  const lo = Math.min(...mags);
  const hi = Math.max(...mags);
  return hi - lo < 0.005 ? `${num(hi, 2)} µB` : `${num(lo, 2)}–${num(hi, 2)} µB`;
}

/**
 * The magnetic section and its one-sentence summary. Priority: the model
 * applied to the refinement (with its provenance: refined jointly, or only
 * carried over), else the candidate under exploration on the magnetic page.
 */
export function magneticReportSection(o: {
  readonly structure: StructureModel;
  readonly applied: MagneticModel | null | undefined;
  /** The page's full parameter list with esds; the moment rows are picked out. */
  readonly params: readonly RefinementParameter[];
  readonly result: RefinementResult | null | undefined;
  readonly explored: MagneticExploration | null | undefined;
  /** How the joint refinement is described, e.g. "the powder pattern". */
  readonly against: string;
}): { section: ReportMagnetic | null; summary: string } {
  const { structure, applied, explored } = o;
  if (applied && applied.moments.length > 0) {
    const momentParams = o.params.filter((p) => isMomentParameterKind(p.kind));
    const sameAsExplored = !!explored && magneticOperationSignature(explored.magnetic.operations ?? []) === magneticOperationSignature(applied.operations ?? []);
    const group = sameAsExplored ? explored.group : groupOfOperations(structure, applied);
    const k = applied.propagation[0] ?? explored?.k ?? [0, 0, 0];
    const jointly = !!o.result && momentParams.some((p) => o.result!.esd[p.id] !== undefined);
    const range = momentRange(structure, applied);
    const status = jointly
      ? `Refined jointly with the atomic structure against ${o.against}; the moment esds come from that fit.`
      : `Included in the model and in the calculated pattern, but not refined together with the atomic structure in this session — the moments are as loaded or as set on the magnetic page` +
        (sameAsExplored && explored.agreement !== null ? ` (moments-only fit there: ${explored.agreementLabel} = ${pct(explored.agreement, 1)}).` : ".");
    const summary = `Magnetic structure: k = ${kLabel(k as Vec3)}, ${group.symbol}${group.numbers ? ` (${group.numbers})` : ""}${range ? `, |m| = ${range}` : ""}, ${jointly ? "refined jointly with the atomic structure" : "included in the model (not refined jointly in this session)"}.`;
    return { section: { magnetic: applied, k: k as Vec3, group, params: momentParams, status, structure }, summary };
  }
  if (explored) {
    const range = momentRange(structure, explored.magnetic);
    const fitted = explored.agreement !== null;
    const status = fitted
      ? `Candidate under exploration on the magnetic page — moments-only fit (${explored.agreementLabel} = ${pct(explored.agreement, 1)}); not applied to the refinement.`
      : "Candidate under exploration on the magnetic page — symmetry-allowed moments at their preview amplitudes; not fitted, not applied to the refinement.";
    const summary = `A magnetic candidate is under exploration on the magnetic page (k = ${kLabel(explored.k)}, ${explored.group.symbol}${range ? `, |m| = ${range}` : ""}); it is ${fitted ? "fitted on its own but " : ""}not part of the refinement above.`;
    return { section: { magnetic: explored.magnetic, k: explored.k, group: explored.group, params: explored.params, status, structure }, summary };
  }
  return { section: null, summary: "No magnetic model is included." };
}

function probeLabel(r: Radiation): string {
  if (r.kind === "neutron-tof") return "Neutron, time-of-flight";
  if (r.kind === "neutron") return `Neutron, constant wavelength λ = ${num(r.wavelength, 4)} Å`;
  return `X-ray, λ = ${num(r.wavelength, 4)} Å${r.polarization !== undefined ? ` · polarization ${num(r.polarization, 2)}` : ""}`;
}

function instrumentLabel(inst: InstrumentParameters, loaded: boolean): string {
  const name = [inst.name, inst.facility].filter(Boolean).join(" · ");
  const bits: string[] = [];
  if (name) bits.push(name);
  if (inst.kind === "tof") {
    bits.push(`difC = ${num(inst.difC, 2)} µs/Å`);
    if (inst.zero !== undefined) bits.push(`zero = ${num(inst.zero, 3)} µs`);
  } else {
    bits.push(`λ = ${num(inst.wavelength, 5)} Å`);
    if (inst.zero !== undefined) bits.push(`zero = ${num(inst.zero, 4)}° 2θ`);
  }
  return `${bits.join(" · ")}${loaded ? "" : " (default parameters — no instrument file loaded)"}`;
}

const X_UNIT_NAME: Record<string, string> = { twoTheta: "° 2θ", dSpacing: "Å (d)", q: "Å⁻¹ (Q)", tof: "µs (TOF)" };

const PEAK_SHAPE: Record<string, string> = {
  gaussian: "Gaussian (Caglioti widths)",
  pseudoVoigt: "Thompson–Cox–Hastings pseudo-Voigt (Caglioti U, V, W; Lorentzian X, Y)",
  tof: "Back-to-back exponentials convolved with a pseudo-Voigt (GSAS-II TOF profile type 1)",
};

function peakShapeLabel(profile: PowderProfile): string {
  return PEAK_SHAPE[profile.shape] ?? profile.shape;
}

// ---------------------------------------------------------------------------
// Powder (Rietveld)

export function powderReportInput(o: {
  readonly session: Session;
  /** Every phase with the current parameter values applied (primary first). */
  readonly refinedPhases: readonly StructureModel[];
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly result: RefinementResult | null;
  readonly instrument: InstrumentParameters;
  readonly instrumentLoaded: boolean;
  /** Agreement over the plotted pattern (fractions). */
  readonly wR: number;
  readonly rExp: number | null;
  readonly gof: number | null;
  /** The figure, in the display unit the user is looking at. */
  readonly curves: FigureCurves;
  readonly xLabel: string;
  readonly ticks: readonly FigureTickRow[];
  readonly fitRange: { readonly min: number; readonly max: number } | null;
  readonly pointsInWindow: number;
  readonly tofViewOnly: boolean;
  readonly explored: MagneticExploration | null;
}): ReportInput {
  const { session, result } = o;
  const params = withEsds(o.params, result);
  const structure = o.refinedPhases[0] ?? session.structure;
  const multi = session.extraPhases.length > 0;
  const phases: ReportPhase[] = o.refinedPhases.map((st, i) => ({
    structure: st,
    params,
    bindings: multi ? o.bindings.filter((b) => b.targetId === st.id) : o.bindings,
    ...(multi ? { role: i === 0 ? "primary phase" : "additional phase" } : {}),
  }));
  const free = params.filter((p) => !p.fixed && !p.expression).length;
  const pattern = session.pattern;
  const xs = pattern.points.map((p) => p.x);
  const xmin = xs.length ? Math.min(...xs) : 0;
  const xmax = xs.length ? Math.max(...xs) : 0;
  const unit = X_UNIT_NAME[pattern.xUnit] ?? pattern.xUnit;

  const magnetic = magneticReportSection({
    structure,
    applied: session.magnetic,
    params,
    result,
    explored: o.explored,
    against: "the powder pattern",
  });

  const stats: ReportStat[] = [
    { label: "wR", value: pct(o.wR), hint: "Weighted profile R over the fit window, w = 1/σ²" },
    ...(o.rExp !== null ? [{ label: "R exp", value: pct(o.rExp), hint: "Expected R: the statistical floor √((N − P) / Σ w y²)" }] : []),
    ...(o.gof !== null ? [{ label: "GoF (S)", value: num(o.gof, 2), hint: "S = wR / R_exp; reduced χ² = S²" }] : []),
    { label: "Points", value: String(o.pointsInWindow), hint: "Data points inside the fit window" },
    { label: "Free parameters", value: String(free) },
    ...(result ? [{ label: "Cycles", value: `${result.history.length}`, hint: `Engine status: ${result.status}` }] : []),
    ...(multi ? [{ label: "Phases", value: String(o.refinedPhases.length) }] : []),
  ];

  const data: ReportRow[] = [
    { label: "Data file", value: session.rawData?.name ?? pattern.name },
    { label: "Probe", value: probeLabel(pattern.radiation) },
    { label: "Instrument", value: instrumentLabel(o.instrument, o.instrumentLoaded) + (session.rawInstrument ? ` · file ${session.rawInstrument.name}` : "") },
    { label: "Range", value: `${num(xmin, pattern.xUnit === "tof" ? 0 : 3)} – ${num(xmax, pattern.xUnit === "tof" ? 0 : 3)} ${unit} · ${pattern.points.length} points` },
    ...(o.fitRange ? [{ label: "Fit window", value: `${num(o.fitRange.min, 3)} – ${num(o.fitRange.max, 3)} (${o.xLabel}) · ${o.pointsInWindow} points` }] : []),
    { label: "Background", value: `Chebyshev polynomial, ${session.backgroundTerms} terms` },
    { label: "Peak shape", value: o.tofViewOnly ? "View only — GSAS-II's calculated curve is shown; MATERIA did not refine this TOF pattern" : peakShapeLabel(session.powderProfile) },
    { label: "Lorentz factor", value: session.powderProfile.lorentz === false ? "off (pre-reduced intensities)" : "applied" },
    ...(session.mustrain && session.mustrain !== "isotropic" ? [{ label: "Microstrain model", value: session.mustrain }] : []),
    ...(multi ? [{ label: "Phases", value: o.refinedPhases.map((s) => s.name || s.id).join(" · ") }] : []),
  ];

  const inst = [o.instrument.name, o.instrument.facility].filter(Boolean).join(" · ");
  const summary =
    `Rietveld refinement of ${structure.name || structure.id}${structure.spaceGroup.hermannMauguin ? ` (${structure.spaceGroup.hermannMauguin})` : ""}` +
    `${multi ? ` with ${session.extraPhases.length} additional phase${session.extraPhases.length === 1 ? "" : "s"}` : ""}` +
    ` against ${probeLabel(pattern.radiation).toLowerCase()} data${inst && o.instrumentLoaded ? ` from ${inst}` : ""}: ` +
    `wR = ${pct(o.wR)}${o.gof !== null ? ` (S = ${num(o.gof, 2)})` : ""} with ${free} free parameter${free === 1 ? "" : "s"} over ${o.pointsInWindow} points. ` +
    magnetic.summary;

  const notes = [
    "wR = √(Σ w (y_obs − y_calc)² / Σ w y_obs²) with w = 1/σ² over the fit window; R_exp = √((N − P) / Σ w y_obs²); S = wR / R_exp (GSAS-II's GoF; reduced χ² = S²).",
    `Background: Chebyshev polynomial with ${session.backgroundTerms} terms, refined with the model.`,
    `Peak shape: ${peakShapeLabel(session.powderProfile)}${pattern.xUnit === "tof" ? "; d = (TOF − zero) / difC." : "."}`,
    ...(magnetic.section
      ? ["Magnetic intensities use the dipole ⟨j0⟩ form factor of the tabulated ion, with the moments expanded over the magnetic space-group operations (time-reversal-signed axial transforms, k-phase over the magnetic supercell). Components are crystal-axis µB; |m| through the cell metric. A powder pattern cannot fix the absolute moment direction within a set of symmetry-equivalent directions."]
      : []),
  ];

  return {
    technique: "powder",
    title: structure.name || structure.id,
    subtitle: `${probeLabel(pattern.radiation)}${inst && o.instrumentLoaded ? ` · ${inst}` : ""} · ${session.rawData?.name ?? pattern.name}`,
    summary,
    appVersion: APP_VERSION,
    stats,
    data,
    phases,
    magnetic: magnetic.section,
    figure: o.curves.x.length > 0
      ? {
          kind: "pattern",
          curves: o.curves,
          xLabel: o.xLabel,
          yLabel: "Intensity",
          ticks: o.ticks,
          ...(o.fitRange ? { fitRange: o.fitRange } : {}),
          caption: `Observed (dots), calculated (line) and difference (lower band) over the full pattern${o.fitRange ? "; shaded regions lie outside the fit window" : ""}. Rows of ticks mark the Bragg positions of each phase${session.magnetic ? " and the magnetic reflections" : ""}.`,
        }
      : null,
    parameters: params,
    result,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Single crystal (F²)

export function singleCrystalReportInput(o: {
  /** The structure AS REFINED (parameters applied). */
  readonly structure: StructureModel;
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly result: RefinementResult | null;
  /** The reflections the fit used (after the σ filter), with the chosen radiation. */
  readonly dataset: SingleCrystalDataset;
  readonly totalReflections: number;
  readonly excluded: number;
  readonly filterOn: boolean;
  readonly cutoffSigma: number;
  readonly agreement: { readonly r1: number; readonly wr2: number; readonly goof: number; readonly observed: number; readonly total: number };
  readonly merge: MergeStatistics;
  readonly points: readonly FobsFcalcPoint[];
  readonly magnetic: MagneticModel | null;
  readonly explored: MagneticExploration | null;
}): ReportInput {
  const params = withEsds(o.params, o.result);
  const free = params.filter((p) => !p.fixed && !p.expression).length;
  const ag = o.agreement;
  const st = o.merge;
  const magnetic = magneticReportSection({
    structure: o.structure,
    applied: o.magnetic,
    params,
    result: o.result,
    explored: o.explored,
    against: "the F² reflection data",
  });
  const stats: ReportStat[] = [
    { label: "R1", value: pct(ag.r1), hint: `Σ||F_o| − |F_c|| / Σ|F_o| over the ${ag.observed} reflections with F_o² > 2σ` },
    { label: "wR2", value: pct(ag.wr2), hint: "√(Σ w (F_o² − F_c²)² / Σ w (F_o²)²), w = 1/σ²(F_o²), all reflections" },
    { label: "GooF", value: num(ag.goof, 2), hint: "√(Σ w (F_o² − F_c²)² / (N − P))" },
    { label: "Reflections", value: String(o.dataset.reflections.length), hint: o.excluded > 0 ? `${o.excluded} excluded by the σ filter` : "All measured reflections" },
    { label: "Unique", value: String(st.unique), hint: `Laue-equivalent merge · redundancy ${num(st.redundancy, 2)}` },
    { label: "R int", value: pct(st.rInt) },
    { label: "Free parameters", value: String(free) },
  ];
  const data: ReportRow[] = [
    { label: "Data file", value: o.dataset.name },
    { label: "Probe", value: probeLabel(o.dataset.radiation) },
    { label: "Reflections", value: `${o.totalReflections} measured · ${o.dataset.reflections.length} used${o.excluded > 0 ? ` · ${o.excluded} rejected with |F_o² − F_c²|/σ > ${o.cutoffSigma}` : o.filterOn ? ` · σ filter at ${o.cutoffSigma} rejected none` : ""}` },
    { label: "Merging", value: `${st.observations} observations → ${st.unique} unique · redundancy ${num(st.redundancy, 2)} · R_int ${pct(st.rInt)} · R_σ ${pct(st.rSigma)}${st.dMin !== undefined ? ` · d_min ${num(st.dMin, 3)} Å` : ""}` },
    { label: "Observed", value: `${ag.observed} of ${ag.total} reflections with F_o² > 2σ(F_o²)` },
    { label: "Weights", value: "w = 1/σ²(F_o²); unit weights where σ is absent" },
    { label: "Unit cell", value: "fixed at the input values (not refinable from a single reflection file)" },
  ];
  const summary =
    `Single-crystal F² refinement of ${o.structure.name || o.structure.id}${o.structure.spaceGroup.hermannMauguin ? ` (${o.structure.spaceGroup.hermannMauguin})` : ""} against ${probeLabel(o.dataset.radiation).toLowerCase()} data: ` +
    `R1 = ${pct(ag.r1)}, wR2 = ${pct(ag.wr2)}, GooF = ${num(ag.goof, 2)} with ${free} free parameter${free === 1 ? "" : "s"} over ${o.dataset.reflections.length} reflections (${st.unique} unique). ` +
    magnetic.summary;
  const notes = [
    "R1 = Σ||F_o| − |F_c|| / Σ|F_o| over reflections with F_o² > 2σ(F_o²); wR2 = √(Σ w (F_o² − F_c²)² / Σ w (F_o²)²) and GooF = √(Σ w (F_o² − F_c²)² / (N − P)) over all reflections, w = 1/σ²(F_o²) (SHELX conventions).",
    "R_int = Σ|F_o² − ⟨F_o²⟩| / Σ F_o² over Laue-equivalent groups with two or more members; R_σ = Σ σ(F_o²) / Σ F_o².",
    ...(magnetic.section
      ? ["Magnetic reflections are computed from the moment component perpendicular to the scattering vector with the dipole ⟨j0⟩ form factor; with a magnetic model applied, the calculated intensity is nuclear + magnetic and one scale is shared."]
      : []),
  ];
  return {
    technique: "singleCrystal",
    title: o.structure.name || o.structure.id,
    subtitle: `${probeLabel(o.dataset.radiation)} · ${o.dataset.name}`,
    summary,
    appVersion: APP_VERSION,
    stats,
    data,
    phases: [{ structure: o.structure, params, bindings: o.bindings }],
    magnetic: magnetic.section,
    figure: { kind: "fobsFcalc", points: o.points, caption: "|F_obs| against |F_calc| for every reflection used; the dashed line is perfect agreement. Magnetic reflections (those whose calculated intensity is mostly magnetic) are coloured." },
    parameters: params,
    result: o.result,
    notes,
  };
}

// ---------------------------------------------------------------------------
// PDF (real space)

const PDF_SOURCE_LABEL: Record<string, string> = {
  gr: "G(r) as loaded",
  sq: "S(Q), sine-transformed to G(r) at load",
  fq: "F(Q), sine-transformed to G(r) at load",
  fgr: "PDFgui fit export; observed rebuilt as G_calc + G_diff",
  "fgr-diff": "PDFgui fit residual (G_diff — the mPDF signal, not a total G(r))",
};

export function pdfReportInput(o: {
  /** Every phase AS REFINED (primary first). */
  readonly phases: readonly StructureModel[];
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly result: RefinementResult | null;
  readonly pattern: PdfPattern;
  /** Rw over G(r) inside the fit window (uniform weights), fraction. */
  readonly rw: number;
  readonly fitRange: { readonly min: number; readonly max: number };
  readonly curves: FigureCurves;
  readonly positionMode: "atomic" | "irreps";
  readonly spinModel: MagneticModel | null;
  readonly warnings?: readonly string[];
}): ReportInput {
  const params = withEsds(o.params, o.result);
  const free = params.filter((p) => !p.fixed && !p.expression).length;
  const { pattern } = o;
  const primary = o.phases[0]!;
  const multi = o.phases.length > 1;
  const rFirst = pattern.points[0]?.r ?? 0;
  const rLast = pattern.points[pattern.points.length - 1]?.r ?? 0;
  const inWindow = pattern.points.filter((p) => p.r >= o.fitRange.min && p.r <= o.fitRange.max).length;
  const magnetic = magneticReportSection({
    structure: primary,
    applied: o.spinModel,
    params,
    result: o.result,
    explored: null,
    against: "G(r)",
  });
  const phases: ReportPhase[] = o.phases.map((st, i) => ({
    structure: st,
    params,
    bindings: multi ? o.bindings.filter((b) => b.targetId === st.id) : o.bindings,
    ...(multi ? { role: i === 0 ? "primary phase" : "additional phase" } : {}),
  }));
  const stats: ReportStat[] = [
    { label: "Rw(G)", value: pct(o.rw), hint: "√(Σ (G_obs − G_calc)² / Σ G_obs²) over the fit window, uniform weights" },
    { label: "Fit window", value: `${num(o.fitRange.min, 1)}–${num(o.fitRange.max, 1)} Å` },
    { label: "Points", value: String(inWindow), hint: "Grid points inside the fit window" },
    { label: "Free parameters", value: String(free) },
    ...(o.result ? [{ label: "Cycles", value: `${o.result.history.length}`, hint: `Engine status: ${o.result.status}` }] : []),
    ...(multi ? [{ label: "Phases", value: String(o.phases.length) }] : []),
  ];
  const meta: string[] = [];
  if (pattern.qmax !== undefined) meta.push(`Q_max ${pattern.qmax} Å⁻¹`);
  if (pattern.qmin !== undefined) meta.push(`Q_min ${pattern.qmin} Å⁻¹`);
  if (pattern.qdamp !== undefined) meta.push(`Q_damp ${pattern.qdamp} Å⁻¹`);
  if (pattern.qbroad !== undefined) meta.push(`Q_broad ${pattern.qbroad} Å⁻¹`);
  const data: ReportRow[] = [
    { label: "Data file", value: `${pattern.name} — ${PDF_SOURCE_LABEL[pattern.sourceKind ?? "gr"] ?? "G(r)"}` },
    { label: "Probe", value: pattern.scatteringType === "neutron" ? "Neutron total scattering (coherent scattering lengths b)" : "X-ray total scattering (Z-weighted, PDFfit2 convention)" },
    { label: "Range", value: `r = ${num(rFirst, 2)} – ${num(rLast, 2)} Å · ${pattern.points.length} points${pattern.rstep !== undefined ? ` · Δr ${pattern.rstep} Å` : ""}` },
    { label: "Fit window", value: `${num(o.fitRange.min, 2)} – ${num(o.fitRange.max, 2)} Å · ${inWindow} points` },
    ...(meta.length ? [{ label: "Reduction", value: meta.join(" · ") }] : []),
    ...(pattern.composition ? [{ label: "Composition", value: pattern.composition }] : []),
    { label: "Positions", value: o.positionMode === "irreps" ? "symmetry-adapted distortion modes (irreps of the parent group)" : "atomic coordinates (symmetry-allowed shifts)" },
    ...(multi ? [{ label: "Phases", value: o.phases.map((s) => s.name || s.id).join(" · ") }] : []),
  ];
  const summary =
    `Real-space PDF refinement of ${primary.name || primary.id}${primary.spaceGroup.hermannMauguin ? ` (${primary.spaceGroup.hermannMauguin})` : ""}${multi ? ` with ${o.phases.length - 1} additional phase${o.phases.length === 2 ? "" : "s"}` : ""} against ${pattern.scatteringType} G(r) over ${num(o.fitRange.min, 1)}–${num(o.fitRange.max, 1)} Å: ` +
    `Rw = ${pct(o.rw)} with ${free} free parameter${free === 1 ? "" : "s"}. ` +
    (o.spinModel ? magnetic.summary.replace("Magnetic structure:", "Magnetic PDF (mPDF) spin model:") : "No magnetic (mPDF) component is included.");
  const notes = [
    "Rw = √(Σ (G_obs − G_calc)² / Σ G_obs²) over the fit window with uniform weights. G(r) point errors are strongly correlated (finite-Q sine transform), so Rw is a relative quality indicator, not a statistical one (Toby & Billinge 2004); esds from this fit are correspondingly optimistic.",
    "G(r) = 4πr[ρ(r) − ρ₀]; the calculated PDF applies the Q_max termination and the Q_damp / Q_broad instrument envelope as loaded.",
    ...(o.spinModel ? ["The magnetic PDF adds the spin-pair correlation term of the applied model (ordered component scaled separately, paramagnetic self-scattering as a smooth hump); it exists for neutron data only."] : []),
  ];
  return {
    technique: "pdf",
    title: primary.name || primary.id,
    subtitle: `${pattern.scatteringType === "neutron" ? "Neutron" : "X-ray"} G(r) · ${pattern.name}`,
    summary,
    appVersion: APP_VERSION,
    stats,
    data,
    phases,
    magnetic: magnetic.section,
    figure: o.curves.x.length > 0
      ? {
          kind: "pattern",
          curves: o.curves,
          xLabel: "r (Å)",
          yLabel: "G(r) (Å⁻²)",
          fitRange: o.fitRange,
          observedAs: "dots",
          caption: "Observed G(r) (dots), calculated (line) and difference (lower band); shaded regions lie outside the fit window.",
        }
      : null,
    parameters: params,
    result: o.result,
    notes,
    ...(o.warnings && o.warnings.length > 0 ? { warnings: o.warnings } : {}),
  };
}
