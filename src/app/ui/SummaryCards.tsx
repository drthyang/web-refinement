/**
 * Row A: three summary cards (Structure / Data / Instrument), each with a load
 * button, an OK status chip, a title line, and a mono meta line.
 */

import { useState, type CSSProperties } from "react";
import { card, color, mono, radius, uppercaseLabel, fz } from "@/app/theme";

export interface SummaryCardData {
  readonly label: string;
  readonly loadLabel: string;
  readonly accept: string;
  readonly onFile: (file: File) => void;
  readonly chip: string;
  readonly title: string;
  readonly meta: string;
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
  return (
    <div style={{ ...card, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={uppercaseLabel}>{data.label}</span>
        <LoadButton label={data.loadLabel} accept={data.accept} onFile={data.onFile} />
      </div>
      <div>
        <span style={okChip}>{data.chip}</span>
      </div>
      <div style={{ fontSize: fz.large, fontWeight: 700, lineHeight: 1.25 }}>{data.title}</div>
      {data.meta && <div style={{ fontSize: fz.small, color: color.secondary, fontFamily: mono }}>{data.meta}</div>}
    </div>
  );
}

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

const okChip: CSSProperties = {
  fontSize: fz.micro,
  padding: "2px 10px",
  borderRadius: radius.pill,
  background: color.okBg,
  border: `1px solid ${color.okBorder}`,
  color: color.okInk,
};
