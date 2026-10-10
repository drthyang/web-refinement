/**
 * Where the Agent keeps its per-browser choices: the settings (mode, model,
 * effort, …) in local storage, and the API key in session storage — or local
 * storage when the user ticks Remember. The key never goes anywhere else.
 */

export const SETTINGS_KEY = "materia.agent.settings";
export const API_KEY_KEY = "materia.agent.apiKey";
/** The drawer width the user dragged to (drawerWidth.ts). */
export const WIDTH_KEY = "materia.agent.width";

/** The keys under the feature's first name ("Copilot", renamed 2026-10-09). */
const LEGACY = { settings: "materia.copilot.settings", apiKey: "materia.copilot.apiKey" } as const;

/**
 * Move anything stored under the old keys to the new ones, once: a value
 * already under a new key wins, and the old key is removed either way.
 * Idempotent, so it can run on every read.
 */
export function migrateLegacyKeys(local: Storage, session: Storage): void {
  move(local, LEGACY.settings, SETTINGS_KEY);
  move(local, LEGACY.apiKey, API_KEY_KEY);
  move(session, LEGACY.apiKey, API_KEY_KEY);
}

function move(store: Storage, from: string, to: string): void {
  const old = store.getItem(from);
  if (old === null) return;
  if (store.getItem(to) === null) store.setItem(to, old);
  store.removeItem(from);
}
