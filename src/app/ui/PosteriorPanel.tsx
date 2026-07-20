/**
 * Posterior view for the PDF workbench plot card: run the ensemble MCMC
 * sampler over the CURRENT free parameters (seeded at their present values —
 * refine first, then sample), and read the posterior the way the reporting
 * literature asks (McCluskey et al. 2023): credible intervals + convergence
 * evidence (split-R̂, ESS, acceptance), never a bare std. The headline column
 * is esdRatio = posterior std / linearized LM esd: ≈ 1 validates the
 * least-squares error bars; ≫ 1 means the linearization was overconfident.
 */

import { useMemo } from "react";
import type { SampleResult } from "@/core/refinement/bayes/sampler";
import type { PosteriorParamSummary } from "@/core/refinement/bayes/diagnostics";
import { color, fz, mono, primaryButton, secondaryButton, uppercaseLabel } from "@/app/theme";
import { InfoBadge } from "@/app/ui/InfoBadge";

export interface PosteriorPanelProps {
  readonly result: SampleResult | null;
  readonly busy: boolean;
  readonly progress: { step: number; total: number } | null;
  /** Kick off a run; `continueRun` resumes the existing chain. */
  readonly onRun: (continueRun: boolean) => void;
  /** A converged LM result exists (enables sampling + the esdRatio column). */
  readonly hasRefined: boolean;
  /** Parameter labels by id (falls back to the id). */
  readonly labels: ReadonlyMap<string, string>;
}

/** Tone for the esdRatio verdict: ≈1 healthy, drifting → warn ink. */
function ratioInk(ratio: number | undefined): string {
  if (ratio === undefined) return color.secondary;
  return ratio > 1.5 || ratio < 0.6 ? color.warnInk : color.okInk;
}

function rhatInk(rhat: number): string {
  return rhat < 1.05 ? color.okInk : color.warnInk;
}

/** Compact marginal histogram (SVG) from the flattened per-parameter draws. */
function Marginal({ draws, summary }: { draws: readonly number[]; summary: PosteriorParamSummary }) {
  const { bars, lo, hi } = useMemo(() => {
    const lo = summary.q025;
    const hi = summary.q975;
    const span = hi - lo || 1;
    const nBins = 24;
    const counts = new Array<number>(nBins).fill(0);
    for (const v of draws) {
      const b = Math.floor(((v - lo) / span) * nBins);
      if (b >= 0 && b < nBins) counts[b] = counts[b]! + 1;
    }
    const max = Math.max(1, ...counts);
    return { bars: counts.map((c) => c / max), lo, hi };
  }, [draws, summary]);

  const W = 132;
  const H = 34;
  const bw = W / bars.length;
  // Median marker position within the histogram span.
  const mx = ((summary.median - lo) / (hi - lo || 1)) * W;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }} aria-hidden>
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * bw + 0.5}
          y={(1 - h) * (H - 4) + 2}
          width={Math.max(bw - 1, 1)}
          height={h * (H - 4)}
          fill={color.primaryTintBorder}
        />
      ))}
      <line x1={mx} x2={mx} y1={0} y2={H} stroke={color.primary} strokeWidth={1.2} />
    </svg>
  );
}

