/**
 * Design tokens for the workbench UI (from the Claude Design handoff:
 * design_handoff_refinement_workbench/README.md). Warm off-white surfaces,
 * IBM Plex type, a single blue primary. Keep this the single source of truth for
 * colour/type so the components stay consistent.
 */

export const color = {
  pageBg: "#faf7f2",
  surface: "#fff",
  raised: "#fffdf9",
  muted: "#f7f3ec",
  muted2: "#fbf8f2",
  groupBg: "#f6f1e8",
  chipBg: "#f3eee4",

  border: "#e8e2d8",
  control: "#ddd5c7",
  input: "#d8d0c2",
  subtle: "#eee7da",
  subtle2: "#f2ece1",

  ink: "#191714",
  secondary: "#5f594f",
  faint: "#94897a",
  faintest: "#b3a993",

  primary: "#1f4fd8",
  primaryHover: "#1a41b4",
  primaryTintBg: "#eaf0fe",
  primaryTintBorder: "#b9c6f4",

  okBg: "#eff5ea",
  okBorder: "#d3e2c4",
  okInk: "#3f6b25",
  noteBg: "#faf3e3",
  noteBorder: "#e8d9ae",
  noteInk: "#6b5310",
  warnBg: "#fdf0ea",
  warnBorder: "#f2cdbb",
  warnInk: "#a03415",

  // Data series
  obs: "#d84a1b",
  calc: "#1f4fd8",
  bkg: "#a87a10",
  diff: "oklch(0.55 0.12 155)",
  hkl: "#1f4fd8",
  magnetic: "#c2185b",
} as const;

export const mono = "'IBM Plex Mono', ui-monospace, monospace";
export const sans = "'IBM Plex Sans', system-ui, sans-serif";

/**
 * Fluid font-size tokens (defined in workbench.css as clamp() CSS variables).
 * Usable directly in inline styles — `fontSize: fz.body` — so text grows gently
 * with the window while staying comfortable and capped. Prefer these over bare
 * pixel literals for anything a reader looks at.
 */
export const fz = {
  micro: "var(--fz-micro)",
  small: "var(--fz-small)",
  body: "var(--fz-body)",
  large: "var(--fz-large)",
  title: "var(--fz-title)",
} as const;

export const radius = { card: 12, button: 8, small: 7, chip: 6, pill: 999 } as const;

export const shadow = {
  header: "0 1px 0 rgba(25,23,20,0.02), 0 3px 10px rgba(25,23,20,0.025)",
  brand: "0 1px 3px rgba(31,79,216,0.35)",
  primaryPill: "0 1px 2px rgba(31,79,216,0.3)",
} as const;

import type { CSSProperties } from "react";

/** Uppercase micro-label (tracked) used across cards/panels. */
export const uppercaseLabel: CSSProperties = {
  fontSize: fz.micro,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: color.faint,
};

export const card: CSSProperties = {
  borderRadius: radius.card,
  border: `1px solid ${color.border}`,
  background: color.surface,
};

export const ghostButton: CSSProperties = {
  border: `1px solid ${color.control}`,
  background: color.surface,
  borderRadius: radius.small,
  padding: "2px 10px",
  fontSize: fz.micro,
  color: color.ink,
  cursor: "pointer",
};

export const secondaryButton: CSSProperties = {
  border: `1px solid ${color.control}`,
  background: color.surface,
  borderRadius: radius.button,
  padding: "7px 15px",
  fontSize: fz.small,
  color: color.ink,
  cursor: "pointer",
};

export const primaryButton: CSSProperties = {
  border: `1px solid ${color.primary}`,
  background: color.primary,
  color: "#fff",
  borderRadius: radius.button,
  padding: "8px 18px",
  fontSize: fz.small,
  fontWeight: 600,
  cursor: "pointer",
};
