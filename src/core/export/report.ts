/**
 * The refinement report — one self-contained HTML document for every
 * technique (Rietveld powder, single crystal F², real-space PDF), offered from
 * the header's Export menu. It summarises a study the way a results section
 * would: what was measured and modelled, how well the model fits (figure and
 * agreement factors), the refined atomic structure with standard uncertainties,
 * the magnetic structure when there is one (k, magnetic space group, moments,
 * projected figure), every parameter, and the refinement's own diagnostics.
 *
 * Pure data → string, in the exporters.ts convention: the workbenches assemble
 * a `ReportInput` from their state (`src/app/reportInputs.ts`) and save the
 * result; nothing here touches the DOM. Figures come from `reportFigures.ts`.
 *
 * Numbers in parentheses are standard uncertainties in the last digit(s)
 * (`formatWithEsd`, the IUCr convention), taken from the refinement's esds via
 * the same parameter → field mapping the CIF export uses (`buildEsdMap`).
 */

import type { StructureModel, UnitCell } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterKind, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ParameterBinding } from "@/core/refinement/types";
import type { Vec3 } from "@/core/math/types";
import { buildEsdMap, cellVolume, formatWithEsd } from "@/core/export/cif";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { kLabel } from "@/core/magnetic/kSearch";
import { magneticSupercell, momentAnchorPosition } from "@/core/crystal/cellExpansion";
import {
  fobsFcalcSvg,
  magneticProjectionSvg,
  patternFigureSvg,
  SUBLATTICE_COLORS,
  type FigureCurves,
  type FigureTickRow,
  type FobsFcalcPoint,
} from "@/core/export/reportFigures";

export type ReportTechnique = "powder" | "singleCrystal" | "pdf";

export const TECHNIQUE_TITLE: Record<ReportTechnique, string> = {
  powder: "Rietveld refinement",
  singleCrystal: "Single-crystal refinement",
  pdf: "PDF refinement",
};

/** One headline number (the tiles under the title). */
export interface ReportStat {
  readonly label: string;
  readonly value: string;
  /** Tooltip: how the number is defined. */
  readonly hint?: string;
}

/** A label / value line of the "Data & model" section. */
export interface ReportRow {
  readonly label: string;
  readonly value: string;
}

/** A refined crystallographic phase: the structure AS REFINED plus the
 *  parameters/bindings that carry its esds (already filtered to this phase). */
export interface ReportPhase {
  readonly structure: StructureModel;
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  /** e.g. "primary phase", "impurity phase". */
  readonly role?: string;
}

/** How the magnetic group is named in the report. */
export interface ReportGroup {
  /** Display symbol, e.g. "Cm′cm′" or "isotropy subgroup of Γ2 ⊕ Γ3". */
  readonly symbol: string;
  /** e.g. "BNS 63.462 · OG 63.9.520". */
  readonly numbers?: string;
  /** Setting transformation when identified off-standard. */
  readonly setting?: string;
  /** Index of the group in the grey group, when known. */
  readonly index?: number;
}

export interface ReportMagnetic {
  /** The model with its moments applied (the arrangement to draw and tabulate). */
  readonly magnetic: MagneticModel;
  readonly k: Vec3;
  readonly group: ReportGroup;
  /** Moment parameters (mode amplitudes), values set, esds when jointly refined. */
  readonly params: readonly RefinementParameter[];
  /** Provenance sentence: refined jointly · moments-only fit · candidate. */
  readonly status: string;
  /** The parent structure the moments decorate; defaults to the primary phase. */
  readonly structure?: StructureModel;
}

export type ReportFigure =
  | {
      readonly kind: "pattern";
      readonly curves: FigureCurves;
      readonly xLabel: string;
      readonly yLabel?: string;
      readonly ticks?: readonly FigureTickRow[];
      readonly fitRange?: { readonly min: number; readonly max: number };
      readonly caption?: string;
      readonly observedAs?: "dots" | "line";
    }
  | {
      readonly kind: "fobsFcalc";
      readonly points: readonly FobsFcalcPoint[];
      readonly caption?: string;
    };

