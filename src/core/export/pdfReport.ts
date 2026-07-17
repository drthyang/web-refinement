/**
 * Markdown refinement report for a PDF (G(r)) study — the "Report" leg of the
 * output triple (mCIF/CIF · refined curves · report). Pure data → string; the
 * caller decides the filename/download. Kept deliberately readable: a report a
 * scientist can paste into a notebook or an SI section and edit down.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";

export interface PdfReportInput {
  readonly phases: readonly StructureModel[];
  readonly pattern: PdfPattern;
  readonly parameters: readonly RefinementParameter[];
  readonly result: RefinementResult | null;
  /** Rw over G(r) inside the fit window (uniform weights). */
  readonly rw: number;
  readonly fitRange: { readonly min: number; readonly max: number };
  readonly warnings?: readonly string[];
}

const SOURCE_LABEL: Record<string, string> = {
  gr: "G(r) as loaded",
  sq: "S(Q), sine-transformed to G(r) at load",
  fq: "F(Q), sine-transformed to G(r) at load",
};

function fmt(v: number, digits = 5): string {
  return Number.isFinite(v) ? v.toPrecision(digits) : "—";
}

export function pdfReport(input: PdfReportInput): string {
  const { pattern, parameters, result } = input;
  const rFirst = pattern.points[0]?.r ?? 0;
  const rLast = pattern.points[pattern.points.length - 1]?.r ?? 0;
  const free = parameters.filter((p) => !p.fixed && !p.expression);

  const lines: string[] = [];
  lines.push(`# PDF refinement report — ${pattern.name}`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} by MATERIA Workbench (real-space G(r) refinement).`);
  lines.push("");
  lines.push("## Data");
  lines.push("");
  lines.push(`- File: ${pattern.name} — ${SOURCE_LABEL[pattern.sourceKind ?? "gr"]}`);
  lines.push(`- Probe: ${pattern.scatteringType} · ${pattern.points.length} points · r = ${rFirst.toFixed(2)}–${rLast.toFixed(2)} Å`);
  const meta: string[] = [];
  if (pattern.qmax !== undefined) meta.push(`Qmax ${pattern.qmax} Å⁻¹ (termination applied)`);
  if (pattern.qdamp !== undefined) meta.push(`Qdamp ${pattern.qdamp} Å⁻¹`);
  if (pattern.qbroad !== undefined) meta.push(`Qbroad ${pattern.qbroad} Å⁻¹`);
  if (pattern.composition) meta.push(`composition ${pattern.composition}`);
  if (meta.length) lines.push(`- ${meta.join(" · ")}`);
  lines.push(`- Fit window: ${input.fitRange.min.toFixed(2)}–${input.fitRange.max.toFixed(2)} Å`);
  lines.push("");
  lines.push("## Model");
  lines.push("");
  for (const phase of input.phases) {
    const c = phase.cell;
    lines.push(`- ${phase.name || phase.id} · ${phase.spaceGroup.hermannMauguin ?? "P1 (as loaded)"} · a ${c.a.toFixed(4)}, b ${c.b.toFixed(4)}, c ${c.c.toFixed(4)} Å · ${phase.sites.length} sites`);
  }
  lines.push("");
  lines.push("## Fit");
  lines.push("");
  lines.push(`- Rw(G) = ${(input.rw * 100).toFixed(2)} % over the fit window — uniform weights; G(r) point errors are correlated, so Rw is a *relative* quality indicator (Toby & Billinge 2004).`);
  if (result) {
    lines.push(`- Engine: ${result.status} in ${result.history.length} cycles · ${free.length} free parameters`);
    const diag = result.diagnostics;
    if (diag && diag.svdZeroCount > 0) lines.push(`- ${diag.svdZeroCount} near-null direction(s) dropped by SVD — see the parameter table; esds on the involved parameters are not meaningful.`);
    if (diag && diag.highCorrelations.length > 0) {
      const top = diag.highCorrelations.slice(0, 4).map((c) => `${c.parameterIdA}/${c.parameterIdB} ${c.coefficient.toFixed(2)}`);
      lines.push(`- Strong correlations: ${top.join("; ")}`);
    }
  }
  for (const w of input.warnings ?? []) lines.push(`- ⚠ ${w}`);
  lines.push("");
  lines.push("## Parameters");
  lines.push("");
  lines.push("| parameter | value | esd | status |");
  lines.push("|---|---|---|---|");
  for (const p of parameters) {
    const esd = result?.esd[p.id];
    lines.push(`| ${p.label} | ${fmt(p.value)} | ${esd !== undefined ? fmt(esd, 2) : "—"} | ${p.fixed ? "fixed" : "refined"} |`);
  }
  lines.push("");
  return lines.join("\n");
}