export function PosteriorPanel({ result, busy, progress, onRun, hasRefined, labels }: PosteriorPanelProps) {
  // Flattened draws per parameter for the marginals (kept small by the panel).
  const flat = useMemo(() => {
    if (!result) return new Map<string, number[]>();
    const out = new Map<string, number[]>();
    result.freeIds.forEach((id, j) => {
      const draws: number[] = [];
      for (const walker of result.chains) for (const row of walker) draws.push(row[j]!);
      out.set(id, draws);
    });
    return out;
  }, [result]);

  const converged = result?.status === "ok";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      {/* Action row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          style={{ ...primaryButton, opacity: busy || !hasRefined ? 0.55 : 1 }}
          disabled={busy || !hasRefined}
          onClick={() => onRun(false)}
          title={
            hasRefined
              ? "Sample the Bayesian posterior of the FREE parameters, seeded at the current refined values (400 ensemble steps; marginalized noise model)"
              : "Refine first — sampling seeds walkers at the converged least-squares values"
          }
        >
          {busy ? <span className="wb-shimmer-text">Sampling…</span> : "Sample posterior"}
        </button>
        {result ? (
          <button
            style={{ ...secondaryButton, opacity: busy ? 0.55 : 1 }}
            disabled={busy}
            onClick={() => onRun(true)}
            title="Continue the SAME chain from its resume token (400 more steps) — the honest fix for a not-converged run"
          >
            Continue ↻
          </button>
        ) : null}
        {progress && busy ? (
          <span style={{ fontFamily: mono, fontSize: fz.small, color: color.secondary }}>
            step {progress.step}/{progress.total}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <InfoBadge
          width={300}
          align="right"
          text={
            <span>
              The ensemble MCMC posterior of the free parameters (uniform priors within
              bounds; error scale marginalized because G(r) point errors are correlated).
              Report the 68% credible interval with the convergence evidence — split-R̂
              ≈ 1 and enough effective samples (ESS). <b>esd ratio</b> = posterior σ /
              least-squares esd: ≈ 1 validates the LM error bars, larger means the
              linearized esd was overconfident.
            </span>
          }
        />
      </div>

      {/* Status banner */}
      {result ? (
        <div
          style={{
            display: "flex",
            gap: 14,
            alignItems: "baseline",
            flexWrap: "wrap",
            padding: "8px 12px",
            borderRadius: 8,
            border: `1px solid ${converged ? color.okBorder : color.border}`,
            background: converged ? color.okBg : color.chipBg,
            fontSize: fz.small,
          }}
        >
          <span style={{ fontWeight: 600, color: converged ? color.okInk : color.noteInk }}>
            {converged ? "Converged" : "Not converged — continue the chain"}
          </span>
          <span style={{ fontFamily: mono, color: color.secondary }}>
            R̂max <b style={{ color: rhatInk(result.diagnostics.maxRHat) }}>{result.diagnostics.maxRHat.toFixed(3)}</b>
          </span>
          <span style={{ fontFamily: mono, color: color.secondary }}>
            ESSmin <b>{Math.round(result.diagnostics.minEss)}</b>
          </span>
          <span style={{ fontFamily: mono, color: color.secondary }}>
            accept <b>{(result.acceptanceFraction * 100).toFixed(0)}%</b>
          </span>
          <span style={{ fontFamily: mono, color: color.secondary }}>
            {result.diagnostics.nSamples} samples
          </span>
        </div>
      ) : (
        <div style={{ color: color.secondary, fontSize: fz.small, lineHeight: 1.5 }}>
          Sample the posterior <i>after</i> a converged refinement: walkers seed at the
          refined values, and the posterior widths are compared against the linearized
          esds (the <b>esd ratio</b> — ≈ 1 validates the least-squares error bars).
          Only the currently <b>free</b> parameters are sampled.
        </div>
      )}

      {/* Per-parameter table */}
      {result ? (
        <div style={{ overflow: "auto", minHeight: 0, flex: 1 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: fz.small }}>
            <thead>
              <tr style={{ ...uppercaseLabel, color: color.faint, textAlign: "left" }}>
                <th style={{ padding: "4px 8px" }}>parameter</th>
                <th style={{ padding: "4px 8px" }}>marginal</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>median</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>68% interval</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>
                  esd ratio
                </th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>R̂</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>ESS</th>
              </tr>
            </thead>
            <tbody>
              {result.posterior.parameters.map((p) => (
                <tr key={p.id} style={{ borderTop: `1px solid ${color.subtle2}` }}>
                  <td style={{ padding: "6px 8px", color: color.ink }}>{labels.get(p.id) ?? p.id}</td>
                  <td style={{ padding: "4px 8px" }}>
                    <Marginal draws={flat.get(p.id) ?? []} summary={p} />
                  </td>
                  <td style={{ fontFamily: mono, padding: "6px 8px", textAlign: "right", color: color.ink }}>
                    {p.median.toPrecision(5)}
                  </td>
                  <td style={{ fontFamily: mono, padding: "6px 8px", textAlign: "right", color: color.secondary }}>
                    [{p.q16.toPrecision(4)}, {p.q84.toPrecision(4)}]
                  </td>
                  <td style={{ fontFamily: mono, padding: "6px 8px", textAlign: "right", fontWeight: 600, color: ratioInk(p.esdRatio) }}>
                    {p.esdRatio !== undefined ? p.esdRatio.toFixed(2) : "—"}
                  </td>
                  <td style={{ fontFamily: mono, padding: "6px 8px", textAlign: "right", color: rhatInk(p.rHat) }}>
                    {p.rHat.toFixed(3)}
                  </td>
                  <td style={{ fontFamily: mono, padding: "6px 8px", textAlign: "right", color: color.secondary }}>
                    {Math.round(p.ess)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
