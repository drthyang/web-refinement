/**
 * The step history card: the path from the first step to the current one,
 * newest first, with each step's wR, the other branches, and back / forward.
 *
 * Clicking a step goes back to it. That never loses work: the shell records
 * the live state first when it differs from the current step, and every step
 * stays in the tree (see core/project/history.ts).
 */

import { useMemo, useState, type CSSProperties } from "react";
import { childrenOf, lineage, type HistoryStep } from "@/core/project/history";
import type { HistoryBinding } from "@/app/historyBinding";
import { card, color, fz, mono, radius, space, uppercaseLabel } from "@/app/theme";

/** Rows shown before "Show all". */
const COLLAPSED_ROWS = 6;

const KIND_GLYPH: Readonly<Record<HistoryStep["kind"], string>> = {
  load: "↧", open: "↧", edit: "✎", settings: "⚙", refine: "▶", magnetic: "M",
};

export function HistoryPanel({ binding }: { readonly binding: HistoryBinding }): JSX.Element {
  const { history, goTo: onGoTo, rename: onRename, back: onBack, forward: onForward } = binding;
  const [expanded, setExpanded] = useState(false);
  const path = useMemo(() => (history ? lineage(history) : []), [history]);
  // Tips of the branches the current path does not run through.
  const otherTips = useMemo(() => {
    if (!history) return [];
    const onPath = new Set(path.map((s) => s.id));
    return history.steps.filter((s) => !onPath.has(s.id) && childrenOf(history, s.id).length === 0);
  }, [history, path]);

  if (!history) {
    return (
      <section style={panel} aria-label="Step history">
        <div style={header}><span style={uppercaseLabel}>History</span></div>
        <p style={emptyNote}>Each refinement, load and model change becomes a step here. Click a step to go back to it.</p>
      </section>
    );
  }

  const newestFirst = [...path].reverse();
  const shown = expanded ? newestFirst : newestFirst.slice(0, COLLAPSED_ROWS);
  return (
    <section style={panel} aria-label="Step history">
      <div style={header}>
        <span style={uppercaseLabel}>History</span>
        <span style={countNote}>{history.steps.length} step{history.steps.length === 1 ? "" : "s"}</span>
        <span style={{ flex: 1 }} />
        <NavButton direction="back" onClick={onBack} title="Back one step (⌘Z / Ctrl+Z)" />
        <NavButton direction="forward" onClick={onForward} title="Forward one step (⇧⌘Z / Ctrl+Shift+Z)" />
      </div>
      <Sparkline steps={path} />
      <ol style={list}>
        {shown.map((s) => (
          <StepRow key={s.id} step={s} current={s.id === history.current} onGoTo={onGoTo} onRename={onRename}
            branches={childrenOf(history, s.id).length - (s.id === history.current ? 0 : 1)} />
        ))}
      </ol>
      {newestFirst.length > COLLAPSED_ROWS && (
        <button type="button" style={linkButton} onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show fewer" : `Show all ${newestFirst.length}`}
        </button>
      )}
      {otherTips.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={branchSummary}>{otherTips.length} other branch{otherTips.length === 1 ? "" : "es"}</summary>
          <ol style={list}>
            {otherTips.map((s) => (
              <StepRow key={s.id} step={s} current={false} onGoTo={onGoTo} onRename={onRename} branches={0} />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** A round button with a circular arrow: counter-clockwise for back, clockwise for forward. */
function NavButton({ direction, onClick, title }: {
  readonly direction: "back" | "forward";
  readonly onClick: (() => void) | undefined;
  readonly title: string;
}): JSX.Element {
  const disabled = !onClick;
  return (
    <button type="button" style={{ ...navButton, ...(disabled ? navButtonDisabled : {}) }} disabled={disabled} onClick={onClick}
      title={title} aria-label={direction === "back" ? "Back one step" : "Forward one step"}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden style={direction === "forward" ? { transform: "scaleX(-1)" } : undefined}>
        {/* Three quarters of a circle, open at the upper left, with the head at its start. */}
        <path d="M4.5 9.5A8 8 0 1 1 6.3 17.7" />
        <path d="M4 4.5v5h5" />
      </svg>
    </button>
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

/** wR along the current path — the refinement's progress at a glance. */
function Sparkline({ steps }: { readonly steps: readonly HistoryStep[] }): JSX.Element | null {
  const pts = steps.filter((s) => s.summary.wR !== undefined).map((s) => s.summary.wR!);
  if (pts.length < 2) return null;
  const w = 220;
  const h = 26;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  // At least 5 % of wR top to bottom, so a change in the fourth decimal reads
  // as flat rather than as a cliff.
  const span = Math.max(hi - lo, 0.05 * hi);
  const y = (v: number): number => (span === 0 ? h / 2 : 3 + (h - 6) * (1 - (v - (hi + lo - span) / 2) / span));
  const x = (i: number): number => 3 + ((w - 6) * i) / (pts.length - 1);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h, display: "block", margin: "2px 0 4px" }} role="img"
      aria-label={`wR from ${(100 * pts[0]!).toFixed(2)}% to ${(100 * pts[pts.length - 1]!).toFixed(2)}% over ${pts.length} steps`}>
      <path d={d} fill="none" stroke={color.calc} strokeWidth={1.5} />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1]!)} r={2.5} fill={color.calc} />
    </svg>
  );
}

// Below the parameter panel in the right column: natural height up to a cap,
// then it scrolls, so the parameters keep most of the column.
const panel: CSSProperties = { ...card, padding: space.inset, flexShrink: 0, maxHeight: "40%", overflowY: "auto" };
const header: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const countNote: CSSProperties = { fontSize: fz.micro, color: color.faint };
const emptyNote: CSSProperties = { margin: "6px 0 0", fontSize: fz.small, color: color.secondary, lineHeight: 1.45 };
const list: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const row: CSSProperties = { display: "flex", alignItems: "center", borderRadius: radius.small };
const rowCurrent: CSSProperties = { background: color.primaryTintBg };
const rowButton: CSSProperties = {
  flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 7, padding: "4px 6px",
  border: "none", background: "transparent", textAlign: "left", cursor: "pointer", fontSize: fz.small, color: color.ink,
};
const glyph: CSSProperties = { width: 12, textAlign: "center", flexShrink: 0, fontSize: fz.micro };
const labelText: CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const wrChip: CSSProperties = { fontFamily: mono, fontSize: fz.micro, color: color.secondary, flexShrink: 0 };
const timeText: CSSProperties = { fontFamily: mono, fontSize: fz.micro, color: color.faint, flexShrink: 0 };
const tag: CSSProperties = { marginLeft: 6, fontSize: fz.micro, color: color.faint, border: `1px solid ${color.border}`, borderRadius: radius.chip, padding: "0 4px" };
const navButton: CSSProperties = {
  border: `1px solid ${color.control}`, background: color.surface, borderRadius: "50%",
  width: 26, height: 26, cursor: "pointer", color: color.ink, padding: 0, flexShrink: 0,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
};
const navButtonDisabled: CSSProperties = { color: color.faintest, cursor: "default", opacity: 0.6 };
const renameButton: CSSProperties = { border: "none", background: "transparent", color: color.faintest, cursor: "pointer", fontSize: fz.micro, padding: "0 6px" };
const linkButton: CSSProperties = { border: "none", background: "transparent", color: color.primary, cursor: "pointer", fontSize: fz.micro, padding: "4px 6px" };
const branchSummary: CSSProperties = { fontSize: fz.micro, color: color.secondary, cursor: "pointer", padding: "2px 6px" };
