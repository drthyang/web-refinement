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

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SequentialResult } from "@/core/refinement/sequential";
import { boxcarStepIndex, type BoxcarDirection, type BoxcarWindow } from "@/core/workflow/pdfBoxcar";
import { color, fz, mono, primaryButton, secondaryButton } from "@/app/theme";
import { InfoBadge } from "@/app/ui/InfoBadge";
import { SegmentedToggle } from "@/app/ui/SegmentedToggle";
import { linearScale } from "@/visualization/scale";

/** One scan pass: the fits made walking the boxes in one direction. Its
 *  `result.steps` are in SCAN order, which for a "down" pass is the reverse of
 *  the run's (ascending) window list — {@link stepIndexFor} maps between them. */
export interface BoxcarSeries {
  readonly direction: BoxcarDirection;
  readonly result: SequentialResult;
}

/** A completed (or in-progress) boxcar scan: the plan and the series it made. */
export interface BoxcarRun {
  /** The full plan, ALWAYS ascending in r, whichever way the passes walked it. */
  readonly windows: readonly BoxcarWindow[];
  /** One entry per direction scanned (two when the run compares both). */
  readonly series: readonly BoxcarSeries[];
  /** Box width used (Å) — reported in the caption, since the plan can be edited
   *  in the panel after a run without invalidating the run itself. */
  readonly width: number;
  /** Randomized restarts each box ran beyond its seeded start (0 = seed only). */
  readonly restarts: number;
  /** Ids that were free when this run started — the tracks worth plotting.
   *  Frozen with the run: the panel's free flags may have changed since. */
  readonly freeIds: readonly string[];
  /** True when the scan was cancelled (or failed) partway: some boxes (or a
   *  whole pass) are missing from the plan. */
  readonly partial?: boolean;
}

/** {@link boxcarStepIndex} bound to a series (see there for the ordering rule). */
export function stepIndexFor(series: BoxcarSeries, windowIndex: number, total: number): number {
  return boxcarStepIndex(series.direction, windowIndex, total, series.result.steps.length);
}

/** Scan order the user asked for: one direction, or both for the comparison. */
export type BoxcarDirectionChoice = BoxcarDirection | "both";

/** The scan the controls describe (owned by the workbench, edited here). */
export interface BoxcarPlan {
  readonly width: number;
  readonly step: number;
  readonly direction: BoxcarDirectionChoice;
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
  /** Adopt one box's refined values into the parameter panel (by series and
   *  ascending window index — a compared run has two candidates per box). */
  readonly onAdoptStep: (seriesIndex: number, windowIndex: number) => void;
}

