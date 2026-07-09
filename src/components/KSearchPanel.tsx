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
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { searchPropagationVector, kLabel, type KCandidate } from "@/core/magnetic/kSearch";
import { littleGroup } from "@/core/magnetic/magneticGroups";
import { operationKey } from "@/core/crystal/symmetry";
import {
  magneticSubgroupLattice,
  latticeRepresentatives,
  type LatticeCandidate,
} from "@/core/magnetic/subgroupLattice";
import { decomposeMagneticRepresentation, projectIrrepModes } from "@/core/magnetic/irreps";
import { isotropySubgroup, type IrrepSelection, type IsotropyFailure } from "@/core/magnetic/isotropy";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { formatMagneticSymbol } from "@/core/magnetic/bnsOg";
import { describeMomentMode } from "@/core/magnetic/momentModel";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import type { MagneticModel } from "@/core/magnetic/types";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { refine } from "@/core/refinement/engine";
import type { PowderProfile } from "@/core/workflow/powder";
import { momentEntriesFrom } from "@/app/ui/cellModel";
import { card as themeCard, color as theme, mono as themeMono, uppercaseLabel as themeLabel } from "@/app/theme";

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

/** Compare magnetic groups by operation set (spatial coset + θ). */
function magOpsSignature(ops: readonly SymmetryOperation[]): string {
  return [...new Set(ops.map((o) => `${operationKey(o)}|${o.timeReversal ?? 1}`))].sort().join(" ");
}

/** Display pieces for a lattice candidate: symbol, numbers, setting note. */
function latticeLabel(c: LatticeCandidate): { symbol: string; numbers: string | null; setting: string | null } {
  if (c.candidate.standard) {
    return {
      symbol: c.candidate.label,
      numbers: `BNS ${c.candidate.standard.bnsNumber} · OG ${c.candidate.standard.ogNumber}`,
      setting: null,
    };
  }
  if (c.settingMatch) {
    return {
      symbol: formatMagneticSymbol(c.settingMatch.identity.bnsSymbol),
      numbers: `BNS ${c.settingMatch.identity.bnsNumber} · OG ${c.settingMatch.identity.ogNumber}`,
      setting: c.settingMatch.transformation,
    };
  }
  // Descriptive fallback: the row already shows the type chip, so strip the
  // label's own "type …" prefix.
  const bare = c.candidate.label
    .replace(/^type III · /, "")
    .replace(/^type I \(no time reversal\)$/, "no time reversal");
  return { symbol: bare, numbers: null, setting: null };
}

