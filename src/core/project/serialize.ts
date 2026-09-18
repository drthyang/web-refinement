/**
 * Readable JSON for project files.
 *
 * `JSON.stringify(x, null, 2)` spreads every observed point over four lines,
 * so a 30 000-point pattern becomes a 120 000-line file nobody can scan. This
 * printer keeps the nesting indented like the standard two-space form but
 * prints small leaves compactly — an array whose elements all fit on one line
 * (points, reflections, parameters, symmetry operations) is written one
 * element per line:
 *
 * ```
 * "points": [
 *   {"x": 10.05, "yObs": 1234.5, "sigma": 35.1},
 *   {"x": 10.1, "yObs": 1250.0, "sigma": 35.4}
 * ]
 * ```
 *
 * Semantics are exactly `JSON.stringify`'s: `undefined` object members are
 * omitted, `undefined`/non-finite values inside arrays become `null`, strings
 * are escaped the same way. `JSON.parse(stringifyProject(x))` therefore equals
 * `JSON.parse(JSON.stringify(x))` — pinned by `serialize.test.ts`.
 */

/** Widest one-line rendering of an array element or small object. */
const COMPACT_MAX = 140;
const INDENT = "  ";

export function stringifyProject(value: unknown): string {
  return render(value, "");
}

function render(value: unknown, indent: string): string {
  if (Array.isArray(value)) return renderArray(value, indent);
  if (isPlainObject(value)) return renderObject(value, indent);
  return leaf(value);
}

/** Primitives (and anything JSON.stringify treats as one). */
function leaf(value: unknown): string {
  const s = JSON.stringify(value);
  // `undefined`, functions and symbols have no JSON form; inside an array the
  // standard emits null, and objects skip them before we get here.
  return s === undefined ? "null" : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One-line form, or null when the value is too long to print compactly. */
function compact(value: unknown): string | null {
  const s = JSON.stringify(value === undefined ? null : value);
  return s.length <= COMPACT_MAX ? s : null;
}

/** Re-space a compact JSON string into the `"a": 1, "b": 2` one-liner style. */
function spaced(compactJson: string): string {
  // Re-space a standard compact JSON string ("a":1,"b":2) into ("a": 1, "b": 2)
  // without touching string contents: walk it once, tracking quotes.
  let out = "";
  let inString = false;
  for (let i = 0; i < compactJson.length; i++) {
    const c = compactJson[i]!;
    if (inString) {
      out += c;
      if (c === "\\") { out += compactJson[++i] ?? ""; continue; }
      if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") { inString = true; out += c; continue; }
    if (c === ":") { out += ": "; continue; }
    if (c === ",") { out += ", "; continue; }
    out += c;
  }
  return out;
}

function renderArray(items: readonly unknown[], indent: string): string {
  if (items.length === 0) return "[]";
  const inner = indent + INDENT;
  // Every element fits on a line → one element per line, each compact. A
  // mixed rendering (some elements expanded, some not) is avoided on purpose:
  // uniform rows are what make a long table scannable.
  const compacts = items.map(compact);
  if (compacts.every((c): c is string => c !== null)) {
    // A short array of primitives stays on one line ([0, 0, 0], [[1,0,0],…]).
    const whole = compact(items);
    if (whole !== null && items.every((it) => !isPlainObject(it))) return spaced(whole);
    // A long array of plain numbers/strings (an overlay curve, peak lists) is
    // wrapped into rows rather than one value per line.
    if (items.every((it) => !isPlainObject(it) && !Array.isArray(it))) return renderPrimitiveRows(compacts, indent);
    return `[\n${compacts.map((c) => inner + spaced(c)).join(",\n")}\n${indent}]`;
  }
  return `[\n${items.map((it) => inner + render(it, inner)).join(",\n")}\n${indent}]`;
}

/** Primitives packed into rows of at most COMPACT_MAX characters. */
function renderPrimitiveRows(leaves: readonly string[], indent: string): string {
  const inner = indent + INDENT;
  const rows: string[] = [];
  let row = "";
  for (const s of leaves) {
    if (row !== "" && row.length + 2 + s.length > COMPACT_MAX) {
      rows.push(row);
      row = "";
    }
    row = row === "" ? s : `${row}, ${s}`;
  }
  if (row !== "") rows.push(row);
  return `[\n${rows.map((r) => inner + r).join(",\n")}\n${indent}]`;
}

function renderObject(obj: Record<string, unknown>, indent: string): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol");
  if (entries.length === 0) return "{}";
  const whole = compact(obj);
  if (whole !== null && entries.every(([, v]) => !isPlainObject(v) && !Array.isArray(v))) return spaced(whole);
  const inner = indent + INDENT;
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${render(v, inner)}`).join(",\n")}\n${indent}}`;
}
