/**
 * Powder-parameter panel, rebuilt to the design handoff spec: collapsible
 * parameter groups (caret + free-count + per-group "all" checkbox), rows with a
 * numeric input / esd / free-fixed-calib status pill and a blue left accent when
 * free. Reset lives in the panel header; the footer pairs the primary Refine
 * action with the magnetic-analysis handoff, plus a result banner and a
 * collapsible refinement-history table. Driven by the real refinement params.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ParameterKind, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { card, color, mono, primaryButton, secondaryButton, uppercaseLabel } from "@/app/theme";

const CATEGORY: Record<ParameterKind, string> = {
  scale: "Scale",
  background: "Background",
  cellLength: "Lattice",
  cellAngle: "Lattice",
  peakWidth: "Instrument / profile",
  profileU: "Instrument / profile",
  profileV: "Instrument / profile",
  profileW: "Instrument / profile",
  profileX: "Microstructure",
  profileY: "Microstructure",
  asymSL: "Instrument / profile",
  asymHL: "Instrument / profile",
  zeroShift: "Instrument / profile",
  sampleDisplacement: "Corrections",
  sampleTransparency: "Corrections",
  tofCalibration: "Instrument / profile",
  tofProfile: "Instrument / profile",
  bIso: "ADPs (thermal)",
  uAniso: "ADPs (thermal)",
  atomX: "Positions",
  atomY: "Positions",
  atomZ: "Positions",
  positionShift: "Positions",
  occupancy: "Occupancy",
  poRatio: "Corrections",
  absorption: "Corrections",
  surfaceRoughA: "Corrections",
  surfaceRoughB: "Corrections",
  extinction: "Corrections",
  stephensStrain: "Microstructure",
  anisoSizePerp: "Microstructure",
  anisoSizePar: "Microstructure",
  mustrainPerp: "Microstructure",
  mustrainPar: "Microstructure",
  mustrainIso: "Microstructure",
  magneticScale: "Magnetic",
  momentX: "Magnetic",
  momentY: "Magnetic",
  momentZ: "Magnetic",
  momentMode: "Magnetic",
  // Real-space PDF fit: the G(r) scale joins "Scale"; the Qdamp/Qbroad envelope
  // and δ1/δ2 correlated-motion sharpening get their own group.
  pdfScale: "Scale",
  qdamp: "PDF",
  qbroad: "PDF",
  delta1: "PDF",
  delta2: "PDF",
  spdiameter: "PDF",
  sratio: "PDF",
  rcut: "PDF",
  // Magnetic PDF (mPDF) scales/widths join the magnetic group with the moments.
  mpdfOrdScale: "Magnetic",
  mpdfParaScale: "Magnetic",
  mpdfPsigma: "Magnetic",
  corrLength: "Magnetic",
};

const ORDER = ["Scale", "Background", "Lattice", "Instrument / profile", "PDF", "ADPs (thermal)", "Positions", "Occupancy", "Microstructure", "Corrections", "Magnetic"];

/** difC/difA/difB come from instrument calibration — shown but not togglable. */
const isLocked = (p: RefinementParameter): boolean => p.kind === "tofCalibration";