const ISOTROPY_FAILURE_TEXT: Record<IsotropyFailure, string> = {
  "no-modes": "The selected irrep(s) carry no moment on the chosen site(s) — this order parameter is magnetically silent here.",
  "complex-irrep": "A conjugate-pair (complex) irrep is selected: its real combinations generally stabilize as anti-translation (type-IV) groups, which the bundled type-I/III table cannot name yet.",
  "multidim-irrep": "A multidimensional irrep is selected: its magnetic group depends on the order-parameter direction (kernel vs epikernels) — direction selection is the next milestone. The magnetic-space-group route covers these orderings today.",
  "complex-phase": "This k gives complex phase factors e^{2πik·L}: naming needs the type-IV / star-of-k treatment (see docs/MAGNETIC_SYMMETRY.md).",
  "primed-translation": "The stabilizer contains a primed pure translation — a type-IV magnetic group, outside the bundled type-I/III table.",
};

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

  // Route A: the FULL lattice of candidate magnetic space groups — every
  // (subgroup H ≤ G_k, θ) pair, not only the maximal index-2 decorations —
  // grouped into conjugacy classes (one representative shown per class, with
  // its domain count), k-SUBGROUPSMAG-style. See subgroupLattice.ts for theory.
  const { reps, lgSize } = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0) return { reps: [] as LatticeCandidate[], lgSize: 0 };
    const lattice = magneticSubgroupLattice(ops, k);
    return { reps: latticeRepresentatives(lattice), lgSize: littleGroup(ops, k).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2]]);

  // Allowed-moment dimension per candidate at the selected sites' positions —
  // the quick "does this group even permit a moment here" badge.
  const repMomentDims = useMemo(() => {
    const sites = [...selected]
      .map((l) => structure.sites.find((s) => s.label === l))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    return reps.map((r) =>
      sites.reduce(
        (sum, s) => sum + allowedMomentDirections(r.candidate.operations, s.position, k).dimension,
        0,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reps, selected, structure, k[0], k[1], k[2]]);

  // Representation-analysis (irrep) route: decompose Γ_mag over G(k) into the
  // irreps of its (abelian) little co-group and project the basis modes each one
  // carries on the reference site.
  const irrepAnalysis = useMemo(() => {
    const ops = structure.spaceGroup.operations;
    if (ops.length === 0 || selected.size === 0) return null;
    const lg = littleGroup(ops, k);
    const dec = decomposeMagneticRepresentation(structure, k, [...selected], lg);
    const modes = dec.available ? dec.terms.map((t) => projectIrrepModes(structure, k, [...selected], lg, t.irrep)) : [];
    return { dec, modes, lg };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, k[0], k[1], k[2], selected]);

  // Which symmetry framework drives the group selection: the Shubnikov
  // (magnetic space group) route or the representation-analysis (irrep) route.
  // Both converge on a magnetic space group whose moments are previewed below.
  const [framework, setFramework] = useState<"msg" | "irrep">("msg");

  // Route B selection: any combination of real irreps (SARAh-style mixing).
  // The resulting magnetic space group is the isotropy subgroup — the exact
  // stabilizer of a generic combination — identified against the BNS/OG table.
  const [chosenIrreps, setChosenIrreps] = useState<ReadonlySet<string>>(new Set());
  const combo = useMemo(() => {
    if (!irrepAnalysis || !irrepAnalysis.dec.available || chosenIrreps.size === 0) return null;
    const selections: IrrepSelection[] = irrepAnalysis.dec.terms
      .filter((t) => chosenIrreps.has(t.irrep.label))
      .map((t) => ({ irrep: t.irrep }));
    if (selections.length === 0) return null;
    return isotropySubgroup(structure, k, [...selected], irrepAnalysis.lg, selections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [irrepAnalysis, chosenIrreps, structure, k[0], k[1], k[2], selected]);

  // The isotropy subgroup expressed as one of the lattice candidates (it always
  // is one, by construction) — cross-links the two routes in the UI.
  const comboRepIdx = useMemo(() => {
    if (!combo || "failure" in combo) return null;
    const sig = magOpsSignature(combo.operations);
    const idx = reps.findIndex((r) => magOpsSignature(r.candidate.operations) === sig);
    return idx >= 0 ? idx : null;
  }, [combo, reps]);

  // Selected magnetic subgroup → symmetry-allowed moment model over the real
  // structure, with editable moment-mode amplitudes and a 3D preview.
  const [selIdx, setSelIdx] = useState<number | null>(null);
  // Collapsible index sections: only the maximal (index-2) group starts open —
  // the top-down workflow — the rest show counts until expanded.
  const [openIndices, setOpenIndices] = useState<ReadonlySet<number>>(new Set([2]));
  const [amps, setAmps] = useState<Record<string, number>>({});
  const [tieMoments, setTieMoments] = useState(true);

  // The operations driving step 5, from whichever framework is active.
  const chosenOps = useMemo(() => {
    if (framework === "msg") return selIdx != null ? reps[selIdx]?.candidate.operations ?? null : null;
    return combo && !("failure" in combo) ? combo.operations : null;
  }, [framework, selIdx, reps, combo]);

  // When the chosen group's BNS identification needed a basis transformation,
  // offer its standard-setting cell as a 3D overlay (e.g. the orthohexagonal
  // C-centred cell of a Cm'cm'-type subgroup of a hexagonal parent).
  const standardCell = useMemo(() => {
    const match =
      framework === "msg"
        ? selIdx != null
          ? reps[selIdx]?.settingMatch
          : undefined
        : combo && !("failure" in combo)
          ? combo.settingMatch ?? undefined
          : undefined;
    if (!match || match.direct) return undefined;
    const { P, originShift: p } = match;
    // New cell origin in parent fractional coordinates: P·p.
    const origin: Vec3 = [
      P[0]![0]! * p[0]! + P[0]![1]! * p[1]! + P[0]![2]! * p[2]!,
      P[1]![0]! * p[0]! + P[1]![1]! * p[1]! + P[1]![2]! * p[2]!,
      P[2]![0]! * p[0]! + P[2]![1]! * p[1]! + P[2]![2]! * p[2]!,
    ];
    return { P, origin, label: formatMagneticSymbol(match.identity.bnsSymbol) };
  }, [framework, selIdx, reps, combo]);

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
    if (!chosenOps) return null;
    return buildMagneticModel(structure, k, [...selected], [...chosenOps], { moment: 2, tieSameSite: tieMoments });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenOps, structure, k[0], k[1], k[2], selected, tieMoments]);

  useEffect(() => {
    if (!magBuild) return;
    const init: Record<string, number> = {};
    for (const p of magBuild.params) init[p.id] = p.value;
    setAmps(init);
  }, [magBuild]);

  // Moment entries for the 3D view (one per site — or per split orbit when the
  // magnetic group splits a site's crystallographic orbit), with amps applied.
  const momentEntries = useMemo(() => {
    if (!magBuild) return undefined;
    return momentEntriesFrom(applyMagneticMoments(magBuild.magnetic, magBuild.bindings, amps));
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
    setChosenIrreps(new Set());
    setOpenIndices(new Set([2]));
  };

  return (
    <div className="wb-mag2">
      {/* Left panel: the 3D model, always visible. Defaults to the magnetic
          (super)cell whenever k defines one; arrows appear once a magnetic
          group is selected on the right. */}
      <section style={{ ...themeCard, padding: "14px 16px", display: "flex", flexDirection: "column", position: "sticky", top: 12, alignSelf: "start", height: "clamp(480px, 78vh, 900px)" }}>
        <div style={{ ...themeLabel, marginBottom: 8 }}>
          3D model — {magBuild ? "moment preview" : "refined structure"}
          <span style={{ color: theme.secondary, textTransform: "none", letterSpacing: 0 }}>
            {" "}· k = {kLabel(k)}
          </span>
        </div>
        <Suspense fallback={<div style={{ flex: 1, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>Loading 3D model…</div>}>
          <StructureView
            structure={structure}
            propagation={k}
            {...(magBuild ? { magneticOperations: magBuild.magnetic.operations ?? [] } : {})}
            {...(momentEntries ? { moments: momentEntries } : {})}
            {...(standardCell ? { standardCell } : {})}
          />
        </Suspense>
        <p style={{ ...help, maxWidth: "none" }}>
          {magBuild
            ? "Red arrows are the ordered moments (axial vectors) on the magnetic sites, shown over the magnetic unit cell. Atoms without an arrow have a symmetry-forbidden moment under the selected group. Absolute magnitude carries a convention factor to cross-check vs GSAS-II; directions and relative sizes are well defined."
            : "Refined nuclear structure. Pick a magnetic space group in step 4 to preview its symmetry-allowed moments here."}
        </p>
      </section>

      {/* Right panel: the workflow controls (steps 1–5). */}
      <div style={{ ...themeCard, padding: 16, display: "grid", gap: 18, alignContent: "start", minWidth: 0 }}>
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
            ? "Shubnikov route (k-SUBGROUPSMAG-style): enumerate every magnetic subgroup — each subgroup H ≤ G(k) with each time-reversal assignment θ: H → ±1 — grouped by index, one representative per conjugacy class (equivalent domains)."
            : "Representation route (SARAh / BasIreps / Jana style): decompose Γ_mag into irreps of G(k) and pick any combination — the resulting magnetic space group is the isotropy subgroup (exact stabilizer) of the mixed order parameter."}
        </p>
      </section>

      {/* 4. Magnetic space group — picked directly, or through an irrep */}
      <section>
        <div style={themeLabel}>4 · Magnetic space group</div>
        {framework === "msg" ? (
          <>
            <p style={help}>
              Full subgroup enumeration: {reps.length} candidate class{reps.length === 1 ? "" : "es"} (every
              H ≤ G(k) with every θ: H → ±1), grouped by index in the grey group. Work top-down:
              the physical symmetry is usually a <strong>maximal</strong> subgroup (index 2) — descend to
              higher index only when no maximal candidate fits. Within a group, candidates that allow a
              moment on your sites are listed first. Click one to preview in step 5.
            </p>
            {(() => {
              const all = reps.map((r, i) => ({ r, i }));
              const indices = [...new Set(all.map(({ r }) => r.index))].sort((a, b) => a - b);
              // BNS-number sort key: labeled candidates in table order, unlabeled last.
              const bnsKey = ({ r }: { r: LatticeCandidate }): number => {
                const num = r.candidate.standard?.bnsNumber ?? r.settingMatch?.identity.bnsNumber;
                if (!num) return Number.MAX_SAFE_INTEGER;
                const [a, b] = num.split(".").map(Number);
                return (a ?? 999) * 100000 + (b ?? 0);
              };
              return (
                <div style={{ margin: "6px 0 0", display: "grid", gap: 3 }}>
                  {indices.map((idx) => {
                    const group = all
                      .filter(({ r }) => r.index === idx)
                      .sort(
                        (A, B) =>
                          Number((repMomentDims[B.i] ?? 0) > 0) - Number((repMomentDims[A.i] ?? 0) > 0) ||
                          Number(B.r.candidate.isTypeI) - Number(A.r.candidate.isTypeI) ||
                          bnsKey(A) - bnsKey(B) ||
                          A.r.classId - B.r.classId,
                      );
                    const open = openIndices.has(idx);
                    const allowing = group.filter(({ i }) => (repMomentDims[i] ?? 0) > 0).length;
                    const holdsSelection = selIdx != null && group.some(({ i }) => i === selIdx);
                    return (
                      <div key={idx} style={{ display: "grid", gap: 3 }}>
                        <button
                          onClick={() =>
                            setOpenIndices((s) => {
                              const next = new Set(s);
                              if (next.has(idx)) next.delete(idx);
                              else next.add(idx);
                              return next;
                            })
                          }
                          style={{
                            textAlign: "left", fontSize: 11.5, fontFamily: themeMono, cursor: "pointer",
                            border: "none", background: "transparent", color: theme.secondary,
                            padding: "4px 2px", marginTop: idx === indices[0] ? 0 : 4,
                            display: "flex", alignItems: "baseline", gap: 8,
                          }}
                        >
                          <span style={{ color: theme.primary }}>{open ? "▾" : "▸"}</span>
                          <span style={{ fontWeight: 700 }}>index {idx}{idx === 2 ? " — maximal" : ""}</span>
                          <span>
                            {group.length} class{group.length === 1 ? "" : "es"} · {allowing} allow moments
                          </span>
                          {!open && holdsSelection && <span style={{ color: theme.primary }}>· selected inside</span>}
                        </button>
                        {open && group.map(({ r, i }) => {
                        const lbl = latticeLabel(r);
                        const dim = repMomentDims[i] ?? 0;
                        return (
                          <button
                            key={r.candidate.id}
                            onClick={() => setSelIdx(i === selIdx ? null : i)}
                            style={{
                              textAlign: "left", fontSize: 12.5, padding: "5px 9px", borderRadius: 7, cursor: "pointer",
                              border: `1px solid ${i === selIdx ? theme.primary : theme.border}`,
                              background: i === selIdx ? theme.chipBg : "#fff",
                              opacity: dim === 0 ? 0.55 : 1,
                            }}
                            title={dim === 0 ? "No symmetry-allowed moment on the selected site(s) under this group" : undefined}
                          >
                            <span style={{ fontFamily: themeMono, color: theme.secondary }}>
                              {r.candidate.isTypeI ? "type I" : "type III"}
                            </span>
                            {" · "}{lbl.symbol}
                            {lbl.numbers && <span style={{ color: theme.secondary }}> · {lbl.numbers}</span>}
                            {lbl.setting && (
                              <span style={{ color: theme.noteInk }}> · setting {lbl.setting}</span>
                            )}
                            {r.domainCount > 1 && (
                              <span style={{ color: theme.secondary }}> · ×{r.domainCount} domains</span>
                            )}
                            <span style={{ float: "right", fontFamily: themeMono, fontSize: 11.5, color: dim === 0 ? theme.secondary : theme.primary }}>
                              {dim === 0 ? "moment forbidden" : `${dim} moment dof`}
                            </span>
                          </button>
                        );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </>
        ) : !irrepAnalysis ? (
          <p style={help}>Select at least one magnetic ion in step 1.</p>
        ) : !irrepAnalysis.dec.available ? (
          <p style={help}>
            This <strong>non-abelian</strong> little co-group at <strong>k ≠ 0</strong> needs the
            projective <em>small</em> representations — the remaining piece (see
            docs/MAGNETIC_SYMMETRY.md). At k = 0 the irreps are generated for any point group.
            Switch to the <strong>magnetic space groups</strong> framework above — it applies to
            every G(k).
          </p>
        ) : (
          <>
            <p style={help}>
              Γ<sub>mag</sub> ({irrepAnalysis.dec.dimension}-dimensional) decomposes into the irreps of the little group
              {irrepAnalysis.dec.method === "induced" ? " (induced point-group irreps, exact at k = 0)" : ""} as{" "}
              <span style={{ fontFamily: themeMono, color: theme.ink }}>
                {irrepAnalysis.dec.terms.map((t) => `${t.multiplicity}${t.irrep.label}`).join(" ⊕ ") || "—"}
              </span>
              . Tick one irrep (the Landau single-irrep prescription) or any <strong>combination</strong> (SARAh-style
              mixing) — the resulting magnetic space group is the isotropy subgroup of the mixed order
              parameter, computed as the exact stabilizer of a generic combination and named from the
              standard BNS/OG table.
            </p>
            <div style={{ margin: "6px 0 0", display: "grid", gap: 3 }}>
              {irrepAnalysis.dec.terms.map((t, i) => {
                const modes = irrepAnalysis.modes[i] ?? [];
                const modeText = modes.length ? modes.map((m) => describeMomentMode(m)).join(", ") : "—";
                const active = chosenIrreps.has(t.irrep.label);
                const dim = t.irrep.dim ?? 1;
                const selectable = t.irrep.real && dim === 1;
                const blockReason = dim > 1 ? ISOTROPY_FAILURE_TEXT["multidim-irrep"] : ISOTROPY_FAILURE_TEXT["complex-irrep"];
                return (
                  <label
                    key={t.irrep.label}
                    style={{
                      textAlign: "left", fontSize: 12, padding: "4px 9px", borderRadius: 7,
                      border: `1px solid ${active ? theme.primary : theme.border}`,
                      background: active ? theme.chipBg : "#fff",
                      display: "flex", gap: 8, alignItems: "baseline", width: "100%",
                      cursor: selectable ? "pointer" : "default",
                      opacity: selectable ? 1 : 0.6,
                    }}
                    title={selectable ? undefined : blockReason}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      disabled={!selectable}
                      onChange={() =>
                        setChosenIrreps((s) => {
                          const next = new Set(s);
                          if (next.has(t.irrep.label)) next.delete(t.irrep.label);
                          else next.add(t.irrep.label);
                          return next;
                        })
                      }
                      style={{ alignSelf: "center" }}
                    />
                    <span style={{ fontFamily: themeMono, color: theme.primary, minWidth: 56 }}>{t.multiplicity} × {t.irrep.label}</span>
                    <span style={{ color: theme.secondary }}>
                      {dim > 1 ? `${dim}-dim` : t.irrep.real ? "real" : "complex"} · modes:{" "}
                      <span style={{ color: theme.ink }}>{modeText}</span>
                    </span>
                    {!selectable && (
                      <span style={{ marginLeft: "auto", fontSize: 11.5, color: theme.secondary, whiteSpace: "nowrap" }}>
                        {dim > 1 ? "multidim — direction UI pending" : "conjugate pair — type-IV territory"}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            {combo && ("failure" in combo ? (
              <p style={{ ...help, marginTop: 8, color: theme.noteInk }}>{ISOTROPY_FAILURE_TEXT[combo.failure]}</p>
            ) : (
              <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 7, border: `1px solid ${theme.primary}`, background: theme.chipBg, fontSize: 12.5 }}>
                <span style={{ color: theme.secondary }}>Isotropy subgroup of </span>
                <span style={{ fontFamily: themeMono }}>{[...chosenIrreps].sort().join(" ⊕ ")}</span>
                <span style={{ color: theme.secondary }}>: </span>
                {combo.standard ? (
                  <strong>{formatMagneticSymbol(combo.standard.bnsSymbol)}
                    <span style={{ fontWeight: 400, color: theme.secondary }}> · BNS {combo.standard.bnsNumber} · OG {combo.standard.ogNumber}</span>
                  </strong>
                ) : combo.settingMatch ? (
                  <strong>{formatMagneticSymbol(combo.settingMatch.identity.bnsSymbol)}
                    <span style={{ fontWeight: 400, color: theme.secondary }}>
                      {" "}· BNS {combo.settingMatch.identity.bnsNumber} · OG {combo.settingMatch.identity.ogNumber} · setting {combo.settingMatch.transformation}
                    </span>
                  </strong>
                ) : (
                  <strong>order-{combo.subgroupOrder} group
                    <span style={{ fontWeight: 400, color: theme.secondary }}> — no tabulated setting match (symbol withheld rather than guessed)</span>
                  </strong>
                )}
                {comboRepIdx != null && (
                  <span style={{ color: theme.secondary }}> · = candidate {comboRepIdx + 1} of the subgroup list</span>
                )}
                <div style={{ ...help, marginTop: 4 }}>
                  The moment preview in step 5 refines this group&rsquo;s symmetry-allowed modes — for a single
                  irrep these are exactly its basis modes; for a combination, the union.
                </div>
              </div>
            ))}
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
            <span style={{ color: theme.secondary }}>
              {framework === "msg" && selIdx != null && reps[selIdx]
                ? ` — ${latticeLabel(reps[selIdx]!).symbol} (index ${reps[selIdx]!.index})`
                : framework === "irrep" && combo && !("failure" in combo)
                  ? ` — isotropy subgroup of ${[...chosenIrreps].sort().join(" ⊕ ")}`
                  : null}
            </span>
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
              <span style={help}>&ldquo;Refine moments&rdquo; fits the moments here (nuclear fixed, shared scale) — the 3D model on the left updates live. &ldquo;Continue&rdquo; adds the moment parameters to the main refinement to fit nuclear + magnetic together.</span>
            </div>
          )}
        </section>
      )}
      </div>
    </div>
  );
}

const help: React.CSSProperties = { fontSize: 12, color: theme.secondary, margin: "4px 0 0", maxWidth: 560 };
const kInput: React.CSSProperties = { width: 64, border: `1px solid ${theme.control}`, borderRadius: 7, padding: "3px 7px", fontSize: 13, fontFamily: themeMono };
const btn: React.CSSProperties = { marginTop: 6, border: "none", background: theme.primary, color: "#fff", borderRadius: 7, padding: "4px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const smallBtn: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 6, padding: "1px 9px", fontSize: 11, cursor: "pointer" };
const th: React.CSSProperties = { padding: "2px 10px 4px 0", fontWeight: 600 };
const td: React.CSSProperties = { padding: "3px 10px 3px 0" };
