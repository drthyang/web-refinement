/**
 * The Workbench engine contract: what the app shell (App.tsx — header, data
 * loading, mode routing) shares with the two refinement engines
 * (`PowderWorkbench`, `SingleCrystalWorkbench`).
 *
 * ## The quality-panel boundary (design decision, ratified 2026-07-10)
 *
 * Each engine owns its **own validation/quality panel and its own
 * agreement-factor calculation**; the shell treats them as opaque and defines
 * NO shared R-factor. The powder and single-crystal communities use genuinely
 * different, non-interchangeable conventions:
 *
 *  - powder (Rietveld): Rwp / Rp / R_exp / GoF = Rwp/R_exp / χ² / R_Bragg,
 *    computed over the *profile* (counts at every point, background included);
 *  - single crystal (SHELX): R1 on |F| (I > 2σ), wR2 on F² (all reflections),
 *    GooF, plus the data-quality set R_int / R_sigma / redundancy.
 *
 * Only the "GoF ≈ 1 is ideal" idea is common — the formulas differ. Anything
 * combined (e.g. a nuclear+magnetic single-crystal agreement) must be computed
 * in that engine's own convention, never borrowed from the other.
 */

import type { MutableRefObject } from "react";

/**
 * Export actions an engine publishes for the shell's header buttons. The
 * mounted, active engine writes its handlers into a ref the shell owns, so the
 * header always acts on the engine actually on screen (each export needs
 * engine-private state: parameters, results, live curves).
 */
export interface WorkbenchExports {
  /** Refined structure as CIF/mCIF, with esds + agreement in the engine's own convention. */
  cif?: () => void;
  /** Single-crystal reflection data as FullProf `.int` (nuclear, plus the paired
   *  magnetic set as `_mag.int` when a joint session is loaded). */
  scInt?: () => void;
  /** Observed/calculated curves as CSV (powder). */
  csv?: () => void;
  /** Whole-session project JSON (powder). */
  projectJson?: () => void;
  /** Model + data + build script as a FullProf bundle (.zip). */
  fullprofBundle?: () => void;
  /** Model + data + instprm + build_gpx.py as a GSAS-II bundle (.zip). */
  gsas2Bundle?: () => void;
}

/** The shell-owned ref an engine publishes its exports into (null when unmounted/inactive). */
export type EngineExportsRef = MutableRefObject<WorkbenchExports | null>;
