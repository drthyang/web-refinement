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
import { magneticRepresentationDimension } from "@/core/magnetic/magneticRepresentation";
import { decomposeMagneticRepresentation, projectIrrepModes } from "@/core/magnetic/irreps";
import { describeMomentMode } from "@/core/magnetic/momentModel";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import type { MagneticModel } from "@/core/magnetic/types";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { refine } from "@/core/refinement/engine";
import type { PowderProfile } from "@/core/workflow/powder";
import { color as theme, mono as themeMono, uppercaseLabel as themeLabel } from "@/app/theme";

// Lazy so three.js stays in its own chunk (only loaded when a group is previewed).
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));

/** Common commensurate propagation vectors, for one-click assignment. */
const K_PRESETS: readonly { label: string; k: Vec3 }[] = [
  { label: "(0 0 0)", k: [0, 0, 0] },
  { label: "(½ 0 0)", k: [0.5, 0, 0] },
  { label: "(0 ½ 0)", k: [0, 0.5, 0] },
  { label: "(0 0 ½)", k: [0, 0, 0.5] },
  { label: "(½ ½ 0)", k: [0.5, 0.5, 0] },
  { label: "(½ 0 ½)", k: [0.5, 0, 0.5] },
  { label: "(0 ½ ½)", k: [0, 0.5, 0.5] },
  { label: "(½ ½ ½)", k: [0.5, 0.5, 0.5] },
  { label: "(⅓ 0 0)", k: [1 / 3, 0, 0] },
  { label: "(⅓ ⅓ 0)", k: [1 / 3, 1 / 3, 0] },
];

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
  onApply,
  onContinue,
}: {
  structure: StructureModel;
  /** d-spacings of candidate magnetic peaks auto-detected from the pattern residual. */
  autoPeaks?: readonly number[];
  /** The observed pattern + refined nuclear model, for running a moment refinement. */
  pattern?: PowderPattern;
  nuclearParams?: readonly RefinementParameter[];
  nuclearBindings?: readonly ParameterBinding[];
  profile?: PowderProfile;
  /** Push the current magnetic model onto the session so the refinement plot
   *  shows the magnetic pattern + satellite ticks (null clears it). */
  onApply?: (magnetic: MagneticModel | null) => void;
  /** Hand the magnetic model + moment params/bindings to the refinement page. */
  onContinue?: (magnetic: MagneticModel, params: readonly RefinementParameter[], bindings: readonly ParameterBinding[]) => void;
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
  const repDim = useMemo(() => magneticRepresentationDimension(structure, [...selected]), [structure, selected]);

  // Representation-analysis (irrep) route: decompose Γ_mag over G(k) into the
  // irreps of its (abelian) little co-group and project the basis modes each one
  // carries on the reference site.
  const irrepAnalysis = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0 || selected.size === 0) return null;
    const lg = littleGroup(ops, k);
    const dec = decomposeMagneticRepresentation(structure, k, [...selected], lg);
    const modes = dec.abelian ? dec.terms.map((t) => projectIrrepModes(structure, k, [...selected], lg, t.irrep)) : [];
    return { dec, modes };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2], selected]);

  // Selected magnetic subgroup → symmetry-allowed moment model over the real
  // structure, with editable moment-mode amplitudes and a 3D preview.
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [amps, setAmps] = useState<Record<string, number>>({});
  const [tieMoments, setTieMoments] = useState(true);

  // True when ≥2 selected magnetic ions share one crystallographic site (disorder).
  const hasSharedMagSite = useMemo(() => {
    const sel = [...selected]
      .map((l) => structure.sites.find((s) => s.label === l))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    const coincide = (a: Vec3, b: Vec3): boolean =>
      [0, 1, 2].every((i) => { const d = Math.abs(a[i]! - b[i]!); return Math.min(d, 1 - d) < 1e-3; });
    for (let i = 0; i < sel.length; i++) for (let j = i + 1; j < sel.length; j++) {
      if (coincide(sel[i]!.position, sel[j]!.position)) return true;
    }
    return false;
  }, [selected, structure]);

  const magBuild = useMemo(() => {
    const sub = selIdx != null ? subgroups[selIdx] : undefined;
    if (!sub) return null;
    return buildMagneticModel(structure, k, [...selected], sub.operations, { moment: 2, tieSameSite: tieMoments });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx, subgroups, structure, k[0], k[1], k[2], selected, tieMoments]);

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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
          <span style={{ ...help, marginTop: 3 }}>Assign directly:</span>
          {K_PRESETS.map((p) => (
            <button key={p.label} style={presetBtn} title={`Set k = ${p.label}`} onClick={() => setK(p.k)}>{p.label}</button>
          ))}
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
        <div style={themeLabel}>Magnetic space groups of the little group G(k)</div>
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
          Click a subgroup to preview the moments and edit their components — this is the
          <strong> magnetic space group (coordinate/basis-vector) route</strong>. The complementary
          <strong> representation (irrep) route</strong> is shown below. Confirm any candidate with a
          magnetic refinement.
        </p>
      </section>

      {/* 4. Representation analysis (irrep decomposition) */}
      {irrepAnalysis && (
        <section>
          <div style={themeLabel}>Representation analysis — Γ_mag over G(k)</div>
          {!irrepAnalysis.dec.abelian ? (
            <p style={help}>
              The little co-group is <strong>non-abelian</strong>; its irrep character tables (and the
              projective small representations for non-symmorphic BZ-boundary k) are the remaining piece
              — see docs/MAGNETIC_SYMMETRY.md. The magnetic space-group route above still applies.
            </p>
          ) : (
            <>
              <p style={help}>
                Γ<sub>mag</sub> ({repDim}-dimensional) decomposes into the irreps of the abelian little
                group as{" "}
                <span style={{ fontFamily: themeMono, color: theme.ink }}>
                  {irrepAnalysis.dec.terms.map((t) => `${t.multiplicity}${t.irrep.label}`).join(" ⊕ ") || "—"}
                </span>
                . Each irrep's basis modes are the refinable moment directions on the reference site.
              </p>
              <div style={{ margin: "6px 0 0", display: "grid", gap: 3 }}>
                {irrepAnalysis.dec.terms.map((t, i) => {
                  const modes = irrepAnalysis.modes[i] ?? [];
                  const modeText = modes.length ? modes.map((m) => describeMomentMode(m)).join(", ") : "—";
                  return (
                    <div key={t.irrep.label} style={{ fontSize: 12, padding: "4px 9px", borderRadius: 7, border: `1px solid ${theme.border}`, background: "#fff", display: "flex", gap: 8 }}>
                      <span style={{ fontFamily: themeMono, color: theme.primary, minWidth: 56 }}>{t.multiplicity} × {t.irrep.label}</span>
                      <span style={{ color: theme.secondary }}>
                        {t.irrep.real ? "real" : "complex"} · modes: <span style={{ color: theme.ink }}>{modeText}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
              {!irrepAnalysis.dec.integerConsistent && (
                <p style={{ ...help, marginTop: 6, color: theme.noteInk }}>
                  Non-integer multiplicities: this non-symmorphic BZ-boundary k needs the projective
                  <em> small</em> representations (ordinary irreps shown as an approximation).
                </p>
              )}
            </>
          )}
        </section>
      )}

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
              {hasSharedMagSite && (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: theme.secondary }} title="Constrain co-located (disordered) magnetic ions to the same moment vector">
                  <input type="checkbox" checked={tieMoments} onChange={(e) => setTieMoments(e.target.checked)} />
                  Same moment on shared site
                </label>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button style={{ ...btn, marginTop: 0, opacity: canRefine && !refining ? 1 : 0.5 }} onClick={runRefine} disabled={!canRefine || refining}>
                  {refining ? "Refining…" : "Refine moments"}
                </button>
                {refineWR != null && (
                  <span style={{ fontSize: 12.5, color: theme.secondary, fontFamily: themeMono }}>wR = {(100 * refineWR).toFixed(1)}%</span>
                )}
                {onApply && (
                  <button
                    style={{ ...btn, marginTop: 0, background: "#fff", color: theme.primary, border: `1px solid ${theme.primary}` }}
                    onClick={() => onApply(applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps))}
                  >
                    Show on refinement pattern
                  </button>
                )}
                {onContinue && (
                  <button
                    style={{ ...btn, marginTop: 0 }}
                    onClick={() => onContinue(
                      applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps),
                      magBuild.params.map((p) => ({ ...p, value: amps[p.id] ?? p.value, initialValue: amps[p.id] ?? p.value })),
                      magBuild.bindings,
                    )}
                  >
                    Continue in refinement page →
                  </button>
                )}
              </div>
              <span style={help}>&ldquo;Refine moments&rdquo; fits the moments here (nuclear fixed, shared scale). &ldquo;Continue&rdquo; adds the moment parameters to the main refinement to fit nuclear + magnetic together.</span>
              <Suspense fallback={<div style={{ height: 360, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>Loading 3D preview…</div>}>
                <StructureView structure={structure} propagation={k} {...(momentsMap ? { moments: momentsMap } : {})} />
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
const presetBtn: React.CSSProperties = { border: `1px solid ${theme.border}`, background: theme.chipBg, borderRadius: 6, padding: "2px 8px", fontSize: 11.5, fontFamily: themeMono, cursor: "pointer", color: theme.ink };
const th: React.CSSProperties = { padding: "2px 10px 4px 0", fontWeight: 600 };
const td: React.CSSProperties = { padding: "3px 10px 3px 0" };
