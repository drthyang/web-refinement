/**
 * Minimal CIF parser sufficient for GSAS-II-exported structure CIFs: unit cell,
 * space-group symmetry operations, and atom sites. Handles the esd-in-
 * parentheses notation (e.g. "5.41317(8)") and quoted values.
 *
 * Not a general CIF reader: it assumes one data row per line inside loops, which
 * holds for the files this workbench consumes. Unknown items are ignored.
 */

import type { AtomSite, SpaceGroup, StructureModel, UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";

/** Strip the parenthetical esd and parse: "5.41317(8)" → 5.41317. */
export function parseCifNumber(raw: string): number {
  const cleaned = raw.replace(/\([^)]*\)/g, "").trim();
  const value = parseFloat(cleaned);
  if (Number.isNaN(value)) {
    throw new Error(`Cannot parse CIF number: "${raw}"`);
  }
  return value;
}

/** Element symbol from a CIF type symbol, dropping oxidation/charge: "Mn2+" → "Mn". */
function elementFromType(type: string): string {
  const m = type.match(/^[A-Z][a-z]?/);
  return m ? m[0] : type;
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

function parseCifBlocks(text: string): ParsedCif {
  const lines = text.split(/\r?\n/);
  const items = new Map<string, string>();
  const loops: Loop[] = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
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
  return { items, loops };
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

function parseSpaceGroup(items: Map<string, string>, loops: Loop[]): SpaceGroup {
  const symLoop = findLoop(loops, (h) =>
    h.some((k) => k.includes("space_group_symop_operation_xyz") || k.includes("symmetry_equiv_pos_as_xyz")),
  );
  const operations = symLoop
    ? symLoop.rows.map((row) => {
        const idx = symLoop.headers.findIndex((h) =>
          h.toLowerCase().includes("xyz"),
        );
        return parseSymmetryOperation(row[idx >= 0 ? idx : row.length - 1]!);
      })
    : [parseSymmetryOperation("x,y,z")];

  const hm = items.get("_symmetry_space_group_name_h-m") ?? items.get("_space_group_name_h-m_alt");
  const number = items.get("_symmetry_int_tables_number") ?? items.get("_space_group_it_number");
  return {
    operations,
    ...(hm !== undefined ? { hermannMauguin: hm } : {}),
    ...(number !== undefined ? { number: parseInt(number, 10) } : {}),
  };
}

function parseSites(loops: Loop[]): AtomSite[] {
  const atomLoop = findLoop(loops, (h) => h.some((k) => k.includes("atom_site_fract_x")));
  if (!atomLoop) return [];

  const col = (name: string): number =>
    atomLoop.headers.findIndex((h) => h.toLowerCase() === name);
  const iLabel = col("_atom_site_label");
  const iType = col("_atom_site_type_symbol");
  const iX = col("_atom_site_fract_x");
  const iY = col("_atom_site_fract_y");
  const iZ = col("_atom_site_fract_z");
  const iOcc = col("_atom_site_occupancy");
  const iU = col("_atom_site_u_iso_or_equiv");
  const iMult = col("_atom_site_site_symmetry_multiplicity");

  return atomLoop.rows.map((row) => {
    const uIso = iU >= 0 && row[iU] !== undefined ? parseCifNumber(row[iU]!) : 0;
    const position: Vec3 = [parseCifNumber(row[iX]!), parseCifNumber(row[iY]!), parseCifNumber(row[iZ]!)];
    const element = iType >= 0 ? elementFromType(row[iType]!) : elementFromType(row[iLabel]!);
    const site: AtomSite = {
      label: iLabel >= 0 ? row[iLabel]! : element,
      element,
      position,
      occupancy: iOcc >= 0 && row[iOcc] !== undefined ? parseCifNumber(row[iOcc]!) : 1,
      // CIF stores U_iso; convert to B_iso = 8π²·U_iso.
      adp: { kind: "isotropic", bIso: 8 * Math.PI * Math.PI * uIso },
      ...(iMult >= 0 && row[iMult] !== undefined ? { multiplicity: parseInt(row[iMult]!, 10) } : {}),
    };
    return site;
  });
}

/** Parse a CIF string into a StructureModel. */
export function parseCif(text: string, id = "structure"): StructureModel {
  const { items, loops } = parseCifBlocks(text);
  const name = items.get("_pd_phase_name")?.replace(/^["']|["']$/g, "") ?? "structure";
  return {
    id,
    name,
    cell: parseCell(items),
    spaceGroup: parseSpaceGroup(items, loops),
    sites: parseSites(loops),
  };
}
