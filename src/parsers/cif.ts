/**
 * CIF reader for structures: unit cell, space-group symmetry operations, and
 * atom sites. Reads CIF 1.1 syntax as a token stream — comments, quoted
 * strings, semicolon text fields, values on the line after their tag, loop rows
 * that wrap or share a line — and the esd-in-parentheses notation (e.g.
 * "5.41317(8)", the esd is dropped). Unknown items are ignored.
 */

import type { AtomSite, DisplacementParameters, SpaceGroup, StructureModel, SymmetryOperation, UnitCell } from "@/core/crystal/types";
import type { MagneticModel, MagneticMoment } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { composeOperations, operationKey, parseMagneticSymmetryOperation, parseSymmetryOperation } from "@/core/crystal/symmetry";
import { IDENTITY3 } from "@/core/math/mat3";
import { completeSpaceGroup, SpaceGroupSettingError } from "@/core/crystal/spaceGroups";
import { EIGHT_PI_SQUARED } from "@/core/crystal/adp";
import { elementFromLetters } from "@/core/crystal/elements";

/** Strip the parenthetical esd and parse: "5.41317(8)" → 5.41317. */
export function parseCifNumber(raw: string): number {
  const cleaned = raw.replace(/\([^)]*\)/g, "").trim();
  const value = parseFloat(cleaned);
  if (Number.isNaN(value)) {
    throw new Error(`Cannot parse CIF number: "${raw}"`);
  }
  return value;
}

/**
 * Parse an *optional* numeric CIF field, returning `fallback` for CIF null
 * markers — `?` (unknown) and `.` (inapplicable) — and for empty/missing values.
 * These appear legitimately, e.g. `_atom_site_U_iso_or_equiv = ?` on a purely
 * anisotropic site (its U_iso is undefined; the real ADP is in the aniso loop).
 */
function parseCifNumberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const t = raw.trim();
  if (t === "" || t === "?" || t === ".") return fallback;
  return parseCifNumber(t);
}

/**
 * Element and formal charge from a CIF atom-type symbol: "Fe3+" and "Fe+3" →
 * Fe, +3; "O2-" → O, −2; "Na+" → Na, +1; "FE" → Fe. The charge becomes the
 * site's oxidation state (it selects the magnetic ⟨j0⟩ ion) instead of being
 * dropped. A non-integer charge ("Fe2.5+") is no tabulated oxidation state and
 * is left unset. A symbol whose letters are not an element ("Wat", "OH-") is an
 * error rather than a guess.
 */
export function parseTypeSymbol(type: string): { element: string; oxidationState?: number } {
  const t = type.trim();
  const m = /^([A-Za-z]{1,2})(?![A-Za-z])(.*)$/.exec(t);
  const element = m ? elementFromLetters(m[1]!) : undefined;
  if (!m || element === undefined || element.length !== m[1]!.length) {
    throw new Error(`CIF: atom type symbol "${type}" is not an element symbol`);
  }
  const rest = m[2]!.trim();
  const charge = /^(\d+(?:\.\d+)?)?([+-])$/.exec(rest) ?? /^([+-])(\d+(?:\.\d+)?)?$/.exec(rest);
  if (!charge) return { element };
  const signFirst = charge[1] === "+" || charge[1] === "-";
  const sign = (signFirst ? charge[1] : charge[2]) === "-" ? -1 : 1;
  const magnitude = Number((signFirst ? charge[2] : charge[1]) ?? "1");
  return Number.isInteger(magnitude) && magnitude !== 0 ? { element, oxidationState: sign * magnitude } : { element };
}

/**
 * Element from an atom-site label, used only when the CIF has no type symbol:
 * the leading letters, case-insensitive, two-letter symbol first — "FE1" → Fe,
 * "CA1" → Ca, "C12" → C, "OW1" → O.
 */
function elementFromLabel(label: string): string {
  const element = elementFromLetters(label);
  if (element === undefined) throw new Error(`CIF: no _atom_site_type_symbol and label "${label}" names no element`);
  return element;
}

/** One CIF token. `quoted` marks a quoted string or a semicolon text field:
 *  always a value, never a tag, a reserved word or the null `?`/`.`. */
interface CifToken {
  readonly text: string;
  readonly quoted: boolean;
  /** 1-based line the token starts on. */
  readonly line: number;
}

