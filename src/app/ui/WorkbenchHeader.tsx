/**
 * Top header: brand mark (concentric diffraction rings), title + kicker, version
 * chip, the workflow stepper, and the export actions. Per the design handoff,
 * scaled up as the app's one fixed landmark: a taller bar, a larger mark, a
 * clearer type ramp, and step pills with numbered badges.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { color, mono, radius, shadow, space } from "@/app/theme";
import type { DemoId } from "@/app/demos";

/** Display face for the MATERIA wordmark — geometric, loaded in index.html. */
const display = '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif';

export interface Step {
  readonly label: string;
  /** Greyed and non-clickable — e.g. Magnetic on the PDF page until mPDF, or
   *  both chips before any data is loaded. */
  readonly disabled?: boolean;
  /**
   * This step's content is part of the CURRENT model even though the user is
   * on another step — the Magnetic chip once moments are in the refinement.
   * Lights the chip (accent tint + a dot) without claiming to be the active
   * page, so the nuclear page shows at a glance that the fit is nuclear +
   * magnetic. Nuclear is never marked: it is always in the model, so the mark
   * would carry no information.
   */
  readonly present?: boolean;
  /** Tooltip (shown on the chip). */
  readonly hint?: string;
}

/** One header export button. The active mode supplies its own set, so the
 *  header always acts on the engine actually on screen (powder vs single
 *  crystal) rather than a fixed powder-only trio. */
export interface ExportAction {
  readonly label: string;
  readonly onClick: () => void;
  /** Tooltip: what the file contains. */
  readonly hint?: string;
}

interface Props {
  readonly steps: readonly Step[];
  readonly active: number;
  readonly onStep: (i: number) => void;
  readonly version: string;
  /** Export buttons for the current mode, rendered left-to-right. */
  readonly exports: readonly ExportAction[];
  /**
   * The active TECHNIQUE, set by the kind of data loaded. Both technique chips
   * (Rietveld, PDF) are always visible: null (nothing loaded) shows both
   * neutral; otherwise the active one is lit and the other dimmed. Single
   * crystal appears as a third chip only while active.
   */
  readonly technique?: "rietveld" | "pdf" | "sc" | null;
  /** The bundled demos (one per workflow) for the Demos ▾ menu. */
  readonly demos?: readonly { readonly id: DemoId; readonly label: string }[];
  /** Which demo is loaded (adds "Exit demo" to the menu and lights the button). */
  readonly activeDemo?: DemoId | null;
  readonly onLoadDemo?: (id: DemoId) => void;
  readonly onExitDemo?: () => void;
  /** Open a saved project file — offered even on the landing, before any data. */
  readonly onOpenProject?: (file: File) => void;
  /** Save the current session as a project file (absent while nothing is loaded). */
  readonly onSaveProject?: () => void;
}

/** File-picker filter for project files (any .json is accepted; the reader decides). */
const PROJECT_ACCEPT = ".materia.json,.json,application/json";

export function WorkbenchHeader({ steps, active, onStep, version, exports, technique = null, demos, activeDemo = null, onLoadDemo, onExitDemo, onOpenProject, onSaveProject }: Props): JSX.Element {
  return (
    <header className="wb-header" style={headerBar}>
      <div style={{ display: "flex", alignItems: "center", gap: 13, minWidth: 0 }}>
        <div className="wb-header-mark" style={brandMark}>
          {/* MATERIA monogram: a clean geometric M. */}
          <svg viewBox="0 0 100 100" width={28} height={28} aria-hidden>
            <path d="M18 82 L18 20 L50 58 L82 20 L82 82" fill="none" stroke="#fff" strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", minWidth: 0 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.05, minWidth: 0 }}>
            <span className="wb-header-title" style={{ fontFamily: display, fontSize: 21, fontWeight: 600, letterSpacing: "0.14em", color: color.ink, whiteSpace: "nowrap" }}>
              MATERIA
            </span>
            <span className="wb-header-sub" style={{ fontFamily: display, fontSize: 11, fontWeight: 500, letterSpacing: "0.36em", color: color.faint, marginTop: 3, whiteSpace: "nowrap" }}>
              WORKBENCH
            </span>
          </div>
          {/* One meta pill, not three: the release state and the version are
              the same fact about this build, so they share a chip instead of
              lining up two boxes in two colours beside the wordmark. The
              version hides itself on a phone (wb-version-chip). */}
          <span style={betaBadge} title="MATERIA is in public beta — validate results against established tools before publication">
            beta
            <span className="wb-version-chip" style={betaVersion}>{version}</span>
          </span>
          <GpuBadge />
        </div>
      </div>
      <div className="wb-header-divider" style={{ width: 1, alignSelf: "stretch", margin: "4px 0", background: color.border }} />
      <nav style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <FormChips technique={technique} />
        <TechniqueChips technique={technique} />
        <ChipGroup
          chips={steps.map((s, i) => ({
            key: s.label,
            label: s.label,
            active: i === active && !s.disabled,
            dimmed: !!s.disabled || (i !== active && !s.present),
            ...(s.present ? { present: true } : {}),
            ...(s.hint !== undefined ? { hint: s.hint } : {}),
            ...(s.disabled ? {} : { onClick: () => onStep(i) }),
          }))}
        />
      </nav>
      <div className="wb-header-actions" style={{ marginLeft: "auto", display: "flex", gap: 9, flexWrap: "wrap" }}>
        {onOpenProject && <ProjectMenu onOpenProject={onOpenProject} {...(onSaveProject ? { onSaveProject } : {})} />}
        {demos && demos.length > 0 && onLoadDemo && (
          <DemosMenu demos={demos} activeDemo={activeDemo} onLoadDemo={onLoadDemo} onExitDemo={onExitDemo} />
        )}
        {exports.length > 0 && <ExportMenu exports={exports} />}
      </div>
    </header>
  );
}

