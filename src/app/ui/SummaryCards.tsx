/**
 * Row A: three summary cards (Structure / Data / Instrument), each with a load
 * button, an OK status chip, a title line, and a mono meta line.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { card, color, mono, radius, uppercaseLabel, fz } from "@/app/theme";

export interface SummaryCardData {
  readonly label: string;
  /** Optional help text shown in a hover tooltip on a "?" badge by the title. */
  readonly help?: string;
  readonly loadLabel: string;
  readonly accept: string;
  readonly onFile: (file: File) => void;
  readonly chip: string;
  /** Status chip tone: "ok" (green, default) or "warn" (red, e.g. synthetic data). */
  readonly chipTone?: "ok" | "warn";
  readonly title: string;
  readonly meta: string;
  /** One badge per crystallographic phase (multi-phase); removable ones show an ×. */
  readonly phaseBadges?: readonly { id: string; label: string; removable: boolean }[];
  readonly onRemovePhase?: (id: string) => void;
  /** Optional interactive control rendered under the meta line (e.g. the
   *  single-crystal X-ray/neutron probe toggle, which the data file can't carry). */
  readonly control?: ReactNode;
  /** Placeholder (nothing loaded): drops the status chip and renders the title
   *  as calm, lighter text so a clean start doesn't feel over-highlighted. */
  readonly muted?: boolean;
}

export function SummaryCards({ cards }: { cards: readonly SummaryCardData[] }): JSX.Element {
  return (
    <div className="wb-autofit">
      {cards.map((c) => (
        <SummaryCard key={c.label} data={c} />
      ))}
    </div>
  );
}

function SummaryCard({ data }: { data: SummaryCardData }): JSX.Element {
  const badges = data.phaseBadges ?? [];
  // Nothing loaded → skip the status chip entirely; a "none" pill is just noise.
  const showChip = !data.muted && !!data.chip;
  const showChipRow = showChip || badges.length > 0;
  const chipStyle = data.chipTone === "warn" ? warnChip : okChip;
  return (
    <div style={{ ...card, padding: "15px 18px", display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={uppercaseLabel}>{data.label}</span>
        {data.help && <HelpBadge text={data.help} />}
        <LoadButton label={data.loadLabel} accept={data.accept} onFile={data.onFile} />
      </div>
      {showChipRow && (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          {showChip && <span style={chipStyle}>{data.chip}</span>}
          {badges.map((ph) => (
            <span key={ph.id} style={phaseChip}>
              {ph.label}
              {ph.removable && data.onRemovePhase && (
                <button
                  onClick={() => data.onRemovePhase!(ph.id)}
                  title={`Remove the ${ph.label} phase`}
                  style={{ border: "none", background: "none", cursor: "pointer", color: color.secondary, fontSize: fz.small, lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: fz.large, fontWeight: data.muted ? 500 : 640, color: data.muted ? color.secondary : color.ink, lineHeight: 1.3, letterSpacing: data.muted ? 0 : "-0.005em" }}>{data.title}</div>
      {data.meta && <div style={{ fontSize: fz.small, color: data.muted ? color.faint : color.secondary, fontFamily: mono }}>{data.meta}</div>}
      {data.control && <div style={{ marginTop: 2 }}>{data.control}</div>}
    </div>
  );
}

const phaseChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: fz.micro,
  fontFamily: mono,
  padding: "1px 5px 1px 8px",
  borderRadius: radius.pill,
  border: `1px solid ${color.border}`,
  color: color.ink,
};

function LoadButton({ label, accept, onFile }: { label: string; accept: string; onFile: (f: File) => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        marginLeft: "auto",
        border: `1px solid ${color.control}`,
        borderRadius: radius.small,
        padding: "2px 10px",
        fontSize: fz.micro,
        color: color.ink,
        cursor: "pointer",
        background: hover ? "#f5f0e7" : "transparent",
      }}
    >
      {label}
      <input
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}

/** A low-key "?" badge that reveals a help tooltip on hover — a quiet way to
 *  surface what each card accepts without cluttering the resting layout. */
function HelpBadge({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span style={{ ...helpBadge, ...(open ? { color: color.secondary, borderColor: color.control } : {}) }} aria-label={text} role="img">?</span>
      {open && <span role="tooltip" style={helpTip}>{text}</span>}
    </span>
  );
}

const helpBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  borderRadius: "50%",
  border: `1px solid ${color.border}`,
  background: color.chipBg,
  color: color.faint,
  fontSize: 9.5,
  fontWeight: 700,
  lineHeight: 1,
  cursor: "help",
};

const helpTip: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 7px)",
  left: -2,
  zIndex: 60,
  width: 232,
  padding: "9px 11px",
  background: color.ink,
  color: "#f4efe6",
  fontSize: 11.5,
  lineHeight: 1.5,
  fontWeight: 400,
  letterSpacing: 0,
  textTransform: "none",
  borderRadius: 9,
  boxShadow: "0 8px 24px rgba(25,23,20,0.22)",
  whiteSpace: "normal",
};

const okChip: CSSProperties = {
  fontSize: fz.micro,
  padding: "2px 10px",
  borderRadius: radius.pill,
  background: color.okBg,
  border: `1px solid ${color.okBorder}`,
  color: color.okInk,
};

/** Warning tone (red) — e.g. the synthetic-demo-data chip. */
const warnChip: CSSProperties = {
  ...okChip,
  background: color.warnBg,
  border: `1px solid ${color.warnBorder}`,
  color: color.warnInk,
};

