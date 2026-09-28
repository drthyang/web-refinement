/**
 * Autosave: the last session's project file, kept in the browser between
 * saves so a reload or a crash does not lose the step history.
 *
 * One slot in IndexedDB (a project with its data is ~1 MB, past what
 * localStorage reliably holds). Every call fails soft: storage can be blocked
 * or absent (private windows, strict settings), and the app then simply has no
 * autosave — nothing else depends on it.
 */

const DB_NAME = "materia";
const STORE = "autosave";
const KEY = "session";

export interface AutosaveEntry {
  /** The serialized project file (core/project/io `serializeProject`). */
  readonly text: string;
  readonly title: string;
  readonly steps: number;
  /** ISO-8601. */
  readonly savedAt: string;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).finally(() => db.close()) as Promise<T | null>;
}

export async function writeAutosave(entry: AutosaveEntry): Promise<void> {
  await run("readwrite", (s) => s.put(entry, KEY));
}

export async function readAutosave(): Promise<AutosaveEntry | null> {
  const v = await run<unknown>("readonly", (s) => s.get(KEY));
  if (!v || typeof v !== "object") return null;
  const e = v as Partial<AutosaveEntry>;
  return typeof e.text === "string" && typeof e.title === "string" && typeof e.savedAt === "string"
    ? { text: e.text, title: e.title, steps: typeof e.steps === "number" ? e.steps : 0, savedAt: e.savedAt }
    : null;
}

export async function clearAutosave(): Promise<void> {
  await run("readwrite", (s) => s.delete(KEY));
}
