/**
 * Self-contained HTML report of a magnetic structure: a basal-plane figure
 * (SVG, viewed down c*) with the moment arrows the 3D viewer shows, plus the
 * refined parameters, sublattices, and cell tables. A pure string producer in
 * the exporters.ts convention — file saving is a UI concern.
 *
 * The figure reuses the viewer's own expansion (`buildCellAtoms` /
 * `displayMoment`, pure geometry despite living under app/ui), so the report
 * shows exactly the structure the app renders: magnetic-subgroup expansion
 * with θ-signed axial transforms and the commensurate k-phase over the
 * magnetic supercell. Projection is onto the Cartesian x–y plane — the a–b
 * plane, viewed down c* (a ∥ x, b in x–y by the orthogonalization
 * convention). In-plane moment components are drawn as arrows; a moment with
 * a significant out-of-plane part gets a ⊙ / ⊗ marker (toward / away from
 * the viewer).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { Vec3 } from "@/core/math/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { kLabel } from "@/core/magnetic/kSearch";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import {
  buildCellAtoms,
  displayMoment,
  magneticSupercell,
  momentEntriesFrom,
  type CellAtom,
} from "@/core/crystal/cellExpansion";

export interface MagneticReportGroup {
  /** Display symbol, e.g. "Cm′cm′" or "isotropy subgroup of Γ2 ⊕ Γ3". */
  readonly symbol: string;
  /** e.g. "BNS 63.462 · OG 63.9.520". */
  readonly numbers?: string;
  /** Setting transformation note when identified off-standard. */
  readonly setting?: string;
  /** Index of the group in the grey group, when known. */
  readonly index?: number;
}

