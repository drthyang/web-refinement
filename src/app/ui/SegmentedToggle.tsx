/**
 * The plot-card view switcher shared by the powder and PDF pages — a compact
 * segmented control (chip-background track, primary-filled active segment).
 * One component so the two pages render byte-identical toggles.
 */

import { color, mono } from "@/app/theme";

export interface SegmentedOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Tooltip describing the view. */
  readonly title: string;
}

export function SegmentedToggle<T extends string>({ options, value, onChange }: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <div style={{ display: "inline-flex", gap: 2, background: color.chipBg, border: `1px solid ${color.border}`, borderRadius: 8, padding: 2 }}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          title={o.title}
          style={{
            border: "none",
            borderRadius: 6,
            padding: "3px 11px",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: mono,
            background: o.id === value ? color.primary : "transparent",
            color: o.id === value ? "#fff" : color.secondary,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
