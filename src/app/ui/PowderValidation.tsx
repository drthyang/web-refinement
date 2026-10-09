/**
 * The powder page's Validation view: the verdict, the Rietveld agreement set,
 * where the misfit sits (normalized residual and cumulative χ² on the pattern's
 * axis, χ² by d-shell, the reflections that carry the most χ²), and the
 * convergence of the last refinement.
 *
 * Deliberately absent: an F_obs vs F_calc scatter. Powder I_obs is split
 * between overlapping peaks in proportion to I_calc, so the scatter leans
 * toward the model; the per-phase R_Bragg keeps the same caveat and says so.
 */

import { useMemo } from "react";
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
  ConvergenceCard,
  KV,
  Row,
  Section,
  StatGrid,
  StatTile,
  VerdictPanel,
  caption,
  col,
  linkButton,
  tableStyle,
  td,
  th,
} from "@/app/ui/ValidationParts";

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 4 }}>
      <Row>
        <VerdictPanel verdict={verdict} onAction={onAction} style={col(7, 380)} />
        <Section title="Agreement" style={col(5, 300)}>
          <StatGrid>
            <StatTile value={pct(ag.rp)} label="Rp" />
            <StatTile value={pct(ag.rwp)} label="Rwp" />
            <StatTile value={pct(ag.rexp)} label="Rexp" />
            <StatTile value={ag.gof.toFixed(2)} label={`GoF · χ²ᵥ ${ag.chi2nu.toFixed(2)}`} tone={ag.gof < 1 ? "note" : ag.gof <= 1.5 ? "ok" : ag.gof <= 2.5 ? "note" : "warn"} />
            {ag.rwpBkg !== undefined ? <StatTile value={pct(ag.rwpBkg)} label="Rwp′ bkg-sub" title="Background subtracted: Σw(y_o − y_c)² over Σw(y_o − y_b)²" /> : null}
            {ag.rexpBkg !== undefined ? <StatTile value={pct(ag.rexpBkg)} label="Rexp′ bkg-sub" /> : null}
            {dw ? <StatTile value={dw.d.toFixed(2)} label={`Durbin–Watson · Q_D ${dw.qd.toFixed(2)}`} tone={dw.correlated ? "warn" : "ok"} title="d ≈ 2 for uncorrelated residuals; below Q_D, neighbouring points miss together (Hill & Flack 1987)" /> : null}
          </StatGrid>
          <span style={{ fontFamily: mono, fontSize: fz.micro, color: color.secondary }}>
            {ag.n.toLocaleString()} points · {refCount} reflections · {nParams} free parameters
          </span>
          {phases.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>Phase</th>
                    <th style={th}>R_Bragg</th>
                    <th style={th}>R_F</th>
                    <th style={th}>N_refl</th>
                  </tr>
                </thead>
                <tbody>
                  {phases.map((p) => (
                    <tr key={p.phaseId}>
                      <td style={{ ...td, textAlign: "left", fontFamily: "inherit" }}>
                        <Dot color={phaseColor(p.phaseId)} />{p.label}
                      </td>
                      <td style={td}>{pct(p.rBragg)}</td>
                      <td style={td}>{pct(p.rF)}</td>
                      <td style={td}>{p.reflections}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p style={caption}>R_Bragg and R_F use the Rietveld split of I_obs, so overlapped reflections lean toward the model. Compare phases with them; don't quote them as proof.</p>
        </Section>
      </Row>

      <Section title="Where the misfit is" subtitle="normalized residual (y_obs − y_calc)/σ and cumulative χ²" id="validation-residual">
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
        <p style={caption}>
          Noise alone climbs the cumulative χ² as a straight ramp; steps are where the model misses. Numbered steps are the rows of the worst-peaks table. Click anywhere on the strip to open that spot in the Refinement view.
        </p>
      </Section>

      <Row>
        <Section title="χ² per point by shell" subtitle={validation.shellAxis === "d" ? "equal-count d-shells" : "equal-count shells"} style={col(5, 300)}>
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
          <p style={caption}>Misfit concentrated at short d points to the ADPs or an absorption/roughness correction; at long d, to peak shape, asymmetry or preferred orientation.</p>
        </Section>

        <Section title="Worst peaks" subtitle={entries.length > 0 ? `by share of χ² · these ${entries.length} carry ${pct(shareTop, 0)}` : undefined} style={col(7, 420)}>
          {entries.length === 0 ? (
            <p style={caption}>No reflection list to attribute the misfit to.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ ...tableStyle, minWidth: 520 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>#</th>
                    <th style={{ ...th, textAlign: "left" }}>Reflection</th>
                    <th style={th}>d (Å)</th>
                    <th style={th}>I_obs/I_calc</th>
                    <th style={th}>χ² share</th>
                    <th style={{ ...th, textAlign: "left" }}>Signature</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
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
                          <td style={{ ...td, textAlign: "left", fontFamily: "inherit", color: color.warnInk }}>+ peak · no reflection here</td>
                          <td style={td}>{props.onLocateX ? <button style={{ ...linkButton, padding: 0 }} onClick={() => props.onLocateX!(x[e.peak.index]!)}>view →</button> : null}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={caption}>The signature reads the residual under each peak: ± lobes mean position, width or asymmetry; a one-signed residual means intensity. Several reflections of one hkl family on the same side suggest preferred orientation.</p>
        </Section>
      </Row>

      <ConvergenceCard
        result={result}
        parameters={parameters}
        extra={props.onAction ? (
          <KV k="Posterior vs esd" v={<button style={{ ...linkButton, padding: 0 }} onClick={() => props.onAction!("posterior")}>open Posterior</button>} />
        ) : undefined}
      />
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

const W = 1000;
const X0 = 46;
const X1 = 988;
const DELTA_LIM = 8;

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
  }, [x, include, validation, toDisplay]);

  if (!geom) return <p style={caption}>No fitted points.</p>;
  const { lo, hi, px, cMin, cMax, cWorst, cum, cols } = geom;
  const yD = (v: number): number => 82 - Math.max(-DELTA_LIM, Math.min(DELTA_LIM, v)) * 8.5;
  const rows = phaseTicks.filter((p) => p.ticks.length > 0);
  const tickTop = 158;
  const cumTop = tickTop + rows.length * 11 + 16;
  const cumH = 60;
  const H = cumTop + cumH + 30;
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
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", cursor: onLocateX ? "pointer" : undefined }} role="img" aria-label="Normalized residual and cumulative chi-square along the pattern" onClick={onClick}>
      <rect x={X0} y={yD(3)} width={X1 - X0} height={yD(-3) - yD(3)} fill={color.chipBg} />
      <line x1={X0} y1={82} x2={X1} y2={82} stroke={color.control} strokeWidth={1} />
      <line x1={X0} y1={yD(DELTA_LIM)} x2={X0} y2={yD(-DELTA_LIM)} stroke={color.border} strokeWidth={1} />
      <path d={env} stroke={color.ink} strokeWidth={1} opacity={0.75} />
      <g fontSize={10} fill={color.secondary} fontFamily={mono} textAnchor="end">
        <text x={X0 - 5} y={yD(3) + 3.5}>+3</text>
        <text x={X0 - 5} y={85.5}>0</text>
        <text x={X0 - 5} y={yD(-3) + 3.5}>−3</text>
        <text x={X0 - 5} y={yD(DELTA_LIM) + 3.5}>+{DELTA_LIM}</text>
        <text x={X0 - 5} y={yD(-DELTA_LIM) + 3.5}>−{DELTA_LIM}</text>
      </g>
      <text x={12} y={82} textAnchor="middle" fontSize={11} fill={color.secondary} transform="rotate(-90 12 82)">Δ/σ</text>

      {rows.map((p, r) => {
        const y = tickTop + r * 11;
        let path = "";
        for (const t of p.ticks) if (t.x >= lo && t.x <= hi) path += `M${px(t.x).toFixed(1)} ${y}v8`;
        return (
          <g key={p.id}>
            <path d={path} stroke={p.color} strokeWidth={1} />
            <text x={X0 - 5} y={y + 7.5} textAnchor="end" fontSize={9} fontFamily={mono} fill={color.secondary}>{p.label.length > 7 ? `${p.label.slice(0, 6)}…` : p.label}</text>
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
        const cy = Math.max(cumTop + 2, yC(f) - 10);
        return (
          <g key={m.n} pointerEvents="none">
            {m.unindexed ? <path d={`M${xx - 5} ${yD(DELTA_LIM) - 9}l5 7l5 -7z`} fill={color.warnInk} /> : null}
            <circle cx={xx} cy={cy} r={7} fill={color.flag} />
            <text x={xx} y={cy + 3.4} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#fff" fontFamily={mono}>{m.n}</text>
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
  );
}
