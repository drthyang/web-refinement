/**
 * Top header: brand mark (concentric diffraction rings), title + kicker, version
 * chip, the workflow stepper, and the export actions. Per the design handoff.
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
      <div style={brandMark}>
        <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden>
          <g fill="none" stroke="#fff" strokeWidth={1.3}>
            <circle cx={10} cy={10} r={8.3} opacity={0.32} />
            <circle cx={10} cy={10} r={5.2} opacity={0.62} />
            <circle cx={10} cy={10} r={2.2} fill="#fff" stroke="none" />
          </g>
        </svg>
      </div>
      <div style={{ lineHeight: 1.15 }}>
        <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Web Refinement Workbench</div>
        <div style={{ fontSize: 10.5, color: color.faint }}>Powder diffraction · Rietveld</div>
      </div>
      <span style={versionChip}>{version}</span>
      <div style={{ width: 1, height: 30, background: color.border }} />
      <nav style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {steps.map((s, i) => (
          <StepPill key={s.label} step={s} active={i === active} onClick={() => onStep(i)} />
        ))}
      </nav>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
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
    padding: "5px 14px",
    fontSize: 11.5,
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    cursor: "pointer",
    fontFamily: sans,
  };
  const style: CSSProperties = active
    ? { ...base, background: color.primary, color: "#fff", border: `1px solid ${color.primary}`, fontWeight: 600, boxShadow: shadow.primaryPill }
    : {
        ...base,
        background: color.surface,
        border: `1px solid ${hover ? color.primary : color.control}`,
        color: hover ? color.primary : color.secondary,
      };
  return (
    <button style={style} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={{ fontFamily: mono, opacity: active ? 0.75 : 1, color: active ? "#fff" : color.faint }}>{step.num}</span>
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
        border: `1px solid ${color.control}`,
        background: hover ? "#f5f0e7" : color.surface,
        borderRadius: radius.button,
        padding: "6px 13px",
        fontSize: 12.5,
        color: color.ink,
        cursor: "pointer",
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
  padding: "12px 24px",
  borderBottom: `1px solid ${color.border}`,
  background: color.raised,
  boxShadow: shadow.header,
  flexWrap: "wrap",
};

const brandMark: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  background: color.primary,
  boxShadow: shadow.brand,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const versionChip: CSSProperties = {
  fontFamily: mono,
  fontSize: 10.5,
  color: color.secondary,
  background: color.chipBg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.chip,
  padding: "2px 7px",
};
