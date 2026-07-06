/**
 * Magnetic refinement panel: moment arrows, an editable moment-parameter table,
 * a refine action, and a per-reflection table showing nuclear / magnetic /
 * total intensities kept separate.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { MagneticReflectionCalc } from "@/core/workflow/magnetic";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { ParameterTable } from "@/components/ParameterTable";
import { MomentArrows } from "@/visualization/MomentArrows";

interface Props {
  readonly structure: StructureModel;
  readonly magnetic: MagneticModel;
  readonly parameters: readonly RefinementParameter[];
  readonly bindings: Parameters<typeof applyMagneticMoments>[1];
  readonly rows: readonly MagneticReflectionCalc[];
  readonly result: RefinementResult | null;
  readonly busy: boolean;
  readonly onChange: (id: string, patch: Partial<RefinementParameter>) => void;
  readonly onRefine: () => void;
}

export function MagneticPanel(props: Props): JSX.Element {
  const { structure, magnetic, parameters, bindings, rows, result, busy, onChange, onRefine } = props;
  // Reflect current parameter values into the moments shown as arrows.
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const liveMagnetic = applyMagneticMoments(magnetic, bindings, values);

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
      <div style={{ minWidth: 300 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          Magnetic group <strong>{structure.spaceGroup.hermannMauguin ?? "(BNS)"}</strong> ·{" "}
          {structure.spaceGroup.operations.length} operations · k = (0 0 0)
        </div>
        <MomentArrows cell={structure.cell} moments={liveMagnetic.moments} />
        <table style={{ fontSize: 12, marginTop: 8 }}>
          <thead>
            <tr><th style={c}>Reflection</th><th style={c}>I(nuc)</th><th style={c}>I(mag)</th><th style={c}>I(tot)</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r, i) => (
              <tr key={i}>
                <td style={c}>{r.h} {r.k} {r.l}</td>
                <td style={c}>{r.iNuclear.toPrecision(3)}</td>
                <td style={c}>{r.iMagnetic.toPrecision(3)}</td>
                <td style={c}>{r.iTotal.toPrecision(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ minWidth: 320, flex: 1 }}>
        <ParameterTable parameters={parameters} esd={result?.esd} onChange={onChange} />
        <div style={{ marginTop: 10 }}>
          <button style={btnPrimary} disabled={busy} onClick={onRefine}>
            {busy ? "Refining…" : "Refine moments"}
          </button>
        </div>
        {result && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <strong>Result:</strong> {result.status} · R = {(100 * result.agreement.rFactor).toFixed(2)}%
            {result.agreement.rWeighted !== undefined && <> · wR = {(100 * result.agreement.rWeighted).toFixed(2)}%</>}
          </div>
        )}
      </div>
    </div>
  );
}

const c: React.CSSProperties = { padding: "2px 8px", textAlign: "left" };
const btn: React.CSSProperties = { border: "1px solid #bbb", background: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13 };
const btnPrimary: React.CSSProperties = { ...btn, background: "#8a1f1f", color: "#fff", borderColor: "#8a1f1f" };
