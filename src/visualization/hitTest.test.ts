import { describe, it, expect } from "vitest";
import { clientToSvgUser, nearestPointIndex } from "@/visualization/hitTest";

describe("nearestPointIndex", () => {
  // A crowded cluster: many points within one halo radius of each other,
  // drawn in an order that would make per-element hit testing pick the
  // LAST one whose halo covers the click.
  const cluster = [
    { x: 50, y: 50 }, // the dot the user aims at
    { x: 55, y: 50 },
    { x: 50, y: 56 },
    { x: 53, y: 54 }, // drawn last — its 7-unit halo covers (50, 50) too
  ];

  it("picks the point the click is closest to, not the last one drawn over it", () => {
    expect(nearestPointIndex(cluster, 50.4, 49.7, 7)).toBe(0);
    expect(nearestPointIndex(cluster, 54.8, 50.2, 7)).toBe(1);
    expect(nearestPointIndex(cluster, 52.9, 54.2, 7)).toBe(3);
  });

  it("returns −1 when nothing lies within the radius", () => {
    expect(nearestPointIndex(cluster, 80, 80, 7)).toBe(-1);
    expect(nearestPointIndex([], 0, 0, 7)).toBe(-1);
  });

  it("treats the radius as exclusive and breaks ties toward the earlier point", () => {
    expect(nearestPointIndex([{ x: 7, y: 0 }], 0, 0, 7)).toBe(-1);
    expect(nearestPointIndex([{ x: 6.99, y: 0 }], 0, 0, 7)).toBe(0);
    expect(nearestPointIndex([{ x: 3, y: 0 }, { x: -3, y: 0 }], 0, 0, 7)).toBe(0);
  });

  it("skips non-finite points", () => {
    expect(nearestPointIndex([{ x: NaN, y: 0 }, { x: 1, y: 0 }], 0, 0, 7)).toBe(1);
  });

  it("is exact on a dense grid of 900 points (the reported regime)", () => {
    const pts = Array.from({ length: 900 }, (_, i) => ({ x: 42 + (i % 30) * 7.2, y: 42 + Math.floor(i / 30) * 7.2 }));
    for (const i of [0, 31, 450, 899]) {
      const p = pts[i]!;
      expect(nearestPointIndex(pts, p.x + 1.1, p.y - 0.9, 7)).toBe(i);
    }
  });
});

describe("clientToSvgUser", () => {
  const box = { left: 100, top: 20, width: 150, height: 150 }; // a 300-unit viewBox rendered at half size

  it("scales by the rendered box when no screen transform is available", () => {
    const svg = { getBoundingClientRect: () => box };
    expect(clientToSvgUser(svg, 100, 20, { width: 300, height: 300 })).toEqual({ x: 0, y: 0 });
    expect(clientToSvgUser(svg, 175, 95, { width: 300, height: 300 })).toEqual({ x: 150, y: 150 });
    expect(clientToSvgUser(svg, 250, 170, { width: 300, height: 300 })).toEqual({ x: 300, y: 300 });
  });

  it("prefers the inverse screen transform when the element provides one", () => {
    // Screen = user·0.5 + (100, 20)  ⇒  inverse: user = screen·2 − (200, 40).
    const svg = {
      getBoundingClientRect: () => box,
      getScreenCTM: () => ({ inverse: () => ({ a: 2, b: 0, c: 0, d: 2, e: -200, f: -40 }) }),
    };
    expect(clientToSvgUser(svg, 175, 95, { width: 300, height: 300 })).toEqual({ x: 150, y: 150 });
  });

  it("returns NaN for a collapsed box rather than dividing by zero", () => {
    const svg = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
    const p = clientToSvgUser(svg, 10, 10, { width: 300, height: 300 });
    expect(Number.isNaN(p.x) && Number.isNaN(p.y)).toBe(true);
  });
});
