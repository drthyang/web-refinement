/**
 * The validation cases (docs/VALIDATION.md, "Does the Agent help?"): pages
 * whose answer is known, split into a dev set (used to improve the tools and
 * skills; the researcher rounds' data and the eval scenarios' pages) and a
 * held-out test set (used only for the reported numbers: structures, faults
 * and data no skill, knowledge note, tool description or eval scenario was
 * written against; validation.test.ts enforces it).
 *
 * Every case is scored by the same functions (scoring.ts) with the
 * tolerances below, fixed before any run. Each tolerance is a physical one,
 * not a fitted one; the test pins the table, so a change is a reviewed edit.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { PowderAgentPort } from "@/agent/port";
import type { Session } from "@/app/powderSession";
import { loadedSession } from "@/app/powderSession";
import { sessionPort } from "@/testSupport/agentHeadless";
import { dataDir } from "@/testSupport/data";
import { knownPhaseStructure } from "@/core/diagnostics/knownPhases";
import { generateReflections } from "@/core/diffraction/reflections";
import { exampleStructure } from "@/examples/mn3ga";
import { parse_instrument, parse_powder_data, parse_structure } from "@/mcp/tools";
import { example3Loaded } from "@/agent/validation/example3";
import { impurityD, mn3gaFluoriteSession, mn3gaImpuritySession, mn3gaMisfitSession, mn3gaSession, mn3gaSwappedUnitsSession, mn3gaWrongWavelengthSession } from "@/agent/evals/pages";
import {
  WAVELENGTH, asDSpacingsLabelledTwoTheta, atWavelength, cif, openedSession, simulatePowder, structureOf, validationInstrument, withLine,
} from "@/agent/validation/simulate";

/**
 * The tolerances a recovered value is scored with, and why (docs/VALIDATION.md):
 *
 * - cellRelative 2e-4: what a calibrated constant-wavelength instrument gives
 *   (λ known to about 1 part in 10⁴); a wavelength 1 % off moves the cell 50×
 *   this, so the two are told apart.
 * - positionAngstrom 0.01 Å: a bond length to 0.01 Å, the precision powder
 *   structures are quoted to; 0.01 Å moves a bond valence by under 3 %
 *   (b = 0.37 Å, Brese & O'Keeffe 1991).
 * - bIso 0.25 Å²: powder B values scatter by a few tenths of an Å² between
 *   careful refinements of the same data (the PbSO₄ round robin, Hill 1992),
 *   their correlation with background and absorption being what limits them.
 * - weightPercent 1.0 wt %: the absolute accuracy of a minor phase in the
 *   quantitative-phase-analysis round robin (Madsen et al. 2001).
 * - gofAcceptable 1.5: GoF = Rwp/Rexp of a correct model on counting-noise
 *   data is ≈ 1; 1.5 is the edge of assess_refinement's "excellent" band
 *   (Toby 2006). A fit above it on a simulated pattern has a wrong model or
 *   is in a false minimum.
 * - lineD 0.005 (relative): a reported unexplained line is the injected one
 *   when its d is within 0.5 % (a few line widths at mid angle).
 */
export const TOLERANCES = {
  cellRelative: 2e-4,
  positionAngstrom: 0.01,
  bIso: 0.25,
  weightPercent: 1.0,
  gofAcceptable: 1.5,
  lineD: 0.005,
} as const;

export type Split = "dev" | "test";

export type FaultKind = "wavelength" | "units" | "centring" | "impurity" | "unexplained-line" | "magnetic";

export interface Fault {
  readonly kind: FaultKind;
  /** What was injected, for the transcript. */
  readonly detail: string;
  /** Whether the Agent can put it right with its tools (a wrong wavelength or model needs the user). */
  readonly recoverable: boolean;
  /** An impurity's or magnetic group's name, as the run must give it. */
  readonly names?: RegExp;
  /** The unexplained line's d (Å). */
  readonly lineD?: number;
}

export type Truth =
  | { readonly kind: "cell"; readonly phase: number; readonly axis: "a" | "b" | "c"; readonly value: number }
  | { readonly kind: "position"; readonly phase: number; readonly site: string; readonly value: Vec3 }
  | { readonly kind: "bIso"; readonly phase: number; readonly site: string; readonly value: number }
  | { readonly kind: "weightPercent"; readonly phase: RegExp; readonly value: number };

