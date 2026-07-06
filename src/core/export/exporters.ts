/**
 * Export helpers: calculated reflection tables and powder patterns as CSV, and
 * projects as JSON. Pure string producers — file saving is a UI concern.
 */

import type { SingleCrystalCalc } from "@/core/workflow/singleCrystal";
import type { PowderCurves } from "@/core/workflow/powder";
import type { ProjectFile } from "@/core/project/types";
import { serializeProject } from "@/parsers/project";

export function reflectionTableCsv(rows: readonly SingleCrystalCalc[]): string {
  const header = "h,k,l,Iobs,sigma,Icalc,delta";
  const lines = rows.map((r) => {
    const sigma = r.sigma ?? "";
    const delta = r.iObs - r.iCalc;
    return `${r.h},${r.k},${r.l},${r.iObs},${sigma},${r.iCalc.toFixed(4)},${delta.toFixed(4)}`;
  });
  return [header, ...lines].join("\n");
}

export function powderPatternCsv(curves: PowderCurves): string {
  const header = "x,yObs,yCalc,diff";
  const lines = curves.x.map((x, i) => {
    const o = curves.yObs[i] ?? 0;
    const c = curves.yCalc[i] ?? 0;
    const d = curves.diff[i] ?? 0;
    return `${x},${o},${c.toFixed(4)},${d.toFixed(4)}`;
  });
  return [header, ...lines].join("\n");
}

export function projectJson(project: ProjectFile): string {
  return serializeProject(project);
}
