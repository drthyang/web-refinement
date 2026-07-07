/**
 * Editable refinement parameter table: value, fixed/free toggle, and
 * post-refinement esd. Rows are grouped by physical category (Scale, Lattice,
 * Background, Instrument/profile, ADPs, Positions, …) with a per-group header and
 * a "refine all / none" toggle. Presentation + local edit callbacks only.
 */

import type { ParameterKind, RefinementParameter } from "@/core/refinement/types";

interface Props {
  readonly parameters: readonly RefinementParameter[];
  readonly esd?: Readonly<Record<string, number>> | undefined;
  readonly onChange: (id: string, patch: Partial<RefinementParameter>) => void;
}

/** Physical category each parameter kind belongs to, for grouping. */
const CATEGORY: Record<ParameterKind, string> = {
  scale: "Scale",
  background: "Background",
  cellLength: "Lattice",
  cellAngle: "Lattice",
  peakWidth: "Instrument / profile",
  profileU: "Instrument / profile",
  profileV: "Instrument / profile",
  profileW: "Instrument / profile",
  profileX: "Instrument / profile",
  profileY: "Instrument / profile",
  zeroShift: "Instrument / profile",
  bIso: "ADPs (thermal)",
  uAniso: "ADPs (thermal)",
  atomX: "Positions",
  atomY: "Positions",
  atomZ: "Positions",
  positionShift: "Positions",
  occupancy: "Occupancy",
  poRatio: "Corrections",
  absorption: "Corrections",
  magneticScale: "Magnetic",
  momentX: "Magnetic",
  momentY: "Magnetic",
  momentZ: "Magnetic",
};

/** Fixed display order; only non-empty groups render, in this order. */
const ORDER = [
  "Scale", "Background", "Lattice", "Instrument / profile",
  "ADPs (thermal)", "Positions", "Occupancy", "Corrections", "Magnetic",
];

export function ParameterTable({ parameters, esd, onChange }: Props): JSX.Element {
  const groups = new Map<string, RefinementParameter[]>();
  for (const p of parameters) {
    const cat = CATEGORY[p.kind] ?? "Other";
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(p);
  }
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  });

  return (
    <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
          <th style={cell}>Parameter</th>
          <th style={cell}>Value</th>
          <th style={cell}>esd</th>
          <th style={cell}>Refine</th>
        </tr>
      </thead>
      <tbody>
        {cats.map((cat) => {
          const rows = groups.get(cat)!;
          const allFree = rows.every((p) => !p.fixed);
          return (
            <GroupBody key={cat} cat={cat} rows={rows} allFree={allFree} esd={esd} onChange={onChange} />
          );
        })}
      </tbody>
    </table>
  );
}

function GroupBody({
  cat, rows, allFree, esd, onChange,
}: {
  cat: string;
  rows: RefinementParameter[];
  allFree: boolean;
  esd: Props["esd"];
  onChange: Props["onChange"];
}): JSX.Element {
  return (
    <>
      <tr style={{ background: "#eef2f7" }}>
        <td style={{ ...cell, fontWeight: 600, color: "#1f4e79" }} colSpan={3}>
          {cat} <span style={{ color: "#888", fontWeight: 400 }}>({rows.length})</span>
        </td>
        <td style={cell}>
          <label style={{ fontSize: 11, color: "#555", display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={allFree}
              onChange={(e) => rows.forEach((p) => onChange(p.id, { fixed: !e.target.checked }))}
            />
            all
          </label>
        </td>
      </tr>
      {rows.map((p) => (
        <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
          <td style={{ ...cell, paddingLeft: 16 }}>{p.label}</td>
          <td style={cell}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number"
                value={p.value}
                min={p.min}
                max={p.max}
                step="any"
                style={{ width: 100 }}
                title={boundLabel(p)}
                onChange={(e) => onChange(p.id, { value: Number(e.target.value) })}
              />
              {boundLabel(p) !== undefined && (
                <span style={{ fontSize: 11, color: "#9a3412", whiteSpace: "nowrap" }}>{boundLabel(p)}</span>
              )}
            </div>
          </td>
          <td style={cell}>{esd && esd[p.id] !== undefined ? esd[p.id]!.toPrecision(3) : "—"}</td>
          <td style={cell}>
            <input
              type="checkbox"
              checked={!p.fixed}
              onChange={(e) => onChange(p.id, { fixed: !e.target.checked })}
            />
          </td>
        </tr>
      ))}
    </>
  );
}

function boundLabel(p: RefinementParameter): string | undefined {
  const tol = Math.max(1e-10, Math.abs(p.value) * 1e-10);
  if (p.max !== undefined && p.value >= p.max - tol) return "at max";
  if (p.min !== undefined && p.value <= p.min + tol) return "at min";
  return undefined;
}

const cell: React.CSSProperties = { padding: "4px 8px" };
