/**
 * FullProf `.pcr` export. FullProf's control file is notoriously template-
 * sensitive (fixed section order, flag lines whose counts must match the blocks
 * that follow), so this builds a clean, valid nuclear `.pcr` from a structure:
 * the control header, the phase (space group + atoms), and the profile/cell
 * block, with all counts kept consistent.
 *
 * Two diffraction geometries are emitted, chosen by the instrument kind:
 *  - Constant wavelength (Job 0, Npr 7 TCH-pV): Lambda header + Caglioti U,V,W.
 *  - Time of flight    (Job −1, Npr 9): TOF calibration (Zero/Dtt1/Dtt2/
 *    Dtt_1overd/2ThetaBank from difC/difA/difB/Zero) + the back-to-back-
 *    exponential ⊗ pseudo-Voigt profile blocks (Sig, Gam, alph/beta).
 *
 * Pure string producer — file saving and bundling are UI concerns. Refined
 * *values* are written; refinement *codes* are left at 0 (a reproducible model,
 * ready to re-refine in FullProf). The TOF peak-shape coefficients (Sig/Gam/
 * alph/beta) are the one thing the workbench's instrument model does not carry,
 * so they are emitted as 0 placeholders — set them from your .irf, or ship the
 * original instrument file verbatim (the export bundle does exactly that).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { bIsoFromUAniso } from "@/core/crystal/adp";

export interface PcrExportOptions {
  /** CW wavelength in Å (default 1.5406, Cu Kα1). Ignored for TOF. */
  readonly wavelength?: number;
  /** COMM title line (default: structure name). */
  readonly title?: string;
  /** Overall scale factor (default 1.0). */
  readonly scale?: number;
  /** Caglioti peak-width U, V, W (default [0, 0, 0.05]). CW only. */
  readonly uvw?: readonly [number, number, number];
  /** Background as (abscissa, intensity) anchor points — in the pattern's own
   *  unit (2θ° for CW, TOF μs for TOF). Default: a flat band across the range. */
  readonly background?: readonly (readonly [number, number])[];
  /** Name of the companion data file, written into the header comment. */
  readonly datFile?: string;
  /** The instrument; its kind selects CW vs TOF and carries difC/difA/difB/Zero. */
  readonly instrument?: InstrumentParameters;
  /** Observed abscissa span [min, max] (2θ° or TOF μs) — sets Thmin/Thmax and
   *  the plot range. Falls back to sensible CW defaults when omitted. */
  readonly dataRange?: readonly [number, number];
}

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

/** Emit the phase's space-group + atom block (identical for CW and TOF). Npr is
 *  the phase profile number (7 for CW TCH-pV, 9 for TOF). */
function pushPhaseAtoms(lines: string[], structure: StructureModel, title: string, npr: number): void {
  const spaceGroup = structure.spaceGroup.hermannMauguin ?? "P 1";
  lines.push(`!-------------------------------------------------------------------------------`);
  lines.push(`!  Data for PHASE number:   1  ==> Current R_Bragg for Pattern#  1:    0.00`);
  lines.push(`!-------------------------------------------------------------------------------`);
  lines.push(title);
  lines.push(`!`);
  lines.push(`!Nat Dis Ang Pr1 Pr2 Pr3 Jbt Irf Isy Str Furth       ATZ    Nvk Npr More`);
  lines.push(`${String(structure.sites.length).padStart(4)}   0   0 0.0 0.0 1.0   0   0   0   0   0          0.000   0${String(npr).padStart(4)}   0`);
  lines.push(`!`);
  lines.push(`${pad(spaceGroup, 20)} <--Space group symbol`);
  lines.push(`!Atom   Typ       X        Y        Z     Biso       Occ     In Fin N_t Spc /Codes`);
  for (const site of structure.sites) {
    const bIso = site.adp.kind === "isotropic" ? site.adp.bIso : bIsoFromUAniso(site.adp.uAniso);
    lines.push(
      `${pad(site.label, 6)} ${pad(site.element, 6)} ${num(site.position[0], 5, 8)} ${num(site.position[1], 5, 8)} ${num(site.position[2], 5, 8)} ${num(bIso, 5, 8)} ${num(site.occupancy, 5, 9)}   0   0   0    0`,
    );
    lines.push(`                  0.00     0.00     0.00     0.00      0.00`);
  }
}

/** Serialize a structure to a nuclear FullProf `.pcr` (CW or TOF by instrument). */
export function structureToPcr(structure: StructureModel, opts: PcrExportOptions = {}): string {
  if (opts.instrument?.kind === "tof") return tofPcr(structure, opts, opts.instrument);
  return cwPcr(structure, opts);
}

