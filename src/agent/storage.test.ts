import { describe, it, expect } from "vitest";
import { API_KEY_KEY, SETTINGS_KEY, migrateLegacyKeys } from "@/agent/storage";

/** A Storage over a Map (node has no Web Storage). */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe("Agent storage migration", () => {
  it("moves settings and keys stored under the old Copilot names", () => {
    const local = memoryStorage({ "materia.copilot.settings": "{\"mode\":\"proxy\"}", "materia.copilot.apiKey": "sk-local" });
    const session = memoryStorage({ "materia.copilot.apiKey": "sk-tab" });
    migrateLegacyKeys(local, session);
    expect(local.getItem(SETTINGS_KEY)).toBe("{\"mode\":\"proxy\"}");
    expect(local.getItem(API_KEY_KEY)).toBe("sk-local");
    expect(session.getItem(API_KEY_KEY)).toBe("sk-tab");
    expect(local.getItem("materia.copilot.settings")).toBeNull();
    expect(local.getItem("materia.copilot.apiKey")).toBeNull();
    expect(session.getItem("materia.copilot.apiKey")).toBeNull();
  });

  it("never overwrites a value already under the new key, and is idempotent", () => {
    const local = memoryStorage({ "materia.copilot.settings": "{\"mode\":\"proxy\"}", [SETTINGS_KEY]: "{\"mode\":\"api-key\"}" });
    const session = memoryStorage();
    migrateLegacyKeys(local, session);
    migrateLegacyKeys(local, session);
    expect(local.getItem(SETTINGS_KEY)).toBe("{\"mode\":\"api-key\"}");
    expect(local.getItem("materia.copilot.settings")).toBeNull();
    expect(local.length).toBe(1);
  });
});
