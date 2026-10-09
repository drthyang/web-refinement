/**
 * Building blocks shared by the powder and single-crystal Validation views:
 * the section card, the verdict (issues first, passing checks as chips), the
 * compact metric grid, and the small bar charts (χ² by shell, K and GooF by
 * intensity).
 *
 * Density rule: a view should read on one screen. Explanations live in "?"
 * badges, passing checks collapse to chips, and nothing repeats what the card
 * header or the parameter panel already shows.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CheckAction, CheckStatus, ValidationVerdict } from "@/core/diagnostics/validationChecks";
import { color, fz, mono } from "@/app/theme";
import { InfoBadge } from "@/app/ui/InfoBadge";

export function Section({ title, subtitle, info, right, children, style, id }: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Help text behind a "?" badge beside the title. */
  info?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties | undefined;
  id?: string | undefined;
}): JSX.Element {
  return (
    <section id={id} style={{ ...sectionStyle, ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, rowGap: 4, flexWrap: "wrap", minHeight: 20 }}>
        <h3 style={sectionTitle}>{title}</h3>
        {info ? <InfoBadge text={info} width={300} /> : null}
        {subtitle ? <span style={{ fontSize: fz.micro, color: color.secondary }}>{subtitle}</span> : null}
        {right ? <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>{right}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** A row of cards that wrap onto their own lines when the view is narrow. */
export function Row({ children }: { children: ReactNode }): JSX.Element {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "stretch" }}>{children}</div>;
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

function StatusIcon({ status, size = 17 }: { status: CheckStatus; size?: number }): JSX.Element {
  const t = TONES[status];
  const label = status === "ok" ? "passes" : status === "info" ? "information" : status === "note" ? "worth a look" : status === "warn" ? "warning" : "critical";
  return (
    <span role="img" aria-label={label} style={{ flex: "none", width: size, height: size, borderRadius: 999, background: t.bg, border: `1px solid ${t.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={size - 7} height={size - 7} viewBox="0 0 16 16" fill="none" stroke={t.ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {status === "ok" ? <path d="M3.5 8.5l3 3 6-7" /> : status === "info" ? <path d="M4 8h8" /> : <><path d="M8 3.5v5.5" /><path d="M8 12.4v0.1" /></>}
      </svg>
    </span>
  );
}

const ACTION_LABEL: Record<CheckAction, string> = {
  "show-unindexed": "show",
  "export-gsas2": "GSAS-II bundle",
  "export-fullprof": "FullProf bundle",
  posterior: "Posterior",
};

/**
 * The verdict: the checks that need attention as full rows (worst first), the
 * passing ones as a single line of chips (detail on hover), and the context
 * lines (not refined yet, cross-checks, what is not checked) muted below.
 */
export function VerdictPanel({ verdict, onAction, style }: {
  verdict: ValidationVerdict;
  onAction?: ((action: CheckAction) => void) | undefined;
  style?: CSSProperties | undefined;
}): JSX.Element {
  const chip = TONES[verdict.tone];
  const rank: Record<CheckStatus, number> = { critical: 0, warn: 1, note: 2, ok: 3, info: 4 };
  const issues = verdict.checks.filter((c) => c.status === "critical" || c.status === "warn" || c.status === "note")
    .sort((a, b) => rank[a.status] - rank[b.status]);
  const passing = verdict.checks.filter((c) => c.status === "ok");
  const context = verdict.checks.filter((c) => c.status === "info");
  const actions = (list: readonly CheckAction[] | undefined): ReactNode =>
    list && onAction ? list.map((a) => <button key={a} onClick={() => onAction(a)} style={linkButton}>{ACTION_LABEL[a]}</button>) : null;
  return (
    <Section
      title="Verdict"
      style={style}
      subtitle={<span style={{ fontSize: fz.micro, fontWeight: 600, color: chip.ink, background: chip.bg, border: `1px solid ${chip.border}`, borderRadius: 999, padding: "1px 9px" }}>{verdict.headline}</span>}
    >
      {issues.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5 }}>
          {issues.map((c) => (
            <li key={c.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ marginTop: 1 }}><StatusIcon status={c.status} /></span>
              <span style={{ fontSize: fz.small, lineHeight: 1.4, color: color.ink }}>
                <b style={{ fontWeight: 600, color: c.status === "critical" ? color.warnInk : color.ink }}>{c.title}</b>
                {c.detail ? <span style={{ color: color.secondary }}> — {c.detail}</span> : null}
                {actions(c.actions)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {passing.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, paddingTop: issues.length > 0 ? 6 : 0, borderTop: issues.length > 0 ? `1px solid ${color.subtle2}` : "none" }}>
          {passing.map((c) => (
            <span key={c.id} title={c.detail ?? c.title} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: fz.micro, color: color.okInk, background: color.okBg, border: `1px solid ${color.okBorder}`, borderRadius: 999, padding: "1px 8px 1px 3px", whiteSpace: "nowrap" }}>
              <StatusIcon status="ok" size={14} />{c.title}
            </span>
          ))}
        </div>
      ) : null}
      {context.map((c) => (
        <div key={c.id} style={{ fontSize: fz.micro, lineHeight: 1.45, color: color.secondary }}>
          <b style={{ fontWeight: 600 }}>{c.title}</b>{c.detail ? ` — ${c.detail}` : ""}{actions(c.actions)}
        </div>
      ))}
    </Section>
  );
}

/** One number with its label beneath; the tone colours the number. */
export function Metric({ value, label, tone, title }: { value: string; label: ReactNode; tone?: "ok" | "note" | "warn" | undefined; title?: string | undefined }): JSX.Element {
  return (
    <div title={title} style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <span style={{ fontFamily: mono, fontSize: 14.5, fontWeight: 600, color: tone ? TONES[tone].ink : color.ink, whiteSpace: "nowrap" }}>{value}</span>
      <span style={{ fontSize: fz.micro, color: color.secondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </div>
  );
}

/** A single wrapping line of metrics (a strip under a card header). */
export function MetricStrip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 24px", padding: "8px 2px", borderTop: `1px solid ${color.subtle}`, borderBottom: `1px solid ${color.subtle}` }}>
      {children}
    </div>
  );
}

/**
 * The rendered width of an element, kept current with a ResizeObserver, so an
 * SVG can draw in true pixels (fixed height, text that never scales) instead of
 * stretching a fixed viewBox with the card.
 */
export function useElementWidth(fallback: number): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    const measure = (): void => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

export function MetricGrid({ children, min = 84 }: { children: ReactNode; min?: number }): JSX.Element {
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: "8px 12px" }}>{children}</div>;
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
export function Bars({ items, max, reference, referenceLabel, axisLabel, height = 96 }: {
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
export function DivergingBars({ items, centre, span, centreLabel, height = 80 }: {
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

/** A compact two-way switch inside a section header. */
export function Tabs<T extends string>({ options, value, onChange }: {
  options: readonly { readonly id: T; readonly label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <span role="tablist" style={{ display: "inline-flex", gap: 14 }}>
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={o.id === value}
          onClick={() => onChange(o.id)}
          style={{
            border: "none", background: "none", padding: "0 0 2px", cursor: "pointer", fontFamily: "inherit",
            fontSize: fz.body, fontWeight: 700,
            color: o.id === value ? color.ink : color.faint,
            borderBottom: `2px solid ${o.id === value ? color.primary : "transparent"}`,
          }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

export const sectionStyle: CSSProperties = {
  background: color.raised,
  border: `1px solid ${color.border}`,
  borderRadius: 10,
  padding: "10px 12px",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 0,
};

const sectionTitle: CSSProperties = { margin: 0, fontSize: fz.body, fontWeight: 700, color: color.ink };

export const caption: CSSProperties = { margin: 0, fontSize: fz.micro, lineHeight: 1.45, color: color.secondary };

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
export const th: CSSProperties = { fontFamily: "inherit", fontWeight: 600, fontSize: fz.micro, color: color.secondary, padding: "3px 6px", borderBottom: `1px solid ${color.border}`, whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "3px 6px", borderBottom: `1px solid ${color.subtle2}`, whiteSpace: "nowrap" };