/** Split one line (no text field) into tokens. A comment starts with `#` at a
 *  token boundary. A quoted string ends at its quote followed by whitespace or
 *  the end of the line, so 'O'Brien' is one value; an unterminated quote is
 *  read as a bare word. */
function tokenizeLine(line: string, lineNo: number, out: CifToken[]): void {
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (/\s/.test(c)) {
      i++; // any whitespace, including a byte-order mark
      continue;
    }
    if (c === "#") return;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < line.length && !(line[j] === c && (j + 1 === line.length || /\s/.test(line[j + 1]!)))) j++;
      if (j < line.length) {
        out.push({ text: line.slice(i + 1, j), quoted: true, line: lineNo });
        i = j + 1;
        continue;
      }
    }
    let j = i;
    while (j < line.length && !/\s/.test(line[j]!)) j++;
    out.push({ text: line.slice(i, j), quoted: false, line: lineNo });
    i = j;
  }
}

/**
 * CIF 1.1 tokens. A line starting with `;` opens a text field that runs to the
 * next line starting with `;`; its lines are one value, so a `_tag`, `loop_` or
 * `data_` inside it is text, not syntax.
 */
function tokenizeCif(text: string): CifToken[] {
  const lines = text.split(/\r\n|\r|\n/);
  const tokens: CifToken[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (!line.startsWith(";")) {
      tokenizeLine(line, n + 1, tokens);
      continue;
    }
    const body = [line.slice(1)];
    let end = n + 1;
    while (end < lines.length && !lines[end]!.startsWith(";")) body.push(lines[end++]!);
    if (end === lines.length) throw new Error(`CIF line ${n + 1}: the text field opened by ";" is never closed`);
    tokens.push({ text: body.join("\n").trim(), quoted: true, line: n + 1 });
    tokenizeLine(lines[end]!.slice(1), end + 1, tokens);
    n = end;
  }
  return tokens;
}

/** The reserved word a token is (`data_<name>` → "data_"), if any. */
function reservedWord(t: CifToken): string | undefined {
  if (t.quoted) return undefined;
  const lower = t.text.toLowerCase();
  if (lower.startsWith("data_")) return "data_";
  if (lower.startsWith("save_")) return "save_";
  return lower === "loop_" || lower === "global_" || lower === "stop_" ? lower : undefined;
}

const isTag = (t: CifToken): boolean => !t.quoted && t.text.startsWith("_");

interface Loop {
  readonly headers: string[];
  readonly rows: string[][];
  /** Set when the values do not fill whole rows; reading the loop throws it. */
  readonly malformed?: string;
}

/**
 * Rows of a loop. CIF puts rows anywhere — wrapped over lines, several to a
 * line — so the values are cut into rows of `headers.length`. One exception
 * keeps a non-conformant layout readable as before: when every line holds the
 * same number of values, more than one row's worth but not a whole number of
 * rows (MAGNDATA's `1 x,y,z,+1 mx,my,mz` under two tags), each line is a row
 * and the extra values are ignored. Values that cannot be cut into rows mark
 * the loop malformed instead of shifting every later column.
 */
function loopRows(headers: string[], values: CifToken[]): Pick<Loop, "rows" | "malformed"> {
  const n = headers.length;
  if (values.length === 0) return { rows: [] };
  const perLine: string[][] = [];
  let last = -1;
  for (const v of values) {
    if (v.line !== last) perLine.push([]);
    perLine[perLine.length - 1]!.push(v.text);
    last = v.line;
  }
  const width = perLine[0]!.length;
  const uniform = perLine.every((r) => r.length === width);
  if (n > 0 && uniform && width > n && width % n !== 0) return { rows: perLine };
  // Every line short by the same count, and not a clean wrap of a row over
  // several lines: a column is missing, so cutting rows would misalign them.
  const missingColumn = uniform && width < n && n % width !== 0;
  if (n > 0 && !missingColumn && values.length % n === 0) {
    const rows: string[][] = [];
    for (let i = 0; i < values.length; i += n) rows.push(values.slice(i, i + n).map((v) => v.text));
    return { rows };
  }
  return {
    rows: [],
    malformed:
      `CIF loop ${headers[0] ?? "(no tags)"} (line ${values[0]!.line}): ${values.length} values ` +
      `in lines of ${[...new Set(perLine.map((r) => r.length))].join("/")} do not fill rows of ${n} columns`,
  };
}

interface ParsedCif {
  readonly items: Map<string, string>;
  readonly loops: Loop[];
}

