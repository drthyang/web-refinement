/**
 * Boxcar view for the PDF workbench plot card: how each refined parameter
 * drifts as a fixed-width r-window slides across G(r).
 *
 * The reading is the point of the whole feature — a value that changes with the
 * box center means the local structure differs from the average one — so the
 * panel is built around ONE parameter track at a time (picked from a chip row),
 * drawn with its per-box esd bars, plus the Rw-vs-r context strip that says
 * whether each box was fitted well enough for its value to mean anything.
 *
 * The plan (box width, step, direction, restarts) lives HERE rather than in the
 * parameter panel: these settings shape this view's result and nothing else, so
 * they sit with the run button and the plot they produce, and the refinement
 * panel keeps one job and one primary action.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SequentialResult } from "@/core/refinement/sequential";
import type { BoxcarDirection, BoxcarWindow } from "@/core/workflow/pdfBoxcar";
import { color, fz, mono, primaryButton, secondaryButton } from "@/app/theme";
import { InfoBadge } from "@/app/ui/InfoBadge";
import { SegmentedToggle } from "@/app/ui/SegmentedToggle";
import { linearScale } from "@/visualization/scale";

/** A completed (or in-progress) boxcar scan: the plan and the series it made. */
export interface BoxcarRun {
  readonly windows: readonly BoxcarWindow[];
  readonly result: SequentialResult;
  /** Box width used (Å) — reported in the caption, since the plan can be edited
   *  in the panel after a run without invalidating the run itself. */
  readonly width: number;
  readonly direction: "up" | "down";
  /** Randomized restarts each box ran beyond its seeded start (0 = seed only). */
  readonly restarts: number;
  /** Ids that were free when this run started — the tracks worth plotting.
   *  Frozen with the run: the panel's free flags may have changed since. */
  readonly freeIds: readonly string[];
  /** True when the scan was cancelled (or failed) partway: the boxes present
   *  are a prefix of the plan, not the whole thing. */
  readonly partial?: boolean;
}

/** The scan the controls describe (owned by the workbench, edited here). */
export interface BoxcarPlan {
  readonly width: number;
  readonly step: number;
  readonly direction: BoxcarDirection;
  /** Re-search each box from perturbed starts instead of the seed alone. */
  readonly randomStart: boolean;
  readonly restarts: number;
}

/** What the current plan resolves to against the page's fit window. */
export interface BoxcarPlanInfo {
  /** Boxes the settings fit inside the window. */
  readonly count: number;
  /** Why the plan cannot run, as user-facing prose (null when it can). */
  readonly issue: string | null;
  /** The r window being scanned (the page's fit range). */
  readonly range: { readonly min: number; readonly max: number };
  /** Where the last box's right edge lands, or null for an unusable plan. */
  readonly scannedMax: number | null;
}

export interface BoxcarPanelProps {
  readonly run: BoxcarRun | null;
  readonly busy: boolean;
  /** Boxes completed / planned, while a scan runs. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  /** Why the panel cannot start a scan right now (disables Run, shown as prose). */
  readonly blockedReason: string | null;
  readonly plan: BoxcarPlan;
  readonly planInfo: BoxcarPlanInfo;
  readonly onPlanChange: (patch: Partial<BoxcarPlan>) => void;
  /** Parameter labels by id (falls back to the id). */
  readonly labels: ReadonlyMap<string, string>;
  /** Download the series as CSV. */
  readonly onExportCsv: () => void;
  /** Adopt one box's refined values into the parameter panel. */
  readonly onAdoptStep: (index: number) => void;
}

const PAD = { left: 62, right: 14, top: 12, bottom: 34 };
/** Height of the Rw context strip below the value panel. */
const RW_H = 54;
/** Fallback drawing box before the container has been measured. */
const FALLBACK = { width: 620, height: 300 };

/** The element's live content box — the plot draws to these exact numbers, so
 *  it fills whatever the flex layout gives it instead of letterboxing inside a
 *  fixed aspect ratio (the card's height is viewport-dependent). */