/** Series ink: the two passes read like the two curves on the fit plot. */
const SERIES_INK: Record<BoxcarDirection, string> = { up: color.calc, down: color.obs };
const DIRECTION_LABEL: Record<BoxcarDirection, string> = { up: "low → high r", down: "high → low r" };

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
  // Parameters worth a chip: free during the run (fixed rows are flat lines by
  // construction) and carrying a value in at least one box of some pass.
  const trackIds = useMemo(() => {
    if (!run) return [];
    const freeSet = new Set(run.freeIds);
    const ids: string[] = [];
    for (const e of run.series[0]?.result.evolution ?? []) {
      if (!freeSet.has(e.parameterId)) continue;
      const anyValue = run.series.some((s) =>
        s.result.evolution.find((x) => x.parameterId === e.parameterId)?.values.some((v) => v !== undefined && Number.isFinite(v)),
      );
      if (anyValue) ids.push(e.parameterId);
    }
    return ids;
  }, [run]);

  const [shownId, setShownId] = useState<string | null>(null);
  // A new scan (or a different free set) invalidates the selection; default to
  // the first track so the tab is never an empty frame after a run.
  useEffect(() => {
    setShownId((prev) => (prev && trackIds.includes(prev) ? prev : trackIds[0] ?? null));
  }, [trackIds]);

  /**
   * The selected parameter, aligned onto the ascending window list: one row per
   * box per pass. This is where a "down" pass's reversed step order is undone,
   * so everything downstream — plot, table, CSV, the direction comparison —
   * reads left to right in r regardless of which way the fit walked.
   */
  const aligned = useMemo(() => {
    if (!run || shownId === null) return null;
    const total = run.windows.length;
    const passes = run.series.map((s) => {
      const evo = s.result.evolution.find((e) => e.parameterId === shownId);
      const cells = run.windows.map((w, wi) => {
        const si = stepIndexFor(s, wi, total);
        const step = si >= 0 ? s.result.steps[si] : undefined;
        if (!step || !evo) return null;
        const value = evo.values[si];
        const esd = evo.esd[si];
        return {
          center: w.center,
          windowIndex: wi,
          value: value !== undefined && Number.isFinite(value) ? value : null,
          esd: esd !== undefined && Number.isFinite(esd) ? esd : null,
          rw: step.result.agreement.rWeighted ?? null,
          status: step.result.status,
        };
      });
      return { direction: s.direction, cells };
    });
    return { total, passes };
  }, [run, shownId]);

  /**
   * The comparison the two-pass run exists for: how far apart the directions
   * land at each box, in units of their combined esd. Seeding forward is what
   * makes a boxcar path-dependent, so a track that reproduces from both ends is
   * a track you can believe; a large separation means the fit is following its
   * starting point, not the data.
   */
  const hysteresis = useMemo(() => {
    if (!aligned || aligned.passes.length < 2) return null;
    const [a, b] = aligned.passes;
    let worst: { center: number; sigma: number; delta: number } | null = null;
    let compared = 0;
    for (let i = 0; i < aligned.total; i++) {
      const x = a!.cells[i];
      const y = b!.cells[i];
      if (!x || !y || x.value === null || y.value === null) continue;
      compared++;
      const delta = Math.abs(x.value - y.value);
      // Combined esd of the two independent fits; fall back to whichever exists
      // so a box with one missing esd still contributes its raw separation.
      const ex = x.esd ?? 0;
      const ey = y.esd ?? 0;
      const sigma = Math.hypot(ex, ey);
      const ratio = sigma > 0 ? delta / sigma : Infinity;
      if (!worst || ratio > (worst.sigma > 0 ? worst.delta / worst.sigma : Infinity)) {
        worst = { center: x.center, sigma, delta };
      }
    }
    if (!worst || compared === 0) return null;
    const ratio = worst.sigma > 0 ? worst.delta / worst.sigma : Infinity;
    return { compared, worst, ratio };
  }, [aligned]);

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
            { id: "both", label: "both", title: "Scan the same boxes BOTH ways from the same starting model and plot the two tracks together. Where they agree, the drift is in the data; where they separate, the fit is following its seed rather than the G(r) — the boxcar's characteristic failure. Costs two passes." },
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
              (plan.direction === "both" || plan.randomStart
                ? ` · ${planInfo.count * (plan.randomStart ? plan.restarts + 1 : 1) * (plan.direction === "both" ? 2 : 1)} fits total`
                : "")}
        </span>
      </div>

      {blockedReason && !busy ? (
        <div style={{ fontSize: fz.small, color: color.warnInk }}>⚠ {blockedReason}</div>
      ) : null}

      {run ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, rowGap: 5, flexWrap: "wrap" }}>
            {trackIds.map((id) => (
              <button
                key={id}
                onClick={() => setShownId(id)}
                style={{ ...chip, ...(id === shownId ? chipActive : {}) }}
                title={`Plot ${labels.get(id) ?? id} against the box center`}
              >
                {labels.get(id) ?? id}
              </button>
            ))}
            {trackIds.length === 0 && (
              <span style={{ fontSize: fz.small, color: color.secondary }}>
                No free parameter produced a value — free some rows in the parameter panel and scan again.
              </span>
            )}
            {run.series.length > 1 && (
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10, fontFamily: mono, fontSize: fz.micro }}>
                {run.series.map((s) => (
                  <span key={s.direction} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: color.secondary }}>
                    <span style={{ width: 14, height: 2, background: SERIES_INK[s.direction], display: "inline-block" }} />
                    {DIRECTION_LABEL[s.direction]}
                  </span>
                ))}
              </span>
            )}
          </div>

          {/* The verdict of a two-pass run, stated rather than left to the eye:
              agreement means the drift is in the data, separation means the fit
              is following its seed. */}
          {hysteresis && (
            <div
              style={{
                ...verdictBar,
                border: `1px solid ${hysteresis.ratio <= 2 ? color.okBorder : color.noteBorder}`,
                background: hysteresis.ratio <= 2 ? color.okBg : color.noteBg,
                color: hysteresis.ratio <= 2 ? color.okInk : color.noteInk,
              }}
            >
              <b>
                {hysteresis.ratio <= 2
                  ? "The two directions agree"
                  : "The two directions disagree — this track is path-dependent"}
              </b>
              <span style={{ fontFamily: mono }}>
                worst gap {Number.isFinite(hysteresis.ratio) ? `${hysteresis.ratio.toFixed(1)}σ` : "—"}
                {" ("}
                {hysteresis.worst.delta.toPrecision(3)}
                {hysteresis.worst.sigma > 0 ? ` vs esd ${hysteresis.worst.sigma.toPrecision(2)}` : " (no esd)"}
                {`) at r = ${hysteresis.worst.center.toFixed(2)} Å · ${hysteresis.compared} boxes compared`}
              </span>
            </div>
          )}

          {/* Plot and table split the region: the plot is the headline, the
              table its numbers, and neither may push the other off-card. */}
          <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {aligned && shownId !== null && (
              <div style={{ flex: "3 1 0", minHeight: 150 }}>
                <TrackPlot passes={aligned.passes} label={labels.get(shownId) ?? shownId} />
              </div>
            )}
            <div style={{ flex: "2 1 0", minHeight: 74, overflow: "auto" }}>
              <StepTable
                run={run}
                aligned={aligned}
                shownId={shownId}
                labels={labels}
                onAdoptStep={onAdoptStep}
                busy={busy}
              />
            </div>
          </div>

          <p style={{ margin: 0, fontSize: 12, color: color.secondary, lineHeight: 1.5 }}>
            {busy ? (
              <b style={{ color: color.primary }}>Scanning — the plot fills in as each box is fitted. </b>
            ) : run.partial ? (
              <b style={{ color: color.noteInk }}>Partial scan (stopped early) — </b>
            ) : null}
            {run.windows.length} boxes of {run.width} Å, scanned{" "}
            {run.series.length > 1
              ? "both ways from the same starting model"
              : DIRECTION_LABEL[run.series[0]?.direction ?? "up"]}
            ; each box was seeded from the previous one
            {run.restarts > 0
              ? `, then re-searched from ${run.restarts} randomly perturbed start${run.restarts === 1 ? "" : "s"} with the lowest-χ² one kept.`
              : run.series.length > 1
                ? "."
                : ", so the track is a continuous path, not independent fits — scan both directions, or turn on random restarts, to check that a drift is not an inherited local minimum."}{" "}
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

