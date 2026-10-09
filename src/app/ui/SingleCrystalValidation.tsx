/**
 * The single-crystal page's Validation view: the verdict, the SHELX agreement
 * and data-quality set, Fo² vs Fc² (log axes by default), SHELXL's analysis of
 * variance by intensity (K and GooF), the resolution-shell table, the largest
 * outliers with where they sit, and the convergence of the last refinement.
 *
 * The analysis of variance replaces the normal-probability plot: both ask
 * whether the weights describe the scatter, but the bins say which reflections
 * are off and in which direction.
 */

import { useMemo } from "react";
import type { SpaceGroup, UnitCell } from "@/core/crystal/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { MergeStatistics } from "@/core/diffraction/merge";
import { singleCrystalValidation, type ScOutlier, type ScValidation } from "@/core/diagnostics/singleCrystalValidation";
import { singleCrystalChecks } from "@/core/diagnostics/validationChecks";
import { shelxWeights, singleCrystalAgreement } from "@/core/diffraction/singleCrystalFactors";
import { FobsFcalc } from "@/app/ui/QualityPlots";
import { color, fz, mono } from "@/app/theme";
import {
  Bars,
  ConvergenceCard,
  DivergingBars,
  Row,
  Section,
  StatGrid,
  StatTile,
  VerdictPanel,
  caption,
  col,
  tableStyle,
  td,
  th,
} from "@/app/ui/ValidationParts";

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
    () => singleCrystalChecks({ validation, goof: ag.goof, result, parameters, nonPositiveDefinite: props.nonPositiveDefinite, xray: props.xray }),
    [validation, ag.goof, result, parameters, props.nonPositiveDefinite, props.xray],
  );

  const v = validation;
  const need = v.centrosymmetric ? 10 : 8;
  const strongest = v.bins.length - 1;
  const ext = v.extinction;
  const hkl = (o: ScOutlier): string => `${o.h} ${o.k} ${o.l}`;
  const pattern = outlierPattern(v);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Row>
        <VerdictPanel verdict={verdict} style={col(7, 380)} />
        <Section title="Agreement & data" style={col(5, 300)}>
          <StatGrid>
            <StatTile value={pct(ag.r1)} label="R1 · I > 2σ" title={`${ag.observed} of ${ag.total} reflections with Fo² > 2σ`} />
            <StatTile value={pct(ag.r1All)} label="R1 · all" />
            <StatTile value={pct(ag.wr2)} label="wR2 · all F²" />
            <StatTile value={ag.goof.toFixed(2)} label="GooF" tone={verdict.checks.find((c) => c.id === "gof")?.status === "ok" ? "ok" : "note"} />
            <StatTile value={v.reflectionsPerParameter.toFixed(1)} label="refl / param" tone={v.reflectionsPerParameter >= need ? "ok" : "warn"} title={`${v.uniqueObserved} unique / ${nParams} free parameters`} />
            {v.completeness !== undefined ? <StatTile value={pct(v.completeness, 1)} label="complete" title={`to sinθ/λ ${v.sinThetaOverLambdaMax.toFixed(3)} Å⁻¹`} tone={v.completeness >= 0.95 ? "ok" : v.completeness >= 0.9 ? "note" : "warn"} /> : null}
            <StatTile value={st.redundancy > 1 ? pct(st.rInt, 1) : "—"} label="R_int" title={st.redundancy > 1 ? undefined : "no redundant observations to merge"} />
            <StatTile value={pct(st.rSigma, 1)} label="R_σ" />
          </StatGrid>
          <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.secondary }}>
            {st.observations} obs → {st.unique} unique · redundancy {st.redundancy.toFixed(2)} · d_min {Number.isFinite(v.dMin) ? v.dMin.toFixed(3) : "—"} Å (sinθ/λ {v.sinThetaOverLambdaMax.toFixed(2)} Å⁻¹) · weights 1/σ²
          </span>
          <p style={caption}>wR2 and GooF on all F² are the honest numbers; R1 is the familiar one. Data quality sits beside model quality, so a weak dataset is not mistaken for a bad model.</p>
        </Section>
      </Row>

      <Row>
        <Section title="Fo² vs Fc²" style={col(5, 300)}>
          <FobsFcalc rows={rows} selected={props.selected} onHighlight={props.onSelect} maxWidth={440} />
        </Section>
        <Section title="By intensity" subtitle="equal-count bins, weak → strong" style={col(5, 300)}>
          <span style={{ fontSize: fz.micro, fontWeight: 600, color: color.ink }}>K = ⟨Fo²⟩/⟨Fc²⟩ <span style={{ fontWeight: 400, color: color.secondary }}>· deviation from 1</span></span>
          <DivergingBars
            centre={1}
            span={Math.max(0.2, ...v.bins.slice(1).map((b) => Math.abs(b.k - 1)))}
            centreLabel="1.00"
            items={v.bins.map((b, i) => ({
              label: b.fcRatioMax.toFixed(2),
              value: b.k,
              text: b.k.toFixed(2),
              title: `Fc/Fc(max) ≤ ${b.fcRatioMax.toFixed(3)} · ${b.n} reflections · K ${b.k.toFixed(3)} · GooF ${b.goof.toFixed(2)}`,
              flagged: i === strongest ? ext.strongBinK < 0.95 : Math.abs(b.k - 1) > 0.1 && i > 0,
            }))}
          />
          <span style={{ fontSize: fz.micro, fontWeight: 600, color: color.ink, marginTop: 4 }}>GooF</span>
          <Bars
            items={v.bins.map((b) => ({ label: b.fcRatioMax.toFixed(2), value: b.goof, title: `${b.n} reflections`, flagged: b.goof > 1.3 }))}
            max={1.2 * Math.max(1.3, ...v.bins.map((b) => b.goof))}
            reference={1}
            referenceLabel="1.0"
            axisLabel="bin upper edge, Fc/Fc(max)"
            height={104}
          />
          <p style={caption}>
            SHELXL's analysis of variance. A flat GooF near 1 means the weights describe the scatter. K below 1 in the strongest bin is extinction; GooF rising with intensity alone means the weighting scheme. The weakest bin's K is noisy because Fo² there is close to zero.
          </p>
        </Section>
      </Row>

      <Section title="Resolution shells" subtitle="equal-count shells, low angle first · data quality | model quality">
        <div style={{ overflowX: "auto" }}>
          <table style={{ ...tableStyle, minWidth: 560 }}>
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
        <p style={caption}>
          K = ⟨Fo²⟩/⟨Fc²⟩. K below 1 with a high GooF only at low angle is extinction (or the beamstop); K drifting across every shell points to the ADPs, absorption or scattering factors. R_int and ⟨I/σ⟩ show where the data run out.
        </p>
      </Section>

      <Section title="Largest outliers" subtitle="(Fo² − Fc²)/σ">
        {pattern ? (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: color.noteBg, border: `1px solid ${color.noteBorder}`, borderRadius: 8, padding: "7px 10px", fontSize: fz.small, color: color.noteInk, lineHeight: 1.45 }}>
            <span><b>Pattern:</b> {pattern}</span>
          </div>
        ) : null}
        <div style={{ overflowX: "auto" }}>
          <table style={{ ...tableStyle, minWidth: 520 }}>
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
              {v.outliers.map((o) => {
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
        <p style={caption}>Click a row to find it in the Fo² vs Fc² plot. Before omitting a reflection, check the pattern: outliers explained by extinction or absorption should be modelled, not rejected.</p>
      </Section>

      <ConvergenceCard result={result} parameters={parameters} />
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
