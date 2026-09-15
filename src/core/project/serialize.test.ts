import { describe, it, expect } from "vitest";
import { stringifyProject } from "@/core/project/serialize";

const sample = {
  schemaVersion: 2,
  metadata: { title: 'a "quoted" title: with, punctuation \\ and \n newline', notes: undefined },
  nested: { deep: { deeper: [1, [2, 3], { k: "v" }] } },
  points: [{ x: 1, yObs: 2 }, { x: 3, yObs: 4, sigma: 0.5 }],
  ops: [{ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y+1/2,-z" }],
  sparse: [1, undefined, NaN, Infinity, null, "s", true],
  empties: { a: [], b: {} },
  long: Array.from({ length: 400 }, (_, i) => i * 0.123456789),
  wide: { label: "x".repeat(200), value: 1e-7, neg: -0.5 },
  unicode: "Mn₃Ga · μ_B · Å",
  skipped: () => 1,
};

describe("stringifyProject", () => {
  it("round-trips exactly like JSON.stringify", () => {
    expect(JSON.parse(stringifyProject(sample))).toEqual(JSON.parse(JSON.stringify(sample)));
  });

  it("prints table-like arrays one element per line, each compact", () => {
    expect(stringifyProject({ points: [{ x: 1, yObs: 2 }, { x: 3, yObs: 4 }] })).toBe(
      '{\n  "points": [\n    {"x": 1, "yObs": 2},\n    {"x": 3, "yObs": 4}\n  ]\n}',
    );
  });

  it("keeps a short primitive array on one line", () => {
    expect(stringifyProject({ p: [0, 0.5, 0.25] })).toBe('{\n  "p": [0, 0.5, 0.25]\n}');
  });

  it("does not re-space punctuation inside strings", () => {
    expect(stringifyProject({ op: { xyz: "x,y+1/2:-z", q: 'a"b' } })).toBe('{\n  "op": {"xyz": "x,y+1/2:-z", "q": "a\\"b"}\n}');
  });

  it("wraps a long primitive array into rows instead of one value per line", () => {
    const out = stringifyProject({ v: Array.from({ length: 200 }, (_, i) => i * 1.5) });
    const lines = out.split("\n");
    expect(lines.length).toBeLessThan(30);
    expect(lines.every((l) => l.length <= 150)).toBe(true);
    expect(JSON.parse(out).v).toHaveLength(200);
  });

  it("falls back to nested rendering when an element is too wide to print compactly", () => {
    const out = stringifyProject({ rows: [{ a: 1 }, { a: "y".repeat(200) }] });
    // The small element still prints compactly; the wide one is expanded.
    expect(out).toContain('\n    {"a": 1},\n    {\n      "a": "yyy');
    expect(JSON.parse(out).rows[1].a).toHaveLength(200);
  });

  it("omits undefined members and writes null for undefined array slots", () => {
    expect(stringifyProject({ a: undefined, b: [undefined, 1] })).toBe('{\n  "b": [null, 1]\n}');
  });
});