export interface ValidationCase {
  readonly id: string;
  readonly split: Split;
  readonly title: string;
  /** Where the case comes from: a structure's reference, or the round or scenario it was taken from. */
  readonly source: string;
  readonly fault: Fault | null;
  /** The values the run must recover (empty when no recovery is possible without the user). */
  readonly truth: readonly Truth[];
  /** The fit must reach GoF ≤ TOLERANCES.gofAcceptable (a correct model on simulated data). */
  readonly fitMustBeGood: boolean;
  readonly session: () => Session;
  /** What the user types, when not MESSAGE (dev cases only: the test set's message names no fault). */
  readonly message?: string;
  /** False when the case's data are not on this machine (a public dataset kept out of git). */
  readonly available?: () => boolean;
}

/** What the user types, the same for every case and arm: it names no fault. */
export const MESSAGE = "Refine this pattern against the loaded structure and report the result. Tell me if anything about the data or the model looks wrong.";

/** The page a case opens on. */
export function casePage(c: ValidationCase): PowderAgentPort {
  return sessionPort(c.session(), validationInstrument(), { instrumentOnPage: true }).port;
}

/** Every refinable value of a structure as truth: its cell lengths, each site's position and B. */
function truthOf(s: StructureModel, phase = 0, opts: { readonly positions?: boolean; readonly b?: boolean } = {}): Truth[] {
  const axes: ("a" | "b" | "c")[] = ["a"];
  if (Math.abs(s.cell.b - s.cell.a) > 1e-6) axes.push("b");
  if (Math.abs(s.cell.c - s.cell.a) > 1e-6) axes.push("c");
  return [
    ...axes.map((axis) => ({ kind: "cell" as const, phase, axis, value: s.cell[axis] })),
    ...(opts.positions === false ? [] : s.sites.map((x) => ({ kind: "position" as const, phase, site: x.label, value: [...x.position] as Vec3 }))),
    ...(opts.b === false ? [] : s.sites.flatMap((x) => (x.adp?.kind === "isotropic" ? [{ kind: "bIso" as const, phase, site: x.label, value: x.adp.bIso }] : []))),
  ];
}

// ── The held-out structures (test set) ──────────────────────────────────────
// Rutile, after Burdett et al. (1987) J. Am. Chem. Soc. 109, 3639.
const RUTILE = cif("TiO2", [4.5937, 4.5937, 2.9587, 90, 90, 90], "P 42/m n m", ["Ti1 Ti 0 0 0 1 0.45", "O1 O 0.3048 0.3048 0 1 0.60"]);
/** A start a real one is like: an older cell (−0.2 %), O off by 0.02 Å, B values guessed. */
const RUTILE_START = cif("TiO2", [4.5845, 4.5845, 2.9533, 90, 90, 90], "P 42/m n m", ["Ti1 Ti 0 0 0 1 1.0", "O1 O 0.3000 0.3000 0 1 1.0"]);
/** The CIF the strained case opens on: a 1.2 % long, c 0.8 % short of the sample's. */
const RUTILE_STRAINED_CIF = cif("TiO2", [4.6488, 4.6488, 2.9350, 90, 90, 90], "P 42/m n m", ["Ti1 Ti 0 0 0 1 0.45", "O1 O 0.3048 0.3048 0 1 0.60"]);
// Calcite, after Maslen et al. (1995) Acta Cryst. B51, 929.
const CALCITE = cif("CaCO3", [4.9896, 4.9896, 17.0610, 90, 90, 120], "R -3 c", ["Ca1 Ca 0 0 0 1 0.55", "C1 C 0 0 0.25 1 0.50", "O1 O 0.2570 0 0.25 1 0.85"]);
const CALCITE_START = cif("CaCO3", [4.9846, 4.9846, 17.0440, 90, 90, 120], "R -3 c", ["Ca1 Ca 0 0 0 1 1.0", "C1 C 0 0 0.25 1 1.0", "O1 O 0.2500 0 0.25 1 1.0"]);
// Wurtzite ZnO, after Kisi & Elcombe (1989) Acta Cryst. C45, 1867.
const ZNO = cif("ZnO", [3.2496, 3.2496, 5.2042, 90, 90, 120], "P 63 m c", ["Zn1 Zn 0.33333 0.66667 0 1 0.55", "O1 O 0.33333 0.66667 0.3819 1 0.65"]);
// NiAl (B2, CsCl type), ordered, a = 2.887 Å (b_Ni 10.3 fm against b_Al 3.45 fm: strong superstructure
// lines); the model offered is the disordered bcc cell (Im-3m), Ni and Al sharing one site.
const NIAL = cif("NiAl", [2.887, 2.887, 2.887, 90, 90, 90], "P m -3 m", ["Ni1 Ni 0 0 0 1 0.40", "Al1 Al 0.5 0.5 0.5 1 0.50"]);
const NIAL_BCC = cif("NiAl", [2.887, 2.887, 2.887, 90, 90, 90], "I m -3 m", ["Ni1 Ni 0 0 0 0.5 0.45", "Al1 Al 0 0 0 0.5 0.45"]);