interface Props {
  readonly params: readonly RefinementParameter[];
  readonly esd?: Readonly<Record<string, number>> | undefined;
  readonly onChange: (id: string, patch: Partial<RefinementParameter>) => void;
  readonly onRefine: () => void;
  /** Multi-start refine — perturbed restarts to reach the global minimum. */
  readonly onThorough?: () => void;
  /**
   * Which face `onThorough` wears: "prefit" from a cold start (broad search,
   * shown before any fit exists) or "escape" once a fit is in hand (light
   * nudge out of a stalled minimum). Same engine, different tuning.
   */
  readonly thoroughMode?: "prefit" | "escape";
  /**
   * Override for the cold-start ("prefit") tooltip. The default text describes
   * the powder engine's Le Bail cell pre-fit stage; an engine whose multi-start
   * has no such stage (PDF — Le Bail extracts Bragg intensities, which a
   * real-space G(r) doesn't have) must supply its own accurate description.
   */
  readonly prefitTitle?: string;
  /** Abort a running refinement; a Cancel button appears while `busy`. */
  readonly onCancel?: () => void;
  readonly onReset: () => void;
  /** Hand the refined structure to the magnetic symmetry analysis page (powder). */
  readonly onMagnetic?: () => void;
  readonly busy: boolean;
  readonly result: RefinementResult | null;
  readonly disabled?: boolean;
  /** Panel header label; defaults to "Powder parameters". */
  readonly title?: string;
  /** Extra footer buttons (e.g. single-crystal "Refine free" / "Export CIF"). */
  readonly extraActions?: ReactNode;
  /**
   * Per-group model controls (keyed by group name, e.g. "Background",
   * "ADPs (thermal)", "Microstructure"). Rendered as a strip under the group
   * header when the group is expanded — where the parameters they govern live.
   */
  readonly groupControls?: Partial<Record<string, ReactNode>> | undefined;
}

export function ParameterPanel({ params, esd, onChange, onRefine, onThorough, thoroughMode = "prefit", prefitTitle, onCancel, onReset, onMagnetic, busy, result, disabled, title, extraActions, groupControls }: Props): JSX.Element {
  const groups = useMemo(() => {
    const byGroup = new Map<string, RefinementParameter[]>();
    for (const p of params) {
      const g = CATEGORY[p.kind] ?? "Other";
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(p);
    }
    return ORDER.filter((g) => byGroup.has(g)).map((g) => ({ name: g, rows: byGroup.get(g)! }));
  }, [params]);

  // All parameter groups start collapsed; the user expands the ones they need.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const freeCount = params.filter((p) => !p.fixed).length;

  const setGroupFree = (rows: RefinementParameter[], free: boolean): void => {
    for (const p of rows) if (!isLocked(p)) onChange(p.id, { fixed: !free });
  };

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", overflow: "hidden", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
        <span style={uppercaseLabel}>{title ?? "Powder parameters"}</span>
        <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 11, color: color.faint }}>{freeCount} of {params.length} free</span>
        <button
          style={{ ...secondaryButton, padding: "3px 11px", fontSize: 11, ...(busy ? disabledStyle : {}) }}
          disabled={busy}
          onClick={onReset}
          title="Reset all parameters to their initial values"
        >
          Reset
        </button>
      </div>
      <div style={actionBar}>
        {onThorough && (
          <button
            style={{ ...secondaryButton, flex: "0 0 auto", padding: "10px 13px", fontSize: 13, fontWeight: 600, ...(busy || disabled ? disabledStyle : {}) }}
            disabled={busy || disabled}
            onClick={onThorough}
            title={thoroughMode === "escape"
              ? "Escape a local minimum: a few perturbed restarts around the current fit, keeping the best — use when a plain Refine has stalled"
              : prefitTitle ?? "Prefit from a cold start: a Le Bail cell pre-fit then a broad set of perturbed restarts, keeping the best — lands the structure in a good basin before you refine"}
          >
            {thoroughMode === "escape" ? "Escape min ↻" : "Prefit ↻"}
          </button>
        )}
        <button
          style={{ ...primaryButton, flex: "1 1 auto", minWidth: 96, textAlign: "center", padding: "10px 16px", fontSize: 14, fontWeight: 650, ...(busy ? refiningStyle : disabled ? disabledStyle : {}) }}
          disabled={busy || disabled}
          onClick={onRefine}
          title="Refine the free parameters against the loaded data"
        >
          {busy ? <span className="wb-shimmer-text">Refining…</span> : "Refine"}
        </button>
        {busy && onCancel && (
          <button style={cancelButton} onClick={onCancel} title="Abort the running refinement">
            Cancel
          </button>
        )}
        {onMagnetic && (
          <button
            style={{ ...secondaryButton, flex: "0 0 auto", padding: "10px 13px", fontSize: 13, ...(busy ? disabledStyle : {}) }}
            disabled={busy}
            onClick={onMagnetic}
            title="Open the magnetic symmetry analysis with the current refined structure (lattice, positions, occupancies)"
          >
            Magnetic analysis →
          </button>
        )}
        {extraActions}
      </div>
      <div style={{ ...colHeader }}>
        <span>Parameter</span>
        <span>Value</span>
        <span>esd</span>
        <span>Refine</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {groups.map((g) => {
          const togglable = g.rows.filter((p) => !isLocked(p));
          const groupFree = togglable.filter((p) => !p.fixed).length;
          const allFree = togglable.length > 0 && groupFree === togglable.length;
          return (
            <div key={g.name}>
              <div style={groupHeader} onClick={() => setOpen((o) => ({ ...o, [g.name]: !o[g.name] }))}>
                <span style={{ color: color.primary, fontSize: 10 }}>{open[g.name] ? "▾" : "▸"}</span>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{g.name}</span>
                <span style={{ fontFamily: mono, fontSize: 10.5, color: color.faint }}>{groupFree}/{togglable.length} free</span>
                <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: color.faint }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={allFree} disabled={disabled || togglable.length === 0} onChange={(e) => setGroupFree(g.rows, e.target.checked)} style={{ accentColor: color.primary }} />
                  all
                </label>
              </div>
              {open[g.name] && groupControls?.[g.name] && (
                <div style={groupControlRow}>{groupControls[g.name]}</div>
              )}
              {open[g.name] &&
                g.rows.map((p) => (
                  <ParamRow key={p.id} param={p} esd={esd?.[p.id] ?? p.esd} onChange={onChange} disabled={disabled} />
                ))}
            </div>
          );
        })}
      </div>
      {result && (
        <div style={footer}>
          <ResultBanner result={result} />
        </div>
      )}
    </div>
  );
}

