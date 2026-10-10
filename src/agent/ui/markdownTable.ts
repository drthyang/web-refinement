/** Pipe tables in the Agent's Markdown (GitHub style). */

/** A pipe table's cells, header row first, or null when the block is not one
 *  (every line `| … |`, the second the `|---|` separator). */
export function tableRows(lines: readonly string[]): string[][] | null {
  const row = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const separator = (l: string): boolean => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);
  if (lines.length < 2 || !lines.every(row) || !separator(lines[1]!)) return null;
  const cells = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  return [cells(lines[0]!), ...lines.slice(2).map(cells)];
}
