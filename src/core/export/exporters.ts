/**
 * Export helpers: powder patterns as CSV. Pure string producers — file saving
 * is a UI concern. (Project files are written by `core/project/io`.)
 */

import type { PowderCurves } from "@/core/workflow/powder";


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