function ParamRow({ param, esd, onChange, disabled }: { param: RefinementParameter; esd?: number | undefined; onChange: (id: string, patch: Partial<RefinementParameter>) => void; disabled?: boolean | undefined }): JSX.Element {
  const locked = isLocked(param);
  const [buf, setBuf] = useState<string | null>(null);
  const shown = buf ?? String(+param.value.toFixed(5));
  // Commit the edited value. `raw` (passed on Enter) is read straight from the
  // input, so a keypress applies even if React hasn't flushed the buffered state
  // yet — otherwise Enter could no-op and the profile would look unresponsive.
  const commit = (raw?: string): void => {
    const source = raw !== undefined ? raw : buf;
    if (source === null) return;
    const v = Number(source);
    if (Number.isFinite(v)) onChange(param.id, { value: v });
    setBuf(null);
  };
  const accent = !param.fixed && !locked ? color.primary : "transparent";
  return (
    <div
      style={{ ...paramRow, borderLeft: `3px solid ${accent}`, cursor: locked || disabled ? "default" : "pointer" }}
      onClick={() => !locked && !disabled && onChange(param.id, { fixed: !param.fixed })}
      title={param.label}
    >
      <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{param.label}</span>
      <input
        value={shown}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => { if (e.key === "Enter") { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); } }}
        style={valueInput}
      />
      <span style={{ fontFamily: mono, fontSize: 11, color: color.faint }}>{esd !== undefined ? `±${+esd.toPrecision(2)}` : "—"}</span>
      <StatusPill param={param} locked={locked} />
    </div>
  );
}

function StatusPill({ param, locked }: { param: RefinementParameter; locked: boolean }): JSX.Element {
  if (locked) return <span style={{ ...pill, border: `1px solid ${color.subtle}`, background: color.pageBg, color: color.faintest }}>calib</span>;
  if (!param.fixed) return <span style={{ ...pill, border: `1px solid ${color.primaryTintBorder}`, background: color.primaryTintBg, color: color.primary }}>● free</span>;
  return <span style={{ ...pill, border: `1px solid ${color.subtle2}`, background: "#f6f2ea", color: color.faint }}>○ fixed</span>;
}

