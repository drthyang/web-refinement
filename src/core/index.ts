/**
 * Public barrel for the scientific core type layer (Phase 0).
 *
 * Only types are exported here so far. Calculation and refinement
 * implementations are added in later phases behind these same names.
 */

export type { Vec3, Mat3, Complex } from "@/core/math/types";

export type {
  UnitCell,
  AtomSite,
  DisplacementParameters,
  SymmetryOperation,
  SpaceGroup,
  StructureModel,
} from "@/core/crystal/types";

export type {
  Radiation,
  PowderXUnit,
  SingleCrystalReflection,
  PowderPoint,
  SingleCrystalDataset,
  PowderPattern,
  DiffractionDataset,
  CalculatedReflection,
} from "@/core/diffraction/types";

export type {
  MomentFrame,
  MagneticMoment,
  PropagationVector,
  MagneticModel,
} from "@/core/magnetic/types";

export type {
  ParameterKind,
  RefinementParameter,
  ParameterBinding,
  RefinementStatus,
  AgreementFactors,
  RefinementIteration,
  RefinementResult,
  RefinementOptions,
} from "@/core/refinement/types";

export type {
  ProjectMetadata,
  ProjectFile,
} from "@/core/project/types";
