/**
 * Refined-structure **CIF / mCIF export** (Roadmap M5, "ship the results").
 *
 * Emits a crystallographic information file for a refined `StructureModel` —
 * cell, symmetry operations, atom sites (fractional coordinates, occupancy,
 * isotropic B / anisotropic U) — and, for a `MagneticModel`, the magnetic
 * (mCIF) extension with a `_atom_site_moment` loop. Values carry standard
 * uncertainties `value(su)` where the refinement supplies an esd for a field
 * with a direct parameter binding (cell, occupancy, B_iso) or a symmetry-mode
 * binding whose per-coordinate su follows from the mode axis (positions).
 *
 * The output round-trips through this project's own `parseCif` / `parseMagneticCif`
 * (see cif.test) and is written to the standard tags external tools read:
 *   - CIF core: `_cell_length_*`, `_cell_angle_*`, `_space_group_symop_operation_xyz`,
 *     `_atom_site_*` (fract, occupancy, adp_type, U_iso_or_equiv), `_atom_site_aniso_U_*`.
 *   - mCIF: `_space_group_symop_magn_operation.xyz`, `_atom_site_moment.crystalaxis_*`.
 *
 * Conventions matched to the parser: the model stores B_iso, CIF stores
 * U_iso = B_iso / 8π²; anisotropic sites use `adp_type Uani` plus a U_11…U_23
 * loop; moments are in the crystallographic frame (μ_B along the crystal axes),
 * matching `_atom_site_moment.crystalaxis_x/y/z`.
 */

import type { AtomSite, StructureModel, SymmetryOperation, UnitCell } from "@/core/crystal/types";
import type { MagneticModel, MagneticMoment } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { inverse, transpose } from "@/core/math/mat3";
import { normalize } from "@/core/math/vec3";
import type { Mat3, Vec3 } from "@/core/math/types";
import { expandMagneticSupercell } from "@/core/crystal/cellExpansion";

const EIGHT_PI2 = 8 * Math.PI * Math.PI;

/** Agreement metadata written as standard `_refine_ls_*` tags. */
export interface CifRefinementMeta {
  /** Powder weighted-profile R (%), → `_refine_ls_wR_factor_obs`. */
  readonly rwp?: number;
  /** Goodness of fit, → `_refine_ls_goodness_of_fit_all`. */
  readonly gof?: number;
  /** Single-crystal R1 (fraction, e.g. 0.032), → `_refine_ls_R_factor_gt`. */
  readonly r1?: number;
  /** Single-crystal wR2 (fraction), → `_refine_ls_wR_factor_ref`. */
  readonly wr2?: number;
  /** Reflection count, → `_refine_ls_number_reflns`. */
  readonly nRef?: number;
  /** Refined-parameter count, → `_refine_ls_number_parameters`. */
  readonly nParam?: number;
}

export interface CifExportOptions {
  /** Refined parameters (with esds), to annotate values with `value(su)`. */
  readonly params?: readonly RefinementParameter[];
  /** The bindings that map those parameters onto the model fields. */
  readonly bindings?: readonly ParameterBinding[];
  /** Refinement agreement metadata written as `_refine_ls_*` tags. */
  readonly refinement?: CifRefinementMeta;
  /** `data_` block name. Defaults to a sanitized structure name. */
  readonly blockName?: string;
  /** Standard BNS symbol for the magnetic block (`_space_group_magn.name_bns`). */
  readonly magneticLabel?: string;
}

/** Per-field standard uncertainties recovered from the refined parameters. */
interface EsdMap {
  readonly cell: Partial<Record<keyof UnitCell, number>>;
  readonly bIso: Map<string, number>;
  readonly occ: Map<string, number>;
  /** site label → [σx, σy, σz] on the fractional coordinates. */
  readonly pos: Map<string, [number, number, number]>;
}

