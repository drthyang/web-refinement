/**
 * The single-crystal page's Validation view, laid out to read on about one
 * screen: a strip of the data/agreement numbers the card header does not
 * already show; the verdict beside SHELXL's analysis of variance by intensity
 * (K and GooF); then Fo² vs Fc² (log axes by default) beside one panel that
 * switches between the resolution-shell table and the largest outliers.
 * Convergence detail lives in the verdict and the parameter panel's Result
 * footer.
 *
 * The analysis of variance replaces the normal-probability plot: both ask
 * whether the weights describe the scatter, but the bins say which reflections
 * are off and in which direction.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { SpaceGroup, UnitCell } from "@/core/crystal/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { MergeStatistics } from "@/core/diffraction/merge";
import { singleCrystalValidation, type ScOutlier, type ScValidation } from "@/core/diagnostics/singleCrystalValidation";
import { singleCrystalChecks } from "@/core/diagnostics/validationChecks";
import { shelxWeights, singleCrystalAgreement } from "@/core/diffraction/singleCrystalFactors";
import { FobsFcalc, ScatterToolbar, type ScatterQuantity, type ScatterScale } from "@/app/ui/QualityPlots";
import { color, fz } from "@/app/theme";
import { InfoBadge } from "@/app/ui/InfoBadge";
import {
  Bars,
  DivergingBars,
  Metric,
  MetricStrip,
  Row,
  Section,
  Tabs,
  VerdictPanel,
  col,
  tableStyle,
  td,
  th,
} from "@/app/ui/ValidationParts";

const DATA_INFO = "R1, wR2 and GooF are in the card header. wR2 and GooF on all F² are the honest numbers; R1 is the familiar one. Data quality (completeness, R_int, R_σ) sits beside model quality so a weak dataset is not mistaken for a bad model. checkCIF asks ≥ 10 reflections per parameter for a centrosymmetric group, ≥ 8 otherwise.";
const INTENSITY_INFO = "SHELXL's analysis of variance, in equal-count bins of Fc/Fc(max). A flat GooF near 1 means the weights describe the scatter. K = ⟨Fo²⟩/⟨Fc²⟩ below 1 in the strongest bin is extinction; GooF rising with intensity alone means the weighting scheme. The weakest bin's K is noisy because Fo² there is close to zero.";
const SHELLS_INFO = "Equal-count resolution shells, low angle first. K below 1 with a high GooF only at low angle is extinction (or the beamstop); K drifting across every shell points to the ADPs, absorption or scattering factors. R_int and ⟨I/σ⟩ show where the data run out.";
const OUTLIERS_INFO = "The largest standardized residuals (Fo² − Fc²)/σ with where they sit. Click a row to find it in Fo² vs Fc². Before omitting a reflection, check the pattern: outliers explained by extinction or absorption should be modelled, not rejected.";

type Selection = { hkl: string; kind: ReflectionObsCalc["kind"]; phaseId?: string };

export interface SingleCrystalValidationProps {
  /** Observed vs calculated per reflection (Fo², Fc², σ) for the current parameters. */
  readonly rows: readonly ReflectionObsCalc[];
  readonly cell: UnitCell;
  readonly spaceGroup: SpaceGroup;
  readonly nParams: number;
  readonly merge: MergeStatistics;
  readonly result: RefinementResult | null;
  readonly parameters: readonly RefinementParameter[];
  /** Sites whose anisotropic U is not positive-definite. */
  readonly nonPositiveDefinite: readonly string[];
  readonly xray: boolean;
  readonly selected: Selection | null;
  readonly onSelect: (sel: Selection | null) => void;
  /** The σ-reject control, shown in the Outliers panel where it acts. */
  readonly outlierFilter?: ReactNode;
  /** Reflections currently omitted by that control, flagged in the strip. */
  readonly omitted?: { readonly count: number; readonly cutoff: number } | undefined;
}

const pct = (v: number, digits = 2): string => (Number.isFinite(v) ? `${(100 * v).toFixed(digits)}%` : "—");