export interface ReportInput {
  readonly technique: ReportTechnique;
  /** The material / structure name. */
  readonly title: string;
  /** One line under the title: probe · instrument · data file. */
  readonly subtitle?: string;
  /** A two-to-four-sentence plain-language summary of the outcome. */
  readonly summary?: string;
  readonly date?: Date;
  readonly appVersion?: string;
  readonly stats: readonly ReportStat[];
  readonly data: readonly ReportRow[];
  readonly phases: readonly ReportPhase[];
  readonly magnetic?: ReportMagnetic | null;
  readonly figure?: ReportFigure | null;
  /** Every parameter of the model, with esds merged in where the fit gave one. */
  readonly parameters: readonly RefinementParameter[];
  readonly result?: RefinementResult | null;
  /** Method notes: how the agreement factors, weights, and models are defined. */
  readonly notes?: readonly string[];
  readonly warnings?: readonly string[];
}

// ---------------------------------------------------------------------------
// Formatting

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fixed = (v: number, d: number): string => {
  const s = v.toFixed(d);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
};

/** Significant-figure formatting that never prints "1e-7"-style exponents for ordinary values. */
function sig(v: number, digits = 5): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(Math.max(1, digits - 1));
  const d = Math.max(0, digits - 1 - Math.floor(Math.log10(a)));
  return fixed(v, Math.min(d, 8));
}

/** Decimal places (or -1 for significant figures) by parameter kind. */
const KIND_DECIMALS: Partial<Record<ParameterKind, number>> = {
  cellLength: 5, cellAngle: 4,
  atomX: 5, atomY: 5, atomZ: 5, positionShift: 5,
  occupancy: 4, bIso: 4, uAniso: 5,
  momentX: 3, momentY: 3, momentZ: 3, momentMode: 3,
  zeroShift: 4, tofCalibration: 3,
  qdamp: 4, qbroad: 4, delta1: 4, delta2: 4, sratio: 4, rcut: 3, spdiameter: 2, corrLength: 2, mpdfPsigma: 4,
};

const KIND_UNIT: Partial<Record<ParameterKind, string>> = {
  cellLength: "Å", cellAngle: "°",
  positionShift: "(frac.)", bIso: "Å²", uAniso: "Å²",
  momentX: "µB", momentY: "µB", momentZ: "µB", momentMode: "µB",
  zeroShift: "° 2θ", sampleDisplacement: "µm",
  qdamp: "Å⁻¹", qbroad: "Å⁻¹", delta1: "Å", delta2: "Å²", rcut: "Å", spdiameter: "Å", corrLength: "Å", mpdfPsigma: "Å",
  tofCalibration: "µs", stephensStrain: "×10⁻⁶", mustrainIso: "×10⁻⁶", mustrainPar: "×10⁻⁶", mustrainPerp: "×10⁻⁶",
};

/** value(su) when the fit gave an esd; otherwise a kind-appropriate precision. */
export function formatParameterValue(p: RefinementParameter): string {
  const d = KIND_DECIMALS[p.kind];
  if (p.esd !== undefined && Number.isFinite(p.esd) && p.esd > 0) return formatWithEsd(p.value, p.esd, d ?? 5);
  return d !== undefined ? fixed(p.value, d) : sig(p.value);
}

interface ParameterGroup {
  readonly title: string;
  readonly kinds: readonly ParameterKind[];
}

const PARAMETER_GROUPS: readonly ParameterGroup[] = [
  { title: "Scale & background", kinds: ["scale", "background", "magneticScale", "pdfScale"] },
  { title: "Unit cell", kinds: ["cellLength", "cellAngle"] },
  { title: "Atoms", kinds: ["atomX", "atomY", "atomZ", "positionShift", "occupancy", "bIso", "uAniso"] },
  { title: "Magnetic moments", kinds: ["momentMode", "momentX", "momentY", "momentZ"] },
  {
    title: "Peak shape, instrument & sample",
    kinds: [
      "peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY", "asymSL", "asymHL",
      "zeroShift", "sampleDisplacement", "sampleTransparency", "tofCalibration", "tofProfile",
      "poRatio", "absorption", "surfaceRoughA", "surfaceRoughB", "extinction", "stephensStrain",
      "anisoSizePerp", "anisoSizePar", "mustrainPerp", "mustrainPar", "mustrainIso",
    ],
  },
  {
    title: "PDF envelope & correlated motion",
    kinds: ["qdamp", "qbroad", "delta1", "delta2", "spdiameter", "sratio", "rcut", "mpdfOrdScale", "mpdfParaScale", "mpdfPsigma", "corrLength"],
  },
];

