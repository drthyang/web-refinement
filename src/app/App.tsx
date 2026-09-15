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
import type { StructureModel } from "@/core/crystal/types";
import { TECHNIQUE_LABEL, type PdfWorkspace, type ProjectFile, type SingleCrystalWorkspace } from "@/core/project/types";
import { looksLikeProjectFile, parseProject, projectFileName, serializeProject } from "@/core/project/io";
import { defaultProjectTitle, projectFileFor, sessionFromPowderWorkspace, type PowderViewState } from "@/app/projectIo";
import { downloadText } from "@/app/download";
import type { MagneticModel } from "@/core/magnetic/types";
import type { PdfPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { buildPowderSpec } from "@/app/powderSpec";
import { parseMagneticCif, parseCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { parseIllD1b, looksLikeIllD1b } from "@/parsers/illPowder";
import { parseFullProfInstrm6, looksLikeInstrm6 } from "@/parsers/fullprofInstrm6";
import { parseGsasCsvPattern } from "@/parsers/gsasPattern";
import { isGsasHistogram, parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { detectDataFormat, type DetectedFormat } from "@/parsers/detectFormat";
import { parsePdfData } from "@/parsers/pdfData";
import { looksLikeFgr, parseFgr, fgrToPattern } from "@/parsers/fgrData";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { startingPowderParams, loadReflectionDataset, describeDrops } from "@/app/loadData";
import { powderBindings } from "@/examples/synthetic";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";
import { gata4se8PdfExample } from "@/examples/gata4se8Pdf";
import { ComputeClient } from "@/workers/computeClient";
import { PowderWorkbench } from "@/app/PowderWorkbench";
import { SingleCrystalWorkbench } from "@/app/SingleCrystalWorkbench";
import { PdfWorkbench } from "@/app/PdfWorkbench";
import { WorkbenchHeader, type Step, type ExportAction } from "@/app/ui/WorkbenchHeader";
import { color as theme } from "@/app/theme";
import {
  type Session,
  newSession,
  loadedSession,
  emptySession,
  buildSpecFor,
  DEFAULT_INSTRUMENT,
  EMPTY_SOURCE,
} from "@/app/powderSession";
import type { WorkbenchExports } from "@/app/workbenchEngine";

// The header's refinement-target chips. "Nuclear" is the main refinement page
// (the whole app refines, so no "Refinement" label needed); "Magnetic" is the
// magnetic symmetry-analysis page.
const STEPS: readonly Step[] = [
  { label: "Nuclear", hint: "Crystal-structure refinement against the loaded data" },
  { label: "Magnetic", hint: "Magnetic symmetry analysis + moment refinement on the refined structure" },
];
// Single crystal shares the same two-step flow: F² refinement, then the (shared,
// structure-driven) magnetic symmetry analysis fitting moments against F² data.
const SC_STEPS: readonly Step[] = STEPS;
// PDF's second chip is the magnetic PDF (mPDF) page. It needs NEUTRON data:
// X-rays have no dipole coupling to spins, so d_mag(r) is identically zero and
// the moment parameters would be unconstrained (the bundled GaTa₄Se₈ demo is
// X-ray — hence a live-but-dimmed chip rather than an unconditional one).
// It is also single-phase only: `buildMpdfSpec` wraps the single-phase nuclear
// builder. The chip must carry BOTH guards, or it would open a page whose
// Apply/Continue silently do nothing (PdfWorkbench's own `magneticCapable`
// check is the stricter one, and would refuse the model without saying why).
const pdfSteps = (pdf: PdfPattern, extraPhases: number): readonly Step[] => [
  STEPS[0]!,
  extraPhases > 0
    ? { label: "Magnetic", disabled: true, hint: "Magnetic PDF is single-phase — remove the additional phases to analyse the spin structure" }
    : pdf.scatteringType === "neutron"
      ? { label: "Magnetic", hint: "Magnetic PDF (mPDF): spin model + moment refinement against the magnetic G(r)" }
      : { label: "Magnetic", disabled: true, hint: "Magnetic PDF needs neutron total-scattering data — an X-ray G(r) carries no magnetic signal" },
];
// Before any data loads, the steps preview the workflow but aren't clickable.
const IDLE_STEPS: readonly Step[] = STEPS.map((s) => ({
  ...s,
  disabled: true,
  hint: "Load a structure + dataset (or pick a demo) to start",
}));
// The bundled demos — one converged snapshot per technique (header Demos menu
// and the landing cards).
const DEMOS = [
  { id: "rietveld", label: "Rietveld · Mn₃Ga neutron TOF" },
  { id: "pdf", label: "PDF · GaTa₄Se₈ X-ray G(r)" },
] as const;

/**
 * What a just-opened project asks the engines to restore. `token` changes per
 * open and is part of the keyed engines' mount keys, so their initializers
 * run against the workspace; each engine reads its block once, at mount.
 */
interface ProjectRestore {
  readonly token: number;
  readonly powderView?: PowderViewState & { readonly token: number };
  readonly singleCrystal?: SingleCrystalWorkspace;
  readonly pdf?: PdfWorkspace;
}
const NO_RESTORE: ProjectRestore = { token: 0 };

/** Identity of the project the session came from, so Save keeps its title and creation date. */
interface ProjectMeta {
  readonly title: string;
  readonly createdAt: string;
  readonly notes?: string;
}

export function App(): JSX.Element {
  // The workbench opens clean (no data): the shell shows a landing view until the
  // user loads the bundled Mn₃Ga POWGEN demo (the header "Demo" toggle) or their
  // own CIF. The demo is embedded in the build, so it works on the deployed site
  // with no runtime fetch or local data/ folder.
  const [session, setSession] = useState<Session>(() => emptySession());
  const [powderResult, setPowderResult] = useState<RefinementResult | null>(null);
  // Single-crystal mode: set when hkl/fcf reflection data is loaded; the app
  // then renders the single-crystal workbench instead of the powder panels.
  // Cleared when powder data is loaded (auto-switch back).
  const [scDataset, setScDataset] = useState<SingleCrystalDataset | null>(null);
  // Phase 2: an optional companion magnetic .int paired with scDataset for joint
  // nuclear+magnetic co-refinement. Set ONLY by onLoadMagneticData; every change
  // to the nuclear dataset (below) routes through setScNuclearDataset, which
  // clears this partner so a new nuclear load can never inherit a stale one.
  const [scMagneticDataset, setScMagneticDataset] = useState<SingleCrystalDataset | null>(null);
  const setScNuclearDataset = (next: SingleCrystalDataset | null): void => {
    setScDataset(next);
    setScMagneticDataset(null);
  };
  // PDF mode: set when a reduced G(r) (.gr) is loaded; the app then renders the
  // PDF workbench. Mutually exclusive with single-crystal mode, and cleared when
  // powder data is loaded (auto-switch back), mirroring scDataset.
  const [pdfDataset, setPdfDataset] = useState<PdfPattern | null>(null);
  const [step, setStep] = useState(0);
  const [instrument, setInstrument] = useState<InstrumentParameters>(DEFAULT_INSTRUMENT);
  const [instrumentLoaded, setInstrumentLoaded] = useState(false);
  // Which bundled demo is the loaded content (null = user's own / nothing) —
  // drives the header Demos menu and is cleared once the user loads their own.
  const [demo, setDemo] = useState<null | "rietveld" | "pdf">(null);
  // Loading own content clears the demo marker (the session is no longer the
  // pristine bundled snapshot); the demo loaders set it directly.
  const setDemoActive = (on: boolean): void => setDemo(on ? demo ?? "rietveld" : null);
  // Once the user has loaded their own primary structure (replacing the bundled
  // example), the Structure card's load button becomes "Add CIF…" and appends a
  // phase instead of replacing — the multi-phase entry point.
  const [ownStructure, setOwnStructure] = useState(false);
  // Project save/open (see workbenchEngine.ts, "The project boundary").
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [restore, setRestore] = useState<ProjectRestore>(NO_RESTORE);
  // A user-facing problem from the last project open. The app has no status
  // bar (status goes to the console), but a refused file must be seen.
  const [notice, setNotice] = useState<string | null>(null);
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
  const pdfExports = useRef<WorkbenchExports | null>(null);

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
          setOwnStructure(true);
          setDemoActive(false);
          setPowderResult(null);
          setMessage(`Loaded magnetic CIF: ${parsed.name} · ${magnetic.moments.length} moments · ${parsed.spaceGroup.hermannMauguin ?? "BNS"}. Nuclear + magnetic pattern shown.`);
          return;
        }
        setSession(newSession({ ...parsed, id: "loaded" }, instrument));
        setOwnStructure(true);
        setDemoActive(false);
        setPowderResult(null);
        setMessage(`Loaded CIF: ${parsed.name} (${parsed.sites.length} sites, ${parsed.spaceGroup.operations.length} symmetry ops). Load button is now "Add CIF…" to add impurity/secondary phases.`);
      } catch (e) {
        setMessage(`CIF parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** Reset the workbench to the clean, data-less landing (drops the demo or any
   *  loaded structures/data/instrument). */
  function clearWorkbench(): void {
    setSession(emptySession());
    setInstrument(DEFAULT_INSTRUMENT);
    setInstrumentLoaded(false);
    setOwnStructure(false);
    setScNuclearDataset(null);
    setPdfDataset(null);
    setPowderResult(null);
    setDemoActive(false);
    setStep(0);
    setProjectMeta(null);
    setRestore((r) => ({ token: r.token }));
    setNotice(null);
  }

  function onClearStructures(): void {
    clearWorkbench();
    setMessage("Cleared the workbench.");
  }

  /** The two bundled demos — one per technique, both converged snapshots. */
  function onLoadDemo(kind: "rietveld" | "pdf"): void {
    // A demo is the bundled snapshot, not the user's project.
    setProjectMeta(null);
    setRestore((r) => ({ token: r.token }));
    if (kind === "rietveld") {
      const ex = mn3gaPowgenExample();
      setSession(loadedSession(ex.structure, ex.pattern, ex.instrument, ex.extraPhases, ex.refinedParams));
      setInstrument(ex.instrument);
      setInstrumentLoaded(true);
      setOwnStructure(false);
      setScNuclearDataset(null);
      setPdfDataset(null);
      setPowderResult(null);
      setStep(0);
      setDemo("rietveld");
      setMessage("Loaded the bundled Mn₃Ga + MnO POWGEN demo (two-phase TOF, converged fit).");
      return;
    }
    const ex = gata4se8PdfExample();
    setSession(newSession(ex.structure, DEFAULT_INSTRUMENT));
    setInstrument(DEFAULT_INSTRUMENT);
    setInstrumentLoaded(false);
    setOwnStructure(true); // "Add CIF…" appends phases, as after a user CIF load
    setScNuclearDataset(null);
    setPdfDataset(ex.pattern);
    setPowderResult(null);
    setStep(0);
    setDemo("pdf");
    setMessage("Loaded the bundled GaTa4Se8 299 K X-ray PDF demo (cubic lacunar spinel, converged fit).");
  }

  /** Header Demos menu exit: clear back to the landing. */
  function onExitDemo(): void {
    clearWorkbench();
    setMessage("Exited the demo — workbench cleared.");
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

  // ── Project save / open ─────────────────────────────────────────────────
  // The shell owns the envelope (phases, metadata, active page); the ACTIVE
  // engine supplies its technique block through the exports ref. Opening runs
  // the other way: the file's technique tag decides which mode the app enters,
  // and the engine gets its block as a `restore` prop on a fresh mount.

  function onSaveProject(): void {
    const engine = pdfDataset ? pdfExports : scDataset ? scExports : powderExports;
    const workspace = engine.current?.projectWorkspace?.();
    if (!workspace) {
      setNotice("Nothing to save yet — load a structure and a dataset first.");
      return;
    }
    // Single crystal refines one phase; the powder / PDF blocks carry every phase.
    const structures: StructureModel[] =
      workspace.technique === "singleCrystal" ? [session.structure] : [session.structure, ...session.extraPhases];
    const title = projectMeta?.title ?? defaultProjectTitle(session.structure, workspace.technique);
    const file = projectFileFor({
      structures,
      workspace,
      title,
      step,
      ...(projectMeta ? { createdAt: projectMeta.createdAt } : {}),
      ...(projectMeta?.notes !== undefined ? { notes: projectMeta.notes } : {}),
    });
    downloadText(projectFileName(file), serializeProject(file), "application/json");
    if (!projectMeta) setProjectMeta({ title, createdAt: file.metadata.createdAt });
    setNotice(null);
    setMessage(`Saved project “${title}” (${TECHNIQUE_LABEL[workspace.technique]}).`);
  }

  function onOpenProject(file: File): void {
    file.text().then((text) => openProjectText(text, file.name));
  }

  function openProjectText(text: string, sourceName: string): void {
    let file: ProjectFile;
    try {
      file = parseProject(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNotice(`Could not open “${sourceName}” — ${msg}`);
      setMessage(`Project open failed: ${msg}`);
      return;
    }
    const structures = file.structures;
    const primary = structures[0]!;
    const ws = file.workspace;
    switch (ws.technique) {
      case "powder": {
        const r = sessionFromPowderWorkspace(ws, structures);
        setSession(r.session);
        setInstrument(r.instrument);
        setInstrumentLoaded(r.instrumentLoaded);
        setPowderResult(r.result);
        setScNuclearDataset(null);
        setPdfDataset(null);
        setRestore((prev) => {
          const token = prev.token + 1;
          return { token, powderView: { ...r.view, token } };
        });
        break;
      }
      case "singleCrystal": {
        // The dormant powder session just carries the structure (as onLoadCif does).
        setSession(newSession(primary, instrument));
        setPowderResult(null);
        setPdfDataset(null);
        setScDataset(ws.dataset);
        setScMagneticDataset(ws.magneticDataset ?? null);
        setRestore((prev) => ({ token: prev.token + 1, singleCrystal: ws }));
        break;
      }
      case "pdf": {
        // Same dormant powder session, but with the file's extra phases so the
        // PDF page (which reads them from the session) sums every phase.
        const extraPhases = structures.slice(1);
        const base = newSession(primary, instrument);
        const spec = buildSpecFor(primary, extraPhases, base.pattern, instrument, true, base.backgroundTerms, base.siteTies, "isotropic");
        setSession({ ...base, extraPhases: [...extraPhases], powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile });
        setPowderResult(null);
        setScNuclearDataset(null);
        setPdfDataset(ws.pattern);
        setRestore((prev) => ({ token: prev.token + 1, pdf: ws }));
        break;
      }
    }
    setOwnStructure(true);
    setDemo(null);
    // The magnetic page exists for every technique except a PDF that cannot
    // carry a magnetic term (X-ray, or multi-phase) — stay on the nuclear page there.
    const wantStep = file.view?.step === 1 ? 1 : 0;
    const magneticPage = ws.technique !== "pdf" || (ws.pattern.scatteringType === "neutron" && structures.length === 1);
    setStep(magneticPage ? wantStep : 0);
    setProjectMeta({ title: file.metadata.title, createdAt: file.metadata.createdAt, ...(file.metadata.notes !== undefined ? { notes: file.metadata.notes } : {}) });
    setNotice(null);
    setMessage(`Opened project “${file.metadata.title}” — ${TECHNIQUE_LABEL[ws.technique]}, saved by v${file.metadata.appVersion}.`);
  }

  // Unified, auto-detecting data loader: the resolver classifies the file
  // (powder vs single-crystal) and, for powder, its x-unit, then dispatches.
  function onLoadData(file: File): void {
    file.text().then((text) => {
      try {
        // A project file dropped on any load button opens as a project.
        if (looksLikeProjectFile(text)) {
          openProjectText(text, file.name);
          return;
        }
        // Any data load is the user's own content — no longer the pristine demo.
        setDemoActive(false);
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
        if (fmt.dataType === "pdf") {
          // PDFgui .fgr fit exports carry the CALCULATED curve in the G(r)
          // column — rebuild the observed one instead of mis-reading it.
          const parsed = looksLikeFgr(text, file.name)
            ? fgrToPattern(parseFgr(text), { id: `${structure.id}-pdf`, filename: file.name })
            : parsePdfData(text, { id: `${structure.id}-pdf`, filename: file.name });
          if (parsed.points.length < 3) throw new Error("fewer than 3 usable G(r) rows");
          setScNuclearDataset(null);
          setPdfDataset(parsed);
          setStep(0);
          const provenance =
            parsed.sourceKind === "sq" ? " (S(Q) → G(r) transformed at load)" :
            parsed.sourceKind === "fq" ? " (F(Q) → G(r) transformed at load)" :
            parsed.sourceKind === "fgr" ? " (PDFgui fit export: Gobs = Gcalc + Gdiff)" : "";
          setMessage(
            `Loaded PDF “${file.name}” · ${parsed.points.length} pts · ${parsed.scatteringType} ${tag}` +
            `${parsed.qmax !== undefined ? ` · Qmax ${parsed.qmax}` : ""}${provenance}. Real-space G(r) fit ready. ${fmt.note}`,
          );
          return;
        }
        if (fmt.dataType === "single-crystal") {
          // Pairing convention (Phase 3): a `<name>_mag.*` file loaded while a
          // nuclear dataset is present is routed to the magnetic partner (for
          // joint co-refinement) rather than replacing the nuclear set — so a
          // `_nuc` + `_mag` pair loads as one session. A `_nuc`/plain file is the
          // nuclear set (and clears any stale magnetic partner via the setter).
          if (/_mag\.[^.]+$/i.test(file.name) && scDataset) {
            onLoadMagneticData(file);
            return;
          }
          const loaded = loadReflectionDataset(text, structure, `${structure.id}-hkl`, file.name);
          if (loaded.kept < 1) throw new Error("no usable reflections in the file");
          setPdfDataset(null);
          setScNuclearDataset(loaded.dataset);
          setMessage(
            `Loaded single-crystal “${file.name}” · ${loaded.kept} reflections [${loaded.format}]` +
            `${describeDrops(loaded)}. Merge report + F² refinement ready.`,
          );
          return;
        }
        setScNuclearDataset(null); // powder data → leave single-crystal mode
        setPdfDataset(null); // …and PDF mode
        applyPowder(text, file.name, fmt, tag);
      } catch (e) {
        setMessage(`Data load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // Phase 2: load a COMPANION magnetic reflection file (.int/.hkl) to co-refine
  // with the already-loaded nuclear dataset. Kept separate from onLoadData (which
  // would replace the nuclear dataset); this only pairs a second file.
  function onLoadMagneticData(file: File): void {
    if (!scDataset) { setMessage("Load the nuclear reflections first, then add the magnetic file."); return; }
    file.text().then((text) => {
      try {
        const loaded = loadReflectionDataset(text, structure, `${structure.id}-mag-hkl`, file.name, { role: "magnetic" });
        if (loaded.kept < 1) throw new Error("no usable reflections in the magnetic file");
        setScMagneticDataset(loaded.dataset);
        setMessage(
          `Loaded magnetic “${file.name}” · ${loaded.kept} reflections [${loaded.format}]` +
          `${describeDrops(loaded)}. Joint nuclear + magnetic co-refinement ready.`,
        );
      } catch (e) {
        setMessage(`Magnetic data load failed: ${e instanceof Error ? e.message : String(e)}`);
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
    setScNuclearDataset(null);
    setPdfDataset(null);
    const wavelength = parsed.wavelength ?? cw?.wavelength ?? 2.5;
    const inst: InstrumentParameters = cw ?? { kind: "constantWavelength", radiationKind: "neutron", wavelength };
    const spec = buildPowderSpec(structure, parsed, inst, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename, rawData: { name: filename, text } }));
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
    setScNuclearDataset(null);
    setPdfDataset(null);
    const inst: InstrumentParameters = cw ?? { kind: "constantWavelength", radiationKind: "neutron", wavelength };
    const spec = buildPowderSpec(structure, parsed, inst, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename, rawData: { name: filename, text } }));
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
          rawData: { name: filename, text },
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
      setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename, rawData: { name: filename, text } }));
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
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename, rawData: { name: filename, text } }));
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
          return { ...s, pattern, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, rawInstrument: { name: file.name, text } };
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
  const headerExports: ExportAction[] = pdfDataset
    ? [
        { label: "CIF", onClick: () => pdfExports.current?.cif?.() },
        { label: "CSV", onClick: () => pdfExports.current?.csv?.() },
        { label: "Report", onClick: () => pdfExports.current?.report?.() },
      ]
    : scDataset
    ? [
        { label: "CIF", onClick: () => scExports.current?.cif?.() },
        { label: ".int", onClick: () => scExports.current?.scInt?.() },
      ]
    : [
        { label: session.magnetic && session.magnetic.moments.length > 0 ? "mCIF" : "CIF", onClick: () => powderExports.current?.cif?.() },
        { label: "CSV", onClick: () => powderExports.current?.csv?.() },
        { label: "GSAS-II bundle (.zip)", onClick: () => powderExports.current?.gsas2Bundle?.() },
        { label: "FullProf bundle (.zip)", onClick: () => powderExports.current?.fullprofBundle?.() },
      ];

  // The workbench opens clean: until the user loads the demo or their own CIF
  // (which replaces the empty session), the shell shows the landing view and
  // hides the workflow steps, exports, and disclaimer.
  const hasContent = session.powderSource !== EMPTY_SOURCE || scDataset !== null || pdfDataset !== null;

  return (
    // The shell is exactly the window: header, disclaimer and footer are fixed
    // chrome and the content column between them takes the rest. That is what
    // lets a working row fill a 16:9 screen without anyone computing how tall
    // the chrome happens to be — and a page whose content genuinely exceeds the
    // window (the magnetic workflow, single crystal) scrolls inside the column
    // instead of pushing the footer off-screen.
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <WorkbenchHeader
        steps={hasContent ? (pdfDataset ? pdfSteps(pdfDataset, session.extraPhases.length) : scDataset ? SC_STEPS : STEPS) : IDLE_STEPS}
        active={step}
        onStep={setStep}
        version={`v${APP_VERSION}`}
        exports={hasContent ? headerExports : []}
        technique={hasContent ? (pdfDataset ? "pdf" : scDataset ? "sc" : "rietveld") : null}
        demos={DEMOS}
        activeDemo={demo}
        onLoadDemo={onLoadDemo}
        onExitDemo={onExitDemo}
        onOpenProject={onOpenProject}
        {...(hasContent ? { onSaveProject } : {})}
      />
      {notice && (
        <div role="alert" style={noticeBar}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button onClick={() => setNotice(null)} style={noticeClose} title="Dismiss">✕</button>
        </div>
      )}
      {hasContent && (
        <div style={disclaimerBar}>
          <b>Public beta</b> — validated against published reference fits for the cases in its docs, not for
          yours. Reproduce anything you intend to publish in{" "}
          {crossCheckTargets(pdfDataset ? "pdf" : scDataset ? "sc" : "rietveld")}; agreement is the evidence.
          Unmodelled effects:{" "}
          <a href={LIMITATIONS_URL} target="_blank" rel="noreferrer" style={disclaimerLink}>
            limitations
          </a>
          .
        </div>
      )}
      {/* The powder engine stays mounted in single-crystal mode (hidden) so all
          its state — fit range, plot mode, k-search picks — survives switching.
          On a clean start it renders its load cards + an empty-state placeholder. */}
      <PowderWorkbench
        session={session}
        setSession={setSession}
        powderResult={powderResult}
        setPowderResult={setPowderResult}
        instrument={instrument}
        instrumentLoaded={instrumentLoaded}
        ownStructure={ownStructure}
        client={client.current}
        active={!scDataset && !pdfDataset}
        step={step}
        onStep={setStep}
        setMessage={setMessage}
        exportsRef={powderExports}
        onLoadData={onLoadData}
        onLoadCif={onLoadCif}
        onAddPhase={onAddPhase}
        onRemovePhase={onRemovePhase}
        onClearStructures={onClearStructures}
        onLoadInstrument={onLoadInstrument}
        onLoadDemo={onLoadDemo}
        onOpenProject={onOpenProject}
        {...(restore.powderView ? { viewRestore: restore.powderView } : {})}
      />
      {pdfDataset && (
        // PDF mode (auto-switched on loading a reduced .gr). Keyed on the dataset
        // id so a new file remounts with a fresh parameter set.
        <main className="wb-main" style={{ flex: 1 }}>
          <PdfWorkbench key={`${pdfDataset.id}#${restore.token}`} structure={structure} pattern={pdfDataset} extraPhases={session.extraPhases} ownStructure={ownStructure} client={client.current} step={step} onStep={setStep} exportsRef={pdfExports} onLoadData={onLoadData} onLoadCif={onLoadCif} onAddPhase={onAddPhase} onRemovePhase={onRemovePhase} {...(demo === "pdf" ? { presetValues: gata4se8PdfExample().refinedParams, presetFitRange: gata4se8PdfExample().fitRange } : {})} {...(restore.pdf ? { restore: restore.pdf } : {})} />
        </main>
      )}
      {scDataset && (
        // Single-crystal mode (auto-switched on loading hkl/fcf data). Keyed on
        // the dataset id so a new file remounts with a fresh parameter set.
        <main className="wb-main" style={{ flex: 1 }}>
          <SingleCrystalWorkbench key={`${scDataset.id}#${restore.token}`} structure={structure} dataset={scDataset} magneticDataset={scMagneticDataset} client={client.current} step={step} onStep={setStep} {...(instrumentLoaded && instrument.kind === "constantWavelength" && instrument.radiationKind ? { instrumentProbe: instrument.radiationKind } : {})} exportsRef={scExports} onLoadData={onLoadData} onLoadMagneticData={onLoadMagneticData} onLoadCif={onLoadCif} {...(restore.singleCrystal ? { restore: restore.singleCrystal } : {})} />
        </main>
      )}
      <footer style={copyrightBar}>
        <span>© 2026 Tsung-Han Yang</span>
        <span aria-hidden style={{ color: theme.faintest }}>·</span>
        <a href="https://github.com/drthyang/web-refinement#readme" target="_blank" rel="noopener noreferrer" style={footerLink}>
          About &amp; documentation
        </a>
      </footer>
    </div>
  );
}