export function SingleCrystalValidationView(props: SingleCrystalValidationProps): JSX.Element {
  const { rows, cell, spaceGroup, nParams, merge: st, result, parameters } = props;

  // SHELX agreement over these rows (σ weights), so every number in the view —
  // including the GooF the verdict reads — describes the same intensities
  // (the total, nuclear + magnetic, when a magnetic model is applied).
  const ag = useMemo(() => {
    const fo = rows.map((r) => r.iObs);
    const fc = rows.map((r) => r.iCalc);
    const sg = rows.map((r) => r.sigma ?? 0);
    return singleCrystalAgreement(fo, fc, sg, shelxWeights(fo, fc, sg), nParams);
  }, [rows, nParams]);

  const validation = useMemo(
    () => singleCrystalValidation({
      rows: rows.map((r) => ({ h: r.h, k: r.k, l: r.l, foSq: r.iObs, fcSq: r.iCalc, ...(r.sigma !== undefined ? { sigma: r.sigma } : {}) })),
      cell, spaceGroup, nParams,
    }),
    [rows, cell, spaceGroup, nParams],
  );
  const verdict = useMemo(
    () => singleCrystalChecks({ validation, goof: ag.goof, result, parameters, nonPositiveDefinite: props.nonPositiveDefinite, xray: props.xray, omitted: props.omitted }),
    [validation, ag.goof, result, parameters, props.nonPositiveDefinite, props.xray, props.omitted],
  );

  const v = validation;
  const need = v.centrosymmetric ? 10 : 8;
  const strongest = v.bins.length - 1;
  const ext = v.extinction;
  const hkl = (o: ScOutlier): string => `${o.h} ${o.k} ${o.l}`;
  const pattern = outlierPattern(v);

  const [table, setTable] = useState<"shells" | "outliers">("shells");
  const [scale, setScale] = useState<ScatterScale>("log");
  const [quantity, setQuantity] = useState<ScatterQuantity>("F2");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <MetricStrip>
        <Metric value={v.reflectionsPerParameter.toFixed(1)} label="refl / param" tone={v.reflectionsPerParameter >= need ? "ok" : "warn"} title={`${v.uniqueObserved} unique / ${nParams} free parameters; checkCIF asks ≥ ${need}`} />
        {v.completeness !== undefined ? <Metric value={pct(v.completeness, 1)} label="complete" title={`to sinθ/λ ${v.sinThetaOverLambdaMax.toFixed(3)} Å⁻¹`} tone={v.completeness >= 0.95 ? "ok" : v.completeness >= 0.9 ? "note" : "warn"} /> : null}
        <Metric value={pct(ag.r1All)} label="R1 · all" title="R1 over every reflection; R1 (I > 2σ), wR2 and GooF are in the header" />
        <Metric value={st.redundancy > 1 ? pct(st.rInt, 1) : "—"} label="R_int" title={st.redundancy > 1 ? undefined : "no redundant observations to merge"} />
        <Metric value={pct(st.rSigma, 1)} label="R_σ" />
        <Metric value={`${st.observations} → ${st.unique}`} label={`obs → unique · ×${st.redundancy.toFixed(2)}`} />
        <Metric value={Number.isFinite(v.dMin) ? `${v.dMin.toFixed(3)} Å` : "—"} label={`d_min · ${v.sinThetaOverLambdaMax.toFixed(2)} Å⁻¹`} />
        {props.omitted && props.omitted.count > 0 ? (
          <Metric value={String(props.omitted.count)} label={`omitted · |Δ|/σ > ${props.omitted.cutoff}`} tone="note" title="Reflections rejected by the σ filter (Outliers panel); every number here is computed without them" />
        ) : null}
        <span style={{ alignSelf: "center" }}><InfoBadge text={DATA_INFO} width={300} align="right" /></span>
      </MetricStrip>

      <Row>
        <VerdictPanel verdict={verdict} style={col(6, 330)} />
        <Section title="By intensity" info={INTENSITY_INFO} subtitle="weak → strong" style={col(5, 300)}>
          <span style={{ fontSize: fz.micro, fontWeight: 600, color: color.ink }}>K = ⟨Fo²⟩/⟨Fc²⟩</span>
          <DivergingBars
            centre={1}
            span={Math.max(0.2, ...v.bins.slice(1).map((b) => Math.abs(b.k - 1)))}
            centreLabel="1.00"
            height={66}
            items={v.bins.map((b, i) => ({
              label: b.fcRatioMax.toFixed(2),
              value: b.k,
              text: b.k.toFixed(2),
              title: `Fc/Fc(max) ≤ ${b.fcRatioMax.toFixed(3)} · ${b.n} reflections · K ${b.k.toFixed(3)} · GooF ${b.goof.toFixed(2)}`,
              flagged: i === strongest ? ext.strongBinK < 0.95 : Math.abs(b.k - 1) > 0.1 && i > 0,
            }))}
          />
          <span style={{ fontSize: fz.micro, fontWeight: 600, color: color.ink, marginTop: 2 }}>GooF</span>
          <Bars
            items={v.bins.map((b) => ({ label: b.fcRatioMax.toFixed(2), value: b.goof, title: `${b.n} reflections`, flagged: b.goof > 1.3 }))}
            max={1.2 * Math.max(1.3, ...v.bins.map((b) => b.goof))}
            reference={1}
            referenceLabel="1.0"
            axisLabel="bin upper edge, Fc/Fc(max)"
            height={74}
          />
        </Section>
      </Row>

      <Row>
        <Section title="Fo² vs Fc²" right={<ScatterToolbar scale={scale} quantity={quantity} onScale={setScale} onQuantity={setQuantity} />} style={col(4, 280)}>
          <FobsFcalc rows={rows} selected={props.selected} onHighlight={props.onSelect} maxWidth={330} scale={scale} quantity={quantity} toolbar={false} compact />
        </Section>
        <Section
        style={col(7, 440)}
        title={<Tabs options={[{ id: "shells", label: "Resolution shells" }, { id: "outliers", label: pattern ? <>Outliers <span title="The outliers share a pattern" style={{ display: "inline-block", width: 7, height: 7, borderRadius: 999, background: color.flag, verticalAlign: 2 }} /></> : "Outliers" }] as const} value={table} onChange={setTable} />}
        info={table === "shells" ? SHELLS_INFO : OUTLIERS_INFO}
        subtitle={table === "shells" ? "data quality | model quality" : "(Fo² − Fc²)/σ"}
      >
        {table === "shells" ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ ...tableStyle, minWidth: 470 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>d (Å)</th>
                  <th style={th}>N</th>
                  <th style={th}>Compl.</th>
                  <th style={th}>⟨I/σ⟩</th>
                  <th style={{ ...th, borderRight: `1px solid ${color.border}` }}>R_int</th>
                  <th style={th}>K</th>
                  <th style={th}>GooF</th>
                  <th style={th}>R1</th>
                </tr>
              </thead>
              <tbody>
                {v.shells.map((s, i) => {
                  const kOff = Math.abs(s.k - 1) > 0.05;
                  const gOff = s.goof > 1.3;
                  return (
                    <tr key={i}>
                      <td style={{ ...td, textAlign: "left" }}>{i === 0 ? "∞" : s.dMax.toFixed(2)} – {s.dMin.toFixed(2)}</td>
                      <td style={td}>{s.n}</td>
                      <td style={{ ...td, ...(s.completeness !== undefined && s.completeness < 0.95 ? flagCell : {}) }}>{s.completeness !== undefined ? pct(s.completeness, 1) : "—"}</td>
                      <td style={td}>{s.iOverSigma.toFixed(1)}</td>
                      <td style={{ ...td, borderRight: `1px solid ${color.border}` }}>{s.rInt !== undefined ? pct(s.rInt, 1) : "—"}</td>
                      <td style={{ ...td, ...(kOff ? flagCell : {}) }}>{s.k.toFixed(3)}</td>
                      <td style={{ ...td, ...(gOff ? flagCell : {}) }}>{s.goof.toFixed(2)}</td>
                      <td style={td}>{pct(s.r1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            {props.outlierFilter}
            {pattern ? (
              <div style={{ background: color.noteBg, border: `1px solid ${color.noteBorder}`, borderRadius: 7, padding: "5px 9px", fontSize: fz.micro, color: color.noteInk, lineHeight: 1.45 }}>
                <b>Pattern:</b> {pattern}
              </div>
            ) : null}
            <div style={{ overflowX: "auto" }}>
              <table style={{ ...tableStyle, minWidth: 420 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>hkl</th>
                    <th style={th}>sinθ/λ</th>
                    <th style={th}>Fc/Fc(max)</th>
                    <th style={th}>Fo²</th>
                    <th style={th}>Fc²</th>
                    <th style={th}>Δ/σ</th>
                  </tr>
                </thead>
                <tbody>
                  {v.outliers.slice(0, 8).map((o) => {
                    const isSel = props.selected?.kind !== "magnetic" && props.selected?.hkl === hkl(o);
                    return (
                      <tr
                        key={hkl(o)}
                        onClick={() => props.onSelect(isSel ? null : { hkl: hkl(o), kind: "nuclear" })}
                        style={{ cursor: "pointer", background: isSel ? color.primaryTintBg : undefined }}
                        aria-selected={isSel}
                      >
                        <td style={{ ...td, textAlign: "left" }}>({hkl(o)})</td>
                        <td style={td}>{o.sinThetaOverLambda.toFixed(3)}</td>
                        <td style={td}>{o.fcRatio.toFixed(3)}</td>
                        <td style={td}>{o.foSq.toFixed(1)}</td>
                        <td style={td}>{o.fcSq.toFixed(1)}</td>
                        <td style={{ ...td, fontWeight: 600, color: Math.abs(o.z) > 5 ? color.warnInk : Math.abs(o.z) > 3 ? color.noteInk : color.secondary }}>{o.z >= 0 ? "+" : "−"}{Math.abs(o.z).toFixed(1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
      </Row>
    </div>
  );
}

/**
 * A one-line reading of the significant outliers when they share a direction
 * and a population: strong and low on Fo² (extinction, the same test as the
 * verdict), or weak and high on Fo² (twinning, background, a missing supercell).
 */
function outlierPattern(v: ScValidation): string | null {
  const ext = v.extinction;
  if (ext.suspected) {
    return `${ext.strongUnder} of the ${ext.outliers} largest outliers are strong reflections with Fo² < Fc², and K is ${ext.strongBinK.toFixed(2)} in the strongest bin. That is the extinction signature, not random error.`;
  }
  const sig = v.outliers.filter((o) => Math.abs(o.z) > 3).slice(0, 8);
  if (sig.length < 3) return null;
  const weakOver = sig.filter((o) => o.z > 0 && o.fcRatio < 0.15).length;
  if (weakOver >= Math.ceil(0.75 * sig.length)) {
    return `${weakOver} of the ${sig.length} largest outliers are weak reflections observed stronger than calculated: check for twinning, a background error, or a missing supercell.`;
  }
  return null;
}

const flagCell = { background: color.noteBg, color: color.noteInk };