function useElementSize<T extends HTMLElement>(): [React.RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState(FALLBACK);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (!box) return;
      setSize({ width: Math.max(240, box.width), height: Math.max(160, box.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function BoxcarPanel({
  run, busy, progress, onRun, onCancel, blockedReason, plan, planInfo, onPlanChange, labels, onExportCsv, onAdoptStep,
}: BoxcarPanelProps): JSX.Element {
  // Tracks worth showing: parameters that were free (fixed rows are flat lines
  // by construction) and actually carry a value in at least one box.
  const tracks = useMemo(() => {
    if (!run) return [];
    const freeSet = new Set(run.freeIds);
    return run.result.evolution
      .filter((e) => freeSet.has(e.parameterId))
      .filter((e) => e.values.some((v) => v !== undefined && Number.isFinite(v)));
  }, [run]);

  const [shownId, setShownId] = useState<string | null>(null);
  // A new scan (or a different free set) invalidates the selection; default to
  // the first track so the tab is never an empty frame after a run.
  useEffect(() => {
    setShownId((prev) => (prev && tracks.some((t) => t.parameterId === prev) ? prev : tracks[0]?.parameterId ?? null));
  }, [tracks]);
  const track = tracks.find((t) => t.parameterId === shownId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          style={{ ...primaryButton, opacity: busy || blockedReason !== null ? 0.55 : 1 }}
          disabled={busy || blockedReason !== null}
          onClick={onRun}
          title={
            blockedReason ??
            `Slide the box across the fit window and refine the free parameters inside each position (${planInfo.count} boxes), each box seeded from the previous one.`
          }
        >
          {busy ? <span className="wb-shimmer-text">Scanning…</span> : "Run boxcar scan"}
        </button>
        {busy && (
          <button style={secondaryButton} onClick={onCancel} title="Abort the scan — the boxes already fitted are kept">
            Cancel
          </button>
        )}
        {progress && busy ? (
          <span style={{ fontFamily: mono, fontSize: fz.small, color: color.secondary }}>
            box {progress.done}/{progress.total}
          </span>
        ) : null}
        {run && !busy ? (
          <button style={secondaryButton} onClick={onExportCsv} title="Download every parameter's value and esd against the box center as CSV">
            Export CSV
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        <InfoBadge
          width={320}
          align="right"
          text={
            <span>
              A <b>boxcar</b> scan refines the same model inside a fixed-width r-window
              slid across G(r). A parameter that drifts with the box center means the
              structure the PDF sees changes with length scale — the local structure at
              low r differing from the average (Bragg) one at high r. Flat tracks mean
              one model describes every length scale. Read the value only where the box
              fitted well (the Rw strip) and where the esd is small compared with the
              drift: narrow boxes hold few points, so esds grow as the box shrinks.
            </span>
          }
        />
      </div>

      {/* The plan. Editing it never disturbs a run already on screen — the run
          carries its own settings — so a user can compare a finished scan
          against the next one's plan before spending the time. */}
      <div style={planBar}>
        <label style={fieldLabel} title="Width of the fitting box in Å. Every box has exactly this width, so the values are comparable across the scan. Too narrow and the box holds too few G(r) points to determine the free parameters.">
          box
          <NumberField value={plan.width} min={0.1} disabled={busy} onCommit={(width) => onPlanChange({ width })} />
          Å
        </label>
        <label style={fieldLabel} title="How far the box advances between fits, in Å. Half the box width gives overlapping boxes — a smoother track at twice the cost.">
          step
          <NumberField value={plan.step} min={0.05} disabled={busy} onCommit={(step) => onPlanChange({ step })} />
          Å
        </label>
        <SegmentedToggle
          options={[
            { id: "up", label: "low → high r", title: "Start at the smallest r and walk outward — each box seeded from the one before, so the local structure is carried into the average one" },
            { id: "down", label: "high → low r", title: "Start at the largest r and walk inward — seeded from the average structure, the usual way to test whether the local structure departs from it" },
          ] as const}
          value={plan.direction}
          onChange={(direction) => { if (!busy) onPlanChange({ direction }); }}
        />
        <label
          style={{ ...fieldLabel, cursor: busy ? "default" : "pointer" }}
          title="Random restarts per box: on top of the seed carried from the previous box, refine this many randomly perturbed starts and keep the lowest-χ² one. Use it when a track looks like it inherited a bad box — seeding forward makes the series path-dependent, and a box that fell into a local minimum hands it to every box after it. Costs (restarts + 1)× the scan time."
        >
          <input
            type="checkbox"
            checked={plan.randomStart}
            disabled={busy}
            onChange={(e) => onPlanChange({ randomStart: e.target.checked })}
            style={{ accentColor: color.primary }}
          />
          random restarts
          {plan.randomStart && (
            <NumberField
              value={plan.restarts}
              min={1}
              max={20}
              integer
              width={44}
              disabled={busy}
              onCommit={(restarts) => onPlanChange({ restarts })}
            />
          )}
          {plan.randomStart ? "per box" : ""}
        </label>
        <span style={{ fontFamily: mono, fontSize: fz.micro, color: planInfo.issue ? color.warnInk : color.secondary }}>
          {planInfo.issue
            ? planInfo.issue
            : `${planInfo.count} box${planInfo.count === 1 ? "" : "es"} · ` +
              `${planInfo.range.min.toFixed(2)}–${(planInfo.scannedMax ?? planInfo.range.max).toFixed(2)} Å` +
              (planInfo.scannedMax !== null && planInfo.scannedMax < planInfo.range.max - 1e-6
                ? ` (last ${(planInfo.range.max - planInfo.scannedMax).toFixed(2)} Å of the fit window has no room for a full box)`
                : "") +
              // step > width samples the span rather than covering it — say so,
              // or the r span above reads as continuous coverage.
              (plan.step > plan.width ? ` · ${(plan.step - plan.width).toFixed(2)} Å gaps between boxes` : "") +
              (plan.randomStart ? ` · ${planInfo.count * (plan.restarts + 1)} fits total` : "")}
        </span>
      </div>

      {blockedReason && !busy ? (
        <div style={{ fontSize: fz.small, color: color.warnInk }}>⚠ {blockedReason}</div>
      ) : null}

      {run ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {tracks.map((t) => (
              <button
                key={t.parameterId}
                onClick={() => setShownId(t.parameterId)}
                style={{ ...chip, ...(t.parameterId === shownId ? chipActive : {}) }}
                title={`Plot ${labels.get(t.parameterId) ?? t.parameterId} against the box center`}
              >
                {labels.get(t.parameterId) ?? t.parameterId}
              </button>
            ))}
            {tracks.length === 0 && (
              <span style={{ fontSize: fz.small, color: color.secondary }}>
                No free parameter produced a value — free some rows in the parameter panel and scan again.
              </span>
            )}
          </div>

          {/* Plot and table split the region: the plot is the headline, the
              table its numbers, and neither may push the other off-card. */}
          <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {track && (
              <div style={{ flex: "3 1 0", minHeight: 150 }}>
                <TrackPlot
                  windows={run.windows}
                  values={track.values}
                  esd={track.esd}
                  label={labels.get(track.parameterId) ?? track.parameterId}
                  rw={run.result.steps.map((s) => s.result.agreement.rWeighted ?? NaN)}
                  statuses={run.result.steps.map((s) => s.result.status)}
                />
              </div>
            )}
            <div style={{ flex: "2 1 0", minHeight: 74, overflow: "auto" }}>
              <StepTable run={run} shownId={shownId} labels={labels} onAdoptStep={onAdoptStep} busy={busy} />
            </div>
          </div>

          <p style={{ margin: 0, fontSize: 12, color: color.secondary, lineHeight: 1.5 }}>
            {run.partial ? (
              <b style={{ color: color.noteInk }}>Partial scan (stopped early) — </b>
            ) : null}
            {run.windows.length} boxes of {run.width} Å, scanned {run.direction === "up" ? "low → high r" : "high → low r"};
            each box was seeded from the previous one
            {run.restarts > 0
              ? `, then re-searched from ${run.restarts} randomly perturbed start${run.restarts === 1 ? "" : "s"} with the lowest-χ² one kept — so a drift here is not an inherited local minimum.`
              : ", so the tracks are a continuous path, not independent fits — turn on random restarts in the Boxcar strip to check that a drift is not an inherited local minimum."}{" "}
            Values are plotted at the box CENTER with their esds; esds come from uniform weights over G(r), so compare them with
            each other rather than reading them as absolute uncertainties. “Adopt” loads that box's values into the parameter panel.
          </p>
        </>
      ) : (
        <div style={{ color: color.secondary, fontSize: fz.small, lineHeight: 1.55 }}>
          Set the box above, free the parameters you want tracked in the refinement panel, then run the scan — the current
          settings fit <b>{planInfo.count}</b> box{planInfo.count === 1 ? "" : "es"} inside the fit window
          ({planInfo.range.min.toFixed(2)}–{planInfo.range.max.toFixed(2)} Å, set with the plot handles on the Refinement tab).
          Typical use: keep the cell and an ADP free, and hold the instrument terms (Qdamp/Qbroad) fixed at their calibrated
          values — they are properties of the diffractometer, not of r, so letting them float per box turns real drift into scatter.
        </div>
      )}
    </div>
  );
}

/** Value-vs-box-center with esd bars, over an Rw context strip. */
function TrackPlot({ windows, values, esd, label, rw, statuses }: {
  windows: readonly BoxcarWindow[];
  values: readonly (number | undefined)[];
  esd: readonly (number | undefined)[];
  label: string;
  rw: readonly number[];
  statuses: readonly string[];
}): JSX.Element {
  const pts = useMemo(() => {
    const out: { x: number; y: number; e: number; i: number }[] = [];
    windows.forEach((w, i) => {
      const v = values[i];
      if (v === undefined || !Number.isFinite(v)) return;
      const e = esd[i];
      out.push({ x: w.center, y: v, e: e !== undefined && Number.isFinite(e) ? e : 0, i });
    });
    // Scan direction only controls the fit ORDER; the plot always reads left to
    // right in r, so a "down" scan is not drawn mirrored.
    return out.sort((a, b) => a.x - b.x);
  }, [windows, values, esd]);

  const [boxRef, { width: PLOT_W, height: TOTAL_H }] = useElementSize<HTMLElement>();
  const PLOT_H = TOTAL_H - RW_H;

  // Every box failed to produce this value (all diverged, or the parameter was
  // fixed after all): there is no track to scale an axis to.
  if (pts.length === 0) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", color: color.secondary, fontSize: fz.small }}>
        No box produced a value for {label}.
      </div>
    );
  }

  const centers = windows.map((w) => w.center);
  const xMin = Math.min(...centers);
  const xMax = Math.max(...centers);
  const yLo = Math.min(...pts.map((p) => p.y - p.e));
  const yHi = Math.max(...pts.map((p) => p.y + p.e));
  const padY = (yHi - yLo || Math.abs(yHi) || 1) * 0.12;
  const sx = linearScale(xMin, xMax, PAD.left, PLOT_W - PAD.right);
  const sy = linearScale(yLo - padY, yHi + padY, PLOT_H - PAD.bottom, PAD.top);
  const sRw = linearScale(0, Math.max(0.001, ...rw.filter(Number.isFinite)), RW_H - 16, 4);

  const xTicks = tickValues(xMin, xMax, 5);
  const yTicks = tickValues(yLo - padY, yHi + padY, 4);

  return (
    <figure ref={boxRef} style={{ margin: 0, height: "100%", minHeight: 0 }}>
      <svg
        viewBox={`0 0 ${PLOT_W} ${TOTAL_H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: "block" }}
        role="img"
        aria-label={`${label} against box center r`}
      >
        {/* value panel */}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.left} x2={PLOT_W - PAD.right} y1={sy(t)} y2={sy(t)} stroke={color.subtle2} strokeWidth={1} />
            <text x={PAD.left - 6} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fontFamily={mono} fill={color.faint}>
              {fmtTick(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={PLOT_H - PAD.bottom + 15} textAnchor="middle" fontSize={10} fontFamily={mono} fill={color.faint}>
            {fmtTick(t)}
          </text>
        ))}
        <line x1={PAD.left} x2={PLOT_W - PAD.right} y1={PLOT_H - PAD.bottom} y2={PLOT_H - PAD.bottom} stroke={color.border} />
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PLOT_H - PAD.bottom} stroke={color.border} />
        {pts.length > 1 && (
          <polyline
            points={pts.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(" ")}
            fill="none"
            stroke={color.calc}
            strokeWidth={1.6}
          />
        )}
        {pts.map((p) => (
          <g key={p.i}>
            {p.e > 0 && (
              <>
                <line x1={sx(p.x)} x2={sx(p.x)} y1={sy(p.y - p.e)} y2={sy(p.y + p.e)} stroke={color.calc} strokeWidth={1} opacity={0.55} />
                <line x1={sx(p.x) - 3} x2={sx(p.x) + 3} y1={sy(p.y + p.e)} y2={sy(p.y + p.e)} stroke={color.calc} strokeWidth={1} opacity={0.55} />
                <line x1={sx(p.x) - 3} x2={sx(p.x) + 3} y1={sy(p.y - p.e)} y2={sy(p.y - p.e)} stroke={color.calc} strokeWidth={1} opacity={0.55} />
              </>
            )}
            <circle cx={sx(p.x)} cy={sy(p.y)} r={3} fill={statuses[p.i] === "diverged" || statuses[p.i] === "failed" ? color.warnInk : color.calc}>
              <title>{`box center ${p.x.toFixed(2)} Å · ${p.y.toPrecision(6)}${p.e > 0 ? ` ± ${p.e.toPrecision(2)}` : ""} · ${statuses[p.i]}`}</title>
            </circle>
          </g>
        ))}
        <text x={12} y={PAD.top + 4} fontSize={10.5} fontFamily={mono} fill={color.secondary} transform={`rotate(-90 12 ${PAD.top + 4})`} textAnchor="end">
          {label}
        </text>

        {/* Rw context strip: a value from a badly-fitted box means nothing. */}
        <g transform={`translate(0 ${PLOT_H})`}>
          <line x1={PAD.left} x2={PLOT_W - PAD.right} y1={RW_H - 16} y2={RW_H - 16} stroke={color.border} />
          {windows.map((w, i) => {
            const v = rw[i];
            if (!Number.isFinite(v)) return null;
            return (
              <rect
                key={i}
                x={sx(w.center) - 3}
                y={sRw(v!)}
                width={6}
                height={Math.max(1, RW_H - 16 - sRw(v!))}
                fill={color.obs}
                opacity={0.65}
              >
                <title>{`box center ${w.center.toFixed(2)} Å · Rw ${(100 * v!).toFixed(2)}%`}</title>
              </rect>
            );
          })}
          <text x={PAD.left - 6} y={12} textAnchor="end" fontSize={10} fontFamily={mono} fill={color.faint}>
            Rw
          </text>
          <text x={(PLOT_W + PAD.left) / 2} y={RW_H - 2} textAnchor="middle" fontSize={10.5} fontFamily={mono} fill={color.secondary}>
            box center r (Å)
          </text>
        </g>
      </svg>
    </figure>
  );
}

function StepTable({ run, shownId, labels, onAdoptStep, busy }: {
  run: BoxcarRun;
  shownId: string | null;
  labels: ReadonlyMap<string, string>;
  onAdoptStep: (index: number) => void;
  busy: boolean;
}): JSX.Element {
  const track = run.result.evolution.find((e) => e.parameterId === shownId);
  return (
    <div style={{ marginTop: 10, border: `1px solid ${color.border}`, borderRadius: 6 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: fz.micro }}>
        <thead>
          <tr style={{ color: color.secondary, textAlign: "left" }}>
            <th style={cell}>box (Å)</th>
            <th style={cell}>window</th>
            <th style={{ ...cell, textAlign: "right" }}>Rw</th>
            <th style={{ ...cell, textAlign: "right" }}>{shownId ? labels.get(shownId) ?? shownId : "value"}</th>
            <th style={{ ...cell, textAlign: "right" }}>esd</th>
            <th style={cell}>status</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {run.windows.map((w, i) => {
            const step = run.result.steps[i];
            if (!step) return null;
            const v = track?.values[i];
            const e = track?.esd[i];
            const bad = step.result.status === "diverged" || step.result.status === "failed";
            return (
              <tr key={i} style={{ borderTop: `1px solid ${color.subtle2}` }}>
                <td style={cell}>{w.center.toFixed(2)}</td>
                <td style={{ ...cell, color: color.secondary }}>{w.min.toFixed(2)}–{w.max.toFixed(2)}</td>
                <td style={{ ...cell, textAlign: "right" }}>
                  {step.result.agreement.rWeighted !== undefined ? `${(100 * step.result.agreement.rWeighted).toFixed(2)}%` : "—"}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>{v !== undefined && Number.isFinite(v) ? v.toPrecision(6) : "—"}</td>
                <td style={{ ...cell, textAlign: "right", color: color.secondary }}>
                  {e !== undefined && Number.isFinite(e) ? `±${e.toPrecision(2)}` : "—"}
                </td>
                <td style={{ ...cell, color: bad ? color.warnInk : color.secondary }}>
                  {step.result.status}
                  {!step.carried ? " · not carried" : ""}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  <button
                    style={{ ...adoptBtn, ...(busy ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}
                    disabled={busy}
                    onClick={() => onAdoptStep(i)}
                    title="Load this box's refined values into the parameter panel (the fit window is not changed)"
                  >
                    Adopt
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Round tick positions covering [lo, hi] — the same "nice numbers" the other
 *  hand-rolled plots use, kept local so this panel has no plot dependency. */
function tickValues(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const stepN = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
  const step = stepN * mag;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) out.push(t);
  return out;
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(1);
  return String(+v.toFixed(4));
}

/**
 * Numeric field that keeps what the user is typing until they commit it (blur
 * or Enter) — the `ParamRow` convention. A plain controlled number input snaps
 * an emptied field back to 0 mid-edit, which here would also flip the plan to
 * "width must be positive" while someone is simply retyping a number.
 */
function NumberField({ value, min, max, integer = false, width = 56, disabled, onCommit }: {
  value: number;
  min: number;
  max?: number;
  integer?: boolean;
  width?: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}): JSX.Element {
  const [buf, setBuf] = useState<string | null>(null);
  const commit = (raw?: string): void => {
    const source = raw !== undefined ? raw : buf;
    setBuf(null);
    // An empty or unparsable entry reverts to the last good value rather than
    // silently committing the minimum — `Number("")` is 0, which would clamp
    // to the bound and quietly rewrite what the user was editing.
    if (source === null || source.trim() === "") return;
    const v = Number(source);
    if (!Number.isFinite(v)) return;
    onCommit(Math.min(max ?? Infinity, Math.max(min, integer ? Math.round(v) : v)));
  };
  return (
    <input
      type="number"
      min={min}
      {...(max !== undefined ? { max } : {})}
      step={integer ? 1 : 0.5}
      value={buf ?? String(value)}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setBuf(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{ ...numberInput, width }}
    />
  );
}

const planBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  rowGap: 6,
  flexWrap: "wrap",
  padding: "7px 10px",
  borderRadius: 8,
  border: `1px solid ${color.border}`,
  background: color.muted2,
};
const fieldLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontFamily: mono,
  fontSize: fz.micro,
  color: color.secondary,
};
const numberInput: CSSProperties = {
  border: `1px solid ${color.input}`,
  borderRadius: 7,
  fontSize: 12,
  fontFamily: mono,
  padding: "2px 6px",
  background: "#fff",
};
const cell: CSSProperties = { padding: "3px 8px", fontWeight: 500 };
const chip: CSSProperties = {
  border: `1px solid ${color.control}`,
  background: "#fff",
  borderRadius: 999,
  padding: "2px 11px",
  fontSize: fz.micro,
  fontFamily: mono,
  color: color.secondary,
  cursor: "pointer",
};
const chipActive: CSSProperties = {
  border: `1px solid ${color.primaryTintBorder}`,
  background: color.primaryTintBg,
  color: color.primary,
  fontWeight: 600,
};
const adoptBtn: CSSProperties = {
  border: `1px solid ${color.control}`,
  background: "#fff",
  borderRadius: 7,
  padding: "1px 9px",
  fontSize: fz.micro,
  fontFamily: mono,
  color: color.secondary,
  cursor: "pointer",
};
