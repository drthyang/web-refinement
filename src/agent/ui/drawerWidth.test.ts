import { describe, it, expect } from "vitest";
import { DRAWER_MAX, DRAWER_MIN, PAGE_MIN, clampDrawerWidth, readDrawerWidth, writeDrawerWidth } from "@/agent/ui/drawerWidth";
import { WIDTH_KEY } from "@/agent/storage";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe("Agent drawer width", () => {
  it("keeps the page its share, and the drawer between its bounds", () => {
    expect(clampDrawerWidth(500, 1920)).toBe(500);
    expect(clampDrawerWidth(2000, 1920)).toBe(DRAWER_MAX);
    expect(clampDrawerWidth(100, 1920)).toBe(DRAWER_MIN);
    // A 1024px window: the page keeps PAGE_MIN, so the drawer stops at 544.
    expect(clampDrawerWidth(700, 1024)).toBe(1024 - PAGE_MIN);
    // A window too narrow for both never pushes the drawer under its floor.
    expect(clampDrawerWidth(700, 700)).toBe(DRAWER_MIN);
    expect(clampDrawerWidth(412.6, 1920)).toBe(413);
  });

  it("remembers a chosen width, forgets it on reset, and ignores junk", () => {
    const store = memory();
    expect(readDrawerWidth(store)).toBeNull();
    writeDrawerWidth(store, 512.4);
    expect(store.getItem(WIDTH_KEY)).toBe("512");
    expect(readDrawerWidth(store)).toBe(512);
    writeDrawerWidth(store, null);
    expect(readDrawerWidth(store)).toBeNull();
    for (const junk of ["wide", "12", "99999", ""]) {
      store.setItem(WIDTH_KEY, junk);
      expect(readDrawerWidth(store)).toBeNull();
    }
  });

  it("survives storage that throws (private mode, blocked site data)", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDrawerWidth(broken)).toBeNull();
    expect(() => writeDrawerWidth(broken, 400)).not.toThrow();
  });
});