function ResultBanner({ result }: { result: RefinementResult }): JSX.Element {
  const d = result.diagnostics;
  const hasDiag = d !== undefined && (d.svdZeroCount > 0 || d.highCorrelations.length > 0 || d.atBounds.length > 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* wR lives on the pattern plot (one readout per page); GoF in the quality rail. */}
      <div style={{ ...banner, background: color.okBg, border: `1px solid ${color.okBorder}`, color: color.okInk }}>
        Result: {result.status} · {result.history.length} cycle{result.history.length === 1 ? "" : "s"}
      </div>
      {hasDiag && d && (
        <div style={{ ...banner, background: color.noteBg, border: `1px solid ${color.noteBorder}`, color: color.noteInk }}>
          {d.svdZeroCount > 0 && <div>SVD dropped {d.svdZeroCount} near-null direction{d.svdZeroCount === 1 ? "" : "s"}.</div>}
          {d.highCorrelations.length > 0 && <div>High correlation: {d.highCorrelations.slice(0, 3).map((c) => `${c.parameterIdA}/${c.parameterIdB} ${c.coefficient.toFixed(2)}`).join("; ")}</div>}
          {d.atBounds.length > 0 && <div>At bound: {d.atBounds.map((b) => b.parameterId).join(", ")}.</div>}
        </div>
      )}
      <details style={{ fontSize: 11.5, color: color.secondary }}>
        <summary style={{ cursor: "pointer" }}>Refinement history ({result.history.length} cycles)</summary>
        <table style={{ fontSize: 11, marginTop: 4, fontFamily: mono, borderCollapse: "collapse" }}>
          <thead><tr><th style={hcell}>cycle</th><th style={hcell}>χ²</th><th style={hcell}>wR %</th></tr></thead>
          <tbody>
            {result.history.map((h) => (
              <tr key={h.iteration}>
                <td style={hcell}>{h.iteration}</td>
                <td style={hcell}>{h.chiSquared.toPrecision(4)}</td>
                <td style={hcell}>{(100 * (h.agreement.rWeighted ?? 0)).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const colHeader: CSSProperties = { display: "grid", gridTemplateColumns: "1fr 104px 62px 62px", padding: "6px 14px", borderBottom: `1px solid ${color.border}`, ...uppercaseLabel };
const groupHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 8, background: color.groupBg, borderTop: `1px solid ${color.subtle}`, padding: "8px 14px", cursor: "pointer" };
const paramRow: CSSProperties = { display: "grid", gridTemplateColumns: "1fr 104px 62px 62px", alignItems: "center", padding: "4px 14px 4px 26px", borderTop: `1px solid ${color.subtle2}` };
const groupControlRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, rowGap: 5, flexWrap: "wrap", padding: "7px 14px 7px 26px", borderTop: `1px solid ${color.subtle2}`, fontSize: 12, color: color.secondary };
const valueInput: CSSProperties = { width: 88, border: `1px solid ${color.input}`, borderRadius: 7, fontSize: 12, fontFamily: mono, padding: "2px 6px", background: "#fff" };
const pill: CSSProperties = { fontSize: 11, padding: "1px 8px", borderRadius: 999, textAlign: "center", justifySelf: "start" };
const actionBar: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 14px", borderBottom: `1px solid ${color.border}`, background: color.muted2 };
const footer: CSSProperties = { borderTop: `1px solid ${color.border}`, padding: "12px 14px", background: color.muted2, display: "flex", flexDirection: "column", gap: 8 };
const banner: CSSProperties = { borderRadius: 8, padding: "6px 10px", fontSize: 12 };
const hcell: CSSProperties = { padding: "1px 10px 1px 0", textAlign: "left", color: color.faint };
const disabledStyle: CSSProperties = { opacity: 0.55, cursor: "not-allowed" };
const cancelButton: CSSProperties = { padding: "11px 15px", fontSize: 13.5, fontWeight: 600, borderRadius: 8, border: `1px solid ${color.warnBorder}`, background: color.warnBg, color: color.warnInk, cursor: "pointer" };
// While refining, keep the button vivid (so the shimmer reads) but show progress.
const refiningStyle: CSSProperties = { cursor: "progress" };