const s = structureOf;

/** Where a line between the reflections of `st` has the widest gap (d, Å), between d = 1.2 and 4 Å. */
export function gapD(st: StructureModel): number {
  const ds = [...new Set(generateReflections(st.cell, st.spaceGroup, 1.2, 4).map((r) => +r.d.toFixed(4)))].sort((a, b) => b - a);
  let best = { gap: 0, d: 2 };
  for (let i = 0; i + 1 < ds.length; i++) {
    const gap = ds[i]! / ds[i + 1]! - 1;
    if (gap > best.gap) best = { gap, d: Math.sqrt(ds[i]! * ds[i + 1]!) };
  }
  return +best.d.toFixed(4);
}

const CALCITE_LINE_D = gapD(s(CALCITE, "calcite"));

const TEST: readonly ValidationCase[] = [
  {
    id: "rutile-start-off",
    split: "test",
    title: "Rutile TiO₂ from an older CIF: the cell 0.2 % small, O 0.02 Å off, B values guessed",
    source: "simulated from rutile (Burdett et al. 1987); no fault",
    fault: null,
    truth: truthOf(s(RUTILE, "rutile")),
    fitMustBeGood: true,
    session: () => openedSession(s(RUTILE_START, "rutile"), simulatePowder({ phases: [s(RUTILE, "rutile")], seed: 101 })),
  },
  {
    id: "calcite-start-off",
    split: "test",
    title: "Calcite CaCO₃ from a rough CIF: the cell 0.1 % small, O x at ¼, B values guessed",
    source: "simulated from calcite (Maslen et al. 1995); no fault",
    fault: null,
    truth: truthOf(s(CALCITE, "calcite")),
    fitMustBeGood: true,
    session: () => openedSession(s(CALCITE_START, "calcite"), simulatePowder({ phases: [s(CALCITE, "calcite")], seed: 102 })),
  },
  {
    id: "zno-wrong-wavelength",
    split: "test",
    title: "ZnO measured at 1.54 Å, loaded at 1.5554 Å (1 % long)",
    source: "simulated from wurtzite ZnO (Kisi & Elcombe 1989); fault: the wavelength",
    fault: { kind: "wavelength", detail: "λ 1.5554 Å given, the data measured at 1.54 Å: every d 1 % long", recoverable: false },
    truth: [],
    fitMustBeGood: false,
    session: () => openedSession(s(ZNO, "zno"), atWavelength(simulatePowder({ phases: [s(ZNO, "zno")], seed: 103 }), 1.01 * WAVELENGTH)),
  },
  {
    id: "rutile-swapped-units",
    split: "test",
    title: "Rutile TiO₂ whose file holds d-spacings, loaded as 2θ",
    source: "simulated from rutile; fault: the axis unit",
    fault: { kind: "units", detail: "the x column is d (Å), read as 2θ (°)", recoverable: false },
    truth: [],
    fitMustBeGood: false,
    session: () => openedSession(s(RUTILE, "rutile"), asDSpacingsLabelledTwoTheta(simulatePowder({ phases: [s(RUTILE, "rutile")], seed: 104 }))),
  },
  {
    id: "nial-wrong-centring",
    split: "test",
    title: "Ordered NiAl (Pm-3m) offered a disordered body-centred model (Im-3m)",
    source: "simulated from B2 NiAl; fault: the model's centring forbids the h+k+l odd lines the data hold",
    fault: { kind: "centring", detail: "the data are primitive (Pm-3m, ordered); the model is I-centred, Ni and Al sharing one site", recoverable: false },
    truth: [],
    fitMustBeGood: false,
    session: () => openedSession(s(NIAL_BCC, "nial"), simulatePowder({ phases: [s(NIAL, "nial")], seed: 105 })),
  },
  {
    id: "zno-nacl-impurity",
    split: "test",
    title: "ZnO with 4 wt % NaCl the model does not hold",
    source: "simulated from ZnO + rock salt (the knownPhases cell); fault: a known impurity",
    fault: { kind: "impurity", detail: "NaCl at 4.0 wt %", recoverable: true, names: /\bNaCl\b|rock ?salt|halite|sodium chloride/i },
    truth: [...truthOf(s(ZNO, "zno"), 0, { positions: false }), { kind: "weightPercent", phase: /NaCl/i, value: 4.0 }],
    fitMustBeGood: true,
    session: () => openedSession(s(ZNO, "zno"), simulatePowder({ phases: [s(ZNO, "zno"), knownPhaseStructure("NaCl")!], minorWeightPercent: [4], seed: 106 })),
  },
  {
    id: "calcite-unknown-line",
    split: "test",
    title: "Calcite with one line no phase explains (an unidentified impurity)",
    source: "simulated from calcite; fault: a line at a d no reflection of calcite or of the known-phase library has",
    fault: { kind: "unexplained-line", detail: `one line at d = ${CALCITE_LINE_D} Å, 600 counts`, recoverable: false, lineD: CALCITE_LINE_D },
    truth: truthOf(s(CALCITE, "calcite")),
    fitMustBeGood: false,
    session: () => openedSession(s(CALCITE, "calcite"), withLine(simulatePowder({ phases: [s(CALCITE, "calcite")], seed: 107 }), CALCITE_LINE_D, 600)),
  },
  {
    id: "rutile-cell-strained",
    split: "test",
    title: "Rutile TiO₂ whose cell differs from the CIF anisotropically (a −1.2 %, c +0.8 %): a false minimum for a fit from the CIF's cell",
    source: "simulated from rutile; the CIF is the unstrained cell. No wavelength error can do this: it scales every d alike",
    fault: null,
    truth: truthOf(s(RUTILE, "rutile")),
    fitMustBeGood: true,
    session: () => openedSession(s(RUTILE_STRAINED_CIF, "rutile"), simulatePowder({ phases: [s(RUTILE, "rutile")], seed: 108 })),
  },
];