/**
 * Split a (possibly multi-block) CIF into its `data_` blocks, parsing each into
 * its own items + loops. A single-block file yields one block. Keeping blocks
 * separate avoids cross-contamination — e.g. a file with X-ray, neutron, and
 * refined-XRD blocks must not take its cell from one block and its atoms from
 * another.
 */
function parseCifBlocks(text: string): ParsedCif {
  const blocks: ParsedCif[] = [];
  let items = new Map<string, string>();
  let loops: Loop[] = [];
  const flush = (): void => {
    if (items.size > 0 || loops.length > 0) blocks.push({ items, loops });
  };

  const tokens = tokenizeCif(text);
  const isValue = (t: CifToken | undefined): t is CifToken => t !== undefined && !isTag(t) && reservedWord(t) === undefined;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const word = reservedWord(t);
    if (word === "data_") {
      // New data block — start fresh so blocks never merge.
      flush();
      items = new Map<string, string>();
      loops = [];
      i++;
      continue;
    }
    if (word === "loop_") {
      i++;
      const headers: string[] = [];
      while (i < tokens.length && isTag(tokens[i]!)) headers.push(tokens[i++]!.text);
      const values: CifToken[] = [];
      while (isValue(tokens[i])) values.push(tokens[i++]!);
      loops.push({ headers, ...loopRows(headers, values) });
      continue;
    }
    if (isTag(t)) {
      const key = t.text.toLowerCase();
      const value = tokens[i + 1];
      i++;
      if (isValue(value)) {
        // Further bare words on the value's line belong to it: a common
        // non-conformant spelling is `_symmetry_space_group_name_H-M P 21/c`.
        let text = value.text;
        i++;
        while (!value.quoted && isValue(tokens[i]) && !tokens[i]!.quoted && tokens[i]!.line === value.line) {
          text += ` ${tokens[i++]!.text}`;
        }
        items.set(key, text);
      }
      continue;
    }
    i++; // global_, save_, stop_, or a stray value
  }
  flush();

  if (blocks.length === 0) return { items: new Map(), loops: [] };
  // Prefer the first block that actually carries atom sites, so a leading
  // metadata-only (global) block or a non-structural block is skipped.
  const hasAtoms = (b: ParsedCif): boolean =>
    b.loops.some((l) => l.headers.some((h) => h.toLowerCase().includes("atom_site_fract")));
  return blocks.find(hasAtoms) ?? blocks[0]!;
}

/** The first loop whose tags satisfy `predicate`; throws if that loop's values
 *  do not fill whole rows, rather than reading misaligned columns. */
function findLoop(loops: Loop[], predicate: (headers: string[]) => boolean): Loop | undefined {
  const loop = loops.find((l) => predicate(l.headers.map((h) => h.toLowerCase())));
  if (loop?.malformed) throw new Error(loop.malformed);
  return loop;
}

function parseCell(items: Map<string, string>): UnitCell {
  const get = (key: string): number => {
    const v = items.get(key);
    if (v === undefined) throw new Error(`CIF missing ${key}`);
    return parseCifNumber(v);
  };
  return {
    a: get("_cell_length_a"),
    b: get("_cell_length_b"),
    c: get("_cell_length_c"),
    alpha: get("_cell_angle_alpha"),
    beta: get("_cell_angle_beta"),
    gamma: get("_cell_angle_gamma"),
  };
}

/** Options for reading a CIF. */
export interface CifParseOptions {
  /**
   * The setting to use when the CIF gives no symmetry operations and its
   * symbol/number fits more than one setting — the extended symbol of one of
   * the candidates a {@link SpaceGroupSettingError} lists (e.g. "F d -3 m:2").
   */
  readonly spaceGroupSetting?: string;
}

