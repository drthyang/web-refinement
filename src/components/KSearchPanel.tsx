/**
 * Magnetic propagation-vector (k) search + little-group magnetic subgroups, for
 * the commensurate single-k first pass. Self-contained over the loaded nuclear
 * structure:
 *   1. select the magnetic ion(s),
 *   2. enter a k-vector by hand OR search it from observed magnetic-peak
 *      d-spacings (FullProf-style position scoring), and
 *   3. read the allowed magnetic subgroups of the little group of k.
 *
 * The heavy lifting is in the pure core (kSearch, magneticGroups, magneticIons);
 * this is presentation only.
 */

import { useMemo, useState } from "react";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { searchPropagationVector, kLabel, type KCandidate } from "@/core/magnetic/kSearch";
import { generateMagneticCandidatesForK, littleGroup } from "@/core/magnetic/magneticGroups";
import { color as theme, mono as themeMono, uppercaseLabel as themeLabel } from "@/app/theme";

function parsePeaks(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => Number(t))
    .filter((v) => Number.isFinite(v) && v > 0);
}

export function KSearchPanel({ structure }: { structure: StructureModel }): JSX.Element {
  const ions = useMemo(() => magneticIonCandidates(structure), [structure]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ions.map((i) => i.siteLabel)));
  const [kText, setKText] = useState<[string, string, string]>(["0", "0", "0"]);
  const [peaksText, setPeaksText] = useState("");
  const [results, setResults] = useState<KCandidate[] | null>(null);

  const k: Vec3 = [Number(kText[0]) || 0, Number(kText[1]) || 0, Number(kText[2]) || 0];

  const { subgroups, lgSize } = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0) return { subgroups: [], lgSize: 0 };
    return { subgroups: generateMagneticCandidatesForK(ops, k), lgSize: littleGroup(ops, k).length };
  }, [structure, k[0], k[1], k[2]]);

  function runSearch(): void {
    const peaks = parsePeaks(peaksText);
    setResults(searchPropagationVector(structure.cell, peaks, { tolerance: 0.02 }));
  }

  function toggleIon(label: string): void {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }

  const setK = (kk: Vec3): void => setKText([String(kk[0]), String(kk[1]), String(kk[2])]);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {/* 1. Magnetic ions */}
      <section>
        <div style={themeLabel}>Magnetic ions</div>
        {ions.length === 0 ? (
          <p style={help}>No magnetic ions in this structure (no site has a tabulated ⟨j0⟩ form factor).</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
            {ions.map((ion) => (
              <label key={ion.siteLabel} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={selected.has(ion.siteLabel)} onChange={() => toggleIon(ion.siteLabel)} />
                {ion.siteLabel} <span style={{ color: theme.secondary, fontFamily: themeMono }}>({ion.ionId})</span>
              </label>
            ))}
          </div>
        )}
      </section>

      {/* 2. k-vector: manual + search */}
      <section>
        <div style={themeLabel}>Propagation vector k</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          {[0, 1, 2].map((i) => (
            <input
              key={i}
              value={kText[i]}
              onChange={(e) => setKText((t) => { const n = [...t] as [string, string, string]; n[i] = e.target.value; return n; })}
              style={kInput}
              aria-label={`k${["x", "y", "z"][i]}`}
            />
          ))}
          <span style={{ fontSize: 13, color: theme.secondary, fontFamily: themeMono }}>= {kLabel(k)}</span>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={help}>Search from observed magnetic-peak d-spacings (Å), one per line or comma-separated:</div>
          <textarea
            value={peaksText}
            onChange={(e) => setPeaksText(e.target.value)}
            placeholder={"e.g.\n6.214\n3.842\n3.107"}
            rows={3}
            style={textarea}
          />
          <button style={btn} onClick={runSearch}>Search k</button>
        </div>
        {results && (
          <div style={{ marginTop: 10 }}>
            {results.length === 0 ? (
              <p style={help}>Enter at least one magnetic-peak d-spacing to search.</p>
            ) : (
              <table style={{ fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ color: theme.secondary, textAlign: "left" }}>
                    <th style={th}>k</th><th style={th}>matched</th><th style={th}>RMSD (Å)</th><th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {results.slice(0, 8).map((c) => (
                    <tr key={c.label} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, fontFamily: themeMono }}>{c.label}</td>
                      <td style={td}>{c.matched}/{c.total}</td>
                      <td style={td}>{Number.isFinite(c.rmsd) ? c.rmsd.toFixed(4) : "—"}</td>
                      <td style={td}><button style={smallBtn} onClick={() => setK(c.k)}>use</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* 3. Little-group magnetic subgroups */}
      <section>
        <div style={themeLabel}>Magnetic subgroups of the little group G(k)</div>
        <p style={help}>
          Little group G(k): {lgSize} of {structure.spaceGroup.operations.length} operations leave k invariant.
          Time-reversal (θ: G→±1) enumeration gives {subgroups.length} candidate{subgroups.length === 1 ? "" : "s"}.
        </p>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
          {subgroups.map((c) => (
            <li key={c.id} style={{ marginBottom: 2 }}>
              <span style={{ fontFamily: themeMono }}>{c.isTypeI ? "type I" : "type III"}</span> · {c.label}
            </li>
          ))}
        </ul>
        <p style={{ ...help, marginTop: 8 }}>
          Note: little-group magnetic subgroups only — no BNS/OG labels, star-of-k arms, or
          representation (irrep) analysis yet. Confirm a candidate with a magnetic refinement.
        </p>
      </section>
    </div>
  );
}

const help: React.CSSProperties = { fontSize: 12, color: theme.secondary, margin: "4px 0 0", maxWidth: 560 };
const kInput: React.CSSProperties = { width: 64, border: `1px solid ${theme.control}`, borderRadius: 7, padding: "3px 7px", fontSize: 13, fontFamily: themeMono };
const textarea: React.CSSProperties = { display: "block", width: "100%", maxWidth: 420, marginTop: 4, border: `1px solid ${theme.control}`, borderRadius: 7, padding: "6px 8px", fontSize: 13, fontFamily: themeMono, resize: "vertical" };
const btn: React.CSSProperties = { marginTop: 6, border: "none", background: theme.primary, color: "#fff", borderRadius: 7, padding: "4px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const smallBtn: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 6, padding: "1px 9px", fontSize: 11, cursor: "pointer" };
const th: React.CSSProperties = { padding: "2px 10px 4px 0", fontWeight: 600 };
const td: React.CSSProperties = { padding: "3px 10px 3px 0" };
