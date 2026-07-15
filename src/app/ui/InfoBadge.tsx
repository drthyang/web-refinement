/**
 * A low-key "?" badge that reveals a help tooltip on hover (or keyboard focus) —
 * the quiet way to keep explanatory prose off the resting layout. Extracted from
 * the summary cards so every panel (magnetic page, plot toolbars, …) shares one
 * look for inline help.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { color } from "@/app/theme";

export function InfoBadge({
  text,
  width = 232,
  align = "left",
}: {
  /** Tooltip content — plain text or light JSX (kept to a few sentences). */
  text: ReactNode;
  /** Tooltip width in px; bump for longer workflow explanations. */
  width?: number;
  /** Horizontal anchoring of the tooltip relative to the badge. */
  align?: "left" | "right";
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
    >
      <span
        style={{ ...badge, ...(open ? { color: color.secondary, borderColor: color.control } : {}) }}
        aria-label={typeof text === "string" ? text : "More information"}
        role="img"
      >
        ?
      </span>
      {open && (
        <span role="tooltip" style={{ ...tip, width, ...(align === "right" ? { left: "auto", right: -2 } : {}) }}>
          {text}
        </span>
      )}
    </span>
  );
}

const badge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  borderRadius: "50%",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: color.border,
  background: color.chipBg,
  color: color.faint,
  fontSize: 9.5,
  fontWeight: 700,
  lineHeight: 1,
  cursor: "help",
  flex: "none",
};

const tip: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 7px)",
  left: -2,
  zIndex: 60,
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
