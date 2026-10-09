/**
 * The powder page's Validation view, laid out to read on one screen: the
 * verdict beside the Rietveld agreement set, where the misfit sits (normalized
 * residual and cumulative χ² on the pattern's axis), then χ² by d-shell beside
 * the reflections that carry the most χ². Convergence detail lives in the
 * verdict and the parameter panel's Result footer, not in a card of its own.
 *
 * Deliberately absent: an F_obs vs F_calc scatter. Powder I_obs is split
 * between overlapping peaks in proportion to I_calc, so the scatter leans
 * toward the model; the per-phase R_Bragg keeps the same caveat and says so.
 */

import { useMemo, useState } from "react";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { PhaseTicks } from "@/visualization/reflectionTicks";
import { clientToSvgUser } from "@/visualization/hitTest";
import {
  phaseAgreement,
  powderValidation,
  unindexedPeaks,
  worstReflections,
  type MisfitSignature,
  type PowderValidation,
  type UnindexedPeak,
} from "@/core/diagnostics/powderValidation";
import { powderChecks, type CheckAction } from "@/core/diagnostics/validationChecks";
import { color, fz, mono } from "@/app/theme";
import {
  Bars,
  Metric,
  MetricGrid,
  Row,
  useElementWidth,
  Section,
  VerdictPanel,
  caption,
  col,
  linkButton,
  tableStyle,
  td,
  th,
} from "@/app/ui/ValidationParts";

const AGREEMENT_INFO = "Rwp is judged against Rexp: their ratio is the GoF (Toby 2006). With the background subtracted (Rwp′, Rexp′) the same misfit is measured against the peaks alone. Durbin–Watson d ≈ 2 for uncorrelated residuals; below Q_D (Hill & Flack 1987) neighbouring points miss together — a profile misfit, and esds that are too small. R_Bragg and R_F come from the Rietveld split of I_obs, so overlapped reflections lean toward the model: compare phases with them, don't quote them as proof.";
const STRIP_INFO = "Top: (y_obs − y_calc)/σ per point, the ±3σ band shaded. Bottom: the running χ² as a share of the total. Noise alone climbs as a straight ramp; steps are where the model misses, and the numbered steps are the rows of Worst peaks. Click the strip to open that spot in the Refinement view.";
const SHELL_INFO = "χ² per point in equal-count shells of d. Near 1 is noise. Misfit concentrated at short d points to the ADPs or an absorption/roughness correction; at long d, to peak shape, asymmetry or preferred orientation.";
const WORST_INFO = "Each point's χ² is shared among the reflections in proportion to their calculated intensity there. The signature reads the residual under the peak: ± lobes mean position, width or asymmetry; a one-signed residual means intensity. Several reflections of one hkl family on the same side suggest preferred orientation.";

/** Worst-peak rows shown before "all". */
const WORST_SHOWN = 4;

export interface PowderValidationProps {
  /** Native-unit curves of the page (total calc, background included). */
  readonly x: readonly number[];
  readonly yObs: readonly number[];
  readonly yCalc: readonly number[];
  readonly yBackground?: readonly number[];
  readonly sigma: readonly number[];
  /** Points that enter the fit. */
  readonly include: readonly boolean[];
  /** d-spacing of every point, when the axis converts. */
  readonly d?: readonly number[];
  /** The data carry their own σ (so residual peaks can be tested for significance). */
  readonly hasSigma: boolean;
  readonly nParams: number;
  /** Rows of the Rietveld partition, built with χ² attribution. */
  readonly reflections: readonly ReflectionObsCalc[];
  /** Bragg tick rows in the display unit (also the reflection list that indexes residual peaks). */
  readonly phaseTicks: readonly PhaseTicks[];
  /** Native x → display x, and the display axis label. */
  readonly toDisplay: (x: number) => number;
  readonly displayLabel: string;
  readonly result: RefinementResult | null;
  readonly parameters: readonly RefinementParameter[];
  /** Open the pattern zoomed on a reflection. */
  readonly onLocateReflection?: (row: ReflectionObsCalc) => void;
  /** Open the pattern zoomed on a native x. */
  readonly onLocateX?: (x: number) => void;
  readonly onAction?: (action: CheckAction) => void;
  readonly canExport?: boolean;
}

