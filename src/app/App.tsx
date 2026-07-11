/**
 * App shell: data loading (structure / pattern / instrument, with format
 * auto-detection), engine routing (powder ↔ single crystal), and the fixed
 * chrome (header with mode-aware steps + exports, disclaimer, footer).
 *
 * The two refinement engines are peers behind the WorkbenchEngine contract
 * (see workbenchEngine.ts): `PowderWorkbench` and `SingleCrystalWorkbench`
 * each own their view state, refinement orchestration, exports, and — per the
 * ratified boundary — their own community's quality panel and agreement
 * factors. The shell owns the *data*: the powder session (which also carries
 * the structure the single-crystal engine refines) and the instrument.
 */

import { useCallback, useRef, useState } from "react";
import { APP_VERSION } from "@/app/constants";
import type { RefinementResult } from "@/core/refinement/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { buildPowderSpec } from "@/app/powderSpec";
import { parseMagneticCif, parseCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { parseIllD1b, looksLikeIllD1b } from "@/parsers/illPowder";
import { parseFullProfInstrm6, looksLikeInstrm6 } from "@/parsers/fullprofInstrm6";
import { parseGsasCsvPattern } from "@/parsers/gsasPattern";
import { isGsasHistogram, parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { detectDataFormat, type DetectedFormat } from "@/parsers/detectFormat";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { startingPowderParams, loadReflectionDataset } from "@/app/loadData";
import { powderBindings } from "@/examples/synthetic";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";
import { ComputeClient } from "@/workers/computeClient";
import { PowderWorkbench } from "@/app/PowderWorkbench";
import { SingleCrystalWorkbench } from "@/app/SingleCrystalWorkbench";
import { WorkbenchHeader, type Step, type ExportAction } from "@/app/ui/WorkbenchHeader";
import { color as theme } from "@/app/theme";
import {
  type Session,
  newSession,
  loadedSession,
  buildSpecFor,
  DEFAULT_INSTRUMENT,
} from "@/app/powderSession";
import type { WorkbenchExports } from "@/app/workbenchEngine";

const STEPS: readonly Step[] = [
  { num: "1", label: "Refinement" },
  { num: "2", label: "Magnetic" },
];
// Single crystal shares the same two-step flow: F² refinement, then the (shared,
// structure-driven) magnetic symmetry analysis fitting moments against F² data.
const SC_STEPS: readonly Step[] = [
  { num: "1", label: "Refinement" },
  { num: "2", label: "Magnetic" },
];

export function App(): JSX.Element {
  // The bundled Mn₃Ga POWGEN 600 K TOF dataset (published) is the default the
  // workbench opens with — embedded in the build, so it works on the deployed
  // site with no runtime fetch or local data/ folder.
  const example = mn3gaPowgenExample();
  const [session, setSession] = useState<Session>(() => loadedSession(example.structure, example.pattern, example.instrument, example.extraPhases));
  const [powderResult, setPowderResult] = useState<RefinementResult | null>(null);
  // Single-crystal mode: set when hkl/fcf reflection data is loaded; the app
  // then renders the single-crystal workbench instead of the powder panels.
  // Cleared when powder data is loaded (auto-switch back).
  const [scDataset, setScDataset] = useState<SingleCrystalDataset | null>(null);
  const [step, setStep] = useState(0);
  const [instrument, setInstrument] = useState<InstrumentParameters>(example.instrument);
  const [instrumentLoaded, setInstrumentLoaded] = useState(true);
  // Once the user has loaded their own primary structure (replacing the bundled
  // example), the Structure card's load button becomes "Add CIF…" and appends a
  // phase instead of replacing — the multi-phase entry point.
  const [ownStructure, setOwnStructure] = useState(false);
  // The status bar under the header is gone (results and diagnostics live in
  // the parameter panel / quality rail); status texts go to the console so
  // load/refine errors are still traceable.
  const setMessage = useCallback((text: string): void => {
    console.info(`[status] ${text}`);
  }, []);
  const client = useRef<ComputeClient>(new ComputeClient());
  // Each engine publishes its header exports into its own shell-owned ref
  // (WorkbenchEngine contract) — the header calls the active mode's handlers,
  // which need engine-private state (parameters, results, live curves).
  const powderExports = useRef<WorkbenchExports | null>(null);
  const scExports = useRef<WorkbenchExports | null>(null);

  const { structure } = session;

  function onLoadCif(file: File): void {
    file.text().then((text) => {
      try {
        const { structure: parsed, magnetic } = parseMagneticCif(text, "loaded");
        if (magnetic) {
          // Drive the powder view from the magnetic structure so the plot shows
          // the nuclear + magnetic pattern and reflection ticks.
          const magStructure = { ...parsed, id: "loaded" };
          setSession({ ...newSession(magStructure, instrument), magnetic: { ...magnetic, structureId: "loaded" } as MagneticModel });
          setPowderResult(null);
          setMessage(`Loaded magnetic CIF: ${parsed.name} · ${magnetic.moments.length} moments · ${parsed.spaceGroup.hermannMauguin ?? "BNS"}. Nuclear + magnetic pattern shown.`);
          return;
        }
        setSession(newSession({ ...parsed, id: "loaded" }, instrument));
        setOwnStructure(true);
        setPowderResult(null);
        setMessage(`Loaded CIF: ${parsed.name} (${parsed.sites.length} sites, ${parsed.spaceGroup.operations.length} symmetry ops). Load button is now "Add CIF…" to add impurity/secondary phases.`);
      } catch (e) {
        setMessage(`CIF parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** Append a CIF as an additional crystallographic phase (multi-phase refinement),
   *  rebuilding the spec while preserving every existing parameter value/state. */
  function onAddPhase(file: File): void {
    file.text().then((text) => {
      try {
        const raw = parseCif(text, `phase-${Date.now().toString(36)}`);
        // Fall back to a composition name (e.g. "MnO") when the CIF omits _pd_phase_name.
        const name = raw.name && raw.name !== "structure"
          ? raw.name
          : [...new Set(raw.sites.map((st) => st.element))].join("") || raw.id;
        const parsed = { ...raw, name };
        setSession((s) => {
          const extraPhases = [...s.extraPhases, parsed];
          const spec = buildSpecFor(s.structure, extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic");
          const previous = new Map(s.powderParams.map((p) => [p.id, p]));
          return {
            ...s,
            extraPhases,
            powderParams: spec.params.map((p) => {
              const old = previous.get(p.id);
              return old ? { ...p, value: old.value, initialValue: old.initialValue, fixed: old.fixed } : p;
            }),
            powderBindings: spec.bindings,
            powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
          };
        });
        setPowderResult(null);
        setMessage(`Added phase "${parsed.name}" (${parsed.spaceGroup.hermannMauguin ?? "?"}). Refine to fit its scale/cell.`);
      } catch (e) {
        setMessage(`Add phase failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** Remove an added phase (by id) and rebuild the spec back down. */
  function onRemovePhase(id: string): void {
    setSession((s) => {
      const extraPhases = s.extraPhases.filter((p) => p.id !== id);
      const spec = buildSpecFor(s.structure, extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic");
      const previous = new Map(s.powderParams.map((p) => [p.id, p]));
      return {
        ...s,
        extraPhases,
        powderParams: spec.params.map((p) => {
          const old = previous.get(p.id);
          return old ? { ...p, value: old.value, initialValue: old.initialValue, fixed: old.fixed } : p;
        }),
        powderBindings: spec.bindings,
        powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
      };
    });
    setPowderResult(null);
  }

  // Unified, auto-detecting data loader: the resolver classifies the file
  // (powder vs single-crystal) and, for powder, its x-unit, then dispatches.
  function onLoadData(file: File): void {
    file.text().then((text) => {
      try {
        // FullProf's ILL `.dat` templates share the extension but differ in
        // header — route each to its own reader before the generic detector.
        if (looksLikeInstrm6(text)) {
          applyInstrm6Powder(text, file.name);
          return;
        }
        if (looksLikeIllD1b(text)) {
          applyIllPowder(text, file.name);
          return;
        }
        const fmt = detectDataFormat({ text, filename: file.name, instrument: instrumentLoaded ? instrument : undefined });
        const tag = `[${fmt.source}/${fmt.confidence}]`;
        if (fmt.dataType === "single-crystal") {
          const loaded = loadReflectionDataset(text, structure, `${structure.id}-hkl`, file.name);
          if (loaded.kept < 1) throw new Error("no usable reflections in the file");
          setScDataset(loaded.dataset);
          setMessage(
            `Loaded single-crystal “${file.name}” · ${loaded.kept} reflections [${loaded.format}]` +
            `${loaded.dropped > 0 ? ` (${loaded.dropped} dropped)` : ""}. Merge report + F² refinement ready.`,
          );
          return;
        }
        setScDataset(null); // powder data → leave single-crystal mode
        applyPowder(text, file.name, fmt, tag);
      } catch (e) {
        setMessage(`Data load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // ILL D1B/D20 constant-wavelength neutron powder (numor format). Uses the
  // loaded CW instrument (e.g. the D1B .irf → λ + Caglioti U/V/W) when present;
  // otherwise a neutron default at the D1B wavelength, and loading the .irf
  // afterwards re-seeds the widths (onLoadInstrument rebuilds the spec).
  // FullProf INSTRM=6 (D2B/3T2/G4.2) CW neutron powder. The wavelength comes
  // from the file header (or the loaded CW instrument, which then supplies the
  // Caglioti widths when its .irf is loaded).
  function applyInstrm6Powder(text: string, filename: string): void {
    const id = `${structure.id}-powder`;
    const cw = instrumentLoaded && instrument.kind === "constantWavelength" ? instrument : null;
    const parsed = parseFullProfInstrm6(text, {
      id, name: filename,
      radiation: { kind: "neutron", wavelength: cw?.wavelength ?? 2.5 },
      ...(cw ? { wavelength: cw.wavelength } : {}),
    });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    setScDataset(null);
    const wavelength = parsed.wavelength ?? cw?.wavelength ?? 2.5;
    const inst: InstrumentParameters = cw ?? { kind: "constantWavelength", radiationKind: "neutron", wavelength };
    const spec = buildPowderSpec(structure, parsed, inst, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
    if (instrument.kind === "tof") { setInstrument(DEFAULT_INSTRUMENT); setInstrumentLoaded(false); }
    setPowderResult(null);
    const last = parsed.points[parsed.points.length - 1]!;
    setMessage(`Loaded FullProf INSTRM=6 powder “${filename}” · ${parsed.points.length} pts · 2θ ${parsed.points[0]!.x.toFixed(2)}–${last.x.toFixed(2)}° · neutron λ=${wavelength} Å.`);
  }

  function applyIllPowder(text: string, filename: string): void {
    const id = `${structure.id}-powder`;
    const cw = instrumentLoaded && instrument.kind === "constantWavelength" ? instrument : null;
    const wavelength = cw?.wavelength ?? 2.52; // D1B graphite λ
    const parsed = parseIllD1b(text, { id, name: filename, radiation: { kind: "neutron", wavelength }, wavelength });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    setScDataset(null);
    const inst: InstrumentParameters = cw ?? { kind: "constantWavelength", radiationKind: "neutron", wavelength };
    const spec = buildPowderSpec(structure, parsed, inst, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
    if (instrument.kind === "tof") { setInstrument(DEFAULT_INSTRUMENT); setInstrumentLoaded(false); }
    setPowderResult(null);
    const last = parsed.points[parsed.points.length - 1]!;
    setMessage(
      `Loaded ILL powder “${filename}” · ${parsed.points.length} pts · 2θ ${parsed.points[0]!.x.toFixed(2)}–${last.x.toFixed(2)}° · neutron λ=${wavelength} Å` +
      `${cw ? " (Caglioti widths from instrument)" : " — load the .irf for Caglioti widths"}.`,
    );
  }

  function applyPowder(text: string, filename: string, fmt: DetectedFormat, tag: string): void {
    const id = `${structure.id}-powder`;
    const isGsasCsv = /(^|,)\s*"?obs"?\s*,/i.test(text) && /calc/i.test(text);
    const isGsasHist = isGsasHistogram(text);
    if (fmt.xUnit === "tof") {
      const overlay = isGsasCsv ? parseGsasCsvPattern(text, id, filename) : null;
      const parsed = overlay
        ? overlay.pattern
        : isGsasHist
          ? parseGsasHistogramPattern(text, id, filename, { radiation: { kind: "neutron-tof" } })
          : parsePowderData(text, { id, name: filename, xUnit: "tof", radiation: { kind: "neutron-tof" } });
      if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
      const tofInstrument = instrumentLoaded && instrument.kind === "tof" ? instrument : null;
      // A GSAS-II CSV carries its own calc/background (shown as a reference
      // overlay); and without a TOF calibration (difC) we cannot place peaks —
      // both stay view-only. A plain TOF pattern with a loaded TOF instrument is
      // refined with the back-to-back-exponential profile.
      if (overlay || !tofInstrument) {
        const tofBindings = powderBindings(structure, id);
        setSession((s) => ({
          ...s,
          extraPhases: [],
          pattern: parsed,
          powderParams: startingPowderParams(structure, parsed, tofBindings),
          powderBindings: tofBindings,
          powderProfile: { shape: "gaussian" },
          powderOverlay: overlay ? { calc: overlay.calc, background: overlay.background } : null,
          powderSource: filename,
        }));
        setPowderResult(null);
        setMessage(
          overlay
            ? `Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag} with GSAS-II calc overlay (reference). ${fmt.note}`
            : `Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag}. Load a TOF instrument (.instprm with difC) to refine. ${fmt.note}`,
        );
        return;
      }
      const spec = buildPowderSpec(structure, parsed, tofInstrument, true, session.backgroundTerms, session.siteTies);
      setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
      setPowderResult(null);
      setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag}. ${spec.params.length} parameters, back-to-back-exponential profile — click “Refine”. ${fmt.note}`);
      return;
    }
    const parsed = isGsasHist
      ? parseGsasHistogramPattern(text, id, filename, { radiation: fmt.radiation })
      : parsePowderData(text, { id, name: filename, xUnit: fmt.xUnit, radiation: fmt.radiation, ...(fmt.radiation.kind !== "neutron-tof" ? { wavelength: fmt.radiation.wavelength } : {}) });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    // Constant-wavelength data: a still-selected TOF instrument (e.g. the bundled
    // default) doesn't apply, so fall back to a constant-wavelength default and
    // reset the instrument — loading a different dataset type auto-switches the
    // workbench into the matching mode instead of staying view-only.
    const cwInstrument = instrumentLoaded && instrument.kind === "constantWavelength" ? instrument : DEFAULT_INSTRUMENT;
    const spec = buildPowderSpec(structure, parsed, cwInstrument, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
    if (instrument.kind === "tof") {
      setInstrument(DEFAULT_INSTRUMENT);
      setInstrumentLoaded(false);
    }
    setPowderResult(null);
    const nParams = spec.params.length;
    setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · unit=${fmt.xUnit} ${tag}. ${nParams} symmetry-allowed parameters. Scale auto-estimated — click “Refine”. ${fmt.note}`);
  }

  function onLoadInstrument(file: File): void {
    file.text().then((text) => {
      try {
        const parsed = parseInstrumentParameters(text);
        setInstrument(parsed);
        setInstrumentLoaded(true);
        // Rebuild the powder spec so the profile reflects the new instrument —
        // otherwise loading structure-then-instrument would leave the old
        // (default) profile in place, making load order matter.
        setSession((s) => {
          // For a constant-wavelength instrument on a non-TOF pattern, adopt its
          // radiation (X-ray vs neutron) and wavelength so the physics is correct
          // regardless of whether the data or the instrument was loaded first.
          const pattern =
            parsed.kind === "constantWavelength" && s.pattern.xUnit !== "tof"
              ? { ...s.pattern, radiation: { kind: parsed.radiationKind ?? "neutron", wavelength: parsed.wavelength }, wavelength: parsed.wavelength }
              : s.pattern;
          const spec = buildSpecFor(s.structure, s.extraPhases, pattern, parsed, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic");
          return { ...s, pattern, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile };
        });
        setPowderResult(null);
        setMessage(
          parsed.kind === "tof"
            ? `Loaded TOF instrument: difC=${parsed.difC.toFixed(2)}, Zero=${(parsed.zero ?? 0).toFixed(3)}. Profile re-seeded.`
            : `Loaded CW instrument: λ=${parsed.wavelength} Å. Profile re-seeded.`,
        );
      } catch (e) {
        setMessage(`Instrument parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // Header export buttons follow the active mode, calling into the engine's
  // published handlers: single crystal exposes only its own CIF; powder keeps
  // CIF/mCIF + CSV + project JSON. Labels the shell can know (they depend only
  // on session state it owns); behavior lives in the engines.
  const headerExports: ExportAction[] = scDataset
    ? [{ label: "Export CIF", onClick: () => scExports.current?.cif?.() }]
    : [
        { label: session.magnetic && session.magnetic.moments.length > 0 ? "Export mCIF" : "Export CIF", onClick: () => powderExports.current?.cif?.() },
        { label: "Export CSV", onClick: () => powderExports.current?.csv?.() },
        { label: "Export project JSON", onClick: () => powderExports.current?.projectJson?.() },
      ];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <WorkbenchHeader
        steps={scDataset ? SC_STEPS : STEPS}
        active={step}
        onStep={setStep}
        version={`v${APP_VERSION}`}
        exports={headerExports}
      />
      <div style={disclaimerBar}>
        Early browser-native refinement workbench — results for publication must be validated against established tools.
      </div>
      {/* The powder engine stays mounted in single-crystal mode (hidden) so all
          its state — fit range, plot mode, k-search picks — survives switching. */}
      <PowderWorkbench
        session={session}
        setSession={setSession}
        powderResult={powderResult}
        setPowderResult={setPowderResult}
        instrument={instrument}
        instrumentLoaded={instrumentLoaded}
        ownStructure={ownStructure}
        client={client.current}
        active={!scDataset}
        step={step}
        onStep={setStep}
        setMessage={setMessage}
        exportsRef={powderExports}
        onLoadData={onLoadData}
        onLoadCif={onLoadCif}
        onAddPhase={onAddPhase}
        onRemovePhase={onRemovePhase}
        onLoadInstrument={onLoadInstrument}
      />
      {scDataset && (
        // Single-crystal mode (auto-switched on loading hkl/fcf data). Keyed on
        // the dataset id so a new file remounts with a fresh parameter set.
        <main className="wb-main" style={{ flex: 1 }}>
          <SingleCrystalWorkbench key={scDataset.id} structure={structure} dataset={scDataset} client={client.current} step={step} onStep={setStep} {...(instrumentLoaded && instrument.kind === "constantWavelength" && instrument.radiationKind ? { instrumentProbe: instrument.radiationKind } : {})} exportsRef={scExports} onLoadData={onLoadData} onLoadCif={onLoadCif} />
        </main>
      )}
      <footer style={copyrightBar}>
        © 2026 Tsung-Han Yang. All rights reserved.
        <span style={{ margin: "0 8px", color: theme.border }}>·</span>
        <a href="https://github.com/drthyang/web-refinement#readme" target="_blank" rel="noopener noreferrer" style={footerLink}>
          About &amp; documentation
        </a>
      </footer>
    </div>
  );
}

const disclaimerBar: React.CSSProperties = { padding: "7px 24px", fontSize: 11.5, background: theme.warnBg, borderBottom: `1px solid ${theme.warnBorder}`, color: theme.warnInk };
const copyrightBar: React.CSSProperties = { padding: "10px 24px", fontSize: 11, color: theme.faint, borderTop: `1px solid ${theme.border}`, background: theme.raised, textAlign: "center" };
const footerLink: React.CSSProperties = { color: theme.secondary, textDecoration: "none", borderBottom: `1px solid ${theme.border}` };
