/**
 * The step history card: the path from the first step to the current one,
 * newest first, with each step's wR, the other branches, and back / forward.
 *
 * Clicking a step goes back to it. That never loses work: the shell records
 * the live state first when it differs from the current step, and every step
 * stays in the tree (see core/project/history.ts).
 *
 * The card has one fixed, compact height whatever the number of steps: the
 * list scrolls inside it, so the parameter panel above keeps its room and does
 * not jump as steps accrue.
 */

import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { childrenOf, lineage, type HistoryStep } from "@/core/project/history";
import type { HistoryBinding } from "@/app/historyBinding";
import { card, color, fz, mono, radius, space, uppercaseLabel } from "@/app/theme";

/** One step row: one line of small text plus the row button's padding. */
const ROW_H = "calc(var(--fz-small) * 1.25 + 8px)";
/** Rows in view. The half row shows there is more to scroll to. */
const VISIBLE_ROWS = 3.5;

const KIND_GLYPH: Readonly<Record<HistoryStep["kind"], string>> = {
  load: "↧", open: "↧", edit: "✎", settings: "⚙", refine: "▶", magnetic: "M",
};

export function HistoryPanel({ binding }: { readonly binding: HistoryBinding }): JSX.Element {
  const { history, goTo: onGoTo, rename: onRename, back: onBack, forward: onForward } = binding;
  const scroller = useRef<HTMLDivElement>(null);
  const path = useMemo(() => (history ? lineage(history) : []), [history]);
  // Tips of the branches the current path does not run through.
  const otherTips = useMemo(() => {
    if (!history) return [];
    const onPath = new Set(path.map((s) => s.id));
    return history.steps.filter((s) => !onPath.has(s.id) && childrenOf(history, s.id).length === 0);
  }, [history, path]);

  // The current step is always the top row (the list is its lineage, newest
  // first), so bring the list back to the top whenever the current step moves.
  const current = history?.current;
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [current]);

  if (!history) {
    return (
      <section style={panel} aria-label="Step history">
        <div style={header}><span style={uppercaseLabel}>History</span></div>
        <p style={emptyNote}>Each refinement, load and model change becomes a step here. Click a step to go back to it.</p>
      </section>
    );
  }

  const newestFirst = [...path].reverse();
  return (
    <section style={panel} aria-label="Step history">
      <div style={header}>
        <span style={uppercaseLabel}>History</span>
        <span style={countNote}>{history.steps.length} step{history.steps.length === 1 ? "" : "s"}</span>
        <span style={{ flex: 1 }} />
        <Sparkline steps={path} />
        <button type="button" style={navButton} disabled={!onBack} onClick={onBack} title="Back one step (⌘Z / Ctrl+Z)">↶</button>
        <button type="button" style={navButton} disabled={!onForward} onClick={onForward} title="Forward one step (⇧⌘Z / Ctrl+Shift+Z)">↷</button>
      </div>
      <div ref={scroller} style={scrollArea}>
        <ol style={list}>
          {newestFirst.map((s) => (
            <StepRow key={s.id} step={s} current={s.id === history.current} onGoTo={onGoTo} onRename={onRename}
              branches={childrenOf(history, s.id).length - (s.id === history.current ? 0 : 1)} />
          ))}
        </ol>
        {otherTips.length > 0 && (
          <>
            <div style={branchHeading}>{otherTips.length} other branch{otherTips.length === 1 ? "" : "es"}</div>
            <ol style={list}>
              {otherTips.map((s) => (
                <StepRow key={s.id} step={s} current={false} onGoTo={onGoTo} onRename={onRename} branches={0} />
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function StepRow({ step, current, branches, onGoTo, onRename }: {
  readonly step: HistoryStep;
  readonly current: boolean;
  readonly branches: number;
  readonly onGoTo: (id: string) => void;
  readonly onRename: (id: string, name: string) => void;
}): JSX.Element {
  const time = new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const rename = (): void => {
    const name = window.prompt("Name this step (empty removes the name)", step.name ?? "");
    if (name !== null) onRename(step.id, name);
  };
  return (
    <li style={{ ...row, ...(current ? rowCurrent : {}) }}>
      <button
        type="button"
        style={rowButton}
        disabled={current}
        onClick={() => onGoTo(step.id)}
        title={current ? "The current step" : `Go back to this step (${step.id}, ${new Date(step.at).toLocaleString()})`}
        aria-current={current ? "step" : undefined}
      >
        <span style={{ ...glyph, color: current ? color.primary : color.faint }} aria-hidden>{KIND_GLYPH[step.kind]}</span>
        <span style={labelText}>
          {step.name && <b style={{ marginRight: 5 }}>{step.name}</b>}
          <span style={{ color: step.name ? color.secondary : color.ink }}>{step.label}</span>
          {step.actor === "agent" && <span style={tag}>agent</span>}
          {branches > 0 && <span style={tag} title={`${branches} other branch${branches === 1 ? "" : "es"} start here`}>⑂{branches}</span>}
        </span>
        {step.summary.wR !== undefined && <span style={wrChip}>{(100 * step.summary.wR).toFixed(2)}%</span>}
        <span style={timeText}>{time}</span>
      </button>
      <button type="button" style={renameButton} onClick={rename} title="Name this step">✎</button>
    </li>
  );
}

/** wR along the current path — the refinement's progress at a glance, in the header. */
function Sparkline({ steps }: { readonly steps: readonly HistoryStep[] }): JSX.Element | null {
  const pts = steps.filter((s) => s.summary.wR !== undefined).map((s) => s.summary.wR!);
  if (pts.length < 2) return null;
  const w = 88;
  const h = 18;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  // At least 5 % of wR top to bottom, so a change in the fourth decimal reads
  // as flat rather than as a cliff.
  const span = Math.max(hi - lo, 0.05 * hi);
  const y = (v: number): number => (span === 0 ? h / 2 : 3 + (h - 6) * (1 - (v - (hi + lo - span) / 2) / span));
  const x = (i: number): number => 3 + ((w - 6) * i) / (pts.length - 1);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ flex: `0 1 ${w}px`, minWidth: 0, height: h, display: "block" }} role="img"
      aria-label={`wR from ${(100 * pts[0]!).toFixed(2)}% to ${(100 * pts[pts.length - 1]!).toFixed(2)}% over ${pts.length} steps`}>
      <path d={d} fill="none" stroke={color.calc} strokeWidth={1.5} />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1]!)} r={2.5} fill={color.calc} />
    </svg>
  );
}

