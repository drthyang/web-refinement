/**
 * First-run landing: shown while the workbench is clean (no demo, no user data).
 * Two entry points — open a crystal structure (CIF) to start your own
 * refinement, or load the bundled demo to explore. Once either loads, the shell
 * swaps this for the full workbench. Deliberately minimal: one clear choice.
 */

import { useState, type CSSProperties } from "react";
import { color, radius, sans, shadow } from "@/app/theme";

interface Props {
  readonly onLoadDemo: () => void;
  readonly onLoadCif: (file: File) => void;
}

export function Landing({ onLoadDemo, onLoadCif }: Props): JSX.Element {
  return (
    <main className="wb-main" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={card}>
        <div style={mark} aria-hidden>
          <svg viewBox="0 0 100 100" width={30} height={30}>
            <path d="M18 82 L18 20 L50 58 L82 20 L82 82" fill="none" stroke="#fff" strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        </div>
        <h1 style={heading}>Start a refinement</h1>
        <p style={lede}>
          Open a crystal structure to begin your own refinement, or load the bundled
          Mn₃Ga POWGEN dataset to explore the workbench.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
          <FileCta label="Open structure (CIF)…" accept=".cif,.mcif,.magcif,text/plain" onFile={onLoadCif} primary />
          <button style={secondaryBtn} onClick={onLoadDemo}>Load demo dataset</button>
        </div>
        <p style={hint}>Your diffraction data and instrument file load once a structure is open.</p>
      </div>
    </main>
  );
}

/** A file-picker styled as a call-to-action button (primary = filled cobalt). */
function FileCta({ label, accept, onFile, primary }: { label: string; accept: string; onFile: (f: File) => void; primary?: boolean }): JSX.Element {
  const [hover, setHover] = useState(false);
  const style: CSSProperties = primary
    ? { ...ctaBase, background: hover ? color.primaryHover : color.primary, color: "#fff", border: `1px solid ${color.primary}`, boxShadow: shadow.primaryPill }
    : { ...ctaBase, background: hover ? color.primaryTintBg : color.surface, color: color.ink, border: `1px solid ${hover ? color.primaryTintBorder : color.control}` };
  return (
    <label style={style} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
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

const card: CSSProperties = {
  maxWidth: 540,
  width: "100%",
  margin: "clamp(24px, 6vh, 80px) auto",
  padding: "clamp(28px, 4vw, 44px)",
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: 18,
  boxShadow: "0 18px 48px rgba(25,23,20,0.10)",
  textAlign: "center",
  fontFamily: sans,
};

const mark: CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: 14,
  margin: "0 auto 18px",
  background: `linear-gradient(150deg, ${color.primary} 12%, ${color.primaryHover} 88%)`,
  boxShadow: shadow.brand,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const heading: CSSProperties = { margin: "0 0 10px", fontSize: 23, fontWeight: 650, color: color.ink, letterSpacing: "-0.01em" };
const lede: CSSProperties = { margin: "0 auto 22px", maxWidth: 400, fontSize: 14, lineHeight: 1.55, color: color.secondary };
const hint: CSSProperties = { margin: "20px 0 0", fontSize: 12, color: color.faint };

const ctaBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "11px 20px",
  fontSize: 14,
  fontWeight: 600,
  borderRadius: radius.button,
  cursor: "pointer",
  fontFamily: sans,
  transition: "background 120ms, border-color 120ms, color 120ms",
};

const secondaryBtn: CSSProperties = { ...ctaBase, background: color.surface, color: color.ink, border: `1px solid ${color.control}` };