/**
 * Recover per-field esds from the refined parameters + bindings. Direct bindings
 * (cell, B_iso, occupancy) map one-to-one; a `positionShift` mode contributes
 * σ_xi = |axis_i|·σ to each coordinate, summed in quadrature over the modes on a
 * site (cross-mode correlation ignored — the common single-mode-exact
 * approximation). Anisotropic-U component esds are not propagated (emitted
 * without su).
 */
function buildEsdMap(params: readonly RefinementParameter[], bindings: readonly ParameterBinding[]): EsdMap {
  const byId = new Map(params.map((p) => [p.id, p]));
  const cell: Partial<Record<keyof UnitCell, number>> = {};
  const bIso = new Map<string, number>();
  const occ = new Map<string, number>();
  const posVar = new Map<string, [number, number, number]>();

  for (const b of bindings) {
    const p = byId.get(b.parameterId);
    if (!p || p.fixed || p.esd === undefined || !(p.esd > 0)) continue;
    const e = p.esd;
    if (b.kind === "cellLength" || b.kind === "cellAngle") {
      if (b.targetKey) cell[b.targetKey as keyof UnitCell] = e;
    } else if (b.kind === "bIso" && b.targetKey) {
      bIso.set(b.targetKey, e);
    } else if (b.kind === "occupancy" && b.targetKey) {
      occ.set(b.targetKey, e);
    } else if (b.kind === "positionShift" && b.targetKey && b.axis) {
      const v = posVar.get(b.targetKey) ?? [0, 0, 0];
      for (let i = 0; i < 3; i++) v[i]! += (b.axis[i]! * e) ** 2;
      posVar.set(b.targetKey, v);
    }
  }
  const pos = new Map<string, [number, number, number]>();
  for (const [k, v] of posVar) pos.set(k, [Math.sqrt(v[0]!), Math.sqrt(v[1]!), Math.sqrt(v[2]!)]);
  return { cell, bIso, occ, pos };
}

/**
 * Format `value(su)` in the IUCr convention: the su to two significant figures,
 * the value to the same decimal place. Falls back to fixed decimals when no
 * (positive, finite) su is available.
 */
export function formatWithEsd(value: number, esd: number | undefined, decimals: number): string {
  if (esd === undefined || !Number.isFinite(esd) || esd <= 0) return value.toFixed(decimals);
  let d = -Math.floor(Math.log10(esd)) + 1; // two significant figures of the su
  if (d < 0) d = 0;
  let su = Math.round(esd * 10 ** d);
  if (su >= 100) {
    // Rounding pushed the su to three digits (e.g. 99.6 → 100); drop a place.
    d = Math.max(0, d - 1);
    su = Math.round(esd * 10 ** d);
  }
  return `${value.toFixed(d)}(${su})`;
}

const sanitizeBlock = (name: string): string => name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "structure";

/** Cell volume V = abc·√(1 − Σcos² + 2∏cos) (Å³). */
function cellVolume(cell: UnitCell): number {
  const rad = (a: number): number => Math.cos((a * Math.PI) / 180);
  const ca = rad(cell.alpha);
  const cb = rad(cell.beta);
  const cg = rad(cell.gamma);
  return cell.a * cell.b * cell.c * Math.sqrt(Math.max(0, 1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg));
}

/** Equivalent isotropic U (Å²) for an anisotropic site — the trace/3 approximation. */
const uEquiv = (u: readonly number[]): number => (u[0]! + u[1]! + u[2]!) / 3;

function loop(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = ["loop_", ...headers.map((h) => `  ${h}`)];
  for (const r of rows) lines.push("  " + r.join(" "));
  return lines.join("\n");
}