// Below the parameter panel in the right column: a fixed height (header plus
// VISIBLE_ROWS rows) that never grows, so the parameters keep the column.
const panel: CSSProperties = { ...card, padding: space.inset, flexShrink: 0, display: "flex", flexDirection: "column", gap: 4 };
// minHeight = the nav buttons, so the empty card (no buttons) is as tall as a full one.
const header: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minHeight: 24 };
const scrollArea: CSSProperties = { height: `calc(${ROW_H} * ${VISIBLE_ROWS})`, overflowY: "auto" };
const countNote: CSSProperties = { fontSize: fz.micro, color: color.faint };
const emptyNote: CSSProperties = { ...scrollArea, margin: 0, fontSize: fz.small, color: color.secondary, lineHeight: 1.45 };
const list: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const row: CSSProperties = { display: "flex", alignItems: "center", height: ROW_H, borderRadius: radius.small };
const rowCurrent: CSSProperties = { background: color.primaryTintBg };
const rowButton: CSSProperties = {
  flex: 1, minWidth: 0, height: "100%", display: "flex", alignItems: "center", gap: 7, padding: "0 6px",
  border: "none", background: "transparent", textAlign: "left", cursor: "pointer", fontSize: fz.small, lineHeight: 1.25, color: color.ink,
};
const glyph: CSSProperties = { width: 12, textAlign: "center", flexShrink: 0, fontSize: fz.micro };
const labelText: CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const wrChip: CSSProperties = { fontFamily: mono, fontSize: fz.micro, color: color.secondary, flexShrink: 0 };
const timeText: CSSProperties = { fontFamily: mono, fontSize: fz.micro, color: color.faint, flexShrink: 0 };
const tag: CSSProperties = { marginLeft: 6, fontSize: fz.micro, color: color.faint, border: `1px solid ${color.border}`, borderRadius: radius.chip, padding: "0 4px" };
const navButton: CSSProperties = {
  border: `1px solid ${color.control}`, background: color.surface, borderRadius: radius.small,
  width: 26, height: 24, cursor: "pointer", fontSize: fz.small, color: color.ink, padding: 0,
};
const renameButton: CSSProperties = { border: "none", background: "transparent", color: color.faintest, cursor: "pointer", fontSize: fz.micro, padding: "0 6px" };
const branchHeading: CSSProperties = { fontSize: fz.micro, color: color.secondary, padding: "6px 6px 2px", borderTop: `1px solid ${color.border}`, marginTop: 4 };
