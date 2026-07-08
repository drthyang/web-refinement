/**
 * Magnetic structure model (Phase 5+).
 *
 * Layered on top of the nuclear StructureModel by referencing atom-site labels,
 * so that atomic/nuclear refinement never imports magnetic types. Magnetic
 * moments are the refinable quantities; the perpendicular-moment projection and
 * magnetic structure factor are computed in sibling modules.
 */

import type { Vec3 } from "@/core/math/types";
import type { SymmetryOperation } from "@/core/crystal/types";

/**
 * Frame in which a moment vector's components are expressed.
 *  - "crystallographic": components along the crystal axes (a, b, c), i.e. in
 *    Bohr magnetons projected onto the direct lattice basis.
 *  - "cartesian": components in an orthonormal frame tied to the cell (a along
 *    x, etc., per the standard convention documented in DATA_MODEL.md).
 */
export type MomentFrame = "crystallographic" | "cartesian";

/** A magnetic moment assigned to a specific atom site. */
export interface MagneticMoment {
  /** Label of the AtomSite this moment belongs to. */
  readonly siteLabel: string;
  /** Reference frame for `components`. */
  readonly frame: MomentFrame;
  /**
   * Moment vector components, in Bohr magnetons (μ_B). Magnitude and direction
   * are derived from this; storing the vector avoids redundant, drift-prone
   * (magnitude, angles) representations.
   */
  readonly components: Vec3;
  /**
   * Optional magnetic form-factor identifier (e.g. "Fe3" for the ⟨j0⟩ analytic
   * approximation). When absent it is resolved from element + oxidation state.
   */
  readonly formFactorId?: string;
}

/**
 * A magnetic propagation vector k (in reciprocal-lattice units). k = (0,0,0)
 * denotes a commensurate structure with the nuclear cell. Multiple k-vectors
 * are reserved for future multi-k structures.
 */
export type PropagationVector = Vec3;

/** Complete magnetic model layered over a StructureModel. */
export interface MagneticModel {
  readonly id: string;
  /** Id of the StructureModel this magnetic model decorates. */
  readonly structureId: string;
  /** Propagation vector(s). Phase 5 assumes a single k. */
  readonly propagation: readonly PropagationVector[];
  readonly moments: readonly MagneticMoment[];
  /**
   * Magnetic (Shubnikov) operations of the chosen subgroup, each carrying its
   * time-reversal sign (`timeReversal`). When present, the magnetic structure
   * factor expands each site's moment over **these** operations — deduplicating
   * the crystallographic orbit — instead of the nuclear space-group operations
   * with θ = 1. This is essential for k ≠ 0: expanding over the nuclear group
   * (θ = 1) is a ferromagnetic arrangement and gives *zero* satellite intensity,
   * and it over-counts special positions. Absent ⇒ legacy nuclear-op expansion.
   */
  readonly operations?: readonly SymmetryOperation[];
  /**
   * Magnetic domains as a future extension: relative populations of symmetry-
   * related domains. Empty/absent means a single domain.
   */
  readonly domainPopulations?: readonly number[];
}