/** The atom-site loop plus, when any site is anisotropic, the aniso-U loop. */
function atomSiteBlocks(structure: StructureModel, esd: EsdMap): string {
  const siteRows = structure.sites.map((s) => {
    const pe = esd.pos.get(s.label);
    const uIso = s.adp.kind === "isotropic" ? s.adp.bIso / EIGHT_PI2 : uEquiv(s.adp.uAniso);
    // esd(U_iso) = esd(B_iso) / 8π²; only isotropic sites carry a B esd.
    const bEsd = s.adp.kind === "isotropic" ? esd.bIso.get(s.label) : undefined;
    return [
      s.label,
      s.element,
      formatWithEsd(s.position[0], pe?.[0], 5),
      formatWithEsd(s.position[1], pe?.[1], 5),
      formatWithEsd(s.position[2], pe?.[2], 5),
      formatWithEsd(s.occupancy, esd.occ.get(s.label), 4),
      s.adp.kind === "isotropic" ? "Uiso" : "Uani",
      formatWithEsd(uIso, bEsd === undefined ? undefined : bEsd / EIGHT_PI2, 5),
    ];
  });
  const atomLoop = loop(
    [
      "_atom_site_label",
      "_atom_site_type_symbol",
      "_atom_site_fract_x",
      "_atom_site_fract_y",
      "_atom_site_fract_z",
      "_atom_site_occupancy",
      "_atom_site_adp_type",
      "_atom_site_U_iso_or_equiv",
    ],
    siteRows,
  );

  const aniso = structure.sites.filter((s) => s.adp.kind === "anisotropic");
  if (aniso.length === 0) return atomLoop;
  const anisoLoop = loop(
    [
      "_atom_site_aniso_label",
      "_atom_site_aniso_U_11",
      "_atom_site_aniso_U_22",
      "_atom_site_aniso_U_33",
      "_atom_site_aniso_U_12",
      "_atom_site_aniso_U_13",
      "_atom_site_aniso_U_23",
    ],
    aniso.map((s) => {
      const u = (s.adp as { uAniso: readonly number[] }).uAniso;
      return [s.label, ...u.map((v) => v.toFixed(5))];
    }),
  );
  return `${atomLoop}\n\n${anisoLoop}`;
}

function cellBlock(cell: UnitCell, esd: EsdMap): string {
  return [
    `_cell_length_a    ${formatWithEsd(cell.a, esd.cell.a, 5)}`,
    `_cell_length_b    ${formatWithEsd(cell.b, esd.cell.b, 5)}`,
    `_cell_length_c    ${formatWithEsd(cell.c, esd.cell.c, 5)}`,
    `_cell_angle_alpha ${formatWithEsd(cell.alpha, esd.cell.alpha, 4)}`,
    `_cell_angle_beta  ${formatWithEsd(cell.beta, esd.cell.beta, 4)}`,
    `_cell_angle_gamma ${formatWithEsd(cell.gamma, esd.cell.gamma, 4)}`,
    `_cell_volume      ${cellVolume(cell).toFixed(4)}`,
  ].join("\n");
}

function symmetryBlock(structure: StructureModel): string {
  const sg = structure.spaceGroup;
  const head: string[] = [];
  if (sg.hermannMauguin) head.push(`_symmetry_space_group_name_H-M  '${sg.hermannMauguin}'`);
  if (sg.number !== undefined) head.push(`_symmetry_Int_Tables_number    ${sg.number}`);
  const ops = sg.operations.length > 0 ? sg.operations : [{ xyz: "x,y,z" }];
  const symLoop = loop(["_space_group_symop_operation_xyz"], ops.map((o) => [`'${o.xyz}'`]));
  return [...head, symLoop].join("\n");
}

function refinementBlock(meta: CifRefinementMeta | undefined): string {
  if (!meta) return "";
  const lines: string[] = [];
  if (meta.nRef !== undefined) lines.push(`_refine_ls_number_reflns      ${meta.nRef}`);
  if (meta.nParam !== undefined) lines.push(`_refine_ls_number_parameters  ${meta.nParam}`);
  if (meta.rwp !== undefined) lines.push(`_refine_ls_wR_factor_obs      ${(meta.rwp / 100).toFixed(4)}`);
  if (meta.r1 !== undefined) lines.push(`_refine_ls_R_factor_gt        ${meta.r1.toFixed(4)}`);
  if (meta.wr2 !== undefined) lines.push(`_refine_ls_wR_factor_ref      ${meta.wr2.toFixed(4)}`);
  if (meta.gof !== undefined) lines.push(`_refine_ls_goodness_of_fit_all ${meta.gof.toFixed(3)}`);
  return lines.join("\n");
}