function statusOf(p: RefinementParameter): string {
  if (p.expression) return `tied · ${esc(p.expression.trim().startsWith("=") ? p.expression.trim() : `= ${p.expression}`)}`;
  return p.fixed ? "fixed" : "refined";
}

// ---------------------------------------------------------------------------
// Sections

function statsHtml(stats: readonly ReportStat[]): string {
  if (stats.length === 0) return "";
  return `<div class="stats">${stats
    .map((s) => `<div class="stat"${s.hint ? ` title="${esc(s.hint)}"` : ""}><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`)
    .join("")}</div>`;
}

function kvHtml(rows: readonly ReportRow[]): string {
  return `<dl class="kv">${rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join("")}</dl>`;
}

function cellTable(cell: UnitCell, esd: ReturnType<typeof buildEsdMap>): string {
  const row = (k: string, v: string): string => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  return `<table>
${row("a", `${formatWithEsd(cell.a, esd.cell.a, 5)} Å`)}
${row("b", `${formatWithEsd(cell.b, esd.cell.b, 5)} Å`)}
${row("c", `${formatWithEsd(cell.c, esd.cell.c, 5)} Å`)}
${row("α", `${formatWithEsd(cell.alpha, esd.cell.alpha, 4)}°`)}
${row("β", `${formatWithEsd(cell.beta, esd.cell.beta, 4)}°`)}
${row("γ", `${formatWithEsd(cell.gamma, esd.cell.gamma, 4)}°`)}
${row("V", `${fixed(cellVolume(cell), 3)} Å³`)}
</table>`;
}

const EIGHT_PI2 = 8 * Math.PI * Math.PI;

function ionLabel(element: string, oxidation: number | undefined): string {
  if (oxidation === undefined || oxidation === 0) return element;
  const sup = "⁰¹²³⁴⁵⁶⁷⁸⁹";
  const n = Math.abs(oxidation);
  const digits = n === 1 ? "" : String(n).split("").map((c) => sup[Number(c)]!).join("");
  return `${element}${digits}${oxidation > 0 ? "⁺" : "⁻"}`;
}

function sitesTable(structure: StructureModel, esd: ReturnType<typeof buildEsdMap>): string {
  const anyAniso = structure.sites.some((s) => s.adp.kind === "anisotropic");
  const rows = structure.sites.map((s) => {
    const pe = esd.pos.get(s.label);
    const bEsd = s.adp.kind === "isotropic" ? esd.bIso.get(s.label) : undefined;
    const b = s.adp.kind === "isotropic" ? s.adp.bIso : EIGHT_PI2 * ((s.adp.uAniso[0]! + s.adp.uAniso[1]! + s.adp.uAniso[2]!) / 3);
    return `<tr><td><b>${esc(s.label)}</b></td><td>${esc(ionLabel(s.element, s.oxidationState))}</td>` +
      `<td class="num">${formatWithEsd(s.position[0], pe?.[0], 5)}</td>` +
      `<td class="num">${formatWithEsd(s.position[1], pe?.[1], 5)}</td>` +
      `<td class="num">${formatWithEsd(s.position[2], pe?.[2], 5)}</td>` +
      `<td class="num">${formatWithEsd(s.occupancy, esd.occ.get(s.label), 4)}</td>` +
      `<td class="num">${formatWithEsd(b, bEsd, 3)}</td>` +
      (anyAniso ? `<td>${s.adp.kind === "isotropic" ? "iso" : "aniso"}</td>` : "") +
      `</tr>`;
  });
  return `<div class="scroll"><table>
<tr><th>Site</th><th>Type</th><th class="num">x</th><th class="num">y</th><th class="num">z</th><th class="num">Occ.</th><th class="num">B${anyAniso ? "<sub>eq</sub>" : "<sub>iso</sub>"} (Å²)</th>${anyAniso ? "<th>ADP</th>" : ""}</tr>
${rows.join("\n")}
</table></div>`;
}

function phaseHtml(phase: ReportPhase, index: number, total: number): string {
  const st = phase.structure;
  const esd = buildEsdMap(phase.params, phase.bindings);
  const sg = st.spaceGroup;
  const sgText = `${sg.hermannMauguin ?? "P1 (as loaded)"}${sg.number !== undefined ? ` · No. ${sg.number}` : ""}`;
  const role = phase.role ?? (total > 1 ? (index === 0 ? "primary phase" : `phase ${index + 1}`) : undefined);
  return `<h3>${esc(st.name || st.id)} <span class="pill">${esc(sgText)}</span>${role ? `<span class="pill">${esc(role)}</span>` : ""}</h3>
<div class="two">
  <div class="card">${sitesTable(st, esd)}</div>
  <div class="card">${cellTable(st.cell, esd)}<p class="note">${st.sites.length} site${st.sites.length === 1 ? "" : "s"} in the asymmetric unit · ${sg.operations.length} symmetry operation${sg.operations.length === 1 ? "" : "s"}</p></div>
</div>`;
}