/**
 * Capability badge: lit when this machine can GPU-accelerate refinement, dimmed
 * otherwise. `navigator.gpu` may exist without a usable adapter, so support is
 * confirmed by actually requesting one. Purely informational — the per-refinement
 * status line still reports whether a given fit used the GPU ("· GPU |F|²").
 */
function GpuBadge(): JSX.Element {
  const [supported, setSupported] = useState<boolean>(
    () => typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu,
  );
  useEffect(() => {
    let cancelled = false;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) {
      setSupported(false);
      return;
    }
    gpu.requestAdapter().then(
      (adapter) => !cancelled && setSupported(!!adapter),
      () => !cancelled && setSupported(false),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <span
      className="wb-gpu-badge"
      style={{ ...gpuBadgeBase, ...(supported ? gpuBadgeOn : gpuBadgeOff) }}
      title={
        supported
          ? "GPU acceleration available — single-phase powder refinement runs structure factors on the WebGPU kernel (validated f32, far below esd)."
          : "GPU acceleration unavailable in this browser — refinement runs on the CPU."
      }
    >
      <svg width={8} height={11} viewBox="0 0 8 11" aria-hidden style={{ display: "block" }}>
        <path d="M4.7 0 0 6.4h2.7L2.1 11 8 4.2H4.8z" fill="currentColor" />
      </svg>
      GPU
    </span>
  );
}

/**
 * The header nav is six chips in three groups — sample form (Powder | Crystal),
 * technique (Rietveld | PDF) and refinement target (Nuclear | Magnetic) — so
 * "what am I fitting, and in which space" is one glance. The first two only
 * REPORT what the loaded data is, so they render as quiet segmented controls
 * ({@link ChipVariant}); only the step group, the one you click, carries the
 * accent. Nothing loaded → all neutral; once data picks the direction, the
 * selected chip in each group lifts and the others dim.
 */
/**
 * How a chip group carries its weight. The header holds three groups, and they
 * are not equal: the step chips are the navigation (you click them), while the
 * sample-form and technique chips only report what the data is. Painting all
 * three in accent blue put four saturated blocks across the bar — the brand
 * mark included — and flattened that difference. "nav" keeps the accent fill;
 * "indicator" is a quiet segmented control (a raised white segment on a warm
 * track), legible at a glance but never competing with the thing you act on.
 */
type ChipVariant = "nav" | "indicator";

interface Chip {
  readonly key: string;
  readonly label: string;
  readonly active: boolean;
  readonly dimmed: boolean;
  /** In the model but not the open page — lit, not selected (see {@link Step}). */
  readonly present?: boolean;
  readonly hint?: string;
  /** Present = clickable (the Nuclear/Magnetic chips navigate); absent = indicator only. */
  readonly onClick?: () => void;
}

function ChipGroup({ chips, variant = "nav" }: { chips: readonly Chip[]; variant?: ChipVariant }): JSX.Element {
  const indicator = variant === "indicator";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        // The indicator track is inset by 2px so its selected segment reads as
        // a tile floating on the track rather than a slab filling the pill.
        gap: indicator ? 2 : 0,
        padding: indicator ? 2 : 0,
        border: `1px solid ${indicator ? color.subtle : color.control}`,
        background: indicator ? color.chipBg : "transparent",
        borderRadius: radius.pill,
        overflow: "hidden",
      }}
    >
      {chips.map((c) => <GroupChip key={c.key} chip={c} variant={variant} />)}
    </span>
  );
}