function parseSpaceGroup(items: Map<string, string>, loops: Loop[], cell?: UnitCell, setting?: string): SpaceGroup {
  const symLoop = findLoop(loops, (h) =>
    h.some((k) => k.includes("space_group_symop_operation_xyz") || k.includes("symmetry_equiv_pos_as_xyz")),
  );
  const explicitOps = symLoop
    ? symLoop.rows.map((row) => {
        const idx = symLoop.headers.findIndex((h) =>
          h.toLowerCase().includes("xyz"),
        );
        return parseSymmetryOperation(row[idx >= 0 ? idx : row.length - 1]!);
      })
    : [];

  const hm = cifText(items.get("_symmetry_space_group_name_h-m") ?? items.get("_space_group_name_h-m_alt"));
  const hall = cifText(items.get("_symmetry_space_group_name_hall") ?? items.get("_space_group_name_hall"));
  const numText = cifText(items.get("_symmetry_int_tables_number") ?? items.get("_space_group_it_number"));
  const number = numText !== undefined ? parseInt(numText, 10) : undefined;

  // Explicit operations (closed, with the centring the lattice letter implies)
  // are authoritative. Without them the setting is built from the table of all
  // 564 settings, which throws for an unknown, contradictory or ambiguous
  // description — e.g. "F d -3 m" alone, which may be origin choice 1 or 2.
  // There is no P1 fallback: expanding an asymmetric unit in P1 is silently
  // wrong.
  try {
    return completeSpaceGroup(
      {
        operations: explicitOps,
        ...(hm !== undefined ? { hermannMauguin: hm } : {}),
        ...(number !== undefined && !Number.isNaN(number) ? { number } : {}),
      },
      cell,
      { ...(hall !== undefined ? { hall } : {}), ...(setting !== undefined ? { setting } : {}) },
    );
  } catch (e) {
    if (e instanceof SpaceGroupSettingError) {
      throw new SpaceGroupSettingError(`CIF space group: ${e.message}`, e.candidates);
    }
    throw e;
  }
}

/** A CIF text value with surrounding quotes removed; undefined for absent,
 *  empty, `?` (unknown) and `.` (inapplicable). */