/** One box's fit of the shown parameter, aligned onto the ascending plan. */
interface AlignedCell {
  readonly center: number;
  readonly windowIndex: number;
  readonly value: number | null;
  readonly esd: number | null;
  readonly rw: number | null;
  readonly status: string;
}
interface AlignedPass {
  readonly direction: BoxcarDirection;
  readonly cells: readonly (AlignedCell | null)[];
}

/**
 * Value vs box center for every pass, over a shared Rw strip. Both passes are
 * drawn on ONE pair of axes — the whole point of a two-direction run is reading
 * their separation, which a side-by-side pair of plots would hide.
 */
function TrackPlot({ passes, label }: { passes: readonly AlignedPass[]; label: string }): JSX.Element {
  const drawn = useMemo(
    () =>
      passes.map((p) => ({
        direction: p.direction,
        // Ascending in r whichever way the fit walked: the reader compares
        // length scales, not scan order.
        pts: p.cells.filter((c): c is AlignedCell => c !== null && c.value !== null),
      })),
    [passes],
  );

  const [boxRef, { width: PLOT_W, height: TOTAL_H }] = useElementSize<HTMLElement>();
  const PLOT_H = TOTAL_H - RW_H;

  const all = drawn.flatMap((d) => d.pts);
  // Every box failed to produce this value (all diverged, or the parameter was
  // fixed after all): there is no track to scale an axis to.
  if (all.length === 0) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", color: color.secondary, fontSize: fz.small }}>
        No box produced a value for {label}.
      </div>
    );
  }

  const centers = passes.flatMap((p) => p.cells.filter((c): c is AlignedCell => c !== null).map((c) => c.center));
  const xMin = Math.min(...centers);
  const xMax = Math.max(...centers);
  const yLo = Math.min(...all.map((p) => p.value! - (p.esd ?? 0)));
  const yHi = Math.max(...all.map((p) => p.value! + (p.esd ?? 0)));
  const padY = (yHi - yLo || Math.abs(yHi) || 1) * 0.12;
  const sx = linearScale(xMin, xMax, PAD.left, PLOT_W - PAD.right);
  const sy = linearScale(yLo - padY, yHi + padY, PLOT_H - PAD.bottom, PAD.top);
  const rwMax = Math.max(0.001, ...all.map((p) => p.rw ?? 0));
  const sRw = linearScale(0, rwMax, RW_H - 16, 4);
  // Two passes fit the same boxes, so their Rw bars would overprint at identical
  // x — offset them by half a bar so both remain readable.
  const barW = passes.length > 1 ? 3 : 6;
  const barOffset = (i: number): number => (passes.length > 1 ? (i === 0 ? -barW : 0) : -barW / 2);

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
        aria-label={`${label} against box center r${passes.length > 1 ? ", scanned in both directions" : ""}`}
      >
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

        {drawn.map(({ direction, pts }) => {
          const ink = SERIES_INK[direction];
          return (
            <g key={direction}>
              {pts.length > 1 && (
                <polyline
                  points={pts.map((p) => `${sx(p.center).toFixed(2)},${sy(p.value!).toFixed(2)}`).join(" ")}
                  fill="none"
                  stroke={ink}
                  strokeWidth={1.6}
                  // The second pass is dashed as well as coloured: where the two
                  // agree they overlap exactly, and one line would simply hide
                  // the other on a monochrome print.
                  {...(direction === "down" ? { strokeDasharray: "5 3" } : {})}
                />
              )}
              {pts.map((p) => (
                <g key={`${direction}-${p.windowIndex}`}>
                  {p.esd !== null && p.esd > 0 && (
                    <>
                      <line x1={sx(p.center)} x2={sx(p.center)} y1={sy(p.value! - p.esd)} y2={sy(p.value! + p.esd)} stroke={ink} strokeWidth={1} opacity={0.55} />
                      <line x1={sx(p.center) - 3} x2={sx(p.center) + 3} y1={sy(p.value! + p.esd)} y2={sy(p.value! + p.esd)} stroke={ink} strokeWidth={1} opacity={0.55} />
                      <line x1={sx(p.center) - 3} x2={sx(p.center) + 3} y1={sy(p.value! - p.esd)} y2={sy(p.value! - p.esd)} stroke={ink} strokeWidth={1} opacity={0.55} />
                    </>
                  )}
                  <circle
                    cx={sx(p.center)}
                    cy={sy(p.value!)}
                    r={3}
                    fill={p.status === "diverged" || p.status === "failed" ? color.warnInk : ink}
                    {...(direction === "down" ? { fillOpacity: 0.75 } : {})}
                  >
                    <title>
                      {`${DIRECTION_LABEL[direction]} · box center ${p.center.toFixed(2)} Å · ${p.value!.toPrecision(6)}` +
                        `${p.esd ? ` ± ${p.esd.toPrecision(2)}` : ""} · ${p.status}`}
                    </title>
                  </circle>
                </g>
              ))}
            </g>
          );
        })}

        <text x={12} y={PAD.top + 4} fontSize={10.5} fontFamily={mono} fill={color.secondary} transform={`rotate(-90 12 ${PAD.top + 4})`} textAnchor="end">
          {label}
        </text>

        {/* Rw context strip: a value from a badly-fitted box means nothing. */}
        <g transform={`translate(0 ${PLOT_H})`}>
          <line x1={PAD.left} x2={PLOT_W - PAD.right} y1={RW_H - 16} y2={RW_H - 16} stroke={color.border} />
          {passes.map((pass, pi) =>
            pass.cells.map((c) => {
              if (!c || c.rw === null) return null;
              return (
                <rect
                  key={`${pass.direction}-${c.windowIndex}`}
                  x={sx(c.center) + barOffset(pi)}
                  y={sRw(c.rw)}
                  width={barW}
                  height={Math.max(1, RW_H - 16 - sRw(c.rw))}
                  fill={SERIES_INK[pass.direction]}
                  opacity={0.55}
                >
                  <title>{`${DIRECTION_LABEL[pass.direction]} · box center ${c.center.toFixed(2)} Å · Rw ${(100 * c.rw).toFixed(2)}%`}</title>
                </rect>
              );
            }),
          )}
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

