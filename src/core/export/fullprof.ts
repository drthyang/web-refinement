/**
 * FullProf `.pcr` export. FullProf's control file is notoriously template-
 * sensitive (fixed section order, flag lines whose counts must match the blocks
 * that follow), so this builds a clean, valid `.pcr` from one or more phases:
 * the control header, each phase (space group + atoms + its profile block), with
 * all counts kept consistent. Layouts are matched line-for-line to real FullProf
 * files in `data/` (LaMn50K nuclear CW, POWGEN PG3_42704 TOF, Eu324 single
 * crystal).
 *
 * Three geometries are emitted:
 *  - Constant wavelength (Job 0 X-ray / 1 neutron, Npr 7 TCH-pV): Lambda header,
 *    Caglioti U,V,W + Lorentzian X,Y, FCJ S_L/D_L asymmetry.
 *  - Time of flight (Job −1, Npr 9): TOF calibration (Zero/Dtt1/Dtt2/Dtt_1overd/
 *    2ThetaBank) + the back-to-back-exponential ⊗ pseudo-Voigt blocks.
 *  - Single crystal (Cry 1, Irf 4): integrated F² read from the companion `.int`.
 *
 * Conventions translated here (the model side is MATERIA's / GSAS-II's):
 *  - **Occ** is FullProf's site occupancy *times* m_site / m_general (a fully
 *    occupied special position on 4c of Pbnm is 0.5), not the CIF site fraction.
 *  - Caglioti U,V,W: MATERIA stores Gaussian FWHM² in centidegrees²; FullProf
 *    wants FWHM² in degrees² → ÷10⁴.
 *  - Lorentzian: MATERIA Γ_L = X/cosθ + Y·tanθ (centidegrees, GSAS-II X = size,
 *    Y = strain); FullProf H_L = X·tanθ + Y/cosθ (degrees) → FullProf X = Y/100,
 *    FullProf Y = X/100 (the two letters swap meaning).
 *  - Anisotropic U_ij → FullProf β_ij = 2π² a*_i a*_j U_ij (N_t = 2).
 *  - The data file is X / Y / σ with an XYDATA header → Ins = 10.
 *  - TOF Sig-Q is always written 0: the FullProf manual documents only
 *    σ² = Sig-2·d⁴ + Sig-1·d² + Sig-0, and the d-dependence of the newer Sig-Q
 *    column is unverified, so MATERIA's σ_q·d term (GSAS-II sig-q) is not
 *    guessed into it — the bundle README flags a nonzero value instead.
 *
 * Pure string producer — file saving and bundling are UI concerns. Refined
 * *values* are written; refinement *codes* are left at 0 (a reproducible model,
 * ready to re-refine in FullProf). Scale factors are NOT transferable (FullProf
 * folds cell volume and its own scattering-length units into the scale), so they
 * are starting values to refine first. FullProf refuses a TOF `.pcr` whose
 * half-widths are all zero with no resolution file ("Zero half-width parameters
 * ... and NO resolution-file provided"), so unknown TOF shape coefficients get
 * the ballpark seeds the workbench refines from instead of zeros.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { spaceGroupSymbol } from "@/core/crystal/spaceGroups";

/** One phase of the `.pcr`: its (refined) structure plus per-phase extras. */
export interface PcrPhase {
  readonly structure: StructureModel;
  /** Phase scale (default 1.0) — a starting value; FullProf's scale differs. */
  readonly scale?: number;
  /** March–Dollase preferred orientation (Nor = 1): axis (hkl) + ratio G1. */
  readonly po?: { readonly axis: readonly [number, number, number]; readonly ratio: number };
}

