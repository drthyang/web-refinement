/**
 * Building blocks shared by the powder and single-crystal Validation views:
 * the section card, the verdict checklist, stat tiles, the small bar charts
 * (χ² by shell, K and GooF by intensity) and the convergence card.
 */

import type { CSSProperties, ReactNode } from "react";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { CheckAction, CheckStatus, ValidationVerdict } from "@/core/diagnostics/validationChecks";
import { parametersChangedSince } from "@/core/diagnostics/validationChecks";
import { color, fz, mono, uppercaseLabel } from "@/app/theme";

export function Section({ title, subtitle, right, children, style, id }: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties | undefined;
  id?: string | undefined;
}): JSX.Element {
  return (
    <section id={id} style={{ ...sectionStyle, ...style }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, rowGap: 4, flexWrap: "wrap" }}>
        <h3 style={sectionTitle}>{title}</h3>
        {subtitle ? <span style={{ fontSize: fz.small, color: color.secondary }}>{subtitle}</span> : null}
        {right ? <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>{right}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** A row of cards that wrap onto their own lines when the view is narrow. */
export function Row({ children }: { children: ReactNode }): JSX.Element {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "stretch" }}>{children}</div>;
}

/** Flex weights for a card in a Row: grow ratio and the width below which it wraps. */
export function col(grow: number, basis: number): CSSProperties {
  return { flex: `${grow} 1 ${basis}px`, minWidth: 0 };
}

const TONES: Record<CheckStatus, { bg: string; border: string; ink: string }> = {
  ok: { bg: color.okBg, border: color.okBorder, ink: color.okInk },
  note: { bg: color.noteBg, border: color.noteBorder, ink: color.noteInk },
  warn: { bg: color.warnBg, border: color.warnBorder, ink: color.warnInk },
  critical: { bg: color.warnBg, border: color.warnInk, ink: color.warnInk },
  info: { bg: color.chipBg, border: color.control, ink: color.secondary },
};