function StepTable({ run, aligned, shownId, labels, onAdoptStep, busy }: {
  run: BoxcarRun;
  aligned: { total: number; passes: AlignedPass[] } | null;
  shownId: string | null;
  labels: ReadonlyMap<string, string>;
  onAdoptStep: (seriesIndex: number, windowIndex: number) => void;
  busy: boolean;
}): JSX.Element {
  const passes = aligned?.passes ?? [];
  const compare = passes.length > 1;
  const valueHead = shownId ? labels.get(shownId) ?? shownId : "value";
  return (
    <div style={{ marginTop: 10, border: `1px solid ${color.border}`, borderRadius: 6 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: fz.micro }}>
        <thead>
          <tr style={{ color: color.secondary, textAlign: "left" }}>
            <th style={cell}>box (Å)</th>
            <th style={cell}>window</th>
            {passes.map((p) => (
              <th key={`h-${p.direction}`} colSpan={2} style={{ ...cell, textAlign: "right", color: compare ? SERIES_INK[p.direction] : color.secondary }}>
                {compare ? DIRECTION_LABEL[p.direction] : ""} Rw · {valueHead}
              </th>
            ))}
            {compare && (
              <th style={{ ...cell, textAlign: "right" }} title="Separation between the two directions at this box, in units of their combined esd. Small means the value is set by the data; large means it is set by where the fit started.">
                gap
              </th>
            )}
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {run.windows.map((w, wi) => {
            const cells = passes.map((p) => p.cells[wi] ?? null);
            if (cells.every((c) => c === null)) return null;
            const [a, b] = cells;
            const gap =
              compare && a && b && a.value !== null && b.value !== null
                ? { delta: Math.abs(a.value - b.value), sigma: Math.hypot(a.esd ?? 0, b.esd ?? 0) }
                : null;
            const ratio = gap ? (gap.sigma > 0 ? gap.delta / gap.sigma : Infinity) : null;
            return (
              <tr key={wi} style={{ borderTop: `1px solid ${color.subtle2}` }}>
                <td style={cell}>{w.center.toFixed(2)}</td>
                <td style={{ ...cell, color: color.secondary }}>{w.min.toFixed(2)}–{w.max.toFixed(2)}</td>
                {cells.map((c, ci) => {
                  const bad = c && (c.status === "diverged" || c.status === "failed");
                  return (
                    <Fragment key={`c-${ci}`}>
                      <td style={{ ...cell, textAlign: "right", color: bad ? color.warnInk : color.secondary }}>
                        {c?.rw !== null && c?.rw !== undefined ? `${(100 * c.rw).toFixed(2)}%` : "—"}
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        {c?.value !== null && c?.value !== undefined ? c.value.toPrecision(6) : "—"}
                        {c?.esd ? <span style={{ color: color.faint }}> ±{c.esd.toPrecision(2)}</span> : null}
                      </td>
                    </Fragment>
                  );
                })}
                {compare && (
                  <td style={{ ...cell, textAlign: "right", color: ratio !== null && ratio > 2 ? color.noteInk : color.secondary }}>
                    {ratio === null ? "—" : Number.isFinite(ratio) ? `${ratio.toFixed(1)}σ` : "∞"}
                  </td>
                )}
                <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                  {cells.map((c, ci) =>
                    c === null ? null : (
                      <button
                        key={`a-${ci}`}
                        style={{ ...adoptBtn, ...(busy ? { opacity: 0.5, cursor: "not-allowed" } : {}), ...(compare ? { marginLeft: 3, color: SERIES_INK[passes[ci]!.direction] } : {}) }}
                        disabled={busy}
                        onClick={() => onAdoptStep(ci, wi)}
                        title={
                          compare
                            ? `Load this box's values from the ${DIRECTION_LABEL[passes[ci]!.direction]} pass into the parameter panel (the fit window is not changed)`
                            : "Load this box's refined values into the parameter panel (the fit window is not changed)"
                        }
                      >
                        {compare ? (passes[ci]!.direction === "up" ? "↑" : "↓") : "Adopt"}
                      </button>
                    ),
                  )}
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

/** The two-direction verdict, stated where the plot's reader will look first. */
const verdictBar: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  rowGap: 4,
  flexWrap: "wrap",
  padding: "6px 11px",
  borderRadius: 8,
  fontSize: fz.small,
};
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