const SIGNATURE: Record<MisfitSignature, string> = {
  shape: "± lobes · shape/position",
  under: "under-calculated",
  over: "over-calculated",
};

function pct(v: number | undefined, digits = 2): string {
  return v === undefined || !Number.isFinite(v) ? "—" : `${(100 * v).toFixed(digits)}%`;
}

export function PowderValidationView(props: PowderValidationProps): JSX.Element {
  const { x, yObs, yCalc, yBackground, sigma, include, d, nParams, reflections, phaseTicks, result, parameters } = props;

  const validation = useMemo(
    () => powderValidation({ x, yObs, yCalc, ...(yBackground ? { yBackground } : {}), sigma, include, nParams, ...(d ? { d } : {}) }),
    [x, yObs, yCalc, yBackground, sigma, include, nParams, d],
  );
  const indexed = useMemo(
    () => phaseTicks.flatMap((p) => p.ticks.map((t) => ({ d: t.d, hkl: t.hkl, phaseLabel: p.label }))),
    [phaseTicks],
  );
  const unindexed = useMemo<UnindexedPeak[]>(
    () => (d ? unindexedPeaks(d, yObs, yCalc, validation, indexed, props.hasSigma ? { pointSigma: sigma } : {}) : []),
    [d, yObs, yCalc, validation, indexed, props.hasSigma, sigma],
  );
  const phases = useMemo(() => phaseAgreement(reflections), [reflections]);
  const worst = useMemo(() => worstReflections(reflections, validation.chi2, 8), [reflections, validation.chi2]);
  const verdict = useMemo(
    () => powderChecks({ validation, unindexed, result, parameters, canExport: props.canExport ?? false }),
    [validation, unindexed, result, parameters, props.canExport],
  );

  const phaseColor = (id: string): string => phaseTicks.find((p) => p.id === id)?.color ?? color.primary;
  const onAction = (a: CheckAction): void => {
    if (a === "show-unindexed" && unindexed[0]) props.onLocateX?.(x[unindexed[0].index]!);
    else props.onAction?.(a);
  };

  // Worst list: reflections and unindexed peaks together, by χ² share.
  type Entry =
    | { kind: "reflection"; share: number; row: ReflectionObsCalc; signature: MisfitSignature }
    | { kind: "unindexed"; share: number; peak: UnindexedPeak };
  const entries: Entry[] = [
    ...worst.map((w) => ({ kind: "reflection" as const, share: w.share, row: w.row, signature: w.signature })),
    ...unindexed.map((p) => ({ kind: "unindexed" as const, share: p.share, peak: p })),
  ].sort((a, b) => b.share - a.share).slice(0, 8);
  const entryX = (e: Entry): number | undefined => {
    if (e.kind === "unindexed") return props.toDisplay(x[e.peak.index]!);
    const id = e.row.kind === "magnetic" ? "magnetic" : e.row.phaseId;
    const hkl = `${e.row.h} ${e.row.k} ${e.row.l}`;
    return phaseTicks.find((p) => p.id === id)?.ticks.find((t) => t.hkl === hkl)?.x;
  };
  const markers = entries.map((e, i) => ({ n: i + 1, x: entryX(e), unindexed: e.kind === "unindexed" }));
  const shareTop = entries.reduce((a, e) => a + e.share, 0);

  const ag = validation.agreement;
  const dw = validation.durbinWatson;
  const refCount = phases.reduce((a, p) => a + p.reflections, 0);
  const meanChi2 = ag.n > 0 ? validation.chi2 / ag.n : 0;

  const [allWorst, setAllWorst] = useState(false);
  const shownEntries = allWorst ? entries : entries.slice(0, WORST_SHOWN);
  // Per-phase rows only when there is more than one series to compare; a
  // single phase puts its R_Bragg/R_F into the metric grid.
  const single = phases.length === 1 ? phases[0] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Row>
        <VerdictPanel verdict={verdict} onAction={onAction} style={col(6, 360)} />
        <Section
          title="Agreement"
          info={AGREEMENT_INFO}
          subtitle={`${ag.n.toLocaleString()} points · ${refCount} refl · ${nParams} free`}
          style={col(5, 300)}
        >
          <MetricGrid>
            <Metric value={pct(ag.rwp)} label="Rwp" />
            <Metric value={pct(ag.rexp)} label="Rexp" />
            <Metric value={ag.gof.toFixed(2)} label={`GoF · χ²ᵥ ${ag.chi2nu.toFixed(1)}`} tone={ag.gof < 1 ? "note" : ag.gof <= 1.5 ? "ok" : ag.gof <= 2.5 ? "note" : "warn"} />
            <Metric value={pct(ag.rp)} label="Rp" />
            {ag.rwpBkg !== undefined ? <Metric value={pct(ag.rwpBkg)} label="Rwp′ bkg-sub" title="Σw(y_o − y_c)² over Σw(y_o − y_b)²" /> : null}
            {ag.rexpBkg !== undefined ? <Metric value={pct(ag.rexpBkg)} label="Rexp′ bkg-sub" /> : null}
            {dw ? <Metric value={dw.d.toFixed(2)} label={`DW · Q_D ${dw.qd.toFixed(2)}`} tone={dw.correlated ? "warn" : "ok"} title="Durbin–Watson d against Hill & Flack's critical value" /> : null}
            {single ? <Metric value={pct(single.rBragg)} label="R_Bragg" /> : null}
            {single ? <Metric value={pct(single.rF)} label="R_F" /> : null}
          </MetricGrid>
          {phases.length > 1 ? (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>Phase</th>
                  <th style={th}>R_Bragg</th>
                  <th style={th}>R_F</th>
                  <th style={th}>N</th>
                </tr>
              </thead>
              <tbody>
                {phases.map((p) => (
                  <tr key={p.phaseId}>
                    <td style={{ ...td, textAlign: "left", fontFamily: "inherit" }}><Dot color={phaseColor(p.phaseId)} />{p.label}</td>
                    <td style={td}>{pct(p.rBragg)}</td>
                    <td style={td}>{pct(p.rF)}</td>
                    <td style={td}>{p.reflections}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Section>
      </Row>

      <Section
        title="Where the misfit is"
        info={STRIP_INFO}
        subtitle="(y_obs − y_calc)/σ and cumulative χ² · click to open in the pattern"
        id="validation-residual"
      >
        <ResidualStrip
          x={x}
          validation={validation}
          include={include}
          toDisplay={props.toDisplay}
          displayLabel={props.displayLabel}
          phaseTicks={phaseTicks}
          markers={markers}
          {...(props.onLocateX ? { onLocateX: props.onLocateX } : {})}
        />
      </Section>

      <Row>
        <Section title="χ² per point" info={SHELL_INFO} subtitle={validation.shellAxis === "d" ? "by d-shell" : "by shell"} style={col(4, 260)}>
          <Bars
            items={validation.shells.map((s) => ({
              label: s.lo.toFixed(validation.shellAxis === "d" ? 2 : 1),
              value: s.chi2PerPoint,
              text: s.chi2PerPoint.toFixed(1),
              title: `${s.lo.toFixed(3)} – ${s.hi.toFixed(3)} · ${s.n} points · ${(100 * s.share).toFixed(1)}% of χ²`,
              flagged: s.chi2PerPoint > 1.5 && s.chi2PerPoint > 1.25 * meanChi2,
            }))}
            max={1.18 * Math.max(1.2, ...validation.shells.map((s) => s.chi2PerPoint))}
            reference={1}
            referenceLabel="noise"
            axisLabel={validation.shellAxis === "d" ? "shell start, d (Å)" : `shell start, ${props.displayLabel}`}
          />
        </Section>

        <Section
          title="Worst peaks"
          info={WORST_INFO}
          subtitle={entries.length > 0 ? `share of χ² · top ${entries.length} carry ${pct(shareTop, 0)}` : undefined}
          right={entries.length > WORST_SHOWN ? (
            <button style={{ ...linkButton, padding: 0, fontSize: fz.micro }} onClick={() => setAllWorst((v) => !v)}>
              {allWorst ? "fewer" : `all ${entries.length}`}
            </button>
          ) : undefined}
          style={col(7, 420)}
        >
          {entries.length === 0 ? (
            <p style={caption}>No reflection list to attribute the misfit to.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ ...tableStyle, minWidth: 470 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>#</th>
                    <th style={{ ...th, textAlign: "left" }}>Reflection</th>
                    <th style={th}>d (Å)</th>
                    <th style={th} title="Rietveld-partitioned I_obs over I_calc">I_o/I_c</th>
                    <th style={th}>χ²</th>
                    <th style={{ ...th, textAlign: "left" }}>Signature</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {shownEntries.map((e, i) => (
                    <tr key={e.kind === "unindexed" ? `u${e.peak.index}` : `${e.row.phaseId}:${e.row.h},${e.row.k},${e.row.l}:${e.row.kind}`}>
                      <td style={{ ...td, textAlign: "left" }}><Badge n={i + 1} /></td>
                      {e.kind === "reflection" ? (
                        <>
                          <td style={{ ...td, textAlign: "left" }}>
                            <Dot color={phaseColor(e.row.kind === "magnetic" ? "magnetic" : e.row.phaseId ?? "")} />({e.row.h} {e.row.k} {e.row.l})
                          </td>
                          <td style={td}>{e.row.d.toFixed(4)}</td>
                          <td style={td}>{e.row.iCalc > 0 ? (e.row.iObs / e.row.iCalc).toFixed(2) : "—"}</td>
                          <td style={td}>{pct(e.share, 1)}</td>
                          <td style={{ ...td, textAlign: "left", fontFamily: "inherit", color: color.secondary }}>{SIGNATURE[e.signature]}</td>
                          <td style={td}>{props.onLocateReflection ? <button style={{ ...linkButton, padding: 0 }} onClick={() => props.onLocateReflection!(e.row)}>view →</button> : null}</td>
                        </>
                      ) : (
                        <>
                          <td style={{ ...td, textAlign: "left", fontFamily: "inherit", color: color.warnInk }}>unindexed</td>
                          <td style={td}>{e.peak.d.toFixed(4)}</td>
                          <td style={td}>—</td>
                          <td style={td}>{pct(e.share, 1)}</td>
                          <td style={{ ...td, textAlign: "left", fontFamily: "inherit", color: color.warnInk }}>no reflection here</td>
                          <td style={td}>{props.onLocateX ? <button style={{ ...linkButton, padding: 0 }} onClick={() => props.onLocateX!(x[e.peak.index]!)}>view →</button> : null}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </Row>
    </div>
  );
}

function Dot({ color: c }: { color: string }): JSX.Element {
  return <span aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: c, marginRight: 6, verticalAlign: 0 }} />;
}

function Badge({ n }: { n: number }): JSX.Element {
  return <span style={{ display: "inline-flex", width: 17, height: 17, borderRadius: 999, background: color.flag, color: "#fff", fontSize: 10, fontWeight: 600, alignItems: "center", justifyContent: "center" }}>{n}</span>;
}

/** 1-2-5 ticks covering [lo, hi]. */
function niceTicks(lo: number, hi: number, target = 8): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9 * span; t += step) out.push(+t.toPrecision(12));
  return out;
}

const X0 = 46;
const DELTA_LIM = 8;
/** δ panel: centre line and px per σ (±DELTA_LIM spans 92 px). */
const D_MID = 56;
const D_SCALE = 5.75;

/**
 * δ = (y_obs − y_calc)/σ as a per-pixel min/max envelope with the ±3σ band,
 * the Bragg tick rows, and the cumulative χ² beneath, on the display axis.
 */
function ResidualStrip({ x, validation, include, toDisplay, displayLabel, phaseTicks, markers, onLocateX }: {
  x: readonly number[];
  validation: PowderValidation;
  include: readonly boolean[];
  toDisplay: (x: number) => number;
  displayLabel: string;
  phaseTicks: readonly PhaseTicks[];
  markers: readonly { n: number; x: number | undefined; unindexed: boolean }[];
  onLocateX?: (x: number) => void;
}): JSX.Element {
  // Draw in true pixels: the strip keeps its height and its text size however
  // wide the card is (a fixed viewBox would scale both with the width).
  const [boxRef, W] = useElementWidth(900);
  const X1 = Math.max(X0 + 120, W - 12);
  const geom = useMemo(() => {
    const idx: number[] = [];
    const dx: number[] = [];
    for (let i = 0; i < x.length; i++) {
      if (!include[i] || Number.isNaN(validation.delta[i]!)) continue;
      const v = toDisplay(x[i]!);
      if (!Number.isFinite(v)) continue;
      idx.push(i);
      dx.push(v);
    }
    if (idx.length === 0) return null;
    const lo = Math.min(...dx);
    const hi = Math.max(...dx);
    const span = hi - lo || 1;
    const px = (v: number): number => X0 + ((v - lo) / span) * (X1 - X0);
    const cols = X1 - X0;
    const cMin = new Float64Array(cols).fill(Infinity);
    const cMax = new Float64Array(cols).fill(-Infinity);
    const cWorst = new Int32Array(cols).fill(-1);
    // Cumulative χ² in display order (left to right), whatever the native order.
    const order = idx.map((_, j) => j).sort((a, b) => dx[a]! - dx[b]!);
    const cum = new Float64Array(cols).fill(Number.NaN);
    const total = validation.chi2 || 1;
    let run = 0;
    for (const j of order) {
      const i = idx[j]!;
      const dl = validation.delta[i]!;
      run += dl * dl;
      const c = Math.min(cols - 1, Math.max(0, Math.floor(((dx[j]! - lo) / span) * cols)));
      if (dl < cMin[c]!) cMin[c] = dl;
      if (dl > cMax[c]!) cMax[c] = dl;
      if (cWorst[c]! < 0 || Math.abs(dl) > Math.abs(validation.delta[cWorst[c]!]!)) cWorst[c] = i;
      cum[c] = run / total;
    }
    // Carry the running total across empty columns.
    let last = 0;
    for (let c = 0; c < cols; c++) {
      if (Number.isNaN(cum[c]!)) cum[c] = last;
      else last = cum[c]!;
    }
    return { lo, hi, px, cMin, cMax, cWorst, cum, cols };
  }, [x, include, validation, toDisplay, X1]);

  if (!geom) return <p style={caption}>No fitted points.</p>;
  const { lo, hi, px, cMin, cMax, cWorst, cum, cols } = geom;
  const yD = (v: number): number => D_MID - Math.max(-DELTA_LIM, Math.min(DELTA_LIM, v)) * D_SCALE;
  const rows = phaseTicks.filter((p) => p.ticks.length > 0);
  const tickTop = yD(-DELTA_LIM) + 6;
  const cumTop = tickTop + rows.length * 10 + 10;
  const cumH = 40;
  const H = cumTop + cumH + 26;
  const yC = (f: number): number => cumTop + cumH - f * (cumH - 4);

  let env = "";
  for (let c = 0; c < cols; c++) {
    if (cMin[c]! === Infinity) continue;
    const xx = (X0 + c + 0.5).toFixed(1);
    const a = yD(cMax[c]!);
    const b = Math.max(yD(cMin[c]!), a + 0.8);
    env += `M${xx} ${a.toFixed(1)}V${b.toFixed(1)}`;
  }
  let cumPath = "";
  for (let c = 0; c < cols; c++) cumPath += `${c === 0 ? "M" : "L"}${(X0 + c + 0.5).toFixed(1)} ${yC(cum[c]!).toFixed(1)}`;
  const colOf = (v: number): number => Math.min(cols - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo || 1)) * cols)));

  const onClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!onLocateX) return;
    const at = clientToSvgUser(e.currentTarget, e.clientX, e.clientY, { width: W, height: H });
    if (at.x < X0 || at.x > X1) return;
    // The worst point within a few pixels of the click.
    const c0 = Math.floor(at.x - X0);
    let best = -1;
    for (let c = Math.max(0, c0 - 3); c <= Math.min(cols - 1, c0 + 3); c++) {
      const i = cWorst[c]!;
      if (i >= 0 && (best < 0 || Math.abs(validation.delta[i]!) > Math.abs(validation.delta[best]!))) best = i;
    }
    if (best >= 0) onLocateX(x[best]!);
  };

  return (
    <div ref={boxRef}>
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ width: "100%", height: H, display: "block", cursor: onLocateX ? "pointer" : undefined }} role="img" aria-label="Normalized residual and cumulative chi-square along the pattern" onClick={onClick}>
      <rect x={X0} y={yD(3)} width={X1 - X0} height={yD(-3) - yD(3)} fill={color.chipBg} />
      <line x1={X0} y1={D_MID} x2={X1} y2={D_MID} stroke={color.control} strokeWidth={1} />
      <line x1={X0} y1={yD(DELTA_LIM)} x2={X0} y2={yD(-DELTA_LIM)} stroke={color.border} strokeWidth={1} />
      <path d={env} stroke={color.ink} strokeWidth={1} opacity={0.75} />
      <g fontSize={10} fill={color.secondary} fontFamily={mono} textAnchor="end">
        <text x={X0 - 5} y={yD(3) + 3.5}>+3</text>
        <text x={X0 - 5} y={D_MID + 3.5}>0</text>
        <text x={X0 - 5} y={yD(-3) + 3.5}>−3</text>
        <text x={X0 - 5} y={yD(DELTA_LIM) + 3.5}>+{DELTA_LIM}</text>
        <text x={X0 - 5} y={yD(-DELTA_LIM) + 3.5}>−{DELTA_LIM}</text>
      </g>
      <text x={12} y={D_MID} textAnchor="middle" fontSize={11} fill={color.secondary} transform={`rotate(-90 12 ${D_MID})`}>Δ/σ</text>

      {rows.map((p, r) => {
        const y = tickTop + r * 10;
        let path = "";
        for (const t of p.ticks) if (t.x >= lo && t.x <= hi) path += `M${px(t.x).toFixed(1)} ${y}v7`;
        return (
          <g key={p.id}>
            <path d={path} stroke={p.color} strokeWidth={1} />
            <text x={X0 - 5} y={y + 7} textAnchor="end" fontSize={9} fontFamily={mono} fill={color.secondary}>{p.label.length > 7 ? `${p.label.slice(0, 6)}…` : p.label}</text>
          </g>
        );
      })}

      <line x1={X0} y1={cumTop + cumH} x2={X1} y2={cumTop + cumH} stroke={color.control} strokeWidth={1} />
      <line x1={X0} y1={yC(1)} x2={X1} y2={yC(1)} stroke={color.subtle} strokeWidth={1} strokeDasharray="2 4" />
      <path d={cumPath} fill="none" stroke={color.primary} strokeWidth={1.6} strokeLinejoin="round" />
      <g fontSize={10} fill={color.secondary} fontFamily={mono} textAnchor="end">
        <text x={X0 - 5} y={yC(1) + 3.5}>100%</text>
        <text x={X0 - 5} y={cumTop + cumH + 3.5}>0</text>
      </g>
      <text x={12} y={cumTop + cumH / 2} textAnchor="middle" fontSize={11} fill={color.secondary} transform={`rotate(-90 12 ${cumTop + cumH / 2})`}>cum. χ²</text>

      {markers.map((m) => {
        if (m.x === undefined || m.x < lo || m.x > hi) return null;
        const xx = px(m.x);
        const f = cum[Math.min(cols - 1, colOf(m.x) + 2)]!;
        const cy = Math.max(cumTop + 1, yC(f) - 9);
        return (
          <g key={m.n} pointerEvents="none">
            {m.unindexed ? <path d={`M${xx - 5} ${yD(DELTA_LIM) - 9}l5 7l5 -7z`} fill={color.warnInk} /> : null}
            <circle cx={xx} cy={cy} r={6.5} fill={color.flag} />
            <text x={xx} y={cy + 3.2} textAnchor="middle" fontSize={9} fontWeight={600} fill="#fff" fontFamily={mono}>{m.n}</text>
          </g>
        );
      })}

      <g fontSize={10} fill={color.secondary} fontFamily={mono} textAnchor="middle">
        {niceTicks(lo, hi).map((t) => (
          <text key={t} x={px(t)} y={H - 12}>{+t.toPrecision(6)}</text>
        ))}
      </g>
      <text x={X1} y={H - 1} textAnchor="end" fontSize={10} fill={color.secondary}>{displayLabel}</text>
    </svg>
    </div>
  );
}
