/**
 * User-facing powder model options that travel with a session: which shared-site
 * ties are on, and which microstrain model is in use. Kept in the core so the
 * project file (core/project) and the UI's spec builder (app/powderSpec) share
 * one definition without the core importing the app layer.
 */

/** Whether atoms sharing a crystallographic site are tied (see structureRefinement). */
export interface SiteTies {
  readonly positions?: boolean;
  readonly adp?: boolean;
  /** Constrain Σ(occupancy) on a shared site to exactly 1 (vs. the starting sum). */
  readonly occupancyToUnity?: boolean;
}

/**
 * Sample microstrain (Mustrain) model, GSAS-II-style:
 *  - `isotropic`   — the Lorentzian Y term (Γ ∝ tanθ); always present, no extra rows.
 *  - `uniaxial`    — equatorial/axial Y about the unique axis (Y⊥, Y∥).
 *  - `generalized` — Stephens (1999) anisotropic S-parameters.
 */
export type MustrainModel = "isotropic" | "uniaxial" | "generalized";

export const MUSTRAIN_MODELS: readonly MustrainModel[] = ["isotropic", "uniaxial", "generalized"];