const HEADER = "# Generated by the Web Refinement Workbench";

/**
 * Serialize a refined `StructureModel` to CIF text. Pass `params` + `bindings`
 * from the refinement to attach standard uncertainties; pass `refinement` to
 * record agreement factors.
 */
export function structureToCif(structure: StructureModel, opts: CifExportOptions = {}): string {
  const esd = buildEsdMap(opts.params ?? [], opts.bindings ?? []);
  const block = sanitizeBlock(opts.blockName ?? structure.name);
  const parts = [
    HEADER,
    `data_${block}`,
    `_pd_phase_name  '${structure.name}'`,
    cellBlock(structure.cell, esd),
    symmetryBlock(structure),
    refinementBlock(opts.refinement),
    atomSiteBlocks(structure, esd),
  ].filter((s) => s.length > 0);
  return parts.join("\n\n") + "\n";
}

/** Inverse of the (â, b̂, ĉ) direction matrix: Cartesian μ_B → crystal-axis μ_B. */
function cartesianToCrystalComponents(cell: UnitCell, comps: Vec3): Vec3 {
  const cols = transpose(orthogonalizationMatrix(cell));
  const dirs: Mat3 = [normalize(cols[0]), normalize(cols[1]), normalize(cols[2])];
  // dirs rows are â,b̂,ĉ; the matrix mapping crystal→cartesian has these as columns.
  const m: Mat3 = transpose(dirs);
  const inv = inverse(m);
  return [
    inv[0][0] * comps[0] + inv[0][1] * comps[1] + inv[0][2] * comps[2],
    inv[1][0] * comps[0] + inv[1][1] * comps[1] + inv[1][2] * comps[2],
    inv[2][0] * comps[0] + inv[2][1] * comps[1] + inv[2][2] * comps[2],
  ];
}

/** Crystal-axis moment components (μ_B), converting from Cartesian if needed. */
function momentCrystalComponents(cell: UnitCell, m: MagneticMoment): Vec3 {
  return m.frame === "cartesian" ? cartesianToCrystalComponents(cell, m.components) : m.components;
}

function momentLoop(structure: StructureModel, magnetic: MagneticModel): string {
  const rows = magnetic.moments.map((m) => {
    const c = momentCrystalComponents(structure.cell, m);
    return [m.siteLabel, c[0].toFixed(4), c[1].toFixed(4), c[2].toFixed(4)];
  });
  return loop(
    [
      "_atom_site_moment.label",
      "_atom_site_moment.crystalaxis_x",
      "_atom_site_moment.crystalaxis_y",
      "_atom_site_moment.crystalaxis_z",
    ],
    rows,
  );
}

/** Magnetic (BNS) symmetry-operation loop, when the space group carries them. */
function magneticSymopBlock(structure: StructureModel, magnetic: MagneticModel, label: string | undefined): string {
  // The magnetic operations are the model's own subgroup ops when it carries
  // them (an in-app model built by buildMagneticModel refines in a subgroup of
  // the parent nuclear group — writing the parent ops would claim the wrong
  // symmetry); a loaded mCIF's structure ops ARE its magnetic ops, so the
  // fallback is equivalent there. An op with no explicit BNS flag is a unitary
  // (+1) magnetic op, not a non-op: filtering on `timeReversal !== undefined`
  // used to drop every unflagged op, so a magnetic model built on a
  // nuclear-CIF structure exported an empty loop that external tools read as
  // P1. Genuine −1 operations keep their sign; everything else defaults to +1.
  const ops = magnetic.operations ?? structure.spaceGroup.operations;
  const head: string[] = [];
  if (label) head.push(`_space_group_magn.name_bns  "${label}"`);
  if (structure.spaceGroup.hermannMauguin && !label) head.push(`_parent_space_group.name_H-M_alt  "${structure.spaceGroup.hermannMauguin}"`);
  if (ops.length === 0) return head.join("\n");
  const opLoop = loop(
    ["_space_group_symop_magn_operation.id", "_space_group_symop_magn_operation.xyz"],
    ops.map((o, i) => [`${i + 1}`, `"${o.xyz},${o.timeReversal === -1 ? "-1" : "+1"}"`]),
  );
  return [...head, opLoop].join("\n");
}