function figureHtml(fig: ReportFigure): string {
  if (fig.kind === "pattern") {
    const svg = patternFigureSvg(fig.curves, {
      xLabel: fig.xLabel,
      ...(fig.yLabel !== undefined ? { yLabel: fig.yLabel } : {}),
      ...(fig.ticks ? { ticks: fig.ticks } : {}),
      ...(fig.fitRange ? { fitRange: fig.fitRange } : {}),
      ...(fig.observedAs ? { observedAs: fig.observedAs } : {}),
    });
    if (!svg) return "";
    return `<figure class="card fig">${svg}${fig.caption ? `<figcaption class="cap">${esc(fig.caption)}</figcaption>` : ""}</figure>`;
  }
  if (fig.points.length === 0) return "";
  return `<figure class="card fig fig-square">${fobsFcalcSvg(fig.points)}${fig.caption ? `<figcaption class="cap">${esc(fig.caption)}</figcaption>` : ""}</figure>`;
}

function magneticHtml(m: ReportMagnetic, fallbackStructure: StructureModel | undefined): string {
  const structure = m.structure ?? fallbackStructure;
  if (!structure) return "";
  const { svg, subKeys } = magneticProjectionSvg(structure, m.magnetic, m.k);
  const supercell = magneticSupercell(m.k);
  const isSuper = supercell.some((n) => n > 1);
  const cell = structure.cell;
  const carried = m.magnetic.moments.filter((mm) => mm.components.some((c) => c !== 0));

  const momentRows = m.magnetic.moments.map((mm) => {
    const site = structure.sites.find((s) => s.label === mm.siteLabel);
    const pos = site
      ? momentAnchorPosition(structure.spaceGroup.operations, m.magnetic.operations ?? structure.spaceGroup.operations, site.position, mm.orbitIndex, mm.position)
      : mm.position ?? [0, 0, 0];
    const cart = crystalComponentsToCartesian(cell, mm.components);
    const mag = Math.hypot(cart[0]!, cart[1]!, cart[2]!);
    const key = mm.orbitIndex && mm.orbitIndex > 1 ? `${mm.siteLabel}#${mm.orbitIndex}` : mm.siteLabel;
    const color = SUBLATTICE_COLORS[Math.max(0, subKeys.indexOf(key)) % SUBLATTICE_COLORS.length]!;
    const orbit = mm.orbitIndex && mm.orbitIndex > 1 ? `orbit ${mm.orbitIndex}` : "orbit 1";
    return `<tr><td><span class="sw" style="background:${color}"></span><b>${esc(mm.siteLabel)}</b> · ${orbit}</td>` +
      `<td class="num">${fixed(pos[0]!, 4)}, ${fixed(pos[1]!, 4)}, ${fixed(pos[2]!, 4)}</td>` +
      `<td class="num">${fixed(mm.components[0]!, 3)}, ${fixed(mm.components[1]!, 3)}, ${fixed(mm.components[2]!, 3)}</td>` +
      `<td class="num">${fixed(mag, 3)}</td></tr>`;
  });

  const paramRows = m.params.map((p) =>
    `<tr><td>${esc(p.label)}</td><td class="num">${formatParameterValue(p)} µB</td><td class="muted">${statusOf(p)}</td></tr>`,
  );

  const facts: ReportRow[] = [
    { label: "Propagation vector", value: `k = ${kLabel(m.k)}` },
    { label: "Magnetic space group", value: m.group.symbol },
    ...(m.group.numbers ? [{ label: "Numbers", value: m.group.numbers }] : []),
    ...(m.group.setting ? [{ label: "Setting", value: m.group.setting }] : []),
    ...(m.group.index !== undefined ? [{ label: "Index in the grey group", value: String(m.group.index) }] : []),
    { label: "Parent space group", value: structure.spaceGroup.hermannMauguin ?? "—" },
    { label: "Magnetic cell", value: isSuper ? `${supercell.join(" × ")} supercell of the nuclear cell` : "the nuclear cell (k = 0)" },
    { label: "Ordered sublattices", value: `${carried.length} of ${m.magnetic.moments.length}` },
  ];

  return `<p class="status">${esc(m.status)}</p>
<div class="two">
  <figure class="card fig">${svg}<figcaption class="cap">${isSuper ? `Magnetic supercell ${supercell.join(" × ")} of the nuclear cell` : "One unit cell"}, projected down c* (a–b plane). Arrows: in-plane moment component, length ∝ |m|; ⊙ / ⊗ marks a component out of / into the page. Filled atoms lie in the lower half of the cell (depth), outlined in the upper half; thin lines join nearest-neighbour magnetic atoms.</figcaption></figure>
  <div>
    <div class="card">${kvHtml(facts)}</div>
    ${paramRows.length > 0 ? `<div class="card" style="margin-top:14px"><h4>Moment parameters</h4><table>${paramRows.join("")}</table></div>` : ""}
  </div>
</div>
<div class="card scroll" style="margin-top:14px">
  <h4>Magnetic sublattices</h4>
  <table>
    <tr><th>Site · orbit</th><th class="num">Position (fractional)</th><th class="num">m along a, b, c (µB)</th><th class="num">|m| (µB)</th></tr>
    ${momentRows.join("\n")}
  </table>
</div>`;
}