export interface MagneticReportInput {
  readonly structure: StructureModel;
  readonly magnetic: MagneticModel;
  /** Moment-parameter values to apply (e.g. the panel's edited amplitudes). */
  readonly values: Readonly<Record<string, number>>;
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly k: Vec3;
  readonly group: MagneticReportGroup;
  /** Optional agreement note, e.g. "wR = 4.2% (moments-only fit)". */
  readonly note?: string;
  /** Report date; injectable so tests are deterministic. */
  readonly date?: Date;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const f = (v: number, d = 2): string => (Object.is(v, -0) ? 0 : v).toFixed(d);

/** Arrow / atom colour cycles (sublattices; elements), light-theme values. */
const SUB_COLORS = ["#cf3b52", "#4b5fc4", "#0e8074", "#b06f1f", "#8a4bc4", "#3f7fb2"];
const EL_COLORS = ["#9d7bc9", "#c9938c", "#7ba3c9", "#8fbc8f", "#c9b07b", "#b98fb9"];

interface Projected {
  readonly atom: CellAtom;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Cartesian moment (µ_B) or null. */
  readonly m: Vec3 | null;
}

function buildFigure(
  structure: StructureModel,
  magnetic: MagneticModel,
  k: Vec3,
): { svg: string; subKeys: string[]; elements: string[] } {
  const entries = momentEntriesFrom(magnetic);
  const supercell = magneticSupercell(k);
  const atoms = buildCellAtoms(structure, supercell, magnetic.operations, entries);
  const momByKey = new Map(entries.map((e) => [e.key, e.components]));
  const subKeys = entries.map((e) => e.key);
  const elements = [...new Set(structure.sites.map((s) => s.element))];

  const pts: Projected[] = atoms.map((atom) => {
    const comps = atom.mag ? momByKey.get(atom.mag.momentKey) : undefined;
    const mc = comps ? displayMoment(atom, comps, k) : null;
    return {
      atom,
      x: atom.xyz[0]!,
      y: atom.xyz[1]!,
      z: atom.xyz[2]!,
      m: mc ? crystalComponentsToCartesian(structure.cell, mc) : null,
    };
  });

  // Viewport: the projected supercell corners plus a margin.
  const corners: Vec3[] = [];
  for (const i of [0, supercell[0]]) for (const j of [0, supercell[1]]) for (const l of [0, supercell[2]]) {
    corners.push(fractionalToCartesian(structure.cell, [i, j, l]));
  }
  const M = 1.9;
  const xmin = Math.min(...corners.map((c) => c[0]!), ...pts.map((p) => p.x)) - M;
  const xmax = Math.max(...corners.map((c) => c[0]!), ...pts.map((p) => p.x)) + M;
  const ymin = Math.min(...corners.map((c) => c[1]!), ...pts.map((p) => p.y)) - M;
  const ymax = Math.max(...corners.map((c) => c[1]!), ...pts.map((p) => p.y)) + M;
  const S = Math.min(62, 760 / (xmax - xmin)); // px per Å, capped for huge cells
  const W = (xmax - xmin) * S;
  const H = (ymax - ymin) * S;
  const px = (x: number): number => (x - xmin) * S;
  const py = (y: number): number => H - (y - ymin) * S; // +y up

  let s = "";
  const line = (a: Vec3, b: Vec3, cls: string, w: number, dash = ""): void => {
    s += `<line x1="${px(a[0]!).toFixed(1)}" y1="${py(a[1]!).toFixed(1)}" x2="${px(b[0]!).toFixed(1)}" y2="${py(b[1]!).toFixed(1)}" class="${cls}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
  };

  // Cell wireframe, projected: the 12 supercell edges (c-direction edges thin —
  // they foreshorten under the down-c* view).
  const corner = (i: number, j: number, l: number): Vec3 =>
    fractionalToCartesian(structure.cell, [i * supercell[0], j * supercell[1], l * supercell[2]]);
  for (const l of [0, 1]) {
    line(corner(0, 0, l), corner(1, 0, l), "cell", l === 0 ? 1.6 : 1);
    line(corner(0, 0, l), corner(0, 1, l), "cell", l === 0 ? 1.6 : 1);
    line(corner(1, 0, l), corner(1, 1, l), "cell", l === 0 ? 1.6 : 1);
    line(corner(0, 1, l), corner(1, 1, l), "cell", l === 0 ? 1.6 : 1);
  }
  for (const i of [0, 1]) for (const j of [0, 1]) line(corner(i, j, 0), corner(i, j, 1), "cell", 0.8);

  // Exchange-network guide lines: magnetic atoms within 1.2× their minimum
  // pair distance (capped at 3.5 Å), same depth layer only.
  const magAtoms = pts.filter((p) => p.m);
  const zmid = (Math.min(...pts.map((p) => p.z)) + Math.max(...pts.map((p) => p.z))) / 2;
  let dmin = Infinity;
  for (let i = 0; i < magAtoms.length; i++) {
    for (let j = i + 1; j < magAtoms.length; j++) {
      const d = Math.hypot(magAtoms[i]!.x - magAtoms[j]!.x, magAtoms[i]!.y - magAtoms[j]!.y, magAtoms[i]!.z - magAtoms[j]!.z);
      if (d > 0.5 && d < dmin) dmin = d;
    }
  }
  const cutoff = Math.min(dmin * 1.2, 3.5);
  for (let i = 0; i < magAtoms.length; i++) {
    for (let j = i + 1; j < magAtoms.length; j++) {
      const a = magAtoms[i]!;
      const b = magAtoms[j]!;
      if ((a.z < zmid) !== (b.z < zmid)) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d > 0.5 && d < cutoff) line([a.x, a.y, 0], [b.x, b.y, 0], "bond", a.z < zmid ? 1.1 : 0.8);
    }
  }

  // Atoms: filled below the depth midplane, outlined above.
  const elColor = (el: string): string => EL_COLORS[Math.max(0, elements.indexOf(el)) % EL_COLORS.length]!;
  const drawAtoms = (filter: (p: Projected) => boolean): void => {
    for (const p of pts.filter(filter)) {
      const lo = p.z < zmid;
      const c = elColor(p.atom.element);
      const r = (p.m ? 9 : 8) * (lo ? 1 : 0.9);
      s += lo
        ? `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="${r.toFixed(1)}" fill="${c}"/>`
        : `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="${r.toFixed(1)}" fill="var(--panel)" stroke="${c}" stroke-width="1.8"/>`;
    }
  };
  drawAtoms((p) => !p.m);
  drawAtoms((p) => !!p.m);

  // Moment arrows (in-plane component), centred on the atom; out-of-plane
  // component as a ⊙ / ⊗ marker beside it.
  const AS = 13.5; // px per µ_B
  for (const p of pts) {
    if (!p.m) continue;
    const key = p.atom.mag!.momentKey;
    const color = SUB_COLORS[Math.max(0, subKeys.indexOf(key)) % SUB_COLORS.length]!;
    const [mx, my, mz] = p.m;
    const mag = Math.hypot(mx!, my!, mz!);
    const inPlane = Math.hypot(mx!, my!);
    const cx = px(p.x);
    const cy = py(p.y);
    if (mag < 1e-6) continue;
    if (inPlane > 0.05 * mag) {
      const len = inPlane * AS;
      const ux = mx! / inPlane;
      const uy = my! / inPlane;
      const x1 = cx - (ux * len) / 2;
      const y1 = cy + (uy * len) / 2;
      const x2 = cx + (ux * len) / 2;
      const y2 = cy - (uy * len) / 2;
      const hw = 4.6;
      const hl = 8.5;
      const bx = x2 - ux * hl;
      const by = y2 + uy * hl;
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${color}" stroke-width="2.6"/>`;
      s += `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${(bx - uy * hw).toFixed(1)},${(by - ux * hw).toFixed(1)} ${(bx + uy * hw).toFixed(1)},${(by + ux * hw).toFixed(1)}" fill="${color}"/>`;
    }
    if (Math.abs(mz!) > 0.1 * mag) {
      // ⊙ (out of the page) / ⊗ (into the page), offset to the atom's side.
      const gx = cx + 12;
      const gy = cy - 12;
      s += `<circle cx="${gx}" cy="${gy}" r="5" fill="none" stroke="${color}" stroke-width="1.6"/>`;
      s += mz! > 0
        ? `<circle cx="${gx}" cy="${gy}" r="1.7" fill="${color}"/>`
        : `<path d="M ${gx - 3.2} ${gy - 3.2} l 6.4 6.4 m 0 -6.4 l -6.4 6.4" stroke="${color}" stroke-width="1.4"/>`;
    }
  }

