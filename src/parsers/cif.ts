/**
 * Minimal CIF parser sufficient for GSAS-II-exported structure CIFs: unit cell,
 * space-group symmetry operations, and atom sites. Handles the esd-in-
 * parentheses notation (e.g. "5.41317(8)") and quoted values.
 *
 * Not a general CIF reader: it assumes one data row per line inside loops, which
 * holds for the files this workbench consumes. Unknown items are ignored.
 */

import type { AtomSite, DisplacementParameters, SpaceGroup, StructureModel, SymmetryOperation, UnitCell } from "@/core/crystal/types";
import type { MagneticModel, MagneticMoment } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { composeOperations, operationKey, parseMagneticSymmetryOperation, parseSymmetryOperation } from "@/core/crystal/symmetry";
import { IDENTITY3 } from "@/core/math/mat3";
import { buildSpaceGroup, completeSpaceGroup, SpaceGroupSettingError } from "@/core/crystal/spaceGroups";
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

function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

interface Loop {
  readonly headers: string[];
  readonly rows: string[][];
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

  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      i++;
      continue;
    }
    if (line.toLowerCase().startsWith("data_")) {
      // New data block — start fresh so blocks never merge.
      flush();
      items = new Map<string, string>();
      loops = [];
      i++;
      continue;
    }
    if (line.toLowerCase() === "loop_") {
      i++;
      const headers: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("_")) {
        headers.push(lines[i]!.trim().split(/\s+/)[0]!);
        i++;
      }
      const rows: string[][] = [];
      while (i < lines.length) {
        const rl = lines[i]!.trim();
        if (rl === "" || rl.startsWith("_") || rl.startsWith("#") || rl.toLowerCase() === "loop_" || rl.toLowerCase().startsWith("data_")) {
          break;
        }
        rows.push(tokenizeLine(rl));
        i++;
      }
      loops.push({ headers, rows });
      continue;
    }
    if (line.startsWith("_")) {
      const tokens = tokenizeLine(line);
      const key = tokens[0]!.toLowerCase();
      if (tokens.length >= 2) {
        items.set(key, tokens.slice(1).join(" "));
      }
      i++;
      continue;
    }
    i++;
  }
  flush();

  if (blocks.length === 0) return { items: new Map(), loops: [] };
  // Prefer the first block that actually carries atom sites, so a leading
  // metadata-only (global) block or a non-structural block is skipped.
  const hasAtoms = (b: ParsedCif): boolean =>
    b.loops.some((l) => l.headers.some((h) => h.toLowerCase().includes("atom_site_fract")));
  return blocks.find(hasAtoms) ?? blocks[0]!;
}

function findLoop(loops: Loop[], predicate: (headers: string[]) => boolean): Loop | undefined {
  return loops.find((l) => predicate(l.headers.map((h) => h.toLowerCase())));
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
  /**
   * Receives what the reader assumed on the file's behalf. Today that is one
   * case: a CIF with no symmetry at all is read as P 1 (see parseSpaceGroup).
   */
  readonly onWarning?: (message: string) => void;
}

function parseSpaceGroup(items: Map<string, string>, loops: Loop[], cell: UnitCell | undefined, options: CifParseOptions): SpaceGroup {
  const setting = options.spaceGroupSetting;
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

  // No symmetry at all — no operations, symbol, Hall symbol or number — is P 1:
  // the CIF core dictionary's default for _space_group_symop_operation_xyz and
  // _symmetry_equiv_pos_as_xyz is x,y,z. P1-expanded exports (diffpy.mpdf's
  // mCIFs) are written this way. An asymmetric unit stripped of its symmetry
  // would read the same, so the caller is told.
  if (explicitOps.length === 0 && hm === undefined && hall === undefined && numText === undefined && setting === undefined) {
    options.onWarning?.(
      "CIF space group: the file gives no symmetry operations, Hermann–Mauguin symbol, Hall symbol or IT number, " +
        "so it is read as P 1 (the CIF default operation x,y,z). If its atoms are an asymmetric unit, add the space group to the file.",
    );
    return buildSpaceGroup(1);
  }

  // Explicit operations (closed, with the centring the lattice letter implies)
  // are authoritative. Without them the setting is built from the table of all
  // 564 settings, which throws for an unknown, contradictory or ambiguous
  // description — e.g. "F d -3 m" alone, which may be origin choice 1 or 2.
  // There is no P1 fallback for those: the file names a group, and expanding
  // its asymmetric unit in P1 is silently wrong.
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
 * A CIF with no symmetry at all is read as P 1 and reported to
 * `options.onWarning`.
 */
export function parseCif(text: string, id = "structure", options: CifParseOptions = {}): StructureModel {
  const { items, loops } = parseCifBlocks(text);
  const name = items.get("_pd_phase_name")?.replace(/^["']|["']$/g, "") ?? "structure";
  const cell = parseCell(items);
  return {
    id,
    name,
    cell,
    spaceGroup: parseSpaceGroup(items, loops, cell, options),
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
    spaceGroup: magSg ?? parseSpaceGroup(items, loops, cell, options),
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
