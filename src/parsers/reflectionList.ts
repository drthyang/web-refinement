/**
 * Parser for GSAS-II exported reflection lists (`*_hkl.dat`): a header line, a
 * column-label line, then rows of
 *   h  k  l  m  d-space  TOF  wid  Fo**2  Fc**2  Icorr  …
 *
 * We keep the crystallographically meaningful columns: indices, multiplicity,
 * d-spacing, and the observed/calculated squared structure factors. These serve
 * as validation references and as loadable "reflection intensity" datasets.
 */

export interface ReflectionListRow {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly multiplicity: number;
  readonly d: number;
  readonly foSq: number;
  readonly fcSq: number;
}

export function parseReflectionList(text: string): ReflectionListRow[] {
  const rows: ReflectionListRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    // A data row starts with three integer Miller indices.
    const h = Number(parts[0]);
    const k = Number(parts[1]);
    const l = Number(parts[2]);
    if (!Number.isInteger(h) || !Number.isInteger(k) || !Number.isInteger(l)) continue;
    const multiplicity = Number(parts[3]);
    const d = Number(parts[4]);
    const foSq = Number(parts[7]);
    const fcSq = Number(parts[8]);
    if ([multiplicity, d, foSq, fcSq].some((v) => Number.isNaN(v))) continue;
    rows.push({ h, k, l, multiplicity, d, foSq, fcSq });
  }
  return rows;
}