/**
 * Split-orbit moments (`orbitIndex` ≥ 2) anchor at an orbit-representative
 * position, not the asymmetric-unit site — written as-is, the moment loop would
 * repeat one site label with different implied positions and no reader could
 * resolve it. Emit each split orbit as its own atom-site row (label suffixed
 * `_oN`, at the orbit position) and point its moment row at that label — the
 * same convention GSAS-II uses for orbit-split magnetic sites (e.g. the
 * Mn1_0/Mn1_1 of the Mn₃Ga golden data).
 */
function withOrbitSites(
  structure: StructureModel,
  magnetic: MagneticModel,
): { structure: StructureModel; magnetic: MagneticModel } {
  const extra: AtomSite[] = [];
  const moments = magnetic.moments.map((m) => {
    if (!m.orbitIndex || m.orbitIndex <= 1 || !m.position) return m;
    const base = structure.sites.find((s) => s.label === m.siteLabel);
    if (!base) return m;
    const label = `${m.siteLabel}_o${m.orbitIndex}`;
    if (!extra.some((s) => s.label === label)) extra.push({ ...base, label, position: m.position });
    return { ...m, siteLabel: label };
  });
  if (extra.length === 0) return { structure, magnetic };
  return {
    structure: { ...structure, sites: [...structure.sites, ...extra] },
    magnetic: { ...magnetic, moments },
  };
}

const IDENTITY_MAT: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Format a value in [0,1) as a compact fraction ("0", "1/2", "1/3", …). */
function fraction(v: number): string {
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  for (let d = 2; d <= 12; d++) {
    const num = v * d;
    if (Math.abs(num - Math.round(num)) < 1e-4) return `${Math.round(num)}/${d}`;
  }
  return v.toFixed(4);
}

/** The child (magnetic-cell) basis transform for a diagonal supercell N, e.g.
 *  N = (1,1,2) → "a,b,2c". */
function childTransform(n: readonly [number, number, number]): string {
  return ["a", "b", "c"].map((ax, i) => (n[i] === 1 ? ax : `${n[i]}${ax}`)).join(",");
}

/**
 * BCS-style provenance for a magnetic supercell: the parent (nuclear) space
 * group, the propagation vector k as a `_parent_propagation_vector` loop, and
 * the parent→child (supercell) basis transform. This records what the enlarged
 * cell derives from, so the mCIF is not just an anonymous P1 supercell.
 */
function supercellProvenance(structure: StructureModel, k: Vec3, n: readonly [number, number, number]): string {
  const lines: string[] = [];
  if (structure.spaceGroup.hermannMauguin) {
    lines.push(`_parent_space_group.name_H-M_alt  "${structure.spaceGroup.hermannMauguin}"`);
  }
  if (structure.spaceGroup.number !== undefined) {
    lines.push(`_parent_space_group.IT_number     ${structure.spaceGroup.number}`);
  }
  lines.push(`_parent_space_group.child_transform_Pp_abc  '${childTransform(n)};0,0,0'`);
  const kLoop = loop(
    ["_parent_propagation_vector.id", "_parent_propagation_vector.kxkykz"],
    [["k1", `[${fraction(k[0])} ${fraction(k[1])} ${fraction(k[2])}]`]],
  );
  return [...lines, kLoop].join("\n");
}