  // a / b axes glyph, bottom-right corner.
  {
    const av = fractionalToCartesian(structure.cell, [1, 0, 0]);
    const bv = fractionalToCartesian(structure.cell, [0, 1, 0]);
    const ox = xmax - 2.6;
    const oy = ymin + 0.9;
    for (const [v, name] of [[av, "a"], [bv, "b"]] as const) {
      const n = Math.hypot(v[0]!, v[1]!);
      if (n < 1e-6) continue;
      const u = [v[0]! / n, v[1]! / n];
      const x2 = ox + u[0]! * 1.3;
      const y2 = oy + u[1]! * 1.3;
      line([ox, oy, 0], [x2, y2, 0], "axis", 1.6);
      s += `<circle cx="${px(x2).toFixed(1)}" cy="${py(y2).toFixed(1)}" r="2.1" class="axisdot"/>`;
      s += `<text x="${(px(x2) + u[0]! * 10 - 3).toFixed(1)}" y="${(py(y2) - u[1]! * 12 + 4).toFixed(1)}" class="lbl">${name}</text>`;
    }
  }

  return {
    svg: `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Projection of the magnetic structure down c-star with moment arrows">${s}</svg>`,
    subKeys,
    elements,
  };
}

const KIND_UNIT: Partial<Record<RefinementParameter["kind"], string>> = {
  momentMode: "µ<sub>B</sub>",
  momentX: "µ<sub>B</sub>",
  momentY: "µ<sub>B</sub>",
  momentZ: "µ<sub>B</sub>",
};

