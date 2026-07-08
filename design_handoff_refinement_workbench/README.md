# Handoff: Web Refinement Workbench — Setup & Structural Refinement

## Overview
A browser-based **Rietveld powder-diffraction refinement workbench**. This screen (steps 1–3 of a 7-step workflow) lets a scientist load a crystal structure, powder data, and instrument parameters; inspect the observed-vs-calculated powder pattern; toggle which parameters are refined; run a least-squares refinement; and read out the fit quality (wR, GoF, χ²). It is an interactive scientific instrument UI — the plot and the parameter table are the two primary work surfaces and are meant to be worked side-by-side.

## About the Design Files
The files in this bundle are **design references created in HTML** — a working prototype showing the intended look and behavior. They are **not production code to copy directly**. The task is to **recreate this design in the target codebase's existing environment** (React, Vue, Svelte, native, etc.) using its established component patterns, charting approach, and state management. If no environment exists yet, choose the most appropriate framework (a React + SVG/plotting-library stack fits this UI well) and implement there.

The prototype is written as a single "Design Component" HTML file. `Modern Lab Workbench.dc.html` contains both the markup and the logic class; `support.js` is the prototype runtime (a lightweight template/render layer) and is **not** something to port — reimplement the logic idiomatically in your framework. Read the logic class in the `.dc.html` for the exact math (peak positions, background polynomial, refinement simulation, coordinate mapping).

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and interactions are all specified. Recreate the UI pixel-accurately using the codebase's existing libraries. The powder-pattern chart is a custom SVG plot — reproduce its exact geometry and behavior (see the Chart section) or rebuild equivalently with the codebase's charting library while preserving the specified layout, axes, overlays, and interactions.

---

## Layout (top to bottom)

The screen is a full-height (`min-height: 100vh`) vertical flex column on a warm off-white page background `#faf7f2`, body font **IBM Plex Sans**, ink color `#191714`.

1. **Header bar** (sticky visual top; not position-sticky in the prototype)
2. **Status bar** (thin full-width strip)
3. **Main content** — max-width `1480px`, centered, `flex: 1`
   - Row A: three summary cards (Structure / Data / Instrument), equal 3-column grid
   - Row B: two panels in a 3-column grid — **plot card spans 2 columns**, **parameter panel spans 1**, `align-items: stretch` so both are equal height
4. **Disclaimer bar** (warn-colored strip)
5. **Copyright footer**

Global spacing: content padding `16–24px`; grid `gap: 14px`; cards `border-radius: 12px`, `border: 1px solid #e8e2d8`, `background: #fff`.

---

## Components

### Header bar
- Container: `display:flex; align-items:center; gap:22px; padding:12px 24px; border-bottom:1px solid #e8e2d8; background:#fffdf9; box-shadow:0 1px 0 rgba(25,23,20,0.02), 0 3px 10px rgba(25,23,20,0.025); flex-wrap:wrap`.
- **Brand mark**: 30×30 rounded square (`border-radius:8px`), `background:#1f4fd8`, `box-shadow:0 1px 3px rgba(31,79,216,0.35)`, containing an inline SVG of **concentric diffraction rings** (three white circles at r=8.3 opacity .32, r=5.2 opacity .62, r=2.2 filled, stroke-width 1.3, on a 20×20 viewBox).
- **Brand text**: title "Web Refinement Workbench" (16px / 700 / letter-spacing −.02em) with a kicker line beneath "Powder diffraction · Rietveld" (10.5px, `#94897a`), line-height 1.15.
- **Version tag**: "v0.9" mono chip — `font-family:'IBM Plex Mono'`, 10.5px, `color:#5f594f`, `background:#f3eee4`, `border:1px solid #e8e2d8`, `border-radius:6px`, `padding:2px 7px`.
- **Divider**: 1px × 30px `#e8e2d8`.
- **Workflow stepper**: horizontal row of pill buttons, `gap:5px`, wrap. Each pill: `border-radius:999px; padding:5px 14px; font-size:11.5px; display:inline-flex; align-items:center; gap:7px`. A leading number in IBM Plex Mono precedes the label.
  - **Active** pill (the "1–3 · Setup & refinement" step): `background:#1f4fd8; color:#fff; border:1px solid #1f4fd8; font-weight:600; box-shadow:0 1px 2px rgba(31,79,216,0.3)`; leading number opacity .75.
  - **Inactive** pills ("4 Quality", "5 Candidates", "6 Magnetic", "7 Compare"): `background:#fff; border:1px solid #ddd5c7; color:#5f594f; cursor:pointer`; number color `#94897a`; hover `border-color:#1f4fd8; color:#1f4fd8`.
