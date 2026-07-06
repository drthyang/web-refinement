/**
 * Editable refinement parameter table: value, fixed/free toggle, bounds, and
 * post-refinement esd. Presentation + local edit callbacks only.
 */

import type { RefinementParameter } from "@/core/refinement/types";

interface Props {
  readonly parameters: readonly RefinementParameter[];
  readonly esd?: Readonly<Record<string, number>> | undefined;
  readonly onChange: (id: string, patch: Partial<RefinementParameter>) => void;
}

export function ParameterTable({ parameters, esd, onChange }: Props): JSX.Element {
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
        {parameters.map((p) => (
          <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
            <td style={cell}>{p.label}</td>
            <td style={cell}>
              <input
                type="number"
                value={p.value}
                step="any"
                style={{ width: 100 }}
                onChange={(e) => onChange(p.id, { value: Number(e.target.value) })}
              />
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
      </tbody>
    </table>
  );
}

const cell: React.CSSProperties = { padding: "4px 8px" };