export interface PcrExportOptions {
  /** CW wavelength in Å (default 1.5406, Cu Kα1). Ignored for TOF. */
  readonly wavelength?: number;
  /** CW probe: selects Job 0 (X-ray, default) or 1 (neutron). */
  readonly radiationKind?: "xray" | "neutron";
  /** COMM title line (default: structure name). */
  readonly title?: string;
  /** Overall scale factor of the first phase (default 1.0). */
  readonly scale?: number;
  /** Every phase in order (the first is the main one). Default: just `structure`. */
  readonly phases?: readonly PcrPhase[];
  /** Zero shift in the pattern's unit (2θ° or TOF µs). Default: the instrument's. */
  readonly zero?: number;
  /** Caglioti Gaussian width, MATERIA/GSAS-II-loaded convention: FWHM² in
   *  centidegrees² (converted to FullProf degrees² here). Default [0, 0, 500]
   *  ≈ 0.22° FWHM. CW only. */
  readonly caglioti?: { readonly u: number; readonly v: number; readonly w: number };
  /** Lorentzian size/strain, MATERIA/GSAS-II convention (centidegrees):
   *  Γ_L = X/cosθ + Y·tanθ. Converted (and swapped) for FullProf. CW only. */
  readonly lorentzian?: { readonly x: number; readonly y: number };
  /** Finger–Cox–Jephcoat axial divergence S/L and H/L → FullProf S_L, D_L. CW only. */
  readonly axial?: { readonly sl: number; readonly hl: number };
  /** Background as (abscissa, intensity) anchor points — in the pattern's own
   *  unit (2θ° for CW, TOF μs for TOF). Default: a flat band across the range. */
  readonly background?: readonly (readonly [number, number])[];
  /** Excluded regions [low, high] in the pattern's unit (e.g. outside the fit range). */
  readonly excluded?: readonly (readonly [number, number])[];
  /** Name of the companion data file, written into the header comment. */
  readonly datFile?: string;
  /** The instrument; its kind selects CW vs TOF and carries difC/difA/difB/Zero. */
  readonly instrument?: InstrumentParameters;
  /** Observed abscissa span [min, max] (2θ° or TOF μs) — sets Thmin/Thmax and
   *  the plot range. Falls back to sensible CW defaults when omitted. */
  readonly dataRange?: readonly [number, number];
  /** TOF detector-bank angle 2θ (default 90°, POWGEN-style). */
  readonly twoThetaBank?: number;
  /** TOF peak-shape coefficients (FullProf Npr 9 / GSAS-II conventions, µs):
   *  σ² = sig2·d⁴ + sig1·d² + sig0 + sigQ·d (µs²), α = alpha0 + alpha1/d,
   *  β = beta0 + beta1/d⁴ + betaQ/d². Takes precedence over the instrument's
   *  own calibration — pass the *refined* profile here. TOF only. */
  readonly tofShape?: {
    readonly sig0?: number;
    readonly sig1?: number;
    readonly sig2?: number;
    readonly sigQ?: number;
    readonly alpha0?: number;
    readonly alpha1?: number;
    readonly beta0?: number;
    readonly beta1?: number;
    readonly betaQ?: number;
  };
  /** Single-crystal job: write the Cry = 1 layout (reflections from the `.int`). */
  readonly singleCrystal?: boolean;
}

/** MATERIA Caglioti FWHM² (centidegrees²) → FullProf FWHM² (degrees²). */
const CENTIDEG2_PER_DEG2 = 1e4;
/** MATERIA Lorentzian FWHM coefficient (centidegrees) → FullProf (degrees). */
const CENTIDEG_PER_DEG = 100;

/** Fixed-decimal number, right-padded to a column width. */
function num(x: number, decimals: number, width: number): string {
  return x.toFixed(decimals).padStart(width);
}

/** Left-justified token padded to a column width. */
function pad(s: string, width: number): string {
  return s.length >= width ? s + " " : s.padEnd(width);
}

/** A FullProf-friendly integer flag row: values joined with aligned spacing. */
function flagRow(values: readonly number[]): string {
  return values.map((v) => String(v).padStart(4)).join("");
}

/** FullProf atom labels/types are blank-delimited tokens: no spaces allowed. */
function token(s: string): string {
  return s.trim().replace(/\s+/g, "_") || "X";
}

/** Multiplicity of the general position (number of distinct operations,
 *  centring included) — the denominator of FullProf's Occ. */
function generalMultiplicity(structure: StructureModel): number {
  const ops = structure.spaceGroup.operations;
  if (ops.length === 0) return 1;
  return siteMultiplicity(ops, [0.1234, 0.2345, 0.3456]);
}

