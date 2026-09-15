/**
 * The Workbench engine contract: what the app shell (App.tsx — header, data
 * loading, mode routing) shares with the refinement engines (`PowderWorkbench`,
 * `SingleCrystalWorkbench`, `PdfWorkbench`).
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
 *
 * ## The project boundary
 *
 * Saving a project follows the same shape: the shell owns the envelope (the
 * phases, metadata, the active page) and each engine owns its technique's
 * `workspace` block — it is the only party that knows its private state
 * (parameters, result, fit window, spin model…). The engine publishes a
 * `projectWorkspace` snapshot function next to its exports; the shell calls
 * the active engine's when the user saves. Restoring runs the other way: the
 * shell parses the file and hands the engine its workspace as a `restore`
 * prop on a fresh mount. See core/project/types.ts for the format.
 */

import type { MutableRefObject } from "react";
import type { Workspace } from "@/core/project/types";

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
  /** Observed/calculated curves as CSV (powder, PDF). */
  csv?: () => void;
  /** Markdown refinement report (PDF page). */
  report?: () => void;
  /** Model + data + build script as a FullProf bundle (.zip). */
  fullprofBundle?: () => void;
  /** Model + data + instprm + build_gpx.py as a GSAS-II bundle (.zip). */
  gsas2Bundle?: () => void;
  /**
   * The engine's technique block of the project file — everything needed to
   * reopen this page as it is now. The shell wraps it with the phases and
   * metadata (Save project).
   */
  projectWorkspace?: () => Workspace;
}

/** The shell-owned ref an engine publishes its exports into (null when unmounted/inactive). */
export type EngineExportsRef = MutableRefObject<WorkbenchExports | null>;