// ── The dev set: the pages the eval scenarios and researcher rounds used ───
const MN3GA_TRUTH = (): Truth[] => truthOf(exampleStructure(), 0, { positions: true });

/**
 * A public dataset with a published refinement, where it is on this machine:
 * data/validation/<id>/case.json names the files (structure, data, instrument)
 * and the published values ({ "truth": [Truth…], "source": citation }). The
 * data stay out of git; only this loader is committed.
 */
function publicCase(id: string, title: string, split: Split): ValidationCase {
  const dir = (): string => join(dataDir("validation"), id);
  const spec = (): { files: { structure: string; data: string; instrument: string }; truth: Truth[]; source: string } =>
    JSON.parse(readFileSync(join(dir(), "case.json"), "utf8"));
  return {
    id,
    split,
    title,
    source: "public tutorial data with a published refinement (data/validation, git-ignored)",
    fault: null,
    get truth() {
      return existsSync(join(dir(), "case.json")) ? spec().truth : [];
    },
    fitMustBeGood: false,
    available: () => existsSync(join(dir(), "case.json")),
    session: () => {
      const c = spec();
      const read = (f: string): string => readFileSync(join(dir(), f), "utf8");
      const instrument = parse_instrument({ text: read(c.files.instrument) });
      const { structure } = parse_structure({ cif: read(c.files.structure), id });
      const { pattern } = parse_powder_data({ text: read(c.files.data), filename: c.files.data, instrument });
      return loadedSession(structure, pattern, instrument);
    },
  };
}

// CsCl, the cell check's own development case (mcp/cellSymmetry.test.ts: CsCl declared I-centred): the dev analog of the centring fault.
const CSCL = cif("CsCl", [4.123, 4.123, 4.123, 90, 90, 90], "P m -3 m", ["Cs1 Cs 0 0 0 1 1.6", "Cl1 Cl 0.5 0.5 0.5 1 1.9"]);
const CSCL_BCC = cif("CsCl", [4.123, 4.123, 4.123, 90, 90, 90], "I m -3 m", ["Cs1 Cs 0 0 0 0.5 1.7", "Cl1 Cl 0 0 0 0.5 1.7"]);

/** The Mn₃Ga demo opened on a cell strained against the data's: a 1.2 % long, c 0.8 % short (the dev analog of the strained cell). */
function mn3gaStrainedSession(): Session {
  const s0 = mn3gaSession();
  const factor: Record<string, number> = { cell_a: 1.012, cell_c: 0.992 };
  return { ...s0, powderParams: s0.powderParams.map((p) => (p.id in factor ? { ...p, value: p.value * factor[p.id]!, initialValue: p.value * factor[p.id]! } : p)) };
}

