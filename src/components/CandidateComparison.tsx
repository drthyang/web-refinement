/**
 * Magnetic space-group candidate generation and comparison (procedure steps 5
 * & 7): from the parent group + k = 0, generate candidate magnetic groups, show
 * the symmetry-allowed moment directions per site, and (on demand) refine every
 * candidate against the data and rank by weighted R.
 */

import { useMemo, useState } from "react";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import { generateMagneticCandidates } from "@/core/magnetic/magneticGroups";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { compareMagneticCandidates, type CandidateFit } from "@/core/workflow/magneticCompare";

interface Props {
  readonly structure: StructureModel;
  readonly dataset: SingleCrystalDataset;
  readonly magneticSiteLabels: readonly string[];
  /** "generate" shows only candidate enumeration (step 5); "compare" adds the
   * refine-and-rank tool (step 7). Defaults to "compare". */
  readonly mode?: "generate" | "compare";
}

export function CandidateComparison({ structure, dataset, magneticSiteLabels, mode = "compare" }: Props): JSX.Element {
  const candidates = useMemo(() => {
    const parent = structure.spaceGroup.operations.map((o) => ({ ...o, timeReversal: 1 as const }));
    return generateMagneticCandidates(parent);
  }, [structure]);

  const [useRestraint, setUseRestraint] = useState(true);
  const [target, setTarget] = useState(2.6);
  const [fits, setFits] = useState<CandidateFit[] | null>(null);
  const [running, setRunning] = useState(false);

  function runComparison(): void {
    setRunning(true);
    // Let the button repaint before the synchronous refinement loop.
    setTimeout(() => {
      const result = compareMagneticCandidates(structure, candidates, dataset, {
        magneticSiteLabels,
        maxIterations: 40,
        ...(useRestraint ? { momentRestraint: { target, weight: 5 } } : {}),
      });
      setFits(result);
      setRunning(false);
    }, 10);
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: "#444" }}>
        From the parent group <strong>{structure.spaceGroup.hermannMauguin ?? "(parsed ops)"}</strong>{" "}
        with k = (0 0 0), {candidates.length} candidate magnetic space groups are allowed (type I +
        one per index-2 subgroup). BNS/OG symbols and numbers come from the bundled ISO-MAG standard
        table; candidates without one are in a non-standard setting.
      </p>

      <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%", marginBottom: 12 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
            <th style={c}>Candidate</th>
            <th style={c}>Allowed moment (per site, dim)</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((cand) => (
            <tr key={cand.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={c}>
                <strong>{cand.label}</strong>
                {cand.standard && (
                  <span style={{ color: "#777" }}>
                    {" "}· {cand.isTypeI ? "type I" : "type III"} · BNS {cand.standard.bnsNumber} · OG{" "}
                    {cand.standard.ogNumber}
                  </span>
                )}
              </td>
              <td style={c}>
                {magneticSiteLabels.map((label) => {
                  const site = structure.sites.find((s) => s.label === label);
                  const dim = site ? allowedMomentDirections(cand.operations, site.position).dimension : 0;
                  return `${label}: ${dim}D`;
                }).join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {mode === "compare" && (
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={useRestraint} onChange={(e) => setUseRestraint(e.target.checked)} />{" "}
          moment-size restraint
        </label>
        {useRestraint && (
          <label style={{ fontSize: 13 }}>
            target |M| (μB){" "}
            <input type="number" value={target} step="0.1" style={{ width: 70 }} onChange={(e) => setTarget(Number(e.target.value))} />
          </label>
        )}
        <button style={btnPrimary} disabled={running} onClick={runComparison}>
          {running ? "Refining candidates…" : "Compare candidates"}
        </button>
      </div>
      )}

      {mode === "compare" && fits && (
        <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
              <th style={c}>Rank</th><th style={c}>Candidate</th><th style={c}>moment dof</th>
              <th style={c}>wR %</th><th style={c}>GoF</th><th style={c}>|M| per site (μB)</th>
            </tr>
          </thead>
          <tbody>
            {fits.map((f, i) => (
              <tr key={f.candidate.id} style={{ background: i === 0 ? "#eaf4ea" : undefined, borderBottom: "1px solid #eee" }}>
                <td style={c}>{i === 0 ? "★ 1" : i + 1}</td>
                <td style={c}>
                  {f.candidate.label}
                  {f.candidate.standard && (
                    <span style={{ color: "#777" }}> · BNS {f.candidate.standard.bnsNumber}</span>
                  )}
                </td>
                <td style={c}>{f.momentDof}</td>
                <td style={c}>{f.wR.toFixed(2)}</td>
                <td style={c}>{f.goodnessOfFit.toFixed(2)}</td>
                <td style={c}>{f.siteMoments.map((s) => `${s.label} ${s.magnitude.toFixed(2)}`).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mode === "compare" && fits && fits[0] && (
        <p style={{ fontSize: 13, marginTop: 8 }}>
          Best fit: <strong>{fits[0].candidate.label}</strong>
          {fits[0].candidate.standard && <> (BNS {fits[0].candidate.standard.bnsNumber})</>}{" "}
          (wR = {fits[0].wR.toFixed(2)}%). Lower wR ⇒ better agreement with the observed magnetic
          intensities.
        </p>
      )}
    </div>
  );
}

const c: React.CSSProperties = { padding: "3px 8px" };
const btn: React.CSSProperties = { border: "1px solid #bbb", background: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13 };
const btnPrimary: React.CSSProperties = { ...btn, background: "#8a1f1f", color: "#fff", border: "1px solid #8a1f1f" };
