/**
 * Helpers for tests that validate against the local GSAS-II datasets in `data/`.
 *
 * The `data/` folder is git-ignored (large, local-only), so these tests must
 * skip gracefully when it is absent — e.g. on a fresh CI checkout — rather than
 * fail. Use `dataExists(rel)` with `describe.skipIf` and read only when present.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DATA_DIR = resolve(process.cwd(), "data");

export function dataExists(rel: string): boolean {
  return existsSync(resolve(DATA_DIR, rel));
}

export function readData(rel: string): string {
  return readFileSync(resolve(DATA_DIR, rel), "utf8");
}