function StatusIcon({ status }: { status: CheckStatus }): JSX.Element {
  const t = TONES[status];
  const label = status === "ok" ? "passes" : status === "info" ? "information" : status === "note" ? "worth a look" : status === "warn" ? "warning" : "critical";
  return (
    <span role="img" aria-label={label} style={{ flex: "none", width: 18, height: 18, borderRadius: 999, background: t.bg, border: `1px solid ${t.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke={t.ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {status === "ok" ? <path d="M3.5 8.5l3 3 6-7" /> : status === "info" ? <path d="M4 8h8" /> : <><path d="M8 3.5v5.5" /><path d="M8 12.4v0.1" /></>}
      </svg>
    </span>
  );
}

const ACTION_LABEL: Record<CheckAction, string> = {
  "show-unindexed": "show",
  "export-gsas2": "Export GSAS-II bundle",
  "export-fullprof": "Export FullProf bundle",
  posterior: "Run in Posterior",
};

export function VerdictPanel({ verdict, onAction, style }: {
  verdict: ValidationVerdict;
  onAction?: ((action: CheckAction) => void) | undefined;
  style?: CSSProperties | undefined;
}): JSX.Element {
  const chip = TONES[verdict.tone];
  return (
    <Section
      title="Verdict"
      style={style}
      subtitle={<span style={{ fontSize: fz.micro, fontWeight: 600, color: chip.ink, background: chip.bg, border: `1px solid ${chip.border}`, borderRadius: 999, padding: "1px 9px" }}>{verdict.headline}</span>}
    >
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
        {verdict.checks.map((c, i) => (
          <li key={c.id} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "5px 2px", borderTop: i > 0 ? `1px solid ${color.subtle2}` : "none" }}>
            <StatusIcon status={c.status} />
            <span style={{ fontSize: fz.small, lineHeight: 1.45, color: color.ink }}>
              <b style={{ fontWeight: 600, color: c.status === "critical" ? color.warnInk : color.ink }}>{c.title}</b>
              {c.detail ? <span style={{ color: color.secondary }}> — {c.detail}</span> : null}
              {c.actions && onAction ? c.actions.map((a) => (
                <button key={a} onClick={() => onAction(a)} style={linkButton}>{ACTION_LABEL[a]}</button>
              )) : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function StatTile({ value, label, tone, title }: { value: string; label: ReactNode; tone?: "ok" | "note" | "warn" | undefined; title?: string | undefined }): JSX.Element {
  const t = tone ? TONES[tone] : null;
  return (
    <div title={title} style={{ background: t ? t.bg : color.surface, border: `1px solid ${t ? t.border : color.subtle}`, borderRadius: 8, padding: "7px 9px", display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span style={{ fontFamily: mono, fontSize: 16, fontWeight: 600, color: t ? t.ink : color.ink, whiteSpace: "nowrap" }}>{value}</span>
      <span style={{ fontSize: fz.micro, color: color.secondary, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </div>
  );
}

export function StatGrid({ children, columns = 4 }: { children: ReactNode; columns?: number }): JSX.Element {
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${columns >= 4 ? 108 : 130}px, 1fr))`, gap: 7 }}>{children}</div>;
}

export interface BarItem {
  readonly label: string;
  readonly value: number;
  /** Shown above the bar (defaults to value with 2 digits). */
  readonly text?: string;
  readonly title?: string;
  readonly flagged?: boolean;
}

/** Vertical bars from zero with a dashed reference line (e.g. χ²/N = 1). */
export function Bars({ items, max, reference, referenceLabel, axisLabel, height = 130 }: {
  items: readonly BarItem[];
  max: number;
  reference?: number;
  referenceLabel?: string;
  axisLabel?: string;
  height?: number;
}): JSX.Element {
  const top = Math.max(max, 1e-9);
  // The reference label sits in a gutter right of the bars, never over one.
  const gutter = referenceLabel ? 34 : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ position: "relative", height, display: "flex", alignItems: "flex-end", gap: 4, paddingRight: gutter, borderBottom: `1px solid ${color.control}` }}>
        {reference !== undefined && reference <= top ? (
          <>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: `${(100 * reference) / top}%`, borderTop: `1.5px dashed ${color.primary}`, opacity: 0.55 }} />
            {referenceLabel ? <span style={{ position: "absolute", right: 0, bottom: `calc(${(100 * reference) / top}% + 2px)`, fontFamily: mono, fontSize: 10, color: color.primary }}>{referenceLabel}</span> : null}
          </>
        ) : null}
        {items.map((b, i) => {
          const h = Math.min(100, (100 * Math.max(b.value, 0)) / top);
          return (
            <div key={i} title={b.title} style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", gap: 2 }}>
              <span style={{ fontFamily: mono, fontSize: 9.5, color: color.secondary, whiteSpace: "nowrap" }}>{b.text ?? b.value.toFixed(2)}</span>
              <div style={{ width: "78%", height: `${h}%`, minHeight: 1, background: b.flagged ? color.flag : color.primary, borderRadius: "2px 2px 0 0" }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 4, paddingRight: gutter }}>
        {items.map((b, i) => (
          <span key={i} style={{ flex: 1, minWidth: 0, textAlign: "center", fontFamily: mono, fontSize: 9.5, color: color.secondary, overflow: "hidden", whiteSpace: "nowrap" }}>{b.label}</span>
        ))}
      </div>
      {axisLabel ? <span style={{ textAlign: "center", fontSize: fz.micro, color: color.secondary }}>{axisLabel}</span> : null}
    </div>
  );
}

/** Bars diverging from a centre value (e.g. K about 1): up when above, down when below. */
export function DivergingBars({ items, centre, span, centreLabel, height = 96 }: {
  items: readonly BarItem[];
  centre: number;
  /** Full scale either side of the centre. */
  span: number;
  centreLabel?: string;
  height?: number;
}): JSX.Element {
  // Half-height kept below 38 % so the value label stays inside the box; a bar
  // beyond the span is clipped there and its label still gives the value.
  const gutter = centreLabel ? 34 : 0;
  return (
    <div style={{ position: "relative", height, display: "flex", gap: 4, paddingRight: gutter, borderTop: `1px solid ${color.subtle2}`, borderBottom: `1px solid ${color.subtle2}` }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTop: `1.5px solid ${color.control}` }} />
      {centreLabel ? <span style={{ position: "absolute", right: 0, top: "calc(50% - 14px)", fontFamily: mono, fontSize: 10, color: color.secondary }}>{centreLabel}</span> : null}
      {items.map((b, i) => {
        const dev = b.value - centre;
        const h = Math.min(38, (38 * Math.abs(dev)) / span);
        const below = dev < 0;
        return (
          <div key={i} title={b.title} style={{ flex: 1, minWidth: 0, position: "relative" }}>
            <div style={{ position: "absolute", left: "16%", right: "16%", [below ? "top" : "bottom"]: "50%", height: `${Math.max(h, 1)}%`, background: b.flagged ? color.flag : color.primary, borderRadius: 2 }} />
            <span style={{ position: "absolute", left: 0, right: 0, textAlign: "center", [below ? "top" : "bottom"]: `${50 + h + 2}%`, fontFamily: mono, fontSize: 9.5, color: color.secondary }}>{b.text ?? b.value.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Convergence and conditioning of the last refinement. */
export function ConvergenceCard({ result, parameters, style, extra }: {
  result: RefinementResult | null;
  parameters: readonly RefinementParameter[];
  style?: CSSProperties | undefined;
  /** Extra rows (technique-specific). */
  extra?: ReactNode;
}): JSX.Element {
  const label = (id: string): string => parameters.find((p) => p.id === id)?.label ?? id;
  const d = result?.diagnostics;
  const stale = result ? parametersChangedSince(result, parameters) : false;
  return (
    <Section title="Convergence & conditioning" subtitle={stale ? "from the last refinement; values edited since" : undefined} style={style}>
      {!result ? (
        <p style={{ margin: 0, fontSize: fz.small, color: color.secondary }}>Refine to see convergence, conditioning and correlations.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <KV k="Status" v={`${result.status} · ${result.history.length} cycle${result.history.length === 1 ? "" : "s"}`} tone={result.status === "converged" ? "ok" : "warn"} />
          {d ? (
            <>
              <KV
                k="Max shift/esd"
                v={`${d.maxShiftOverEsd.toFixed(d.maxShiftOverEsd < 0.01 ? 3 : 2)}${d.maxShiftParameterId ? ` · ${label(d.maxShiftParameterId)}` : ""}`}
                tone={d.maxShiftOverEsd > 1 ? "warn" : d.maxShiftOverEsd > 0.1 ? "note" : "ok"}
              />
              <KV k="Condition number" v={scientific(d.conditionNumber)} />
              <KV k="SVD null directions" v={String(d.svdZeroCount)} tone={d.svdZeroCount > 0 ? "warn" : "ok"} />
              <KV k="At a bound" v={d.atBounds.length === 0 ? "none" : d.atBounds.map((b) => label(b.parameterId)).join(", ")} tone={d.atBounds.length > 0 ? "warn" : "ok"} />
              <KV
                k="Correlations ≥ 0.95"
                v={d.highCorrelations.length === 0 ? "none" : d.highCorrelations.slice(0, 3).map((c) => `${label(c.parameterIdA)}/${label(c.parameterIdB)} ${c.coefficient.toFixed(2)}`).join(" · ")}
                tone={d.highCorrelations.length > 0 ? "note" : "ok"}
              />
            </>
          ) : null}
          {extra}
        </div>
      )}
    </Section>
  );
}

const SUPERSCRIPT: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

/** 41000 → "4.1 × 10⁴". */
export function scientific(v: number): string {
  if (!Number.isFinite(v)) return "∞";
  if (v !== 0 && (Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3)) {
    const [m, e] = v.toExponential(1).split("e");
    return `${m} × 10${[...String(Number(e))].map((ch) => SUPERSCRIPT[ch] ?? ch).join("")}`;
  }
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(+v.toPrecision(3));
}

export function KV({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: "ok" | "note" | "warn" }): JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 1px", borderBottom: `1px solid ${color.subtle2}`, fontSize: fz.small }}>
      <span style={{ color: color.secondary, flex: "none" }}>{k}</span>
      <span style={{ fontFamily: mono, textAlign: "right", color: tone ? TONES[tone].ink : color.ink, overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

export const sectionStyle: CSSProperties = {
  background: color.raised,
  border: `1px solid ${color.border}`,
  borderRadius: 10,
  padding: "12px 14px",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 9,
  minWidth: 0,
};

const sectionTitle: CSSProperties = { margin: 0, fontSize: fz.body, fontWeight: 700, color: color.ink };

export const caption: CSSProperties = { margin: 0, fontSize: fz.micro, lineHeight: 1.45, color: color.secondary };

export const smallLabel: CSSProperties = { ...uppercaseLabel, color: color.secondary };

export const linkButton: CSSProperties = {
  border: "none",
  background: "none",
  padding: "0 0 0 8px",
  color: color.primary,
  fontSize: "inherit",
  fontFamily: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

export const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: fz.small, fontFamily: mono, textAlign: "right" };
export const th: CSSProperties = { fontFamily: "inherit", fontWeight: 600, fontSize: fz.micro, color: color.secondary, padding: "4px 6px", borderBottom: `1px solid ${color.border}`, whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "4px 6px", borderBottom: `1px solid ${color.subtle2}`, whiteSpace: "nowrap" };