- **Actions** (right, `margin-left:auto; gap:8px`): two secondary buttons "Export CSV" and "Export project JSON" — `border:1px solid #ddd5c7; background:#fff; border-radius:8px; padding:6px 13px; font-size:12.5px`; hover `background:#f5f0e7`. Export CSV downloads a CSV of `tof_us,yobs,ycalc,ybkg,diff`.

### Status bar
- `display:flex; align-items:center; gap:8px; padding:7px 24px; border-bottom:1px solid #e8e2d8; background:#f7f3ec; font-size:12px; color:#5f594f`.
- A 6px blue dot (`#1f4fd8`), an uppercase "STATUS" label (9.5px / 600 / letter-spacing .09em / `#94897a`), then the live status message in `#191714`. Message updates on load / during refinement / on convergence (e.g. "Powder refinement converged: wR = 4.83% (8 cycles).").

### Summary cards (Structure / Data / Instrument)
Each: `padding:12px 16px; display:flex; flex-direction:column; gap:5px`.
- Header row: uppercase label (10px / 600 / letter-spacing .08em / `#94897a`) + right-aligned ghost button ("Load CIF…" / "Load data…" / "Load instrument…", `border:1px solid #ddd5c7; border-radius:7px; padding:1px 9px; font-size:11px`; hover `background:#f5f0e7`).
- Status chip (OK style): `font-size:11px; padding:1px 9px; border-radius:999px; background:#eff5ea; border:1px solid #d3e2c4; color:#3f6b25` — e.g. "✓ parsed", "✓ loaded".
- Title line: 14px / 700 (e.g. "Mn₃Ga · P6₃/mmc (194)", "Mn₃Ga POWGEN 600 K", "POWGEN .instprm · TOF").
- Meta line: 11.5px, `#5f594f`, IBM Plex Mono (e.g. "a 5.42185 · c 4.37543 Å · V 111.41 Å³ · 2 sites").

### Plot card (spans 2 columns) — **the powder pattern chart**
Card: `padding:14px 16px; display:flex; flex-direction:column`.

**Header row** (`display:flex; align-items:center; gap:10px; margin-bottom:8px`):
- Uppercase title "Powder pattern — observed vs calculated" (10px / 600 / `#94897a`).
- **X-axis unit toggle** (segmented control, `margin-left:auto`): container `display:inline-flex; gap:2px; background:#f3eee4; border:1px solid #e8e2d8; border-radius:8px; padding:2px`. Three buttons **TOF / d / Q**. Active button `background:#1f4fd8; color:#fff`; inactive `background:transparent; color:#5f594f`. Each `border:none; border-radius:6px; padding:3px 11px; font-size:11px; font-weight:600`.
- "wR" label (11px uppercase `#94897a`) + wR value (16px / 600 / `#1f4fd8` / IBM Plex Mono, e.g. "25.17%").

