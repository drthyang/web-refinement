/**
 * Top header: brand mark (concentric diffraction rings), title + kicker, version
 * chip, the workflow stepper, and the export actions. Per the design handoff,
 * scaled up as the app's one fixed landmark: a taller bar, a larger mark, a
 * clearer type ramp, and step pills with numbered badges.
 */

import { useState, type CSSProperties } from "react";
import { color, mono, radius, shadow, sans } from "@/app/theme";

/** Display face for the Materia wordmark — geometric, loaded in index.html. */
const display = '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif';

export interface Step {
  readonly num: string;
  readonly label: string;
}

/** One header export button. The active mode supplies its own set, so the
 *  header always acts on the engine actually on screen (powder vs single
 *  crystal) rather than a fixed powder-only trio. */
export interface ExportAction {
  readonly label: string;
  readonly onClick: () => void;
}

interface Props {
  readonly steps: readonly Step[];
  readonly active: number;
  readonly onStep: (i: number) => void;
  readonly version: string;
  /** Export buttons for the current mode, rendered left-to-right. */
  readonly exports: readonly ExportAction[];
}

export function WorkbenchHeader({ steps, active, onStep, version, exports }: Props): JSX.Element {
  return (
    <header className="wb-header" style={headerBar}>
      <div style={{ display: "flex", alignItems: "center", gap: 13, minWidth: 0 }}>
        <div className="wb-header-mark" style={brandMark}>
          {/* Materia monogram: geometric M with a small sprout in its centre notch. */}
          <svg viewBox="0 0 100 100" width={28} height={28} aria-hidden>
            <path d="M18 82 L18 20 L50 58 L82 20 L82 82" fill="none" stroke="#fff" strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" />
            <line x1={50} y1={57} x2={50} y2={43.5} stroke="#fff" strokeWidth={3.4} strokeLinecap="round" />
            <ellipse cx={44.6} cy={40.6} rx={4.7} ry={2.2} fill="#fff" transform="rotate(-42 44.6 40.6)" />
            <ellipse cx={55.4} cy={40.6} rx={4.7} ry={2.2} fill="#fff" transform="rotate(42 55.4 40.6)" />
          </svg>
        </div>
        <div style={{ lineHeight: 1.05, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
            <span className="wb-header-title" style={{ fontFamily: display, fontSize: 21, fontWeight: 600, letterSpacing: "0.14em", color: color.ink, whiteSpace: "nowrap" }}>
              MATERIA
            </span>
            <span style={betaBadge} title="Materia is in public beta — validate results against established tools before publication">beta</span>
            <span className="wb-version-chip" style={versionChip}>{version}</span>
          </div>
          <div className="wb-header-sub" style={{ fontFamily: display, fontSize: 11, fontWeight: 500, letterSpacing: "0.36em", color: color.faint, marginTop: 3 }}>
            WORKBENCH
          </div>
        </div>
      </div>
      <div className="wb-header-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0", background: color.border }} />
      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {steps.map((s, i) => (
          <StepPill key={s.label} step={s} active={i === active} onClick={() => onStep(i)} />
        ))}
      </nav>
      <div className="wb-header-actions" style={{ marginLeft: "auto", display: "flex", gap: 9, flexWrap: "wrap" }}>
        {exports.map((e) => (
          <ActionButton key={e.label} onClick={e.onClick}>{e.label}</ActionButton>
        ))}
      </div>
    </header>
  );
}

function StepPill({ step, active, onClick }: { step: Step; active: boolean; onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  const base: CSSProperties = {
    borderRadius: radius.pill,
    padding: "8px 18px 8px 9px",
    fontSize: 13.5,
    display: "inline-flex",
    alignItems: "center",
    gap: 9,
    cursor: "pointer",
    fontFamily: sans,
    transition: "border-color 120ms, color 120ms, background 120ms",
  };
  const style: CSSProperties = active
    ? { ...base, background: color.primary, color: "#fff", border: `1px solid ${color.primary}`, fontWeight: 650, boxShadow: shadow.primaryPill }
    : {
        ...base,
        background: color.surface,
        border: `1px solid ${hover ? color.primary : color.control}`,
        color: hover ? color.primary : color.secondary,
        fontWeight: 500,
      };
  const badge: CSSProperties = {
    width: 22,
    height: 22,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: mono,
    fontSize: 11.5,
    fontWeight: 600,
    background: active ? "rgba(255,255,255,0.18)" : color.chipBg,
    color: active ? "#fff" : hover ? color.primary : color.faint,
    border: active ? "1px solid rgba(255,255,255,0.28)" : `1px solid ${color.border}`,
  };
  return (
    <button className="wb-header-step" style={style} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={badge}>{step.num}</span>
      {step.label}
    </button>
  );
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      className="wb-header-action"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: `1px solid ${hover ? color.primaryTintBorder : color.control}`,
        background: hover ? color.primaryTintBg : color.surface,
        color: hover ? color.primary : color.ink,
        borderRadius: radius.button,
        padding: "8px 16px",
        fontSize: 13,
        fontWeight: 550,
        cursor: "pointer",
        transition: "border-color 120ms, color 120ms, background 120ms",
      }}
    >
      {children}
    </button>
  );
}

const headerBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 22,
  padding: "15px 28px",
  borderBottom: `1px solid ${color.border}`,
  background: color.raised,
  boxShadow: shadow.header,
  flexWrap: "wrap",
};

const brandMark: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 12,
  background: `linear-gradient(150deg, ${color.primary} 12%, ${color.primaryHover} 88%)`,
  boxShadow: shadow.brand,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const versionChip: CSSProperties = {
  fontFamily: mono,
  fontSize: 11,
  color: color.secondary,
  background: color.chipBg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.chip,
  padding: "2px 8px",
};

const betaBadge: CSSProperties = {
  fontFamily: mono,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: color.noteInk,
  background: color.noteBg,
  border: `1px solid ${color.noteBorder}`,
  borderRadius: radius.chip,
  padding: "2px 7px",
};