function parametersHtml(params: readonly RefinementParameter[]): string {
  if (params.length === 0) return `<p class="note">No parameters.</p>`;
  const seen = new Set<string>();
  const blocks: string[] = [];
  const table = (title: string, rows: readonly RefinementParameter[]): string => {
    const free = rows.filter((p) => !p.fixed && !p.expression).length;
    return `<div class="card pgroup"><h4>${esc(title)} <span class="muted">· ${rows.length} parameter${rows.length === 1 ? "" : "s"}, ${free} refined</span></h4>
<table>
<tr><th>Parameter</th><th class="num">Value</th><th>Unit</th><th>Status</th></tr>
${rows.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${formatParameterValue(p)}</td><td class="muted">${KIND_UNIT[p.kind] ?? ""}</td><td class="muted">${statusOf(p)}</td></tr>`).join("\n")}
</table></div>`;
  };
  for (const g of PARAMETER_GROUPS) {
    const rows = params.filter((p) => g.kinds.includes(p.kind));
    if (rows.length === 0) continue;
    rows.forEach((p) => seen.add(p.id));
    blocks.push(table(g.title, rows));
  }
  const rest = params.filter((p) => !seen.has(p.id));
  if (rest.length > 0) blocks.push(table("Other parameters", rest));
  return blocks.join("\n");
}

function detailsHtml(input: ReportInput): string {
  const r = input.result;
  const labelOf = new Map(input.parameters.map((p) => [p.id, p.label]));
  const rows: ReportRow[] = [];
  const free = input.parameters.filter((p) => !p.fixed && !p.expression).length;
  rows.push({ label: "Free parameters", value: `${free} of ${input.parameters.length}` });
  if (r) {
    rows.push({ label: "Engine", value: `${r.status}${r.history.length > 0 ? ` after ${r.history.length} cycle${r.history.length === 1 ? "" : "s"}` : ""}` });
    const last = r.history[r.history.length - 1];
    if (last) rows.push({ label: "Final χ² (Σ w Δ²)", value: sig(last.chiSquared, 6) });
    if (r.agreement.rWeighted !== undefined) rows.push({ label: "Weighted R", value: `${(100 * r.agreement.rWeighted).toFixed(3)} %` });
    if (r.agreement.rExpected !== undefined) rows.push({ label: "Expected R", value: `${(100 * r.agreement.rExpected).toFixed(3)} %` });
    if (r.agreement.goodnessOfFit !== undefined) rows.push({ label: "Goodness of fit S", value: r.agreement.goodnessOfFit.toFixed(3) });
    const diag = r.diagnostics;
    if (diag) {
      if (diag.svdZeroCount > 0) rows.push({ label: "Null directions", value: `${diag.svdZeroCount} dropped by SVD — esds on the involved parameters are not meaningful` });
      if (diag.highCorrelations.length > 0) {
        rows.push({
          label: "Strong correlations",
          value: diag.highCorrelations
            .slice(0, 6)
            .map((c) => `${labelOf.get(c.parameterIdA) ?? c.parameterIdA} / ${labelOf.get(c.parameterIdB) ?? c.parameterIdB} ${c.coefficient.toFixed(2)}`)
            .join("; "),
        });
      }
    }
    if (r.message) rows.push({ label: "Engine note", value: r.message });
  } else {
    rows.push({ label: "Engine", value: "no refinement run in this session — values are as loaded or set" });
  }
  const warnings = (input.warnings ?? []).map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join("");
  const notes = (input.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("");
  return `<div class="card">${kvHtml(rows)}${warnings}${notes ? `<h4 style="margin-top:14px">Conventions</h4><ul class="notes">${notes}</ul>` : ""}</div>`;
}

// ---------------------------------------------------------------------------
// Document

const CSS = `
  :root {
    --bg: #f5f6f8; --panel: #ffffff; --ink: #1d232c; --soft: #5a6572; --faint: #8e98a3;
    --hair: #e1e5ea; --accent: #0f6f8f; --warn: #a3541c;
    --obs: #23486f; --calc: #c8352e; --diffc: #4f7a33; --bkgc: #98a3ae; --excl: rgba(110, 120, 132, .10);
    --cellc: #8b93a0; --bondc: #b9a7d6;
    --mono: "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14181e; --panel: #1b2129; --ink: #e5e9ee; --soft: #a0aab5; --faint: #7d8792; --hair: #2c343e;
            --accent: #63b3d1; --warn: #e0925a; --obs: #9ec1ea; --calc: #ff7b72; --diffc: #8fc46e; --bkgc: #6f7b87;
            --excl: rgba(160, 170, 182, .12); --cellc: #6d7683; --bondc: #55496e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14.5px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 36px 28px 64px; }
  .masthead { border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-bottom: 20px; }
  .eyebrow { font-family: var(--mono); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--soft); margin: 0 0 8px; }
  h1 { font-size: 30px; line-height: 1.15; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 6px; }
  .sub { color: var(--soft); margin: 0; font-size: 14.5px; }
  .summary { font-size: 15.5px; line-height: 1.6; margin: 18px 0 0; max-width: 78ch; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 10px; margin: 22px 0 30px; }
  .stat { background: var(--panel); border: 1px solid var(--hair); border-radius: 10px; padding: 12px 14px 10px; }
  .stat b { display: block; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .stat span { display: block; margin-top: 2px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--soft); }
  section { margin: 0 0 30px; }
  h2 { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--soft); margin: 0 0 12px; }
  h2 .n { font-family: var(--mono); color: var(--accent); }
  h3 { font-size: 16px; font-weight: 600; margin: 18px 0 10px; }
  h3:first-of-type { margin-top: 0; }
  h4 { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--soft); font-weight: 650; margin: 0 0 8px; }
  .card { background: var(--panel); border: 1px solid var(--hair); border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .fig { padding: 10px 10px 4px; }
  .fig svg { display: block; width: 100%; height: auto; }
  .fig-square svg { max-width: 460px; margin: 0 auto; }
  .cap { font-size: 12.5px; color: var(--soft); padding: 8px 6px 6px; border-top: 1px solid var(--hair); margin-top: 6px; line-height: 1.5; }
  .two { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 14px; align-items: start; }
  @media (max-width: 820px) { .two { grid-template-columns: 1fr; } }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 6px 12px 6px 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--hair); }
  th { font-weight: 600; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); }
  tr:last-child > td { border-bottom: none; }
  td:last-child, th:last-child { padding-right: 0; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; font-size: 12.5px; }
  th.num { text-align: right; }
  .muted { color: var(--soft); }
  .scroll { overflow-x: auto; }
  .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 22px; margin: 0; font-size: 13.5px; }
  .kv dt { color: var(--soft); }
  .kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .pill { display: inline-block; font-size: 11.5px; font-weight: 500; padding: 1px 9px; border-radius: 999px; border: 1px solid var(--hair); color: var(--soft); margin-left: 8px; vertical-align: 2px; }
  .status { font-size: 13.5px; color: var(--soft); margin: -4px 0 12px; }
  .note { font-size: 12.5px; color: var(--soft); margin: 10px 0 0; }
  .warn { font-size: 13px; color: var(--warn); margin: 10px 0 0; }
  .notes { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--soft); line-height: 1.55; }
  .notes li { margin: 3px 0; }
  .pgroup + .pgroup { margin-top: 12px; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 7px; vertical-align: -1px; }
  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--hair); font-size: 12px; color: var(--soft); line-height: 1.5; }
  /* figures */
  .frame { fill: none; stroke: var(--hair); stroke-width: 1; }
  .grid { stroke: var(--hair); stroke-width: 1; stroke-dasharray: 2 4; }
  .zero { stroke: var(--faint); stroke-width: 1; }
  .tickmark { stroke: var(--soft); stroke-width: 1; }
  .excl { fill: var(--excl); }
  .axistext { font-family: var(--mono); font-size: 11px; fill: var(--soft); }
  .axistitle { font-family: var(--sans); font-size: 12px; fill: var(--soft); }
  .legend { font-family: var(--sans); font-size: 12px; fill: var(--soft); }
  .ticklabel { font-family: var(--mono); font-size: 10.5px; }
  .obs { stroke: var(--obs); stroke-width: 2.6; stroke-linecap: round; fill: none; }
  .obsline { stroke: var(--obs); stroke-width: 1.4; fill: none; }
  .calc { stroke: var(--calc); stroke-width: 1.5; fill: none; }
  .diff { stroke: var(--diffc); stroke-width: 1.2; fill: none; }
  .bkg { stroke: var(--bkgc); stroke-width: 1.1; stroke-dasharray: 5 4; fill: none; }
  .unity { stroke: var(--faint); stroke-width: 1; stroke-dasharray: 4 4; }
  .pt { stroke: var(--obs); stroke-width: 4.2; stroke-linecap: round; opacity: .7; fill: none; }
  .ptmag { stroke: var(--calc); stroke-width: 4.6; stroke-linecap: round; opacity: .8; fill: none; }
  .cell { stroke: var(--cellc); fill: none; }
  .bond { stroke: var(--bondc); opacity: .55; }
  .axis { stroke: var(--soft); }
  .axisdot { fill: var(--soft); }
  .lbl { font-family: var(--mono); font-size: 11px; fill: var(--soft); paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; }
  @media print {
    body { background: #fff; color: #000; }
    .wrap { max-width: none; padding: 0; }
    .card, .fig, .stat { border-color: #cfd4da; break-inside: avoid; }
    h2, h3 { break-after: avoid; }
    .stats { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
  }
`;

/** Build the standalone HTML report (a complete document, ready to save). */
export function reportHtml(input: ReportInput): string {
  const date = (input.date ?? new Date()).toISOString().slice(0, 10);
  const technique = TECHNIQUE_TITLE[input.technique];
  const primary = input.phases[0]?.structure;
  let n = 0;
  const section = (id: string, title: string, body: string): string =>
    body ? `<section id="${id}"><h2><span class="n">${++n}</span>${esc(title)}</h2>\n${body}\n</section>` : "";

  const data = input.data.length > 0 ? `<div class="card">${kvHtml(input.data)}</div>` : "";
  const fit = input.figure ? figureHtml(input.figure) : "";
  const phases = input.phases.map((p, i) => phaseHtml(p, i, input.phases.length)).join("\n");
  const magnetic = input.magnetic ? magneticHtml(input.magnetic, primary) : "";
  const params = parametersHtml(input.parameters);
  const details = detailsHtml(input);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · ${esc(technique)} report</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <p class="eyebrow">MATERIA · ${esc(technique)} report · ${esc(date)}</p>
    <h1>${esc(input.title)}</h1>
    ${input.subtitle ? `<p class="sub">${esc(input.subtitle)}</p>` : ""}
    ${input.summary ? `<p class="summary">${esc(input.summary)}</p>` : ""}
  </header>
  ${statsHtml(input.stats)}
  ${section("data", "Data & model", data)}
  ${section("fit", "Fit", fit)}
  ${section("structure", input.phases.length > 1 ? "Atomic structures" : "Atomic structure", phases)}
  ${section("magnetic", "Magnetic structure", magnetic)}
  ${section("parameters", "Parameters", params)}
  ${section("details", "Refinement details", details)}
  <footer>
    Generated by MATERIA Workbench${input.appVersion ? ` v${esc(input.appVersion)}` : ""} on ${esc(date)}.
    Values in parentheses are standard uncertainties in the last digit(s), from the least-squares covariance of this fit;
    a value without one was fixed, tied, or not part of the last refinement.
    MATERIA is in public beta — reproduce results you intend to publish in an established package (the Export menu offers GSAS-II and FullProf bundles).
  </footer>
</div>
</body>
</html>
`;
}
