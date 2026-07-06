/**
 * Parser for GSAS-II "export pattern as CSV" files (the `fitted_results.csv`
 * this workbench consumes). Layout:
 *
 *   "limits",<lo>,<hi>
 *   "masked X","X","obs","calc","bkg","diff"
 *   --,<X>,<obs>,<calc>,<bkg>,<diff>
 *   ...
 *
 * `X` is the histogram abscissa — for POWGEN data this is time-of-flight in µs.
 * We keep the observed pattern (for the app to hold) plus GSAS-II's own calc and
 * background curves, so the real Rietveld fit can be shown as a reference overlay.
 * The minimal engine cannot profile-fit TOF, so this is a faithful *view* of the
 * published fit, not a refit.
 */

import type { PowderPattern } from "@/core/diffraction/types";

export interface GsasCsvPattern {
  /** Observed pattern held by the app (xUnit "tof"). */
  readonly pattern: PowderPattern;
  /** GSAS-II's calculated profile, aligned with `pattern.points`. */
  readonly calc: number[];
  /** GSAS-II's background, aligned with `pattern.points`. */
  readonly background: number[];
}

function splitCsv(line: string): string[] {
  return line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

export function parseGsasCsvPattern(text: string, id: string, name: string): GsasCsvPattern {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  // Locate the column header row (contains "obs" and "calc").
  let headerIdx = lines.findIndex((l) => /(^|,)\s*"?obs"?\s*,/i.test(l) && /calc/i.test(l));
  if (headerIdx < 0) throw new Error("not a GSAS-II CSV pattern (no obs/calc header)");
  const headers = splitCsv(lines[headerIdx]!).map((h) => h.toLowerCase());
  const iX = headers.findIndex((h) => h === "x");
  const iObs = headers.indexOf("obs");
  const iCalc = headers.indexOf("calc");
  const iBkg = headers.indexOf("bkg");
  if (iX < 0 || iObs < 0) throw new Error("GSAS-II CSV missing X/obs columns");

  const points: { x: number; yObs: number; sigma: number }[] = [];
  const calc: number[] = [];
  const background: number[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = splitCsv(lines[i]!);
    const x = Number(parts[iX]);
    const yObs = Number(parts[iObs]);
    if (Number.isNaN(x) || Number.isNaN(yObs)) continue;
    points.push({ x, yObs, sigma: Math.sqrt(Math.max(yObs, 1)) });
    calc.push(iCalc >= 0 ? Number(parts[iCalc]) || 0 : 0);
    background.push(iBkg >= 0 ? Number(parts[iBkg]) || 0 : 0);
  }
  if (points.length < 3) throw new Error("GSAS-II CSV had no usable data rows");

  const pattern: PowderPattern = {
    id,
    name,
    xUnit: "tof",
    radiation: { kind: "neutron-tof" },
    points,
  };
  return { pattern, calc, background };
}