/** Constant-wavelength `.pcr` (Job 0, Npr 7 Thompson-Cox-Hastings pseudo-Voigt). */
function cwPcr(structure: StructureModel, opts: PcrExportOptions): string {
  const wavelength = opts.wavelength ?? 1.5406;
  const title = opts.title ?? (structure.name || "structure");
  const scale = opts.scale ?? 1.0;
  const [u, v, w] = opts.uvw ?? [0, 0, 0.05];
  const [thMin, thMax] = opts.dataRange ?? [2, 130];
  const step = (thMax - thMin) / 2560;
  const background = opts.background ?? [
    [thMin, 50], [thMin + (thMax - thMin) * 0.2, 50], [thMin + (thMax - thMin) * 0.4, 50],
    [thMin + (thMax - thMin) * 0.6, 50], [thMin + (thMax - thMin) * 0.8, 50], [thMax, 50],
  ];
  const cell = structure.cell;
  const lines: string[] = [];

  lines.push(`COMM ${title}`);
  lines.push(`! Current global Chi2 (Bragg contrib.) =      0.000`);
  lines.push(`! Files => DAT-file: ${opts.datFile ?? ""},  PCR-file: ${title}`);
  // Job=0 (X-ray/neutron CW); Npr=7 (Thompson-Cox-Hastings pseudo-Voigt).
  lines.push(`!Job Npr Nph Nba Nex Nsc Nor Dum Iwg Ilo Ias Res Ste Nre Cry Uni Cor Opt Aut`);
  lines.push(flagRow([0, 7, 1, background.length, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
  lines.push(`!`);
  lines.push(`!Ipr Ppl Ioc Mat Pcr Ls1 Ls2 Ls3 NLI Prf Ins Rpa Sym Hkl Fou Sho Ana`);
  lines.push(flagRow([0, 0, 1, 0, 1, 0, 4, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
  lines.push(`!`);
  lines.push(`! Lambda1  Lambda2    Ratio    Bkpos    Wdt    Cthm     muR   AsyLim   Rpolarz  2nd-muR -> Patt# 1`);
  lines.push(` ${num(wavelength, 6, 8)} ${num(wavelength, 6, 8)}  0.00000   30.000  8.0000  0.0000  0.0000  180.00    0.0000  0.0000`);
  lines.push(`!`);
  lines.push(`!NCY  Eps  R_at  R_an  R_pr  R_gl     Thmin       Step       Thmax    PSD    Sent0`);
  lines.push(`  5  0.10  1.00  1.00  1.00  1.00   ${num(thMin, 4, 9)}   ${num(step, 6, 8)}   ${num(thMax, 4, 8)}   0.000   0.000`);
  lines.push(`!`);
  lines.push(`!2Theta/TOF/E(Kev)   Background  for Pattern#  1`);
  for (const [x, bkg] of background) {
    lines.push(`  ${num(x, 4, 12)} ${num(bkg, 4, 14)} ${num(0, 4, 10)}`);
  }
  lines.push(`!`);
  lines.push(`       0    !Number of refined parameters`);
  lines.push(`!`);
  lines.push(`!  Zero    Code    SyCos    Code   SySin    Code  Lambda     Code MORE ->Patt# 1`);
  lines.push(`  0.00000    0.0  0.00000    0.0  0.00000    0.0 0.000000    0.00   0`);
  pushPhaseAtoms(lines, structure, title, 7);
  lines.push(`!-------> Profile Parameters for Pattern #  1`);
  lines.push(`!  Scale        Shape1      Bov      Str1      Str2      Str3   Strain-Model`);
  lines.push(`  ${num(scale, 5, 9)}   0.00000   0.00000   0.00000   0.00000   0.00000       0`);
  lines.push(`     0.00000     0.000     0.000     0.000     0.000     0.000`);
  lines.push(`!       U         V          W           X          Y        GauSiz   LorSiz Size-Model`);
  lines.push(`  ${num(u, 6, 8)} ${num(v, 6, 10)} ${num(w, 6, 10)}   0.000000   0.000000   0.000000   0.000000    0`);
  lines.push(`      0.000      0.000      0.000      0.000      0.000      0.000      0.000`);
  lines.push(`!     a          b         c        alpha      beta       gamma      #Cell Info`);
  lines.push(`  ${num(cell.a, 6, 9)} ${num(cell.b, 6, 10)} ${num(cell.c, 6, 10)} ${num(cell.alpha, 6, 10)} ${num(cell.beta, 6, 10)} ${num(cell.gamma, 6, 10)}`);
  lines.push(`    0.00000    0.00000    0.00000    0.00000    0.00000    0.00000`);
  lines.push(`!  Pref1    Pref2      Asy1     Asy2     Asy3     Asy4      S_L      D_L`);
  lines.push(`  0.00000  0.00000  0.00000  0.00000  0.00000  0.00000  0.00000  0.00000`);
  lines.push(`     0.00     0.00     0.00     0.00     0.00     0.00     0.00     0.00`);
  lines.push(`!  2Th1/TOF1    2Th2/TOF2  Pattern to plot`);
  lines.push(`  ${num(thMin, 3, 10)}  ${num(thMax, 3, 10)}       1`);

  return lines.join("\n") + "\n";
}

/** Time-of-flight `.pcr` (Job −1, Npr 9: back-to-back exponentials ⊗ pseudo-Voigt). */
function tofPcr(structure: StructureModel, opts: PcrExportOptions, inst: Extract<InstrumentParameters, { kind: "tof" }>): string {
  const title = opts.title ?? (structure.name || "structure");
  const scale = opts.scale ?? 1.0;
  const [tMin, tMax] = opts.dataRange ?? [1000, 30000];
  const step = (tMax - tMin) / 2560;
  const zero = inst.zero ?? 0;
  const dtt1 = inst.difC;
  const dtt2 = inst.difA ?? 0;
  const dtt1overd = inst.difB ?? 0;
  const twoThetaBank = 90.0; // POWGEN-style backscattering default; not carried by the model.
  const background = opts.background ?? [
    [tMin, 0], [tMin + (tMax - tMin) * 0.2, 0], [tMin + (tMax - tMin) * 0.4, 0],
    [tMin + (tMax - tMin) * 0.6, 0], [tMin + (tMax - tMin) * 0.8, 0], [tMax, 0],
  ];
  const cell = structure.cell;
  const lines: string[] = [];

  lines.push(`COMM ${title}`);
  lines.push(`! Files => DAT-file: ${opts.datFile ?? ""},  PCR-file: ${title}`);
  // Job=-1 (neutron TOF); Npr=9 (TOF back-to-back exponentials ⊗ pseudo-Voigt).
  // Res=0: no external resolution (.irf) file — the profile is written inline.
  lines.push(`!Job Npr Nph Nba Nex Nsc Nor Dum Iwg Ilo Ias Res Ste Nre Cry Uni Cor Opt Aut`);
  lines.push(flagRow([-1, 9, 1, background.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1]));
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
  lines.push(`!`);
  lines.push(`       0    !Number of refined parameters`);
  lines.push(`!`);
  lines.push(`!    Zero       Code      Dtt1      Code       Dtt2     Code  Dtt_1overd    Code  2ThetaBank  -> Patt#  1`);
  lines.push(
    `  ${num(zero, 5, 9)}    0.00  ${num(dtt1, 5, 10)}    0.00  ${num(dtt2, 5, 8)}    0.00  ${num(dtt1overd, 5, 8)}    0.00  ${num(twoThetaBank, 3, 8)}`,
  );
  pushPhaseAtoms(lines, structure, title, 9);
  lines.push(`!-------> Profile Parameters for Pattern #   1  ----> Phase #   1`);
  lines.push(`!  Scale         Extinc      Bov     Str1     Str2     Str3    Strain-Model`);
  lines.push(`  ${num(scale, 5, 9)}       0.0000   0.0000   0.0000   0.0000   0.0000       0`);
  lines.push(`       0.00000     0.00     0.00     0.00     0.00     0.00`);
  lines.push(`!      Sig-2       Sig-1       Sig-0       Sig-Q     G-Strain     G-Size        Z0  Size-Model`);
  lines.push(`!  Peak-shape (Sigma) coefficients — set from your .irf or refine; 0 = placeholder.`);
  lines.push(`      0.0000      0.0000      0.0000      0.0000      0.0000      0.0000      0.0000   0`);
  lines.push(`        0.00        0.00        0.00        0.00        0.00        0.00        0.00`);
  lines.push(`!      Gam-2       Gam-1       Gam-0        LStr        LSiz`);
  lines.push(`!  Peak-shape (Gamma) coefficients — set from your .irf or refine; 0 = placeholder.`);
  lines.push(`      0.0000      0.0000      0.0000      0.0000      0.0000`);
  lines.push(`        0.00        0.00        0.00        0.00        0.00`);
  lines.push(`!     a          b         c        alpha      beta       gamma      #Cell Info`);
  lines.push(`  ${num(cell.a, 6, 9)} ${num(cell.b, 6, 10)} ${num(cell.c, 6, 10)} ${num(cell.alpha, 6, 10)} ${num(cell.beta, 6, 10)} ${num(cell.gamma, 6, 10)}`);
  lines.push(`    0.00000    0.00000    0.00000    0.00000    0.00000    0.00000`);
  lines.push(`!      Pref1      Pref2        alph0       beta0       alph1       beta1      alphQ     betaQ`);
  lines.push(`!  Back-to-back exponential (alpha/beta) coefficients — set from your .irf or refine.`);
  lines.push(`    0.000000    0.000000    0.000000    0.000000    0.000000    0.000000    0.000000    0.000000`);
  lines.push(`        0.00        0.00        0.00        0.00        0.00        0.00        0.00        0.00`);
  lines.push(`!Absorption correction parameters`);
  lines.push(`   0.00000    0.00   0.00000    0.00            ABS: ABSCOR1  ABSCOR2`);
  lines.push(`!  2Th1/TOF1    2Th2/TOF2  Pattern to plot`);
  lines.push(`  ${num(tMin, 3, 11)} ${num(tMax, 3, 11)}       1`);

  return lines.join("\n") + "\n";
}