**Chart** (SVG, `viewBox="0 0 860 560"`, `preserveAspectRatio="none"`, absolutely positioned to fill a `position:relative; flex:1` wrapper so it stretches to the panel's full height):
- Paper background `#fffdf9`.
- **Intensity (main) region**: y=14 (top) to baseline y=380. Left axis line and bottom baseline in `#c9c0b0`.
- **Y-axis ticks**: computed "nice" numeric labels (0, 2k, 4k, …) auto-scaled to the max intensity currently in view. Tick marks x=54→58; labels right-aligned at x=51, 9.5px IBM Plex Mono `#94897a`. Rotated axis title "Intensity (a.u.)" at x=16, centered on the region.
- **X-axis ticks**: ~6 "nice" ticks spanning the current view range; labels centered at y=396, 10px IBM Plex Mono `#94897a`. Axis title at y=552 — **text switches with the toggle**: "TOF (µs)" / "d-spacing (Å)" / "Q (Å⁻¹)". Tick labels are converted per mode (d = (TOF − zero)/difC; Q = 2π/d).
- **Data series** (drawn over the region):
  - **obs** — orange `#d84a1b`, drawn as dotted markers (`stroke-width:2.6`, `opacity:0.5`).
  - **calc** — blue `#1f4fd8` polyline, `stroke-width:1.4`.
  - **bkg** — amber `#a87a10` dashed polyline (`stroke-dasharray:5 3`, `stroke-width:1.2`), toggleable (opacity 0.9 / 0).
  - **diff** — green `oklch(0.55 0.12 155)` polyline, `stroke-width:1`, drawn in a lower band around baseline y=458 (±58), with a dashed zero line at y=458 in `#e0d8c9` and a rotated "Difference" axis label at x=16 centered on the band.
- **Legend** (top-left, y≈24): obs (dot), calc (line), diff (line), bkg (dashed line), hkl (short vertical tick), each with a 11px `#5f594f` label.
- **Bragg reflection markers**: a row of thin vertical ticks (`stroke:#1f4fd8; stroke-width:1; opacity:0.7`) from y=384 to y=393, one per allowed hkl reflection, positioned at each peak's TOF. Each tick has an **invisible 8px-wide hit area** and a native tooltip (`<title>`) showing the reflection: e.g. `(1 0 0)   d 2.712 Å   Q 2.32 Å⁻¹   TOF 61234 µs`. Marker positions recompute live as cell/instrument params change.
- **Excluded-region scrims**: outside the fit range, two semi-transparent paper-colored rects (`fill:#fffdf9; opacity:0.6`) are drawn *over* the curves to dim them, plus a faint blue tint (`fill:#1f4fd8; opacity:0.06`) underneath.
- **Fit-range handles**: two full-height vertical lines (`#1f4fd8; stroke-width:1.5`) at the fit min/max, each with a 12px-wide transparent drag grip and a rounded blue cap (9×14, `rx:3`) **at the bottom of the plot** (y=507), `cursor:ew-resize`.

**Caption row** (below chart, `margin-top:8px; font-size:12px; color:#5f594f`): help text "Powder (TOF) · back-to-back-exponential profile[· fit range …] · drag across the plot to zoom, blue handles to set the fit range." Followed by conditional controls: a mono "view <lo>–<hi> µs" label + "Zoom out" + "Reset zoom" buttons (shown when zoomed), and a "Reset range" button (shown when a fit range is set). Small buttons: `border:1px solid #ddd5c7; background:#fff; border-radius:7px; padding:1px 9px; font-size:11px`; hover `background:#f5f0e7`.

### Parameter panel (spans 1 column)
Card: `display:flex; flex-direction:column; overflow:hidden`.
- **Header**: uppercase "Powder parameters" label + right-aligned mono free-count ("12 of 25 free").
- **Column header row** (`grid-template-columns:1fr 104px 62px 62px`): Parameter / Value / esd / Refine — 10px / 600 uppercase `#94897a`, bottom border.
- **Scrolling body** (`max-height:520px; overflow-y:auto`): parameter **groups** (Scale, Background, Lattice, Instrument / profile, ADPs (thermal), Positions, Occupancy). Each group:
  - **Group header** (`background:#f6f1e8; border-top:1px solid #eee7da; padding:8px 14px; cursor:pointer`): caret (`#1f4fd8`), group name (11px / 700 uppercase), mono count ("6/6 free"), and a right-aligned "all" checkbox (`accent-color:#1f4fd8`) that frees/fixes the whole group. Click header toggles open/collapsed.
  - **Parameter rows** (`grid-template-columns:1fr 104px 62px 62px; padding:4px 14px 4px 29px; border-left:3px solid <accent>`): label; a numeric `<input>` (88px, `border:1px solid #d8d0c2; border-radius:7px; font-size:12px; IBM Plex Mono`; focus `border-color:#1f4fd8`; committed on blur/Enter); esd (11px mono `#94897a`); and a status pill:
    - **free**: `border:1px solid #b9c6f4; background:#eaf0fe; color:#1f4fd8` "● free"
    - **fixed**: `border:1px solid #e2dccf; background:#f6f2ea; color:#94897a` "○ fixed"
    - **calib** (locked/calibration params): `border:1px solid #eee7da; background:#faf7f2; color:#b3a993` "calib"
    - Clicking a (non-locked) row toggles free/fixed.
- **Footer** (`border-top:1px solid #e8e2d8; padding:12px 14px; background:#fbf8f2; display:flex; flex-direction:column; gap:8px`):
  - Button row: **Refine selected** (primary — `border:1px solid #1f4fd8; background:#1f4fd8; color:#fff; border-radius:8px; padding:7px 16px; font-size:12.5px; font-weight:600`; hover `background:#1a41b4`), **Guided (staged)** and **Reset** (secondary style as above). Buttons disable while busy and show progress labels ("Refining…", "Running stages…").
  - On result: an OK banner ("Result: converged · wR = … · GoF = …", `background:#eff5ea; border:1px solid #d3e2c4; color:#3f6b25`), an optional note banner for diagnostics (`background:#faf3e3; border:1px solid #e8d9ae; color:#6b5310`), and a collapsible "Refinement history (N cycles)" `<details>` with a mono cycle/χ²/wR table.

### Disclaimer bar
`padding:7px 24px; font-size:11.5px; background:#fdf0ea; border-top:1px solid #f2cdbb; color:#a03415` — "Early browser-native refinement workbench — results for publication must be validated against established tools."

### Copyright footer
`padding:10px 24px; font-size:11px; color:#94897a; border-top:1px solid #e8e2d8; background:#fffdf9; text-align:center` — "© 2026 Tsung-Han Yang. All rights reserved."

---

## Interactions & Behavior

- **Refine / Guided / Reset**: "Refine selected" runs a simulated least-squares loop (interval-driven), stepping free parameters toward target values, appending cycle history, then finishing at converged values with esds. "Guided (staged)" unlocks parameter groups in expert order (scale → background → cell → profile → ADP → positions) across cycles. "Reset" restores initial parameter values. Refinement speed is scaled by the `simSpeed` prop. During a run, buttons are disabled and the status bar/labels reflect progress.
- **Parameter freeing**: click a group's "all" checkbox to free/fix the whole group; click a row to toggle a single parameter; locked "calib" params can't be toggled. Free-count and pills update immediately. Editing a value commits on blur or Enter.
- **Fit range**: drag the blue handle lines (grips/caps) to set fit min/max in TOF. Regions outside are visually dimmed (scrims) and excluded from wR. "Reset range" clears it.
- **Zoom**: click-drag horizontally anywhere on the plot to rubber-band select an x-range (a translucent blue selection rect appears); release to zoom the x-axis into that TOF range. The y-axis and difference band **auto-rescale** to the data in view; x-ticks and reflection markers recompute. **Double-click** the plot resets zoom. "Zoom out" doubles the current span (clamped to full range); "Reset zoom" returns to full range. Dragging a fit-range grip does **not** start a zoom (grips are flagged and excluded).
- **X-unit toggle**: TOF / d / Q re-labels the x-axis title and all tick labels; data positions are unchanged (conversion is label-only, using difC and zero from the instrument params).
- **Reflection tooltips**: hovering a Bragg tick shows its hkl, d, Q, and TOF via a native tooltip; the hit area is widened (8px) for easy targeting.
- **Exports**: "Export CSV" downloads the current obs/calc/bkg/diff arrays as CSV.

## State Management
Per-workbench state object:
- `params`: array of `{ id, value, free, esd }` seeded from parameter definitions (id, label, group, init, truth, esd, decimals, free, locked).
- `open`: map of group-name → expanded boolean.
- `fitMin`, `fitMax`: TOF fit-range bounds (null = full).
- `viewMin`, `viewMax`: TOF zoom view bounds (null = full range 15400–92000).
- `zoom`: transient `{ x0, x1 }` pixel bounds during a rubber-band drag (null otherwise).
- `xMode`: `'tof' | 'd' | 'q'` for the x-axis unit toggle.
- `busy`, `busyKind`, `stageIdx`, `planLen`: refinement run status.
- `result`: `{ status, wr, gof, diag }` or null.
- `history`: array of `{ c, chi, wr }` refinement cycles.
- `message`: status-bar string.

Derived each render: the plot paths (obs/calc/bkg/diff) and axis ticks (computed against the current view range with y auto-scaling), reflection marker positions/tooltips, fit-range pixel positions, wR, free-count. Coordinate mapping: `sx(tof) = 58 + (tof − viewMin)/(viewMax − viewMin) × 788`; intensity `sy(y) = 380 − clamp(y,0,yTop)/yTop × 356` where `yTop` is 1.06 × max intensity in view.

Domain math (see logic class for exact formulas): TOF↔d via `TOF = difC·d + difA·d² + difB/d + zero`; d-spacing from hexagonal cell `d = 1/√(q/a² + l²/c²)`; background as a Chebyshev-style polynomial; peaks as back-to-back-exponential profiles.

## Design Tokens
Colors:
- Page bg `#faf7f2`; card/surface `#fff`; raised surface `#fffdf9`; muted surfaces `#f7f3ec`, `#fbf8f2`, `#f6f1e8`, `#f3eee4`.
- Borders `#e8e2d8` (card), `#ddd5c7` (control), `#d8d0c2` (input), `#eee7da`/`#f2ece1` (subtle).
- Ink `#191714`; secondary `#5f594f`; faint `#94897a`; faintest `#b3a993`.
- **Primary** `#1f4fd8`; primary hover `#1a41b4`; primary tint bg `#eaf0fe`, tint border `#b9c6f4`.
- Status OK `#eff5ea` / `#d3e2c4` / `#3f6b25`; note `#faf3e3` / `#e8d9ae` / `#6b5310`; warn `#fdf0ea` / `#f2cdbb` / `#a03415`.
- Data series: obs `#d84a1b`, calc `#1f4fd8`, bkg `#a87a10`, diff `oklch(0.55 0.12 155)`.

Type:
- Families: **IBM Plex Sans** (UI), **IBM Plex Mono** (numbers, meta, axis labels).
- Sizes: 16 (brand/title), 14 (card titles / wR), 12.5 (buttons/body), 12 (captions), 11.5 (chips), 11 (small controls), 10.5 (kicker/tags), 10 (uppercase labels / x-ticks), 9.5 (y-ticks).
- Uppercase labels: weight 600, letter-spacing .08em.

Radius: 12 (cards), 8 (buttons/tags/toggle), 7 (small buttons/inputs), 6 (segmented buttons/version chip), 999 (pills/chips).
Shadows: header `0 3px 10px rgba(25,23,20,0.025)`; brand mark `0 1px 3px rgba(31,79,216,0.35)`; primary pill `0 1px 2px rgba(31,79,216,0.3)`.

## Tweakable props (from the prototype)
- `simSpeed` (0.5–3, default 1): refinement animation speed multiplier.
- `noise` (0–2.5, default 1): synthetic-data noise level (affects observed pattern).
- `showBackground` (boolean, default true): show/hide the background curve.

## Assets
No external image assets. The only graphic is the inline SVG brand mark (concentric rings), reproducible in code. Fonts load from Google Fonts (IBM Plex Sans + IBM Plex Mono). Use the codebase's existing icon/font system if it has one.

## Files
- `Modern Lab Workbench.dc.html` — the full prototype: markup + logic class (all layout, chart geometry, and domain/refinement math). **Primary reference.**
- `support.js` — prototype runtime only; do not port. Reimplement rendering in the target framework.
- `screenshots/01-overview.png` — top of screen: header, workflow stepper, status bar, summary cards, plot header with TOF/d/Q toggle.
- `screenshots/02-chart-and-params.png` — full powder-pattern chart (obs/calc/bkg/diff, y-axis, Bragg reflection ticks, difference band, bottom fit-range handles) beside the parameter table and refine buttons.
- `screenshots/03-zoomed.png` — chart after a drag-to-zoom, showing x-range zoom with auto-rescaled y-axis and recomputed ticks/markers.
