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

/**
 * Datasets whose local folder name varies between checkouts. Tests, README and
 * docs use the canonical name (the key); a local copy may sit under any listed
 * alias — the GaNb4Se8 synchrotron set is commonly kept under its NSLS-II
 * beamline name, `GaNb4Se8_XRD_28ID`. Resolving the name here is what keeps a
 * differently-named local folder from silently skipping every test that needs
 * it: a skip looks identical to a pass in `npm test`.
 */
const DIR_ALIASES: Record<string, readonly string[]> = {
  GaNb4Se8_XRD: ["GaNb4Se8_XRD", "GaNb4Se8_XRD_28ID"],
};

/**
 * Absolute path of a dataset directory, trying each known alias in order.
 * Falls back to the canonical name when none is present, so callers still get a
 * sensible path to report in an error message.
 */
export function dataDir(name: string): string {
  for (const alias of DIR_ALIASES[name] ?? [name]) {
    const dir = resolve(DATA_DIR, alias);
    if (existsSync(dir)) return dir;
  }
  return resolve(DATA_DIR, name);
}

/** Absolute path of `rel` ("<dataset>/<file>"), with the dataset alias-resolved. */
export function dataPath(rel: string): string {
  const [head, ...rest] = rel.split("/");
  const dir = dataDir(head ?? "");
  return rest.length > 0 ? resolve(dir, ...rest) : dir;
}

export function dataExists(rel: string): boolean {
  return existsSync(dataPath(rel));
}

export function readData(rel: string): string {
  return readFileSync(dataPath(rel), "utf8");
}
