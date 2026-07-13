/**
 * The structure-viewer cell expansion moved to `@/core/crystal/cellExpansion`
 * (pure geometry, no three.js / React) so the mCIF exporter and the 3D viewer
 * share one expansion. This re-export keeps the app-layer import path stable.
 */
export {
  buildCellAtoms,
  displayMoment,
  magneticSupercell,
  momentEntriesFrom,
  expandMagneticSupercell,
  distinctPlacedPositions,
  placingFor,
  type CellAtom,
  type MomentPlacing,
  type MomentEntry,
  type StandardCellRegion,
  type SupercellAtom,
  type MagneticSupercellExpansion,
} from "@/core/crystal/cellExpansion";
