/**
 * Top header: brand mark (concentric diffraction rings), title + kicker, version
 * chip, the workflow stepper, and the export actions. Per the design handoff,
 * scaled up as the app's one fixed landmark: a taller bar, a larger mark, a
 * clearer type ramp, and step pills with numbered badges.
 */

import { useState, type CSSProperties } from "react";
import { color, mono, radius, shadow, sans } from "@/app/theme";

export interface Step {
  readonly num: string;
  readonly label: string;
}

interface Props {
  readonly steps: readonly Step[];
  readonly active: number;
  readonly onStep: (i: number) => void;
  readonly version: string;
  readonly onExportCsv: () => void;
  readonly onExportProject: () => void;
}

export function WorkbenchHeader({ steps, active, onStep, version, onExportCsv, onExportProject }: Props): JSX.Element {
  return (
    <header style={headerBar}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
        <div style={brandMark}>
          <svg viewBox="0 0 20 20" width={26} height={26} aria-hidden>
            <g fill="none" stroke="#fff" strokeWidth={1.3}>
              <circle cx={10} cy={10} r={8.3} opacity={0.32} />
              <circle cx={10} cy={10} r={5.2} opacity={0.62} />
              <circle cx={10} cy={10} r={2.2} fill="#fff" stroke="none" />
            </g>
          </svg>
        </div>
        <div style={{ lineHeight: 1.2, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 21, fontWeight: 750, letterSpacing: "-0.022em", color: color.ink, whiteSpace: "nowrap" }}>
              Web Refinement Workbench
            </span>
            <span style={versionChip}>{version}</span>
          </div>
          <div style={{ fontSize: 12, color: color.faint, letterSpacing: "0.04em", marginTop: 2 }}>
            Powder diffraction · Rietveld · magnetic symmetry
          </div>
        </div>
      </div>
      <div style={{ width: 1, alignSelf: "stretch", margin: "4px 0", background: color.border }} />
      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {steps.map((s, i) => (
          <StepPill key={s.label} step={s} active={i === active} onClick={() => onStep(i)} />
        ))}
      </nav>
      <div style={{ marginLeft: "auto", display: "flex", gap: 9 }}>
        <ActionButton onClick={onExportCsv}>Export CSV</ActionButton>
        <ActionButton onClick={onExportProject}>Export project JSON</ActionButton>
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
    <button style={style} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={badge}>{step.num}</span>
      {step.label}
    </button>
  );
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
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
