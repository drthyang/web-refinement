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
import { decomposeMagneticRepresentation, projectIrrepModes, shubnikovCandidateIndex } from "@/core/magnetic/irreps";
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

/**
 * Parse one k component, accepting fractions ("1/2", "-1/3") as well as
 * decimals — exact fractions matter: 0.333 misses the little-group tolerance
 * where 1/3 is meant.
 */
function parseKComponent(s: string): number {
  const frac = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const den = Number(frac[2]);
    return den === 0 ? 0 : Number(frac[1]) / den;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

/** The two equivalent symmetry frameworks for step 3 of the workflow. */
const FRAMEWORKS: readonly { id: "msg" | "irrep"; label: string }[] = [
  { id: "msg", label: "Magnetic space groups" },
  { id: "irrep", label: "Representation analysis" },
];

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
  const [results, setResults] = useState<KCandidate[] | null>(null);

  // k is confirmed explicitly ("Add") so the symmetry analysis below does not
  // churn on every keystroke; the inputs hold a draft until then.
  const [k, setAppliedK] = useState<Vec3>([0, 0, 0]);
  const draftK: Vec3 = [parseKComponent(kText[0]), parseKComponent(kText[1]), parseKComponent(kText[2])];
  const draftPending = draftK.some((v, i) => Math.abs(v - k[i]!) > 1e-12);

  const { subgroups, lgSize } = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0) return { subgroups: [], lgSize: 0 };
    return { subgroups: generateMagneticCandidatesForK(ops, k), lgSize: littleGroup(ops, k).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2]]);

  // Representation-analysis (irrep) route: decompose Γ_mag over G(k) into the
  // irreps of its (abelian) little co-group and project the basis modes each one
  // carries on the reference site.
  const irrepAnalysis = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0 || selected.size === 0) return null;
    const lg = littleGroup(ops, k);
    const dec = decomposeMagneticRepresentation(structure, k, [...selected], lg);
    const modes = dec.abelian ? dec.terms.map((t) => projectIrrepModes(structure, k, [...selected], lg, t.irrep)) : [];
    return { dec, modes, lg };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2], selected]);

  // Which symmetry framework drives the group selection: the Shubnikov
  // (magnetic space group) route or the representation-analysis (irrep) route.
  // Both converge on a magnetic space group whose moments are previewed below.
  const [framework, setFramework] = useState<"msg" | "irrep">("msg");

  // Each *real* irrep is a time-reversal homomorphism θ = χ, i.e. exactly one of
  // the Shubnikov candidates above — the map lets a click on an irrep drive the
  // same moment preview as the subgroup route.
  const irrepCandidate = useMemo(() => {
    if (!irrepAnalysis || !irrepAnalysis.dec.abelian) return [];
    return irrepAnalysis.dec.terms.map((t) => shubnikovCandidateIndex(t.irrep, irrepAnalysis.lg, subgroups));
  }, [irrepAnalysis, subgroups]);

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

  /** Search candidate k-vectors from the auto-detected magnetic peaks. */
  function autoDetectAndSearch(): void {
    setResults(searchPropagationVector(structure.cell, [...autoPeaks], { tolerance: 0.02 }));
  }

  function toggleIon(label: string): void {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }

  /** Confirm a k: sync the inputs, apply it, and drop the previous k's group pick. */
  const applyK = (kk: Vec3): void => {
    setKText([String(kk[0]), String(kk[1]), String(kk[2])]);
    setAppliedK([kk[0], kk[1], kk[2]]);
    setSelIdx(null);
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {/* 1. Atomic structure: which sites carry a moment */}
      <section>
        <div style={themeLabel}>1 · Atomic structure — magnetic ions</div>
        <p style={help}>
          {structure.name || "Structure"}
          {structure.spaceGroup.hermannMauguin ? ` · ${structure.spaceGroup.hermannMauguin}` : ""}
          {` · ${structure.sites.length} site${structure.sites.length === 1 ? "" : "s"} (current refined values). Tick the moment-carrying ion(s).`}
        </p>
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
        <div style={themeLabel}>2 · Propagation vector k</div>
        <p style={help}>Components accept exact fractions (1/2, 1/3, −1/3 …) or decimals; confirm with Add.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          {[0, 1, 2].map((i) => (
            <input
              key={i}
              value={kText[i]}
              onChange={(e) => setKText((t) => { const n = [...t] as [string, string, string]; n[i] = e.target.value; return n; })}
              onKeyDown={(e) => { if (e.key === "Enter" && draftPending) applyK(draftK); }}
              placeholder={["0", "1/2", "1/3"][i]}
              style={kInput}
              aria-label={`k${["x", "y", "z"][i]}`}
            />
          ))}
          <button
            style={{ ...btn, marginTop: 0, opacity: draftPending ? 1 : 0.45 }}
            onClick={() => applyK(draftK)}
            disabled={!draftPending}
            title="Confirm this propagation vector — the symmetry analysis below uses it"
          >
            Add
          </button>
          <span style={{ fontSize: 13, color: theme.secondary, fontFamily: themeMono }}>
            k = {kLabel(k)}
            {draftPending && <span style={{ color: theme.noteInk }}> · draft {kLabel(draftK)} — press Add</span>}
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...btn, marginTop: 0, opacity: autoPeaks.length === 0 ? 0.5 : 1 }} onClick={autoDetectAndSearch} disabled={autoPeaks.length === 0}>
              Auto-detect &amp; search ({autoPeaks.length})
            </button>
            <span style={help}>
              {autoPeaks.length > 0
                ? "Extra peaks from the nuclear-fit residual (refine the nuclear structure first, then all fixed)."
                : "No extra peaks in the residual — refine the nuclear structure first, or set k directly above."}
            </span>
          </div>
        </div>
        {results && (
          <div style={{ marginTop: 10 }}>
            {results.length === 0 ? (
              <p style={help}>No candidate k reproduces the detected peaks — check the nuclear fit, or set k directly above.</p>
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
                      <td style={td}><button style={smallBtn} onClick={() => applyK(c.k)}>use</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* 3. Choose the symmetry framework */}
      <section>
        <div style={themeLabel}>3 · Symmetry framework</div>
        <p style={help}>
          Little group G(k): {lgSize} of {structure.spaceGroup.operations.length} operations leave k invariant.
          Describe the ordering it allows in either framework — both converge on a magnetic space group in step 4.
        </p>
        <div style={{ display: "inline-flex", gap: 2, background: theme.chipBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 2, marginTop: 6 }}>
          {FRAMEWORKS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFramework(f.id)}
              style={{
                border: "none", borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 600,
                cursor: "pointer", fontFamily: themeMono,
                background: framework === f.id ? theme.primary : "transparent",
                color: framework === f.id ? "#fff" : theme.secondary,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p style={{ ...help, marginTop: 6 }}>
          {framework === "msg"
            ? "Shubnikov route: enumerate the time-reversal assignments θ: G(k) → ±1 — the coordinate (basis-vector) description used by mCIF / GSAS-II."
            : "Representation route (BasIreps / Jana style): decompose Γ_mag into irreps of G(k). Every real 1-D irrep is exactly one of the Shubnikov groups, so both frameworks meet at step 4."}
        </p>
      </section>

      {/* 4. Magnetic space group — picked directly, or through an irrep */}
      <section>
        <div style={themeLabel}>4 · Magnetic space group</div>
        {framework === "msg" ? (
          <>
            <p style={help}>
              θ-enumeration gives {subgroups.length} candidate{subgroups.length === 1 ? "" : "s"}. Click one to
              preview its symmetry-allowed moments in step 5; confirm any candidate with a refinement.
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
                  {c.standard && (
                    <span style={{ color: theme.secondary }}> · BNS {c.standard.bnsNumber} · OG {c.standard.ogNumber}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        ) : !irrepAnalysis ? (
          <p style={help}>Select at least one magnetic ion in step 1.</p>
        ) : !irrepAnalysis.dec.abelian ? (
          <p style={help}>
            The little co-group is <strong>non-abelian</strong>; its irrep character tables (and the
            projective small representations for non-symmorphic BZ-boundary k) are the remaining piece
            — see docs/MAGNETIC_SYMMETRY.md. Switch to the <strong>magnetic space groups</strong>{" "}
            framework above — it applies to every G(k).
          </p>
        ) : (
          <>
            <p style={help}>
              Γ<sub>mag</sub> ({irrepAnalysis.dec.dimension}-dimensional) decomposes into the irreps of the abelian little
              group as{" "}
              <span style={{ fontFamily: themeMono, color: theme.ink }}>
                {irrepAnalysis.dec.terms.map((t) => `${t.multiplicity}${t.irrep.label}`).join(" ⊕ ") || "—"}
              </span>
              . Each irrep's basis modes are the refinable moment directions on the reference site;
              click a real irrep to select its magnetic space group and preview the moments in step 5
              (arrows honour the primed operations).
            </p>
            <div style={{ margin: "6px 0 0", display: "grid", gap: 3 }}>
              {irrepAnalysis.dec.terms.map((t, i) => {
                const modes = irrepAnalysis.modes[i] ?? [];
                const modeText = modes.length ? modes.map((m) => describeMomentMode(m)).join(", ") : "—";
                const cand = irrepCandidate[i] ?? null;
                const active = cand != null && cand === selIdx;
                const rowStyle: React.CSSProperties = {
                  textAlign: "left", fontSize: 12, padding: "4px 9px", borderRadius: 7,
                  border: `1px solid ${active ? theme.primary : theme.border}`,
                  background: active ? theme.chipBg : "#fff",
                  display: "flex", gap: 8, alignItems: "baseline", width: "100%",
                };
                const body = (
                  <>
                    <span style={{ fontFamily: themeMono, color: theme.primary, minWidth: 56 }}>{t.multiplicity} × {t.irrep.label}</span>
                    <span style={{ color: theme.secondary }}>
                      {t.irrep.real ? "real" : "complex"} · modes: <span style={{ color: theme.ink }}>{modeText}</span>
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: cand != null ? theme.primary : theme.secondary, whiteSpace: "nowrap" }}>
                      {cand != null
                        ? `≙ magnetic group ${cand + 1} · ${active ? "selected ↓" : "select & preview"}`
                        : "conjugate pair — combine ± modes"}
                    </span>
                  </>
                );
                return cand != null ? (
                  <button key={t.irrep.label} style={{ ...rowStyle, cursor: "pointer" }} onClick={() => setSelIdx(active ? null : cand)}>
                    {body}
                  </button>
                ) : (
                  <div key={t.irrep.label} style={rowStyle}>{body}</div>
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

      {/* 5. Selected subgroup: editable moments + 3D preview + handoff */}
      {magBuild && (
        <section>
          <div style={themeLabel}>
            5 · Moment preview → back to refinement
            {selIdx != null && (
              <span style={{ color: theme.secondary }}>
                {" — magnetic group "}{selIdx + 1}
                {irrepAnalysis?.dec.abelian && (() => {
                  const labels = irrepAnalysis.dec.terms.filter((_, i) => irrepCandidate[i] === selIdx).map((t) => t.irrep.label);
                  return labels.length > 0 ? ` (irrep ${labels.join(", ")})` : null;
                })()}
              </span>
            )}
          </div>
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
                <StructureView
                  structure={structure}
                  propagation={k}
                  magneticOperations={magBuild.magnetic.operations ?? []}
                  {...(momentsMap ? { moments: momentsMap } : {})}
                />
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
const btn: React.CSSProperties = { marginTop: 6, border: "none", background: theme.primary, color: "#fff", borderRadius: 7, padding: "4px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const smallBtn: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 6, padding: "1px 9px", fontSize: 11, cursor: "pointer" };
const th: React.CSSProperties = { padding: "2px 10px 4px 0", fontWeight: 600 };
const td: React.CSSProperties = { padding: "3px 10px 3px 0" };