function GroupChip({ chip, variant = "nav" }: { chip: Chip; variant?: ChipVariant }): JSX.Element {
  const [rawHover, setHover] = useState(false);
  const hover = rawHover && chip.onClick !== undefined && !chip.active;
  const indicator = variant === "indicator";
  // Lit but not selected: the accent tint of hover, made permanent, plus a dot
  // so the state reads as "in the model" rather than "the cursor is here".
  const lit = !!chip.present && !chip.active;
  const background = chip.active
    ? indicator ? color.surface : color.primary
    : lit || hover ? color.primaryTintBg : "transparent";
  const ink = chip.active
    ? indicator ? color.ink : "#fff"
    : lit || hover ? color.primary : chip.dimmed ? (indicator ? color.faint : color.faintest) : color.secondary;
  const style: CSSProperties = {
    fontFamily: mono,
    fontSize: indicator ? 10.5 : 11,
    fontWeight: 600,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    padding: indicator ? "4px 11px" : "7px 14px",
    whiteSpace: "nowrap",
    border: "none",
    borderRadius: indicator ? radius.pill : 0,
    background,
    color: ink,
    ...(indicator && chip.active ? { boxShadow: "0 1px 2px rgba(25,23,20,0.10)" } : {}),
    cursor: chip.onClick && !chip.active ? "pointer" : "default",
    transition: "color 160ms, background 160ms",
  };
  const shared = {
    title: chip.hint,
    style,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  };
  const content = (
    <>
      {lit && <span aria-hidden style={presentDot} />}
      {chip.label}
    </>
  );
  return chip.onClick
    ? <button className="wb-header-step" {...shared} onClick={chip.onClick}>{content}</button>
    : <span {...shared}>{content}</span>;
}

/** The "in the model" marker on a lit (present, not active) chip: a small
 *  accent dot with a soft halo, so it reads as a status light on the tint
 *  rather than a stray bullet glued to the label. */
const presentDot: CSSProperties = {
  display: "inline-block",
  width: 4.5,
  height: 4.5,
  borderRadius: "50%",
  background: color.primary,
  boxShadow: `0 0 0 2.5px ${color.primaryTintBorder}66`,
  marginRight: 7,
  verticalAlign: "middle",
};

/** Sample form: Powder (Bragg profile or total scattering) vs Single crystal (F²). */
function FormChips({ technique }: { technique: "rietveld" | "pdf" | "sc" | null }): JSX.Element {
  const form = technique === null ? null : technique === "sc" ? "sc" : "powder";
  const chips = [
    { id: "powder", label: "Powder", hint: "Powder sample — Bragg profile (Rietveld) or total-scattering (PDF) data" },
    { id: "sc", label: "Crystal", hint: "Single-crystal sample — integrated-intensity F² reflection data (.hkl/.fcf/.int)" },
  ] as const;
  return (
    <ChipGroup
      variant="indicator"
      chips={chips.map((c) => ({
        key: c.id,
        label: c.label,
        active: form === c.id,
        dimmed: form !== null && form !== c.id,
        hint: c.hint,
      }))}
    />
  );
}

/** Refinement space for powder data: Rietveld (reciprocal) vs PDF (real).
 *  Single-crystal F² is neither, so both dim while a reflection list drives. */
function TechniqueChips({ technique }: { technique: "rietveld" | "pdf" | "sc" | null }): JSX.Element {
  const chips = [
    { id: "rietveld", label: "Rietveld", hint: "Reciprocal-space powder profile refinement — load Bragg powder data (or the Mn₃Ga demo)" },
    { id: "pdf", label: "PDF", hint: "Real-space G(r) refinement — load a reduced total-scattering file (.gr/.sq/.fq, or the GaTa4Se8 demo)" },
  ] as const;
  return (
    <ChipGroup
      variant="indicator"
      chips={chips.map((c) => ({
        key: c.id,
        label: c.label,
        active: technique === c.id,
        dimmed: technique !== null && technique !== c.id,
        hint: c.hint,
      }))}
    />
  );
}