/** FullProf Occ = site fraction × m_site / m_general. */
export function fullprofOccupancy(structure: StructureModel, site: StructureModel["sites"][number]): number {
  const ops = structure.spaceGroup.operations;
  if (ops.length === 0) return site.occupancy;
  return (site.occupancy * siteMultiplicity(ops, site.position)) / generalMultiplicity(structure);
}

/** FullProf anisotropic β_ij = 2π² a*_i a*_j U_ij (order β11 β22 β33 β12 β13 β23). */
export function fullprofBetas(
  structure: StructureModel,
  u: readonly [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  const gs = reciprocalMetricTensor(structure.cell);
  const as = [Math.sqrt(gs[0]![0]!), Math.sqrt(gs[1]![1]!), Math.sqrt(gs[2]![2]!)];
  const f = 2 * Math.PI * Math.PI;
  return [
    f * as[0]! * as[0]! * u[0],
    f * as[1]! * as[1]! * u[1],
    f * as[2]! * as[2]! * u[2],
    f * as[0]! * as[1]! * u[3],
    f * as[0]! * as[2]! * u[4],
    f * as[1]! * as[2]! * u[5],
  ];
}

/** The phase list the writers iterate (explicit phases, else the one structure). */
function phaseList(structure: StructureModel, opts: PcrExportOptions): readonly PcrPhase[] {
  if (opts.phases && opts.phases.length > 0) return opts.phases;
  return [{ structure, ...(opts.scale !== undefined ? { scale: opts.scale } : {}) }];
}

/**
 * The space-group symbol FullProf rebuilds the phase's operations from. A phase
 * with operations but no symbol (a CIF with only a symop loop) is named by the
 * tabulated setting its operations are; one that is none cannot be written. It
 * used to become "P 1", which FullProf expands as a different structure.
 */
function pcrSpaceGroupSymbol(structure: StructureModel): string {
  const symbol = spaceGroupSymbol(structure.spaceGroup);
  if (symbol !== undefined) return symbol;
  throw new Error(
    `FullProf export: phase "${structure.name || structure.id}" has ${structure.spaceGroup.operations.length} symmetry ` +
      `operations, no space-group symbol, and they are none of the tabulated settings, so no symbol reproduces them.`,
  );
}

/** Emit the phase's space-group + atom block (identical for CW, TOF and single
 *  crystal). `npr` is the phase profile number (7 CW, 9 TOF, 0 single crystal),
 *  `irf` the phase Irf flag (4 = F² list for single crystal). */
function pushPhaseAtoms(lines: string[], phase: PcrPhase, index: number, npr: number, irf = 0): void {
  const structure = phase.structure;
  const spaceGroup = pcrSpaceGroupSymbol(structure);
  const [pr1, pr2, pr3] = phase.po?.axis ?? [0, 0, 1];
  const anyAniso = structure.sites.some((s) => s.adp.kind === "anisotropic");
  lines.push(`!-------------------------------------------------------------------------------`);
  lines.push(`!  Data for PHASE number:  ${String(index + 1).padStart(2)}  ==> Current R_Bragg for Pattern#  1:    0.00`);
  lines.push(`!-------------------------------------------------------------------------------`);
  lines.push(structure.name || `Phase${index + 1}`);
  lines.push(`!`);
  lines.push(`!Nat Dis Ang Pr1 Pr2 Pr3 Jbt Irf Isy Str Furth       ATZ    Nvk Npr More`);
  lines.push(
    `${String(structure.sites.length).padStart(4)}   0   0${num(pr1, 1, 4)}${num(pr2, 1, 4)}${num(pr3, 1, 4)}   0${String(irf).padStart(4)}   0   0   0          0.000   0${String(npr).padStart(4)}   0`,
  );
  lines.push(`!`);
  lines.push(`${pad(spaceGroup, 20)} <--Space group symbol`);
  lines.push(`!Atom   Typ       X        Y        Z     Biso       Occ     In Fin N_t Spc /Codes`);
  if (anyAniso) lines.push(`!     beta11   beta22   beta33   beta12   beta13   beta23 /Codes`);
  for (const site of structure.sites) {
    const aniso = site.adp.kind === "anisotropic";
    // Anisotropic sites carry their full tensor as betas (N_t = 2) with Biso 0 —
    // FullProf multiplies both factors, so a nonzero Biso would double-count.
    const bIso = site.adp.kind === "isotropic" ? site.adp.bIso : 0;
    const occ = fullprofOccupancy(structure, site);
    lines.push(
      `${pad(token(site.label), 6)} ${pad(token(site.element), 6)} ${num(site.position[0], 5, 8)} ${num(site.position[1], 5, 8)} ${num(site.position[2], 5, 8)} ${num(bIso, 5, 8)} ${num(occ, 5, 9)}   0   0${aniso ? "   2" : "   0"}    0`,
    );
    lines.push(`                  0.00     0.00     0.00     0.00      0.00`);
    if (site.adp.kind === "anisotropic") {
      const b = fullprofBetas(structure, site.adp.uAniso);
      lines.push(`  ${b.map((v) => num(v, 6, 9)).join("")}`);
      lines.push(`      0.00     0.00     0.00     0.00     0.00     0.00`);
    }
  }
}

/** The cell block of a phase (values + zero codes). */
function pushCell(lines: string[], structure: StructureModel): void {
  const cell = structure.cell;
  lines.push(`!     a          b         c        alpha      beta       gamma      #Cell Info`);
  lines.push(`  ${num(cell.a, 6, 9)} ${num(cell.b, 6, 10)} ${num(cell.c, 6, 10)} ${num(cell.alpha, 6, 10)} ${num(cell.beta, 6, 10)} ${num(cell.gamma, 6, 10)}`);
  lines.push(`    0.00000    0.00000    0.00000    0.00000    0.00000    0.00000`);
}

/** Excluded-region block (only when Nex > 0). */
function pushExcluded(lines: string[], excluded: readonly (readonly [number, number])[]): void {
  if (excluded.length === 0) return;
  lines.push(`! Excluded regions (LowT  HighT) for Pattern#  1`);
  for (const [lo, hi] of excluded) lines.push(`  ${num(lo, 4, 12)} ${num(hi, 4, 12)}`);
}

/** Serialize a structure (or phases) to a FullProf `.pcr` (CW, TOF or single crystal). */
export function structureToPcr(structure: StructureModel, opts: PcrExportOptions = {}): string {
  if (opts.singleCrystal) return singleCrystalPcr(structure, opts);
  if (opts.instrument?.kind === "tof") return tofPcr(structure, opts, opts.instrument);
  return cwPcr(structure, opts);
}

/** Constant-wavelength `.pcr` (Job 0/1, Npr 7 Thompson-Cox-Hastings pseudo-Voigt). */
function cwPcr(structure: StructureModel, opts: PcrExportOptions): string {
  const inst = opts.instrument?.kind === "constantWavelength" ? opts.instrument : undefined;
  const wavelength = opts.wavelength ?? inst?.wavelength ?? 1.5406;
  const neutron = (opts.radiationKind ?? inst?.radiationKind) === "neutron";
  const title = opts.title ?? (structure.name || "structure");
  const phases = phaseList(structure, opts);
  const zero = opts.zero ?? inst?.zero ?? 0;
  const cag = opts.caglioti ?? (inst?.u !== undefined ? { u: inst.u, v: inst.v ?? 0, w: inst.w ?? 0 } : { u: 0, v: 0, w: 500 });
  const lor = opts.lorentzian ?? (inst?.x !== undefined || inst?.y !== undefined ? { x: inst?.x ?? 0, y: inst?.y ?? 0 } : { x: 0, y: 0 });
  const u = cag.u / CENTIDEG2_PER_DEG2;
  const v = cag.v / CENTIDEG2_PER_DEG2;
  const w = cag.w / CENTIDEG2_PER_DEG2;
  const fpX = lor.y / CENTIDEG_PER_DEG; // FullProf X: tanθ (strain) ← MATERIA Y
  const fpY = lor.x / CENTIDEG_PER_DEG; // FullProf Y: 1/cosθ (size) ← MATERIA X
  const sL = opts.axial?.sl ?? 0;
  const dL = opts.axial?.hl ?? 0;
  const [thMin, thMax] = opts.dataRange ?? [2, 130];
  const step = (thMax - thMin) / 2560;
  const background = opts.background ?? [
    [thMin, 50], [thMin + (thMax - thMin) * 0.2, 50], [thMin + (thMax - thMin) * 0.4, 50],
    [thMin + (thMax - thMin) * 0.6, 50], [thMin + (thMax - thMin) * 0.8, 50], [thMax, 50],
  ];
  const excluded = opts.excluded ?? [];
  const lines: string[] = [];

  lines.push(`COMM ${title}`);
  lines.push(`! Current global Chi2 (Bragg contrib.) =      0.000`);
  lines.push(`! Files => DAT-file: ${opts.datFile ?? ""},  PCR-file: ${title}`);
  // Job = 0 X-ray / 1 neutron (CW); Npr = 7 (Thompson-Cox-Hastings pseudo-Voigt);
  // Nor = 1 (March–Dollase, so Pref1 = 1 means no preferred orientation).
  lines.push(`!Job Npr Nph Nba Nex Nsc Nor Dum Iwg Ilo Ias Res Ste Nre Cry Uni Cor Opt Aut`);
  lines.push(flagRow([neutron ? 1 : 0, 7, phases.length, background.length, excluded.length, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
  lines.push(`!`);
  // Ins = 10: X, Y, σ data with an XYDATA header (the bundle's .dat).
  lines.push(`!Ipr Ppl Ioc Mat Pcr Ls1 Ls2 Ls3 NLI Prf Ins Rpa Sym Hkl Fou Sho Ana`);
  lines.push(flagRow([0, 0, 1, 0, 1, 0, 4, 0, 0, 1, 10, 0, 0, 0, 0, 0, 0]));
  lines.push(`!`);
  lines.push(`! Lambda1  Lambda2    Ratio    Bkpos    Wdt    Cthm     muR   AsyLim   Rpolarz  2nd-muR -> Patt# 1`);
  lines.push(` ${num(wavelength, 6, 8)} ${num(wavelength, 6, 8)}  0.00000 ${num(thMin, 3, 8)}  8.0000  0.0000  0.0000  180.00    0.0000  0.0000`);
  lines.push(`!`);
  lines.push(`!NCY  Eps  R_at  R_an  R_pr  R_gl     Thmin       Step       Thmax    PSD    Sent0`);
  lines.push(`  5  0.10  1.00  1.00  1.00  1.00   ${num(thMin, 4, 9)}   ${num(step, 6, 8)}   ${num(thMax, 4, 8)}   0.000   0.000`);
  lines.push(`!`);
  lines.push(`!2Theta/TOF/E(Kev)   Background  for Pattern#  1`);
  for (const [x, bkg] of background) {
    lines.push(`  ${num(x, 4, 12)} ${num(bkg, 4, 14)} ${num(0, 4, 10)}`);
  }
  pushExcluded(lines, excluded);
  lines.push(`!`);
  lines.push(`       0    !Number of refined parameters`);
  lines.push(`!`);
  lines.push(`!  Zero    Code    SyCos    Code   SySin    Code  Lambda     Code MORE ->Patt# 1`);
  lines.push(`  ${num(zero, 5, 7)}    0.0  0.00000    0.0  0.00000    0.0 0.000000    0.00   0`);
  phases.forEach((phase, i) => {
    pushPhaseAtoms(lines, phase, i, 7);
    lines.push(`!-------> Profile Parameters for Pattern #  1  ----> Phase #  ${i + 1}`);
    lines.push(`!  Scale        Shape1      Bov      Str1      Str2      Str3   Strain-Model`);
    lines.push(`  ${num(phase.scale ?? 1, 5, 9)}   0.00000   0.00000   0.00000   0.00000   0.00000       0`);
    lines.push(`     0.00000     0.000     0.000     0.000     0.000     0.000`);
    lines.push(`!       U         V          W           X          Y        GauSiz   LorSiz Size-Model`);
    lines.push(`  ${num(u, 6, 9)} ${num(v, 6, 10)} ${num(w, 6, 10)} ${num(fpX, 6, 10)} ${num(fpY, 6, 10)}   0.000000   0.000000    0`);
    lines.push(`      0.000      0.000      0.000      0.000      0.000      0.000      0.000`);
    pushCell(lines, phase.structure);
    lines.push(`!  Pref1    Pref2      Asy1     Asy2     Asy3     Asy4      S_L      D_L`);
    lines.push(`  ${num(phase.po?.ratio ?? 1, 5, 7)}  0.00000  0.00000  0.00000  0.00000  0.00000 ${num(sL, 5, 8)} ${num(dL, 5, 8)}`);
    lines.push(`     0.00     0.00     0.00     0.00     0.00     0.00     0.00     0.00`);
  });
  lines.push(`!  2Th1/TOF1    2Th2/TOF2  Pattern to plot`);
  lines.push(`  ${num(thMin, 3, 10)}  ${num(thMax, 3, 10)}       1`);

  return lines.join("\n") + "\n";
}

/** Time-of-flight `.pcr` (Job −1, Npr 9: back-to-back exponentials ⊗ pseudo-Voigt). */
function tofPcr(structure: StructureModel, opts: PcrExportOptions, inst: Extract<InstrumentParameters, { kind: "tof" }>): string {
  const title = opts.title ?? (structure.name || "structure");
  const phases = phaseList(structure, opts);
  const [tMin, tMax] = opts.dataRange ?? [1000, 30000];
  const step = (tMax - tMin) / 2560;
  const zero = opts.zero ?? inst.zero ?? 0;
  const dtt1 = inst.difC;
  const dtt2 = inst.difA ?? 0;
  const dtt1overd = inst.difB ?? 0;
  const twoThetaBank = opts.twoThetaBank ?? 90.0;
  // Peak shape: refined profile (tofShape) → instrument calibration → loadable
  // seeds. FullProf refuses a .pcr whose half-widths are all zero when Res=0,
  // and α=β=0 degenerates the back-to-back exponentials, so unknown
  // coefficients get the same ballparks the workbench refines from
  // (σ₁² = (difC·Δd/d)² with Δd/d ≈ 0.0015; moderator-scale α/β).
  const shape = opts.tofShape;
  const sig0 = shape?.sig0 ?? inst.sig0 ?? 0;
  const sig2 = shape?.sig2 ?? inst.sig2 ?? 0;
  let sig1 = shape?.sig1 ?? inst.sig1 ?? 0;
  if (sig0 === 0 && sig1 === 0 && sig2 === 0) sig1 = (inst.difC * 0.0015) ** 2;
  const alpha0 = shape?.alpha0 ?? 0;
  let alpha1 = shape?.alpha1 ?? inst.alpha ?? 0;
  if (alpha0 === 0 && alpha1 === 0) alpha1 = 1.5;
  const beta1 = shape?.beta1 ?? inst.beta1 ?? 0;
  const betaQ = shape?.betaQ ?? inst.betaQ ?? 0;
  let beta0 = shape?.beta0 ?? inst.beta0 ?? 0;
  if (beta0 === 0 && beta1 === 0 && betaQ === 0) beta0 = 0.02;
  const background = opts.background ?? [
    [tMin, 0], [tMin + (tMax - tMin) * 0.2, 0], [tMin + (tMax - tMin) * 0.4, 0],
    [tMin + (tMax - tMin) * 0.6, 0], [tMin + (tMax - tMin) * 0.8, 0], [tMax, 0],
  ];
  const excluded = opts.excluded ?? [];
  const lines: string[] = [];

  lines.push(`COMM ${title}`);
  lines.push(`! Files => DAT-file: ${opts.datFile ?? ""},  PCR-file: ${title}`);
  // Job=-1 (neutron TOF); Npr=9 (TOF back-to-back exponentials ⊗ pseudo-Voigt).
  // Res=0: no external resolution (.irf) file — the profile is written inline.
  // Nor=1 (March–Dollase): Pref1 = 1 means no preferred orientation.
  lines.push(`!Job Npr Nph Nba Nex Nsc Nor Dum Iwg Ilo Ias Res Ste Nre Cry Uni Cor Opt Aut`);
  lines.push(flagRow([-1, 9, phases.length, background.length, excluded.length, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1]));
  lines.push(`!`);
  lines.push(`!Ipr Ppl Ioc Mat Pcr Ls1 Ls2 Ls3 NLI Prf Ins Rpa Sym Hkl Fou Sho Ana`);
  lines.push(flagRow([0, 0, 1, 0, 1, 0, 4, 0, 0, 3, 10, 0, 0, 0, 0, 0, 0]));
  lines.push(`!`);
  lines.push(`!  Bkpos        Wdt    Iabscor for Pattern#  1`);
  lines.push(`  ${num(tMin, 3, 10)}    6.00     0`);
  lines.push(`!NCY  Eps  R_at  R_an  R_pr  R_gl    TOF-min      <Step>       TOF-max `);
  lines.push(` 10  0.10  1.00  1.00  1.00  1.00 ${num(tMin, 4, 12)} ${num(step, 4, 11)} ${num(tMax, 4, 12)}`);
  lines.push(`!`);
  lines.push(`!2Theta/TOF/E(Kev)   Background  for Pattern#  1`);
  for (const [x, bkg] of background) {
    lines.push(`  ${num(x, 4, 14)} ${num(bkg, 4, 14)} ${num(0, 4, 10)}`);
  }
  pushExcluded(lines, excluded);
  lines.push(`!`);
  lines.push(`       0    !Number of refined parameters`);
  lines.push(`!`);
  lines.push(`!    Zero       Code      Dtt1      Code       Dtt2     Code  Dtt_1overd    Code  2ThetaBank  -> Patt#  1`);
  lines.push(
    `  ${num(zero, 5, 9)}    0.00  ${num(dtt1, 5, 10)}    0.00  ${num(dtt2, 5, 8)}    0.00  ${num(dtt1overd, 5, 8)}    0.00  ${num(twoThetaBank, 3, 8)}`,
  );
  phases.forEach((phase, i) => {
    pushPhaseAtoms(lines, phase, i, 9);
    lines.push(`!-------> Profile Parameters for Pattern #   1  ----> Phase #   ${i + 1}`);
    lines.push(`!  Scale         Extinc      Bov     Str1     Str2     Str3    Strain-Model`);
    lines.push(`  ${num(phase.scale ?? 1, 5, 9)}       0.0000   0.0000   0.0000   0.0000   0.0000       0`);
    lines.push(`       0.00000     0.00     0.00     0.00     0.00     0.00`);
    lines.push(`!      Sig-2       Sig-1       Sig-0       Sig-Q     G-Strain     G-Size        Z0  Size-Model`);
    lines.push(`!  Gaussian variance sigma^2 = Sig-2*d^4 + Sig-1*d^2 + Sig-0 (us^2); Sig-Q left 0 (see README).`);
    lines.push(`${num(sig2, 4, 12)}${num(sig1, 4, 12)}${num(sig0, 4, 12)}${num(0, 4, 12)}${num(0, 4, 12)}${num(0, 4, 12)}${num(0, 4, 12)}   0`);
    lines.push(`        0.00        0.00        0.00        0.00        0.00        0.00        0.00`);
    lines.push(`!      Gam-2       Gam-1       Gam-0        LStr        LSiz`);
    lines.push(`!  Lorentzian (Gamma) coefficients: the exported profile is Gaussian-only; refine if needed.`);
    lines.push(`      0.0000      0.0000      0.0000      0.0000      0.0000`);
    lines.push(`        0.00        0.00        0.00        0.00        0.00`);
    pushCell(lines, phase.structure);
    lines.push(`!      Pref1      Pref2        alph0       beta0       alph1       beta1      alphQ     betaQ`);
    lines.push(`!  Back-to-back exponentials: alpha = alph0 + alph1/d, beta = beta0 + beta1/d^4 + betaQ/d^2.`);
    lines.push(`${num(phase.po?.ratio ?? 1, 6, 12)}${num(0, 6, 12)}${num(alpha0, 6, 12)}${num(beta0, 6, 12)}${num(alpha1, 6, 12)}${num(beta1, 6, 12)}${num(0, 6, 12)}${num(betaQ, 6, 12)}`);
    lines.push(`        0.00        0.00        0.00        0.00        0.00        0.00        0.00        0.00`);
    lines.push(`!Absorption correction parameters`);
    lines.push(`   0.00000    0.00   0.00000    0.00            ABS: ABSCOR1  ABSCOR2`);
  });
  lines.push(`!  2Th1/TOF1    2Th2/TOF2  Pattern to plot`);
  lines.push(`  ${num(tMin, 3, 11)} ${num(tMax, 3, 11)}       1`);

  return lines.join("\n") + "\n";
}

/** Single-crystal `.pcr` (Cry = 1, Npr 0; Irf = 4 reads F² from `<name>.int`).
 *  Matched to the Eu324 D23 FullProf file in `data/Eu324_fullprof/Str/`. */
function singleCrystalPcr(structure: StructureModel, opts: PcrExportOptions): string {
  const title = opts.title ?? (structure.name || "structure");
  const neutron = (opts.radiationKind ?? (opts.instrument?.kind === "constantWavelength" ? opts.instrument.radiationKind : undefined)) !== "xray";
  const phases = phaseList(structure, opts);
  const lines: string[] = [];
  lines.push(`COMM ${title}`);
  lines.push(`! Current global Chi2 (Bragg contrib.) =      0.000`);
  lines.push(`! Files => DAT-file: ${opts.datFile ?? ""},  PCR-file: ${title}`);
  // Job = 1 neutron / 0 X-ray; Npr 0 and no background (integrated intensities);
  // Cry = 1: single-crystal (or integrated-intensity) refinement.
  lines.push(`!Job Npr Nph Nba Nex Nsc Nor Dum Iwg Ilo Ias Res Ste Nre Cry Uni Cor Opt Aut`);
  lines.push(flagRow([neutron ? 1 : 0, 0, phases.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]));
  lines.push(`!`);
  lines.push(`!Ipr Ppl Ioc Mat Pcr Ls1 Ls2 Ls3 NLI Prf Ins Rpa Sym Hkl Fou Sho Ana`);
  lines.push(flagRow([0, 0, 1, 0, 1, 0, 4, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]));
  lines.push(`!`);
  lines.push(`!NCY  Eps  R_at  R_an  R_pr  R_gl     Thmin       Step       Thmax    PSD    Sent0`);
  lines.push(` 10  0.10  1.00  1.00  1.00  1.00      0.0000   0.020000   150.0000   0.000   0.000`);
  lines.push(`!`);
  lines.push(`!`);
  lines.push(`       0    !Number of refined parameters`);
  phases.forEach((phase, i) => {
    pushPhaseAtoms(lines, phase, i, 0, 4);
    lines.push(`!-------> Scale, Extinction and  Cell Parameters for Pattern #  1`);
    lines.push(`!  Scale Factors `);
    lines.push(`!   Sc1        Sc2         Sc3         Sc4         Sc5         Sc6`);
    lines.push(`  ${num(phase.scale ?? 1, 5, 9)}   0.000       0.000       0.000       0.000       0.000    `);
    lines.push(`        0.00        0.00        0.00        0.00        0.00        0.00`);
    lines.push(`!  Extinction Parameters `);
    lines.push(`! Ext1       Ext2       Ext3       Ext4       Ext5       Ext6       Ext7   Ext-Model`);
    lines.push(`  0.000      0.000      0.000      0.000      0.000      0.000      0.000       0`);
    lines.push(`       0.00       0.00       0.00       0.00       0.00       0.00       0.00`);
    pushCell(lines, phase.structure);
    lines.push(`! x-Lambda/2 `);
    lines.push(`     0.00000`);
    lines.push(`        0.00`);
  });
  lines.push(`!  2Th1/TOF1    2Th2/TOF2  Pattern to plot`);
  lines.push(`       0.000     150.000       1`);
  return lines.join("\n") + "\n";
}