/** Build the standalone HTML report (a complete document, ready to save). */
export function magneticReportHtml(input: MagneticReportInput): string {
  const { structure, k, group, params, bindings, values } = input;
  const magnetic = applyMagneticMoments(input.magnetic, bindings, values);
  const { svg, subKeys } = buildFigure(structure, magnetic, k);
  const date = (input.date ?? new Date()).toISOString().slice(0, 10);
  const cell = structure.cell;
  const supercell = magneticSupercell(k);
  const isSuper = supercell.some((n) => n > 1);

  const paramRows = params
    .map((p) => {
      const v = values[p.id] ?? p.value;
      return `<tr><td>${esc(p.label)}</td><td class="num">${f(v)} ${KIND_UNIT[p.kind] ?? ""}</td><td>${p.fixed ? "fixed" : "refined"}</td></tr>`;
    })
    .join("");

  const momentRows = magnetic.moments
    .map((m) => {
      const site = structure.sites.find((s) => s.label === m.siteLabel);
      const pos = m.position ?? site?.position ?? [0, 0, 0];
      const cart = crystalComponentsToCartesian(cell, m.components);
      const mag = Math.hypot(cart[0]!, cart[1]!, cart[2]!);
      const key = m.orbitIndex && m.orbitIndex > 1 ? `${m.siteLabel}#${m.orbitIndex}` : m.siteLabel;
      const color = SUB_COLORS[Math.max(0, subKeys.indexOf(key)) % SUB_COLORS.length]!;
      const orbit = m.orbitIndex && m.orbitIndex > 1 ? `orbit ${m.orbitIndex}` : "orbit 1";
      return `<tr><td><span class="sw" style="background:${color}"></span>${esc(m.siteLabel)} · ${orbit}</td>` +
        `<td class="num">(${f(pos[0]!, 4)}, ${f(pos[1]!, 4)}, ${f(pos[2]!, 4)})</td>` +
        `<td class="num">(${f(m.components[0]!)}, ${f(m.components[1]!)}, ${f(m.components[2]!)})</td>` +
        `<td class="num">${f(mag)}</td></tr>`;
    })
    .join("");

  const groupBits = [
    group.numbers ? `<span class="soft">${esc(group.numbers)}</span>` : "",
    group.setting ? `<span class="soft">setting ${esc(group.setting)}</span>` : "",
    group.index !== undefined ? `<span class="soft">index ${group.index}</span>` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(structure.name || structure.id)} · ${esc(group.symbol)} magnetic structure</title>
<style>
  :root {
    --bg: #f7f8fa; --panel: #ffffff; --ink: #22272e; --soft: #5b6470;
    --hair: #d9dde3; --cellc: #8b93a0; --bondc: #b9a7d6;
    --mono: "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151a21; --panel: #1c222b; --ink: #e6e9ed; --soft: #9aa4b0; --hair: #313945; --cellc: #6d7683; --bondc: #55496e; }
  }
  body { background: var(--bg); color: var(--ink); margin: 0; padding: 28px 24px 48px;
         font: 14px/1.55 Seravek, "Avenir Next", "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  .eyebrow { font-family: var(--mono); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--soft); margin: 0 0 6px; }
  h1 { font-size: 23px; font-weight: 650; margin: 0 0 6px; }
  .sub { color: var(--soft); margin: 0 0 18px; max-width: 74ch; }
  .sub code, .prov code { font-family: var(--mono); font-size: .93em; color: var(--ink); }
  .soft { color: var(--soft); }
  .split { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 18px; align-items: start; }
  @media (max-width: 880px) { .split { grid-template-columns: 1fr; } }
  .fig, .card { background: var(--panel); border: 1px solid var(--hair); border-radius: 10px; }
  .fig { padding: 10px 10px 4px; overflow-x: auto; }
  .fig svg { display: block; width: 100%; height: auto; }
  .cap { font-size: 12.5px; color: var(--soft); padding: 8px 8px 10px; border-top: 1px solid var(--hair); margin-top: 6px; }
  .rail { display: grid; gap: 14px; }
  .card { padding: 14px 16px; }
  .card h2 { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; font-weight: 650; color: var(--soft); margin: 0 0 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td, th { padding: 5px 8px 5px 0; text-align: left; vertical-align: top; border-top: 1px solid var(--hair); }
  tr:first-child > td, tr:first-child > th { border-top: none; }
  th { color: var(--soft); font-weight: 600; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .prov { font-size: 12px; color: var(--soft); margin: 18px 0 0; max-width: 90ch; }
  .cell { stroke: var(--cellc); fill: none; }
  .bond { stroke: var(--bondc); opacity: .55; }
  .axis { stroke: var(--soft); }
  .axisdot { fill: var(--soft); }
  .lbl { font-family: var(--mono); font-size: 11px; fill: var(--soft);
         paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; }
  .moments-table { overflow-x: auto; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">Magnetic structure report · ${esc(date)}</p>
    <h1>${esc(structure.name || structure.id)} — ${esc(group.symbol)}</h1>
    <p class="sub">
      Parent ${esc(structure.spaceGroup.hermannMauguin ?? "—")} · k = ${esc(kLabel(k))}${groupBits ? " · " + groupBits : ""}${input.note ? ` · ${esc(input.note)}` : ""}
    </p>
  </header>

  <div class="split">
    <figure class="fig" style="margin:0">
      ${svg}
      <figcaption class="cap">
        ${isSuper ? `Magnetic supercell ${supercell.join(" × ")} of the nuclear cell, projected` : "One unit cell, projected"}
        down c* (a–b plane). Arrows: in-plane moment component, length ∝ |m|;
        ⊙ / ⊗ marks a moment component out of / into the page. Filled atoms lie in the
        lower half of the cell (depth), outlined in the upper half. Thin lines connect
        nearest-neighbour magnetic atoms.
      </figcaption>
    </figure>

    <div class="rail">
      <div class="card">
        <h2>Moment parameters</h2>
        <table>${paramRows}</table>
      </div>
      <div class="card">
        <h2>Cell</h2>
        <table>
          <tr><td>a, b, c</td><td class="num">${f(cell.a, 4)}, ${f(cell.b, 4)}, ${f(cell.c, 4)} Å</td></tr>
          <tr><td>α, β, γ</td><td class="num">${f(cell.alpha, 2)}°, ${f(cell.beta, 2)}°, ${f(cell.gamma, 2)}°</td></tr>
        </table>
      </div>
    </div>
  </div>

  <div class="card moments-table" style="margin-top:18px">
    <h2>Magnetic sublattices</h2>
    <table>
      <tr><th>Site · orbit</th><th>Position (frac)</th><th>m (crystal axes, µ<sub>B</sub>)</th><th>|m| (µ<sub>B</sub>)</th></tr>
      ${momentRows}
    </table>
  </div>

  <p class="prov">
    Generated by the refinement workbench: magnetic subgroup expansion over the
    ${esc(group.symbol)} operations (θ-signed axial transforms, k-phase over the magnetic
    supercell) — the same model that drives the 3D preview and the powder/single-crystal
    magnetic intensities. Moment components are crystal-axis µ<sub>B</sub>; |m| via the cell metric.
  </p>
</div>
</body>
</html>
`;
}