/** "Demos ▾": one bundled, converged example per technique. */
function DemosMenu({ demos, activeDemo, onLoadDemo, onExitDemo }: {
  demos: readonly { readonly id: DemoId; readonly label: string }[];
  activeDemo: DemoId | null;
  onLoadDemo: (id: DemoId) => void;
  onExitDemo?: (() => void) | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <ActionButton onClick={() => setOpen((o) => !o)} active={open || activeDemo !== null}>
        {activeDemo ? "Demo ✓ ▾" : "Demos ▾"}
      </ActionButton>
      {open && (
        <div style={menu}>
          {demos.map((d) => (
            <MenuItem key={d.id} onClick={() => { setOpen(false); onLoadDemo(d.id); }}>
              {activeDemo === d.id ? "✓ " : ""}{d.label}
            </MenuItem>
          ))}
          {activeDemo && onExitDemo && (
            <MenuItem onClick={() => { setOpen(false); onExitDemo(); }}>Exit demo</MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Project ▾": save the whole session as one `.materia.json`, or open a saved
 * one. Lives beside Demos/Export because a project is the session-level
 * counterpart of the per-mode exports (see workbenchEngine.ts).
 */
function ProjectMenu({ onOpenProject, onSaveProject }: { onOpenProject: (file: File) => void; onSaveProject?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <ActionButton onClick={() => setOpen((o) => !o)} active={open}>Project ▾</ActionButton>
      {open && (
        <div style={menu}>
          {onSaveProject && (
            <MenuItem onClick={() => { setOpen(false); onSaveProject(); }}>Save project</MenuItem>
          )}
          <MenuFileItem accept={PROJECT_ACCEPT} onFile={(f) => { setOpen(false); onOpenProject(f); }}>
            Open project…
          </MenuFileItem>
        </div>
      )}
    </div>
  );
}

/** A menu row that opens the file picker (a label wrapping a hidden input). */
function MenuFileItem({ children, accept, onFile }: { children: React.ReactNode; accept: string; onFile: (file: File) => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <label onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ ...menuItem(hover), boxSizing: "border-box" }}>
      {children}
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

function ActionButton({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }): JSX.Element {
  const [hover, setHover] = useState(false);
  const lit = hover || active;
  return (
    <button
      className="wb-header-action"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: `1px solid ${lit ? color.primaryTintBorder : color.control}`,
        background: lit ? color.primaryTintBg : color.surface,
        color: lit ? color.primary : color.ink,
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

/** A single "Export ▾" button that opens a menu of the mode's export actions —
 *  keeps the header uncluttered as the export set grows. */
function ExportMenu({ exports }: { exports: readonly ExportAction[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <ActionButton onClick={() => setOpen((o) => !o)} active={open}>Export ▾</ActionButton>
      {open && (
        <div style={menu}>
          {exports.map((e) => (
            <MenuItem key={e.label} onClick={() => { setOpen(false); e.onClick(); }} {...(e.hint ? { title: e.hint } : {})}>{e.label}</MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={menuItem(hover)} {...(title ? { title } : {})}>
      {children}
    </button>
  );
}

const menuItem = (hover: boolean): CSSProperties => ({
  display: "block",
  width: "100%",
  textAlign: "left",
  whiteSpace: "nowrap",
  border: "none",
  background: hover ? color.primaryTintBg : "transparent",
  color: hover ? color.primary : color.ink,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
});

const menu: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  zIndex: 40,
  minWidth: 180,
  padding: "5px 0",
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.button,
  boxShadow: "0 10px 28px rgba(25,23,20,0.14)",
};

const headerBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 22,
  padding: `15px ${space.edge}`,
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


/** Engine-mode badge (Rietveld / PDF / single crystal): primary-tinted pill so
 *  the active engine is always one glance away, next to the workflow steps. */
/**
 * The meta pills beside the wordmark (release + build, GPU). They share one
 * geometry — same height, radius, type scale and optical padding — so they read
 * as one quiet cluster rather than three unrelated boxes.
 */
const metaPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 20,
  fontFamily: mono,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  borderRadius: radius.pill,
  padding: "0 8px",
  whiteSpace: "nowrap",
};

const betaBadge: CSSProperties = {
  ...metaPill,
  color: color.noteInk,
  background: color.noteBg,
  border: `1px solid ${color.noteBorder}`,
};

/** The build number inside the beta pill: same chip, lighter voice. */
const betaVersion: CSSProperties = {
  fontWeight: 500,
  letterSpacing: "0.04em",
  textTransform: "none",
  opacity: 0.72,
};

const gpuBadgeBase: CSSProperties = {
  ...metaPill,
  gap: 4,
  padding: "0 8px 0 7px",
  cursor: "default",
  transition: "opacity 160ms, color 160ms, background 160ms",
};

const gpuBadgeOn: CSSProperties = {
  color: color.primary,
  background: color.primaryTintBg,
  border: `1px solid ${color.primaryTintBorder}`,
};

const gpuBadgeOff: CSSProperties = {
  color: color.faint,
  background: color.chipBg,
  border: `1px solid ${color.border}`,
  opacity: 0.5,
};
