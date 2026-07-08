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

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { searchPropagationVector, kLabel, type KCandidate } from "@/core/magnetic/kSearch";
import { generateMagneticCandidatesForK, littleGroup } from "@/core/magnetic/magneticGroups";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { refine } from "@/core/refinement/engine";
import type { PowderProfile } from "@/core/workflow/powder";
import { color as theme, mono as themeMono, uppercaseLabel as themeLabel } from "@/app/theme";

// Lazy so three.js stays in its own chunk (only loaded when a group is previewed).
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));

function parsePeaks(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => Number(t))
    .filter((v) => Number.isFinite(v) && v > 0);
}

export function KSearchPanel({
  structure,
  autoPeaks = [],
  pattern,
  nuclearParams,
  nuclearBindings,
  profile,
}: {
  structure: StructureModel;
  /** d-spacings of candidate magnetic peaks auto-detected from the pattern residual. */
  autoPeaks?: readonly number[];
  /** The observed pattern + refined nuclear model, for running a moment refinement. */
  pattern?: PowderPattern;
  nuclearParams?: readonly RefinementParameter[];
  nuclearBindings?: readonly ParameterBinding[];
  profile?: PowderProfile;
}): JSX.Element {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2]]);

  // Selected magnetic subgroup → symmetry-allowed moment model over the real
  // structure, with editable moment-mode amplitudes and a 3D preview.
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [amps, setAmps] = useState<Record<string, number>>({});

  const magBuild = useMemo(() => {
    const sub = selIdx != null ? subgroups[selIdx] : undefined;
    if (!sub) return null;
    return buildMagneticModel(structure, k, [...selected], sub.operations, { moment: 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx, subgroups, structure, k[0], k[1], k[2], selected]);

  useEffect(() => {
    if (!magBuild) return;
    const init: Record<string, number> = {};
    for (const p of magBuild.params) init[p.id] = p.value;
    setAmps(init);
  }, [magBuild]);

  const momentsMap = useMemo(() => {
    if (!magBuild) return undefined;
    const applied = applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps);
    const map = new Map<string, Vec3>();
    for (const m of applied.moments) map.set(m.siteLabel, [...m.components] as Vec3);
    return map;
  }, [magBuild, amps]);

  // Optional moment refinement against the loaded pattern: nuclear model held
  // fixed (the handoff convention), moment-mode amplitudes freed, shared scale.
  const [refining, setRefining] = useState(false);
  const [refineWR, setRefineWR] = useState<number | null>(null);
  const canRefine = !!(magBuild && magBuild.params.length > 0 && pattern && nuclearParams && nuclearBindings && profile);

  function runRefine(): void {
    if (!canRefine || !magBuild) return;
    setRefining(true);
    setRefineWR(null);
    // Defer so the busy state paints before the (main-thread) solve.
    setTimeout(() => {
      try {
        const nuclearFixed = nuclearParams!.map((p) => ({ ...p, fixed: true }));
        const moments = magBuild.params.map((p) => ({ ...p, value: amps[p.id] ?? p.value, initialValue: amps[p.id] ?? p.value, fixed: false }));
        const bindings = [...nuclearBindings!, ...magBuild.bindings];
        const problem = buildMagneticPowderProblem(structure, magBuild.magnetic, pattern!, [...nuclearFixed, ...moments], bindings, {
          shape: profile!.shape,
          ...(profile!.eta !== undefined ? { eta: profile!.eta } : {}),
        });
        const result = refine(problem, { maxIterations: 20 });
        const next: Record<string, number> = { ...amps };
        for (const p of magBuild.params) next[p.id] = result.parameters[p.id] ?? next[p.id]!;
        setAmps(next);
        setRefineWR(result.agreement.rWeighted ?? null);
      } finally {
        setRefining(false);
      }
    }, 30);
  }

  function runSearch(peaks?: readonly number[]): void {
    const list = peaks ?? parsePeaks(peaksText);
    setResults(searchPropagationVector(structure.cell, [...list], { tolerance: 0.02 }));
  }

  /** Fill the box with the auto-detected magnetic peaks and search them. */
  function autoDetectAndSearch(): void {
    setPeaksText(autoPeaks.map((d) => d.toFixed(4)).join("\n"));
    runSearch(autoPeaks);
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
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...btn, marginTop: 0, opacity: autoPeaks.length === 0 ? 0.5 : 1 }} onClick={autoDetectAndSearch} disabled={autoPeaks.length === 0}>
              Auto-detect &amp; search ({autoPeaks.length})
            </button>
            <span style={help}>
              {autoPeaks.length > 0
                ? "Extra peaks from the nuclear-fit residual (refine the nuclear structure first, then all fixed)."
                : "No extra peaks in the residual — refine the nuclear structure first, or enter d-spacings manually."}
            </span>
          </div>
          <div style={{ ...help, marginTop: 10 }}>Or enter magnetic-peak d-spacings (Å) manually, one per line or comma-separated:</div>
          <textarea
            value={peaksText}
            onChange={(e) => setPeaksText(e.target.value)}
            placeholder={"e.g.\n6.214\n3.842\n3.107"}
            rows={3}
            style={textarea}
          />
          <button style={btn} onClick={() => runSearch()}>Search k</button>
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
        <div style={{ margin: "6px 0 0", display: "grid", gap: 3 }}>
          {subgroups.map((c, i) => (
            <button
              key={c.id}
              onClick={() => setSelIdx(i === selIdx ? null : i)}
              style={{
                textAlign: "left", fontSize: 12.5, padding: "5px 9px", borderRadius: 7, cursor: "pointer",
                border: `1px solid ${i === selIdx ? theme.primary : theme.border}`,
                background: i === selIdx ? theme.chipBg : "#fff",
              }}
            >
              <span style={{ fontFamily: themeMono, color: theme.secondary }}>{c.isTypeI ? "type I" : "type III"}</span> · {c.label}
            </button>
          ))}
        </div>
        <p style={{ ...help, marginTop: 8 }}>
          Click a subgroup to preview the moments and edit their components. Note: little-group
          magnetic subgroups only — no BNS/OG labels, star-of-k arms, or representation (irrep)
          analysis yet. Confirm a candidate with a magnetic refinement.
        </p>
      </section>

      {/* 4. Selected subgroup: editable moments + 3D preview */}
      {magBuild && (
        <section>
          <div style={themeLabel}>Magnetic structure preview & moments</div>
          {magBuild.params.length === 0 ? (
            <p style={help}>No symmetry-allowed moment on the selected ion(s) under this subgroup — the moment is forbidden here.</p>
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {magBuild.params.map((p) => (
                  <label key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                    <span style={{ color: theme.secondary }}>{p.label} (µ_B)</span>
                    <input
                      type="number"
                      step={0.1}
                      value={amps[p.id] ?? p.value}
                      onChange={(e) => setAmps((a) => ({ ...a, [p.id]: Number(e.target.value) }))}
                      style={kInput}
                    />
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button style={{ ...btn, marginTop: 0, opacity: canRefine && !refining ? 1 : 0.5 }} onClick={runRefine} disabled={!canRefine || refining}>
                  {refining ? "Refining…" : "Refine moments"}
                </button>
                {refineWR != null && (
                  <span style={{ fontSize: 12.5, color: theme.secondary, fontFamily: themeMono }}>wR = {(100 * refineWR).toFixed(1)}%</span>
                )}
                <span style={help}>Nuclear model fixed; moment amplitudes refined against the loaded pattern (shared scale).</span>
              </div>
              <Suspense fallback={<div style={{ height: 360, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>Loading 3D preview…</div>}>
                <StructureView structure={structure} {...(momentsMap ? { moments: momentsMap } : {})} />
              </Suspense>
              <p style={help}>
                Red arrows are the ordered moments (axial vectors) on the magnetic sites. Absolute
                magnitude carries a convention factor to cross-check vs GSAS-II; directions and
                relative sizes are well defined.
              </p>
            </div>
          )}
        </section>
      )}
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