/**
 * The package a user should reproduce THIS technique's result in. Naming the
 * right one beats a generic "established tools": a PDF user told to check
 * against GSAS-II learns nothing, and the reference implementations differ per
 * technique (real space vs reciprocal space vs single crystal).
 */
function crossCheckTargets(technique: "rietveld" | "pdf" | "sc"): string {
  switch (technique) {
    case "pdf":
      // The real-space references, including the magnetic term the PDF page can
      // add — diffpy.mpdf is the only implementation of it worth checking against.
      return "PDFgui / diffpy-CMI (PDFfit2), or diffpy.mpdf for a magnetic PDF";
    case "sc":
      return "SHELXL, JANA2020, or FullProf";
    default:
      return "GSAS-II or FullProf (Export ▸ bundle writes both decks)";
  }
}

const LIMITATIONS_URL = "https://github.com/drthyang/web-refinement/blob/main/docs/LIMITATIONS.md";

const noticeBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "8px 24px", fontSize: 12.5, background: theme.warnBg, borderBottom: `1px solid ${theme.warnBorder}`, color: theme.warnInk, lineHeight: 1.45 };
const noticeClose: React.CSSProperties = { border: "none", background: "transparent", color: theme.warnInk, cursor: "pointer", fontSize: 13, padding: "0 4px" };
const disclaimerBar: React.CSSProperties = { padding: "7px 24px", fontSize: 11.5, background: theme.warnBg, borderBottom: `1px solid ${theme.warnBorder}`, color: theme.warnInk, lineHeight: 1.45 };
const disclaimerLink: React.CSSProperties = { color: theme.warnInk, textDecoration: "underline" };
const copyrightBar: React.CSSProperties = { display: "flex", justifyContent: "center", alignItems: "center", gap: 8, padding: "10px 24px", fontSize: 11, color: theme.faint, borderTop: `1px solid ${theme.border}`, background: theme.raised };
const footerLink: React.CSSProperties = { color: theme.secondary, textDecoration: "none" };