/**
 * mCIF for a commensurate k ≠ 0 magnetic structure, written in its magnetic
 * supercell (the smallest cell in which k is a reciprocal-lattice point). The
 * atoms and moments are expanded explicitly and the moment field is static
 * (k = 0 in the supercell), so external readers (VESTA, Bilbao, GSAS-II) and the
 * app's 3D viewer render the identical structure — the enlarged cell and the
 * per-atom moment directions match what the user sees on screen. The magnetic
 * symmetry is written as P1 (all atoms explicit); the parent group + k are kept
 * as provenance. See {@link magneticStructureToMcif}.
 */
function mcifSupercell(
  structure: StructureModel,
  magnetic: MagneticModel,
  sup: NonNullable<ReturnType<typeof expandMagneticSupercell>>,
  k: Vec3,
  block: string,
  opts: CifExportOptions,
): string {
  const noEsd = buildEsdMap([], []); // esds are on the parent params — not the derived supercell
  const supStructure: StructureModel = {
    ...structure,
    cell: sup.cell,
    sites: sup.atoms.map((a) => a.site),
    spaceGroup: { number: 1, operations: [{ rotation: IDENTITY_MAT, translation: [0, 0, 0], xyz: "x,y,z" }] },
  };
  const identityMagn: SymmetryOperation = { rotation: IDENTITY_MAT, translation: [0, 0, 0], xyz: "x,y,z", timeReversal: 1 };
  const supMagnetic: MagneticModel = {
    ...magnetic,
    propagation: [[0, 0, 0]],
    operations: [identityMagn],
    moments: sup.atoms
      .filter((a) => a.moment)
      .map((a) => ({
        siteLabel: a.site.label,
        frame: "crystallographic" as const,
        components: a.moment!,
        ...(a.formFactorId ? { formFactorId: a.formFactorId } : {}),
      })),
  };
  const parts = [
    HEADER,
    `data_${block}`,
    `_pd_phase_name  '${structure.name}'`,
    supercellProvenance(structure, k, sup.n),
    cellBlock(sup.cell, noEsd),
    magneticSymopBlock(supStructure, supMagnetic, opts.magneticLabel),
    refinementBlock(opts.refinement),
    atomSiteBlocks(supStructure, noEsd),
    momentLoop(supStructure, supMagnetic),
  ].filter((s) => s.length > 0);
  return parts.join("\n\n") + "\n";
}

/**
 * Serialize a refined `StructureModel` + `MagneticModel` to mCIF text: the CIF
 * core plus the magnetic (BNS) symmetry operations and the `_atom_site_moment`
 * loop (crystallographic frame, μ_B).
 *
 * For a commensurate propagation vector k ≠ 0 the structure is written in its
 * magnetic supercell (e.g. 1×1×2 for k = (0,0,½)) with atoms and moments
 * expanded explicitly — so the exported cell and moment directions match the
 * app's 3D view instead of an unmodulated 1×1×1 parent cell. For k = 0 the
 * parent cell is written directly, with the propagation vector as a comment.
 */
export function magneticStructureToMcif(
  structure: StructureModel,
  magnetic: MagneticModel,
  opts: CifExportOptions = {},
): string {
  const esd = buildEsdMap(opts.params ?? [], opts.bindings ?? []);
  const block = sanitizeBlock(opts.blockName ?? structure.name);
  const k = magnetic.propagation[0] ?? [0, 0, 0];

  const sup = expandMagneticSupercell(structure, magnetic);
  if (sup) return mcifSupercell(structure, magnetic, sup, k, block, opts);

  const aug = withOrbitSites(structure, magnetic);
  const parts = [
    HEADER,
    `# propagation vector k = (${k[0]}, ${k[1]}, ${k[2]})`,
    `data_${block}`,
    `_pd_phase_name  '${structure.name}'`,
    cellBlock(structure.cell, esd),
    magneticSymopBlock(structure, magnetic, opts.magneticLabel),
    refinementBlock(opts.refinement),
    atomSiteBlocks(aug.structure, esd),
    momentLoop(structure, aug.magnetic),
  ].filter((s) => s.length > 0);
  return parts.join("\n\n") + "\n";
}
