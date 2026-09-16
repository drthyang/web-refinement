/**
 * LOCAL-ONLY magnetic demo — the high-entropy tungstate (Co,Cu,Fe,Mn,Ni,Zn)WO₄
 * ("AWO₄", wolframite-type P2/c) on POWGEN time-of-flight neutron data at 6 K,
 * below its antiferromagnetic ordering: k = (½,0,0) satellites at half-integer
 * h that the paramagnetic 100 K pattern does not have.
 *
 * The data are UNPUBLISHED and never enter the repository or the public build.
 * Everything this demo needs is read at runtime from the git-ignored `data/`
 * folder, which the dev server exposes under `/data/…` (vite.config.ts,
 * `serveLocalData`, dev only):
 *
 *   data/AWO4/autoreduced/PG3_61115.gsa                    the 6 K bank-3 histogram
 *   data/AWO4/GSAS-II_2025B_HR/2025B_HighRes_60HzB3_CWL2p665.instprm
 *   data/AWO4/awo4_demo_solution.json                       the solved structure
 *
 * The solution file is written by `awo4MagneticSolve.test.ts` (run with
 * AWO4_SOLVE=1): staged nuclear refinement → residual k-search → every
 * candidate magnetic group ranked → joint refinement, all with the app's own
 * pipeline. The demo appears in the Demos menu only when these files can be
 * fetched; a deployed site has none of them and shows no AWO₄ demo.
 *
 * The nuclear structure itself (the 100 K refined CIF) is the one already
 * bundled in `highEntropyWO4.ts`.
 */

import { HIGH_ENTROPY_CIF } from "@/examples/highEntropyWO4";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { Vec3 } from "@/core/math/types";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";

/** Where the demo's files live under the (git-ignored) data folder. */
export const AWO4_DEMO_FILES = {
  data: "AWO4/autoreduced/PG3_61115.gsa",
  instrument: "AWO4/GSAS-II_2025B_HR/2025B_HighRes_60HzB3_CWL2p665.instprm",
  solution: "AWO4/awo4_demo_solution.json",
} as const;

const STRUCTURE_ID = "awo4";
const PATTERN_ID = `${STRUCTURE_ID}-powder`;
const PATTERN_NAME = "AWO₄ POWGEN 6 K bank 3 (TOF, λ=2.665 Å) · local data";

/** The solved magnetic structure, as `awo4MagneticSolve.test.ts` writes it. */
export interface Awo4Solution {
  readonly k: Vec3;
  /** Chosen magnetic group (maximal subgroup among the tied best fits). */
  readonly group: string;
  /** Its operations (Jones–Faithful xyz + time reversal), in the parent setting. */
  readonly ops: readonly { readonly xyz: string; readonly timeReversal: 1 | -1 }[];
  /** The magnetic ion sites (co-located 3d cations; Zn²⁺ carries none). */
  readonly ions: readonly string[];
  /** Chebyshev background terms the solve refined with (the session must match). */
  readonly backgroundTerms: number;
  /** Converged values by parameter id — nuclear rows and moment modes. */
  readonly params: Readonly<Record<string, number>>;
  readonly nuclearWr: number;
  readonly jointWr: number;
}

export interface Awo4MagneticExample {
  readonly structure: StructureModel;
  readonly pattern: PowderPattern;
  readonly instrument: InstrumentParameters;
  /** The original files, verbatim, for the cross-check bundles. */
  readonly rawData: { name: string; text: string };
  readonly rawInstrument: { name: string; text: string };
  readonly k: Vec3;
  readonly magneticSites: readonly string[];
  /** The applied magnetic model: the chosen group's operations, moments at the refined amplitudes. */
  readonly magnetic: MagneticModel;
  readonly momentParams: RefinementParameter[];
  readonly momentBindings: ParameterBinding[];
  /** Converged nuclear parameter values by id, for `loadedSession`. */
  readonly refinedParams: Readonly<Record<string, number>>;
  readonly backgroundTerms: number;
  readonly group: string;
  readonly nuclearWr: number;
  readonly jointWr: number;
}

/** Assemble the demo from the three files' text — pure, so tests can feed it from disk. */
export function buildAwo4MagneticExample(files: { data: string; instrument: string; solution: string }): Awo4MagneticExample {
  const solution = JSON.parse(files.solution) as Awo4Solution;
  const structure: StructureModel = { ...parseCif(HIGH_ENTROPY_CIF, STRUCTURE_ID), name: "(Co,Cu,Fe,Mn,Ni,Zn)WO₄" };
  const instrument = parseInstrumentParameters(files.instrument);
  const pattern = parseGsasHistogramPattern(files.data, PATTERN_ID, PATTERN_NAME, { radiation: { kind: "neutron-tof" } });
  const ops: SymmetryOperation[] = solution.ops.map((o) => ({ ...parseSymmetryOperation(o.xyz), timeReversal: o.timeReversal }));
  const build = buildMagneticModel(structure, solution.k, solution.ions, ops, { moment: 2, tieSameSite: true });
  const momentParams = build.params.map((p) => {
    const v = solution.params[p.id] ?? p.value;
    return { ...p, value: v, initialValue: v, fixed: false };
  });
  const magnetic = applyMagneticMoments(build.magnetic, build.bindings, Object.fromEntries(momentParams.map((p) => [p.id, p.value])));
  return {
    structure,
    pattern,
    instrument,
    rawData: { name: AWO4_DEMO_FILES.data.split("/").pop()!, text: files.data },
    rawInstrument: { name: AWO4_DEMO_FILES.instrument.split("/").pop()!, text: files.instrument },
    k: solution.k,
    magneticSites: solution.ions,
    magnetic,
    momentParams,
    momentBindings: build.bindings,
    refinedParams: solution.params,
    backgroundTerms: solution.backgroundTerms,
    group: solution.group,
    nuclearWr: solution.nuclearWr,
    jointWr: solution.jointWr,
  };
}

/** URL of one demo file on the dev server's `/data/` route. */
function dataUrl(rel: string): string {
  return `${import.meta.env.BASE_URL}data/${rel}`;
}

/**
 * Whether the local files are reachable — true only on a dev server with the
 * data folder present. Decides whether the demo is offered at all.
 */
export async function awo4MagneticDemoAvailable(): Promise<boolean> {
  try {
    const res = await fetch(dataUrl(AWO4_DEMO_FILES.solution), { method: "GET", cache: "no-store" });
    if (!res.ok) return false;
    // GitHub Pages answers unknown paths with an HTML 404 page; a real answer is JSON.
    const text = await res.text();
    return text.trimStart().startsWith("{");
  } catch {
    return false;
  }
}

let cached: Promise<Awo4MagneticExample> | null = null;

/** Fetch the local files and assemble the demo (memoized). */
export function loadAwo4MagneticExample(): Promise<Awo4MagneticExample> {
  if (!cached) {
    cached = (async () => {
      const get = async (rel: string): Promise<string> => {
        const res = await fetch(dataUrl(rel), { cache: "no-store" });
        if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
        return res.text();
      };
      const [data, instrument, solution] = await Promise.all([
        get(AWO4_DEMO_FILES.data),
        get(AWO4_DEMO_FILES.instrument),
        get(AWO4_DEMO_FILES.solution),
      ]);
      return buildAwo4MagneticExample({ data, instrument, solution });
    })().catch((e: unknown) => {
      cached = null; // let a later attempt retry
      throw e;
    });
  }
  return cached;
}