function cifText(raw: string | undefined): string | undefined {
  const t = raw?.trim().replace(/^['"]|['"]$/g, "").trim();
  return t === undefined || t === "" || t === "?" || t === "." ? undefined : t;
}

function parseAnisotropicAdps(loops: Loop[]): Map<string, DisplacementParameters> {
  const anisoLoop = findLoop(loops, (h) => h.some((k) => k.includes("atom_site_aniso_u_11")));
  if (!anisoLoop) return new Map();
  const col = (name: string): number =>
    anisoLoop.headers.findIndex((h) => h.toLowerCase() === name);
  const iLabel = col("_atom_site_aniso_label");
  const iU11 = col("_atom_site_aniso_u_11");
  const iU22 = col("_atom_site_aniso_u_22");
  const iU33 = col("_atom_site_aniso_u_33");
  const iU12 = col("_atom_site_aniso_u_12");
  const iU13 = col("_atom_site_aniso_u_13");
  const iU23 = col("_atom_site_aniso_u_23");
  if ([iLabel, iU11, iU22, iU33, iU12, iU13, iU23].some((i) => i < 0)) return new Map();

  const adps = new Map<string, DisplacementParameters>();
  for (const row of anisoLoop.rows) {
    const label = row[iLabel];
    if (label === undefined) continue;
    adps.set(label, {
      kind: "anisotropic",
      uAniso: [
        parseCifNumberOr(row[iU11], 0),
        parseCifNumberOr(row[iU22], 0),
        parseCifNumberOr(row[iU33], 0),
        parseCifNumberOr(row[iU12], 0),
        parseCifNumberOr(row[iU13], 0),
        parseCifNumberOr(row[iU23], 0),
      ],
    });
  }
  return adps;
}

function parseSites(loops: Loop[]): AtomSite[] {
  const atomLoop = findLoop(loops, (h) => h.some((k) => k.includes("atom_site_fract_x")));
  if (!atomLoop) return [];
  const anisoAdps = parseAnisotropicAdps(loops);

  const col = (name: string): number =>
    atomLoop.headers.findIndex((h) => h.toLowerCase() === name);
  const iLabel = col("_atom_site_label");
  const iType = col("_atom_site_type_symbol");
  const iX = col("_atom_site_fract_x");
  const iY = col("_atom_site_fract_y");
  const iZ = col("_atom_site_fract_z");
  const iOcc = col("_atom_site_occupancy");
  // `_atom_site_thermal_displace_type` is the older/alternate name for
  // `_atom_site_adp_type` (both hold "Uani"/"Uiso"); accept either so
  // anisotropic sites keep their U tensor instead of collapsing to isotropic.
  const iAdpType = col("_atom_site_adp_type") >= 0 ? col("_atom_site_adp_type") : col("_atom_site_thermal_displace_type");
  // U_iso and B_iso are the same quantity in different units (B = 8π²U). Which
  // one a file carries is a dialect choice — GSAS-II/VESTA write U, the
  // structure-report dialects often write B — so read either. A file with no
  // column at all leaves B_iso = 0, which is a *missing* ADP, not a cold one:
  // callers warn (see zeroAdpWarning); substituting a default here would
  // invent physics.
  const iU = col("_atom_site_u_iso_or_equiv");
  const iB = col("_atom_site_b_iso_or_equiv");
  const iMult = col("_atom_site_site_symmetry_multiplicity");

  return atomLoop.rows.map((row) => {
    // Per row, not per column: a mixed loop can leave U_iso as `?` on the sites
    // whose value sits in the B column (and vice versa).
    const uIso = iU >= 0 ? parseCifNumberOr(row[iU], NaN) : NaN;
    const bIsoRead = iB >= 0 ? parseCifNumberOr(row[iB], NaN) : NaN;
    const bIso = !Number.isNaN(uIso) ? EIGHT_PI_SQUARED * uIso : !Number.isNaN(bIsoRead) ? bIsoRead : 0;
    const position: Vec3 = [parseCifNumber(row[iX]!), parseCifNumber(row[iY]!), parseCifNumber(row[iZ]!)];
    // A `?`/`.` type symbol is as good as none: fall back to the label.
    const typeText = iType >= 0 ? cifText(row[iType]) : undefined;
    const typed = typeText !== undefined ? parseTypeSymbol(typeText) : { element: elementFromLabel(row[iLabel] ?? "") };
    const element = typed.element;
    const label = iLabel >= 0 ? row[iLabel]! : element;
    const adpType = iAdpType >= 0 ? row[iAdpType]?.toLowerCase() : undefined;
    const adp = adpType === "uani" && anisoAdps.has(label)
      ? anisoAdps.get(label)!
      : { kind: "isotropic" as const, bIso };
    const site: AtomSite = {
      label,
      element,
      ...(typed.oxidationState !== undefined ? { oxidationState: typed.oxidationState } : {}),
      position,
      occupancy: iOcc >= 0 ? parseCifNumberOr(row[iOcc], 1) : 1,
      adp,
      ...(iMult >= 0 && row[iMult] !== undefined ? { multiplicity: parseInt(row[iMult]!, 10) } : {}),
    };
    return site;
  });
}

/**
 * Parse a CIF string into a StructureModel. Throws a SpaceGroupSettingError
 * when the CIF gives no symmetry operations and its symbol/number is unknown or
 * fits several settings; `options.spaceGroupSetting` picks one of the latter.
 */
export function parseCif(text: string, id = "structure", options: CifParseOptions = {}): StructureModel {
  const { items, loops } = parseCifBlocks(text);
  const name = items.get("_pd_phase_name")?.replace(/^["']|["']$/g, "") ?? "structure";
  const cell = parseCell(items);
  return {
    id,
    name,
    cell,
    spaceGroup: parseSpaceGroup(items, loops, cell, options.spaceGroupSetting),
    sites: parseSites(loops),
  };
}

/**
 * Parse magnetic (BNS) symmetry operations from an mCIF, if present.
 *
 * magCIF splits a magnetic space group across TWO loops, and the group is their
 * product: `_space_group_symop_magn_operation.xyz` holds the coset
 * representatives, `_space_group_symop_magn_centering.xyz` the centering
 * translations — including ANTI-translations (θ = −1), which is how a black-and-
 * white lattice is written. Reading only the operation loop silently yields a
 * fraction of the group: MnO (MAGNDATA 1.31, BNS C_c2/c) lists 4 operations and
 * 32 centerings, so its 32-Mn magnetic cell came out with 4 Mn — one eighth of
 * the structure, with no error anywhere.
 */
const IDENTITY_OPERATION: SymmetryOperation = {
  rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z", timeReversal: 1,
};

function parseMagneticSpaceGroup(items: Map<string, string>, loops: Loop[]): SpaceGroup | null {
  const magLoop = findLoop(loops, (h) =>
    h.some((k) => k.includes("space_group_symop_magn_operation.xyz")),
  );
  if (!magLoop) return null;
  const idx = magLoop.headers.findIndex((h) => h.toLowerCase().includes("magn_operation.xyz"));
  const representatives = magLoop.rows.map((row) =>
    parseMagneticSymmetryOperation(row[idx >= 0 ? idx : row.length - 1]!),
  );

  const centLoop = findLoop(loops, (h) =>
    h.some((k) => k.includes("space_group_symop_magn_centering.xyz")),
  );
  const centerings = centLoop
    ? centLoop.rows.map((row) => {
        const ci = centLoop.headers.findIndex((h) => h.toLowerCase().includes("magn_centering.xyz"));
        return parseMagneticSymmetryOperation(row[ci >= 0 ? ci : row.length - 1]!);
      })
    : [];

  // The full group, deduped mod lattice. θ must be part of the key: an
  // operation and its anti-operation share a rotation and translation and would
  // otherwise collapse onto each other, halving a black-and-white group.
  const operations: SymmetryOperation[] = [];
  const seen = new Set<string>();
  for (const rep of representatives) {
    for (const c of centerings.length > 0 ? centerings : [IDENTITY_OPERATION]) {
      const op = composeOperations(c, rep);
      const key = `${operationKey(op)}|${op.timeReversal ?? 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      operations.push(op);
    }
  }
  // Only strip surrounding double-quotes; apostrophes are part of BNS names.
  const bns = items.get("_space_group_magn.name_bns")?.replace(/^"|"$/g, "");
  const parent = items.get("_parent_space_group.name_h-m_alt")?.replace(/^"|"$/g, "");
  return {
    operations,
    ...(bns !== undefined ? { hermannMauguin: bns } : parent !== undefined ? { hermannMauguin: parent } : {}),
  };
}

/** Parse the `_atom_site_moment` loop into magnetic moments (μ_B, crystal axes). */
function parseMoments(loops: Loop[]): MagneticMoment[] {
  const momLoop = findLoop(loops, (h) => h.some((k) => k.includes("atom_site_moment.label")));
  if (!momLoop) return [];
  const col = (needle: string): number =>
    momLoop.headers.findIndex((h) => h.toLowerCase().includes(needle));
  const iLabel = col("atom_site_moment.label");
  const iX = col("crystalaxis_x");
  const iY = col("crystalaxis_y");
  const iZ = col("crystalaxis_z");

  const moments: MagneticMoment[] = [];
  for (const row of momLoop.rows) {
    const components: Vec3 = [
      iX >= 0 ? parseCifNumber(row[iX]!) : 0,
      iY >= 0 ? parseCifNumber(row[iY]!) : 0,
      iZ >= 0 ? parseCifNumber(row[iZ]!) : 0,
    ];
    // Skip zero moments (e.g. non-magnetic atoms listed with 0,0,0).
    if (components[0] === 0 && components[1] === 0 && components[2] === 0) continue;
    moments.push({ siteLabel: iLabel >= 0 ? row[iLabel]! : "", frame: "crystallographic", components });
  }
  return moments;
}

export interface MagneticCifResult {
  readonly structure: StructureModel;
  readonly magnetic: MagneticModel | null;
}

/**
 * Parse a magnetic CIF (mCIF): the crystal structure plus, when present, a
 * MagneticModel built from the BNS symmetry operations and moment loop. The
 * structure's space group is set to the magnetic operations (spatial parts);
 * time-reversal flags are retained on each operation.
 */
export function parseMagneticCif(text: string, id = "structure", options: CifParseOptions = {}): MagneticCifResult {
  const { items, loops } = parseCifBlocks(text);
  const name = items.get("_pd_phase_name")?.replace(/^["']|["']$/g, "") ?? "structure";
  const magSg = parseMagneticSpaceGroup(items, loops);
  const cell = parseCell(items);
  const structure: StructureModel = {
    id,
    name,
    cell,
    spaceGroup: magSg ?? parseSpaceGroup(items, loops, cell, options.spaceGroupSetting),
    sites: parseSites(loops),
  };
  const moments = parseMoments(loops);
  // Carry the BNS operations on the magnetic model: the structure factor then
  // expands each moment over the magnetic group with position deduplication.
  // Without them it falls back to the legacy no-dedup expansion, which
  // over-counts special positions by their stabilizer order — sites of
  // different multiplicity (e.g. Mn₃Ga 350 K: 8g and 4c Mn) get *different*
  // spurious factors and the relative magnetic intensities come out wrong.
  const magnetic: MagneticModel | null =
    magSg && moments.length > 0
      ? { id: `${id}-mag`, structureId: id, propagation: [[0, 0, 0]], moments, operations: magSg.operations }
      : null;
  return { structure, magnetic };
}