const DEV: readonly ValidationCase[] = [
  {
    id: "dev-mn3ga-misfit",
    split: "dev",
    title: "The Mn₃Ga demo from a start off in ADPs, the Mn position and the peak width",
    source: "eval scenario misfits-not-extra-peaks (pages.ts)",
    fault: null,
    truth: MN3GA_TRUTH(),
    fitMustBeGood: true,
    session: mn3gaMisfitSession,
  },
  {
    id: "dev-mn3ga-fluorite",
    split: "dev",
    title: "The Mn₃Ga demo with fluorite lines (round 10's by-product)",
    source: "eval scenario known-impurity (pages.ts)",
    fault: { kind: "impurity", detail: "CaF₂ lines at a few per cent", recoverable: true, names: /CaF|fluorite/i },
    truth: [],
    fitMustBeGood: false,
    session: mn3gaFluoriteSession,
  },
  {
    id: "dev-mn3ga-wrong-wavelength",
    split: "dev",
    title: "The Mn₃Ga demo loaded at 1.556 Å",
    source: "eval scenario wrong-wavelength (pages.ts)",
    fault: { kind: "wavelength", detail: "λ 1.556 Å given, 1.54 Å measured", recoverable: false },
    truth: [],
    fitMustBeGood: false,
    session: mn3gaWrongWavelengthSession,
  },
  {
    id: "dev-mn3ga-swapped-units",
    split: "dev",
    title: "The Mn₃Ga demo's d-spacings loaded as 2θ",
    source: "eval scenario swapped-units (pages.ts)",
    fault: { kind: "units", detail: "the x column is d (Å), read as 2θ (°)", recoverable: false },
    truth: [],
    fitMustBeGood: false,
    session: mn3gaSwappedUnitsSession,
  },
  {
    id: "dev-example3-magnetic",
    split: "dev",
    title: "Example 3: Mn₃Ga at 30 K, the magnetic order to find (k = 0, P2₁'/m'; one moments fit stops with Mn1 almost off)",
    source: "docs/AGENT_EXAMPLES.md Example 3 (simulated from src/examples/mn3gaMagnetic.ts)",
    fault: { kind: "magnetic", detail: "magnetic order at k = 0 in P2₁'/m', moments on all three Mn sites", recoverable: true, names: /P2[₁1_]{1,2}'\/m'|P2_1'\/m'/ },
    truth: [],
    fitMustBeGood: false,
    message: "Fit this 30 K neutron pattern with the loaded nuclear structure. If the nuclear model leaves intensity unexplained, find the magnetic order: the propagation vector, the magnetic space group and the Mn moments.",
    session: example3Loaded,
  },
  {
    id: "dev-mn3ga-impurity-line",
    split: "dev",
    title: "The Mn₃Ga demo with one line of an unknown phase between its reflections",
    source: "eval scenario impurity-line (pages.ts)",
    fault: { kind: "unexplained-line", detail: "one line between the Mn₃Ga reflections", recoverable: false, lineD: impurityD() },
    truth: [],
    fitMustBeGood: false,
    session: mn3gaImpuritySession,
  },
  {
    id: "dev-cscl-wrong-centring",
    split: "dev",
    title: "Ordered CsCl offered a disordered body-centred model (the cell check's development case)",
    source: "simulated as mcp/cellSymmetry.test.ts's CsCl declared I-centred",
    fault: { kind: "centring", detail: "the data are primitive (Pm-3m); the model is I-centred", recoverable: false },
    truth: [],
    fitMustBeGood: false,
    session: () => openedSession(s(CSCL_BCC, "cscl"), simulatePowder({ phases: [s(CSCL, "cscl")], seed: 205 })),
  },
  {
    id: "dev-mn3ga-cell-strained",
    split: "dev",
    title: "The Mn₃Ga demo opened on a cell strained against the data (a +1.2 %, c −0.8 %)",
    source: "the demo's pattern; the page's cell altered",
    fault: null,
    truth: truthOf(exampleStructure(), 0, { positions: false, b: false }),
    fitMustBeGood: true,
    session: mn3gaStrainedSession,
  },
  publicCase("pbso4-d1a", "PbSO₄ on D1A (GSAS-II tutorial; the IUCr round robin, Hill 1992)", "dev"),
];

export const VALIDATION_CASES: readonly ValidationCase[] = [...TEST, ...DEV];
export const TEST_CASES = TEST;
export const DEV_CASES = DEV;

/** The held-out structures' names and formulas: none may appear where the Agent is taught (validation.test.ts). */
export const HELD_OUT_TERMS: readonly RegExp[] = [/\brutile\b/i, /\bTiO[2₂]\b/, /titanium dioxide/i, /\bcalcite\b/i, /\bCaCO[3₃]\b/, /calcium carbonate/i, /\bwurtzite\b/i, /\bZnO\b/, /zinc oxide/i, /\bNiAl\b/, /nickel aluminide/i];

export const caseById = (id: string): ValidationCase | undefined => VALIDATION_CASES.find((c) => c.id === id);
