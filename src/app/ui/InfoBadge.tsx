/**
 * A low-key "?" badge that reveals a help tooltip on hover (or keyboard focus) —
 * the quiet way to keep explanatory prose off the resting layout. Extracted from
 * the summary cards so every panel (magnetic page, plot toolbars, …) shares one
 * look for inline help.
 *
 * The tooltip is `position: fixed` and placed from the badge's viewport rect:
 * absolutely-positioned tips get clipped by any `overflow: auto/hidden`
 * ancestor (the parameter panel's scrolling group list cut them off), while a
 * fixed tip's containing block is the viewport — nothing in the app introduces
 * a transform/filter ancestor that would re-capture it. First open renders the
 * tip hidden for one layout pass to measure its real size, then clamps it
 * inside the viewport and flips above the badge when there is no room below.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  // Viewport coords for the tip; null = the hidden measuring pass.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchorRef.current?.getBoundingClientRect();
    const t = tipRef.current?.getBoundingClientRect();
    if (!a || !t) return;
    let left = align === "right" ? a.right + 2 - t.width : a.left - 2;
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    let top = a.bottom + 7;
    if (top + t.height > window.innerHeight - 8) top = Math.max(8, a.top - 7 - t.height);
    setPos({ left, top });
  }, [open, align, width]);
  return (
    <span
      ref={anchorRef}
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
        <span
          role="tooltip"
          ref={tipRef}
          style={{ ...tip, width, ...(pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }) }}
        >
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
  position: "fixed",
  zIndex: 1000,
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
