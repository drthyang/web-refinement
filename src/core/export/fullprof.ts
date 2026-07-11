/**
 * FullProf `.pcr` export. FullProf's control file is notoriously template-
 * sensitive (fixed section order, flag lines whose counts must match the blocks
 * that follow), so this builds a clean, valid nuclear constant-wavelength `.pcr`
 * from a structure: the control header, the phase (space group + atoms), and the
 * profile/cell block, with all counts kept consistent.
 *
 * Pure string producer — file saving and bundling are UI concerns. Refined
 * *values* are written; refinement *codes* are left at 0 (a reproducible model,
 * ready to re-refine in FullProf). Powder CW today; TOF and single-crystal are
 * follow-on modes.
 */

import type { StructureModel } from "@/core/crystal/types";
import { bIsoFromUAniso } from "@/core/crystal/adp";

export interface PcrExportOptions {
  /** CW wavelength in Å (default 1.5406, Cu Kα1). */
  readonly wavelength?: number;
  /** COMM title line (default: structure name). */
  readonly title?: string;
  /** Overall scale factor (default 1.0). */
  readonly scale?: number;
  /** Caglioti peak-width U, V, W (default [0, 0, 0.05]). */
  readonly uvw?: readonly [number, number, number];
  /** Background as (2θ, intensity) anchor points (default a flat 6-point band). */
  readonly background?: readonly (readonly [number, number])[];
  /** Name of the companion data file, written into the header comment. */
  readonly datFile?: string;
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

/**
 * Serialize a structure to a nuclear constant-wavelength FullProf `.pcr`.
 */
export function structureToPcr(structure: StructureModel, opts: PcrExportOptions = {}): string {
  const wavelength = opts.wavelength ?? 1.5406;
  const title = opts.title ?? (structure.name || "structure");
  const scale = opts.scale ?? 1.0;
  const [u, v, w] = opts.uvw ?? [0, 0, 0.05];
  const background = opts.background ?? [
    [2, 50], [20, 50], [40, 50], [80, 50], [110, 50], [130, 50],
  ];
  const cell = structure.cell;
  const spaceGroup = structure.spaceGroup.hermannMauguin ?? "P 1";
  const lines: string[] = [];

  lines.push(`COMM ${title}`);
  lines.push(`! Current global Chi2 (Bragg contrib.) =      0.000`);
  lines.push(`! Files => DAT-file: ${opts.datFile ?? ""},  PCR-file: ${title}`);
  // Job=0 (X-ray CW is 0, neutron CW also 0); Npr=7 (Thompson-Cox-Hastings pV).
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
  lines.push(`  5  0.10  1.00  1.00  1.00  1.00      2.0000   0.050000   130.0000   0.000   0.000`);
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
  lines.push(`!-------------------------------------------------------------------------------`);
  lines.push(`!  Data for PHASE number:   1  ==> Current R_Bragg for Pattern#  1:    0.00`);
  lines.push(`!-------------------------------------------------------------------------------`);
  lines.push(title);
  lines.push(`!`);
  lines.push(`!Nat Dis Ang Pr1 Pr2 Pr3 Jbt Irf Isy Str Furth       ATZ    Nvk Npr More`);
  lines.push(`${String(structure.sites.length).padStart(4)}   0   0 0.0 0.0 1.0   0   0   0   0   0          0.000   0   7   0`);
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
  lines.push(`       2.000     130.000       1`);

  return lines.join("\n") + "\n";
}
