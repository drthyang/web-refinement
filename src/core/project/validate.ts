/**
 * Structural validation of a project document (schema v2).
 *
 * The reader never trusts a file: after JSON.parse and migration, every field
 * the app will touch is checked for presence and type, ids are checked for
 * uniqueness and referential integrity (bindings → parameters, magnetic model →
 * primary phase and its sites), and — the guard this format exists for — the
 * **workspace is validated by its `technique` tag**. Each technique has its own
 * branch that knows what its dataset looks like, so PDF data labelled as a
 * powder pattern (or the reverse) is refused with a message that names the
 * mismatch instead of surfacing later as a blank plot or a NaN fit.
 *
 * Errors are `ProjectFileError`s whose message starts with the JSON path of the
 * offending field (`workspace.pattern.points[12].yObs: expected a finite
 * number, got null`).
 *
 * Reading is lenient where writing is strict: an optional field written as
 * `null` is accepted as absent (the serializer never writes one).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { ProjectFile, Workspace } from "@/core/project/types";
import { STEP_ACTORS, STEP_KINDS } from "@/core/project/history";
import {
  PROJECT_SCHEMA_VERSION,
  TECHNIQUES,
  SINGLE_CRYSTAL_PROBES,
  PDF_POSITION_MODES,
} from "@/core/project/types";
import { MUSTRAIN_MODELS, PEAK_CORRECTION_IDS } from "@/core/workflow/powderModelOptions";
import { EXTINCTION_MODELS } from "@/core/diffraction/singleCrystalFactors";

export class ProjectFileError extends Error {
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "ProjectFileError";
  }
}

type Rec = Record<string, unknown>;
type Check<T> = (v: unknown, path: string) => T;

export function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "nothing";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 37)}…` : v);
  return String(v);
}

function fail(path: string, message: string): never {
  throw new ProjectFileError(`${path}: ${message}`, path);
}

const rec: Check<Rec> = (v, path) => (isRecord(v) ? v : fail(path, `expected an object, got ${describe(v)}`));
const arr: Check<unknown[]> = (v, path) => (Array.isArray(v) ? v : fail(path, `expected an array, got ${describe(v)}`));
const str: Check<string> = (v, path) => (typeof v === "string" ? v : fail(path, `expected a string, got ${describe(v)}`));
const bool: Check<boolean> = (v, path) => (typeof v === "boolean" ? v : fail(path, `expected true or false, got ${describe(v)}`));
const num: Check<number> = (v, path) =>
  typeof v === "number" && Number.isFinite(v) ? v : fail(path, `expected a finite number, got ${describe(v)}`);
const int: Check<number> = (v, path) => {
  const n = num(v, path);
  return Number.isInteger(n) ? n : fail(path, `expected an integer, got ${n}`);
};

function oneOf<T extends string>(allowed: readonly T[]): Check<T> {
  return (v, path) =>
    typeof v === "string" && (allowed as readonly string[]).includes(v)
      ? (v as T)
      : fail(path, `expected one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}, got ${describe(v)}`);
}

/** Optional field: absent (or null) passes; present must satisfy `check`. */
function opt<T>(v: unknown, path: string, check: Check<T>): T | undefined {
  return v === undefined || v === null ? undefined : check(v, path);
}

function numbers(n: number): Check<void> {
  return (v, path) => {
    const a = arr(v, path);
    if (a.length !== n) fail(path, `expected ${n} components, got ${a.length}`);
    a.forEach((c, i) => num(c, `${path}[${i}]`));
  };
}
const vec3 = numbers(3);
const vec6 = numbers(6);
const strings3: Check<void> = (v, path) => {
  const a = arr(v, path);
  if (a.length !== 3) fail(path, `expected 3 components, got ${a.length}`);
  a.forEach((c, i) => str(c, `${path}[${i}]`));
};

function each(v: unknown, path: string, check: (item: unknown, itemPath: string, index: number) => void): unknown[] {
  const a = arr(v, path);
  a.forEach((item, i) => check(item, `${path}[${i}]`, i));
  return a;
}

// ---------------------------------------------------------------------------
// Shared domain shapes
// ---------------------------------------------------------------------------

const RADIATION_KINDS = ["neutron", "xray", "neutron-tof"] as const;
const X_UNITS = ["twoTheta", "dSpacing", "q", "tof"] as const;
const PEAK_SHAPES = ["gaussian", "pseudoVoigt", "tof"] as const;
const BACKGROUND_TYPES = ["chebyshev", "cosine", "powerSeries", "linInterpolate", "logInterpolate", "polynomial"] as const;
const STATUSES = ["converged", "maxIterations", "stalled", "diverged", "failed"] as const;
const PDF_SOURCE_KINDS = ["gr", "sq", "fq", "fgr", "fgr-diff"] as const;

function checkSymmetryOperation(v: unknown, path: string): void {
  const op = rec(v, path);
  each(op.rotation, `${path}.rotation`, (row, p) => vec3(row, p));
  if ((op.rotation as unknown[]).length !== 3) fail(`${path}.rotation`, "expected a 3×3 matrix");
  vec3(op.translation, `${path}.translation`);
  str(op.xyz, `${path}.xyz`);
  if (op.timeReversal !== undefined && op.timeReversal !== null && op.timeReversal !== 1 && op.timeReversal !== -1) {
    fail(`${path}.timeReversal`, `expected 1 or -1, got ${describe(op.timeReversal)}`);
  }
}

function checkStructure(v: unknown, path: string): void {
  const s = rec(v, path);
  str(s.id, `${path}.id`);
  str(s.name, `${path}.name`);
  const cell = rec(s.cell, `${path}.cell`);
  for (const k of ["a", "b", "c", "alpha", "beta", "gamma"]) num(cell[k], `${path}.cell.${k}`);
  const sg = rec(s.spaceGroup, `${path}.spaceGroup`);
  const ops = each(sg.operations, `${path}.spaceGroup.operations`, checkSymmetryOperation);
  if (ops.length === 0) fail(`${path}.spaceGroup.operations`, "needs at least the identity operation");
  opt(sg.number, `${path}.spaceGroup.number`, int);
  opt(sg.hermannMauguin, `${path}.spaceGroup.hermannMauguin`, str);
  each(s.sites, `${path}.sites`, (item, p) => {
    const site = rec(item, p);
    str(site.label, `${p}.label`);
    str(site.element, `${p}.element`);
    vec3(site.position, `${p}.position`);
    num(site.occupancy, `${p}.occupancy`);
    const adp = rec(site.adp, `${p}.adp`);
    const kind = oneOf(["isotropic", "anisotropic"] as const)(adp.kind, `${p}.adp.kind`);
    if (kind === "isotropic") num(adp.bIso, `${p}.adp.bIso`);
    else vec6(adp.uAniso, `${p}.adp.uAniso`);
    opt(site.isotope, `${p}.isotope`, num);
    opt(site.oxidationState, `${p}.oxidationState`, num);
    opt(site.multiplicity, `${p}.multiplicity`, int);
    opt(site.disorder, `${p}.disorder`, (d, dp) => {
      const r = rec(d, dp);
      str(r.assembly, `${dp}.assembly`);
      int(r.group, `${dp}.group`);
    });
    opt(site.su, `${p}.su`, (u, up) => {
      const r = rec(u, up);
      vec3(r.position, `${up}.position`);
      num(r.occupancy, `${up}.occupancy`);
      num(r.uIso, `${up}.uIso`);
      opt(r.uAniso, `${up}.uAniso`, vec6);
    });
  });
}

function checkRadiation(v: unknown, path: string): void {
  const r = rec(v, path);
  const kind = oneOf(RADIATION_KINDS)(r.kind, `${path}.kind`);
  if (kind !== "neutron-tof") num(r.wavelength, `${path}.wavelength`);
  if (kind === "xray") {
    opt(r.polarization, `${path}.polarization`, num);
    if (r.kAlpha2 !== undefined && r.kAlpha2 !== null) {
      const k = rec(r.kAlpha2, `${path}.kAlpha2`);
      num(k.wavelength, `${path}.kAlpha2.wavelength`);
      num(k.ratio, `${path}.kAlpha2.ratio`);
    }
  }
}

function checkWindow(v: unknown, path: string): void {
  const w = rec(v, path);
  const min = num(w.min, `${path}.min`);
  const max = num(w.max, `${path}.max`);
  if (!(min < max)) fail(path, `min (${min}) must be below max (${max})`);
}

function checkRawFile(v: unknown, path: string): void {
  const f = rec(v, path);
  str(f.name, `${path}.name`);
  str(f.text, `${path}.text`);
}

function checkResult(v: unknown, path: string): void {
  const r = rec(v, path);
  oneOf(STATUSES)(r.status, `${path}.status`);
  rec(r.parameters, `${path}.parameters`);
  rec(r.esd, `${path}.esd`);
  const ag = rec(r.agreement, `${path}.agreement`);
  num(ag.rFactor, `${path}.agreement.rFactor`);
  arr(r.history, `${path}.history`);
  opt(r.message, `${path}.message`, str);
}

/**
 * Parameters + bindings (+ optional lastResult): ids unique, every binding
 * pointing at a parameter that exists.
 */
function checkRefinement(v: unknown, path: string): Set<string> {
  const r = rec(v, path);
  const ids = new Set<string>();
  each(r.parameters, `${path}.parameters`, (item, p) => {
    const pp = rec(item, p);
    const id = str(pp.id, `${p}.id`);
    if (ids.has(id)) fail(`${p}.id`, `duplicate parameter id ${JSON.stringify(id)}`);
    ids.add(id);
    str(pp.label, `${p}.label`);
    str(pp.kind, `${p}.kind`);
    num(pp.value, `${p}.value`);
    num(pp.initialValue, `${p}.initialValue`);
    bool(pp.fixed, `${p}.fixed`);
    opt(pp.min, `${p}.min`, num);
    opt(pp.max, `${p}.max`, num);
    opt(pp.esd, `${p}.esd`, num);
    opt(pp.linear, `${p}.linear`, bool);
    opt(pp.group, `${p}.group`, str);
    opt(pp.expression, `${p}.expression`, str);
  });
  each(r.bindings, `${path}.bindings`, (item, p) => {
    const b = rec(item, p);
    const pid = str(b.parameterId, `${p}.parameterId`);
    if (!ids.has(pid)) fail(`${p}.parameterId`, `refers to a parameter that is not in the file: ${JSON.stringify(pid)}`);
    str(b.kind, `${p}.kind`);
    str(b.targetId, `${p}.targetId`);
    opt(b.targetKey, `${p}.targetKey`, str);
    opt(b.axis, `${p}.axis`, vec3);
    opt(b.uBasis, `${p}.uBasis`, vec6);
    opt(b.momentBasis, `${p}.momentBasis`, vec3);
    opt(b.momentPart, `${p}.momentPart`, oneOf(["cos", "sin"] as const));
  });
  opt(r.lastResult, `${path}.lastResult`, checkResult);
  return ids;
}

/** What a magnetic model must agree with: the primary phase and its sites. */
interface PhaseContext {
  readonly primaryId: string;
  readonly siteLabels: ReadonlySet<string>;
}

function checkMagnetic(ctx: PhaseContext): Check<void> {
  return (v, path) => {
    const m = rec(v, path);
    str(m.id, `${path}.id`);
    const sid = str(m.structureId, `${path}.structureId`);
    if (sid !== ctx.primaryId) {
      fail(`${path}.structureId`, `must be the primary phase ${JSON.stringify(ctx.primaryId)}, got ${JSON.stringify(sid)}`);
    }
    each(m.propagation, `${path}.propagation`, (k, p) => vec3(k, p));
    each(m.moments, `${path}.moments`, (item, p) => {
      const mo = rec(item, p);
      const label = str(mo.siteLabel, `${p}.siteLabel`);
      if (!ctx.siteLabels.has(label)) {
        fail(`${p}.siteLabel`, `no site ${JSON.stringify(label)} in the primary phase (sites: ${[...ctx.siteLabels].join(", ") || "none"})`);
      }
      oneOf(["crystallographic", "cartesian"] as const)(mo.frame, `${p}.frame`);
      vec3(mo.components, `${p}.components`);
      opt(mo.sinComponents, `${p}.sinComponents`, vec3);
      opt(mo.position, `${p}.position`, vec3);
      opt(mo.orbitIndex, `${p}.orbitIndex`, int);
      opt(mo.formFactorId, `${p}.formFactorId`, str);
    });
    if (m.operations !== undefined && m.operations !== null) each(m.operations, `${path}.operations`, checkSymmetryOperation);
    if (m.domainPopulations !== undefined && m.domainPopulations !== null) each(m.domainPopulations, `${path}.domainPopulations`, (x, p) => num(x, p));
  };
}

// ---------------------------------------------------------------------------
// Technique branches — each knows its own dataset and refuses the others'.
// ---------------------------------------------------------------------------

/** The cross-technique tell: what the first record of a dataset looks like. */
function looksLikePowderPoint(p: Rec): boolean { return "x" in p && "yObs" in p; }
function looksLikePdfPoint(p: Rec): boolean { return "r" in p && "gObs" in p; }
function looksLikeReflection(p: Rec): boolean { return "h" in p && "k" in p && "l" in p && "iObs" in p; }

function refuseForeignData(first: unknown, path: string, expected: "powder" | "pdf" | "singleCrystal"): void {
  if (!isRecord(first)) return;
  const found =
    looksLikePowderPoint(first) ? "powder" : looksLikePdfPoint(first) ? "pdf" : looksLikeReflection(first) ? "singleCrystal" : null;
  if (found !== null && found !== expected) {
    const what = { powder: "powder-pattern points (x, yObs)", pdf: "PDF points (r, gObs)", singleCrystal: "single-crystal reflections (h k l, iObs)" };
    fail(path, `contains ${what[found]} but workspace.technique is ${JSON.stringify(expected)} — the data does not belong to this kind of measurement`);
  }
}

function checkPowderWorkspace(ws: Rec, path: string, ctx: PhaseContext): void {
  const pat = rec(ws.pattern, `${path}.pattern`);
  str(pat.id, `${path}.pattern.id`);
  str(pat.name, `${path}.pattern.name`);
  oneOf(X_UNITS)(pat.xUnit, `${path}.pattern.xUnit`);
  checkRadiation(pat.radiation, `${path}.pattern.radiation`);
  opt(pat.wavelength, `${path}.pattern.wavelength`, num);
  const points = arr(pat.points, `${path}.pattern.points`);
  refuseForeignData(points[0], `${path}.pattern.points`, "powder");
  points.forEach((pt, i) => {
    const p = rec(pt, `${path}.pattern.points[${i}]`);
    num(p.x, `${path}.pattern.points[${i}].x`);
    num(p.yObs, `${path}.pattern.points[${i}].yObs`);
    opt(p.sigma, `${path}.pattern.points[${i}].sigma`, num);
  });

  const inst = rec(ws.instrument, `${path}.instrument`);
  const kind = oneOf(["constantWavelength", "tof"] as const)(inst.kind, `${path}.instrument.kind`);
  if (kind === "constantWavelength") num(inst.wavelength, `${path}.instrument.wavelength`);
  else num(inst.difC, `${path}.instrument.difC`);
  bool(ws.instrumentLoaded, `${path}.instrumentLoaded`);

  const prof = rec(ws.profile, `${path}.profile`);
  oneOf(PEAK_SHAPES)(prof.shape, `${path}.profile.shape`);
  opt(prof.eta, `${path}.profile.eta`, num);
  opt(prof.lorentz, `${path}.profile.lorentz`, bool);
  opt(prof.backgroundType, `${path}.profile.backgroundType`, oneOf(BACKGROUND_TYPES));
  if (int(ws.backgroundTerms, `${path}.backgroundTerms`) < 1) fail(`${path}.backgroundTerms`, "needs at least one background term");
  const ties = rec(ws.siteTies, `${path}.siteTies`);
  for (const k of ["positions", "adp", "occupancyToUnity", "composition"]) opt(ties[k], `${path}.siteTies.${k}`, bool);
  opt(ws.anisotropicAdp, `${path}.anisotropicAdp`, bool);
  opt(ws.mustrain, `${path}.mustrain`, oneOf(MUSTRAIN_MODELS));
  if (ws.corrections !== undefined && ws.corrections !== null) {
    const c = rec(ws.corrections, `${path}.corrections`);
    opt(c.asymmetry, `${path}.corrections.asymmetry`, bool);
    if (c.preferredOrientation !== undefined && c.preferredOrientation !== null) {
      const axis = each(c.preferredOrientation, `${path}.corrections.preferredOrientation`, (x, p) => int(x, p));
      if (axis.length !== 3) fail(`${path}.corrections.preferredOrientation`, "needs three indices h k l");
    }
    if (c.peak !== undefined && c.peak !== null) each(c.peak, `${path}.corrections.peak`, (x, p) => oneOf(PEAK_CORRECTION_IDS)(x, p));
  }
  if (ws.overlay !== undefined && ws.overlay !== null) {
    const ov = rec(ws.overlay, `${path}.overlay`);
    const calc = each(ov.calc, `${path}.overlay.calc`, (x, p) => num(x, p));
    const bkg = each(ov.background, `${path}.overlay.background`, (x, p) => num(x, p));
    if (calc.length !== points.length || bkg.length !== points.length) {
      fail(`${path}.overlay`, `must have one value per pattern point (${points.length}); got ${calc.length} calc / ${bkg.length} background`);
    }
  }
  str(ws.source, `${path}.source`);
  opt(ws.rawInstrument, `${path}.rawInstrument`, checkRawFile);
  opt(ws.rawData, `${path}.rawData`, checkRawFile);
  opt(ws.magnetic, `${path}.magnetic`, checkMagnetic(ctx));
  checkRefinement(ws.refinement, `${path}.refinement`);
  opt(ws.fitRange, `${path}.fitRange`, checkWindow);
  opt(ws.displayUnit, `${path}.displayUnit`, oneOf(X_UNITS));
  if (ws.manualPeaks !== undefined && ws.manualPeaks !== null) each(ws.manualPeaks, `${path}.manualPeaks`, (d, p) => num(d, p));
}

function checkScDataset(v: unknown, path: string): void {
  const d = rec(v, path);
  str(d.id, `${path}.id`);
  str(d.name, `${path}.name`);
  checkRadiation(d.radiation, `${path}.radiation`);
  opt(d.origin, `${path}.origin`, oneOf(["refinement-listing"] as const));
  const refl = arr(d.reflections, `${path}.reflections`);
  refuseForeignData(refl[0], `${path}.reflections`, "singleCrystal");
  refl.forEach((item, i) => {
    const r = rec(item, `${path}.reflections[${i}]`);
    for (const k of ["h", "k", "l", "iObs"]) num(r[k], `${path}.reflections[${i}].${k}`);
    for (const k of ["sigma", "batch", "wavelength", "twoTheta", "tbar", "transmission"]) opt(r[k], `${path}.reflections[${i}].${k}`, num);
  });
}

function checkModulated(v: unknown, path: string): void {
  const m = rec(v, path);
  strings3(m.k, `${path}.k`);
  const ions = rec(m.ions, `${path}.ions`);
  for (const [label, ion] of Object.entries(ions)) {
    const io = rec(ion, `${path}.ions.${label}`);
    bool(io.on, `${path}.ions.${label}.on`);
    strings3(io.direction, `${path}.ions.${label}.direction`);
    str(io.phase, `${path}.ions.${label}.phase`);
  }
  num(m.moment, `${path}.moment`);
  int(m.seed, `${path}.seed`);
  int(m.restarts, `${path}.restarts`);
}

function checkSingleCrystalWorkspace(ws: Rec, path: string, ctx: PhaseContext): void {
  checkScDataset(ws.dataset, `${path}.dataset`);
  opt(ws.magneticDataset, `${path}.magneticDataset`, checkScDataset);
  oneOf(SINGLE_CRYSTAL_PROBES)(ws.probe, `${path}.probe`);
  checkRefinement(ws.refinement, `${path}.refinement`);
  opt(ws.magnetic, `${path}.magnetic`, checkMagnetic(ctx));
  opt(ws.adpModel, `${path}.adpModel`, oneOf(["isotropic", "anisotropic"] as const));
  opt(ws.inverted, `${path}.inverted`, bool);
  if (ws.outlierFilter !== undefined && ws.outlierFilter !== null) {
    const f = rec(ws.outlierFilter, `${path}.outlierFilter`);
    bool(f.on, `${path}.outlierFilter.on`);
    num(f.cutoffSigma, `${path}.outlierFilter.cutoffSigma`);
    opt(f.minExtinction, `${path}.outlierFilter.minExtinction`, num);
  }
  opt(ws.omitted, `${path}.omitted`, (v, p) => each(v, p, (item, ip) => {
    const o = rec(item, ip);
    int(o.h, `${ip}.h`);
    int(o.k, `${ip}.k`);
    int(o.l, `${ip}.l`);
    opt(o.batch, `${ip}.batch`, int);
    opt(o.reason, `${ip}.reason`, str);
  }));
  opt(ws.riding, `${path}.riding`, (v, p) => each(v, p, (item, ip) => {
    const r = rec(item, ip);
    str(r.site, `${ip}.site`);
    str(r.parent, `${ip}.parent`);
    const geometry = oneOf(["aromatic", "methyl", "hydroxyl", "methylene", "methine", "fixed", "free"] as const)(r.geometry, `${ip}.geometry`);
    num(r.uFactor, `${ip}.uFactor`);
    opt(r.uShared, `${ip}.uShared`, str);
    opt(r.distance, `${ip}.distance`, num);
    opt(r.offset, `${ip}.offset`, vec3);
    opt(r.torsion, `${ip}.torsion`, num);
    opt(r.phase, `${ip}.phase`, num);
    opt(r.reference, `${ip}.reference`, vec3);
    opt(r.side, `${ip}.side`, num);
    opt(r.neighbours, `${ip}.neighbours`, (nv, np) => each(nv, np, (n, nip) => {
      const nr = rec(n, nip);
      str(nr.label, `${nip}.label`);
      int(nr.op, `${nip}.op`);
      vec3(nr.cell, `${nip}.cell`);
    }));
    if (geometry === "fixed" && r.offset === undefined) fail(ip, "a hydrogen at a fixed offset needs its offset");
    if (geometry !== "fixed" && geometry !== "free" && (r.distance === undefined || !Array.isArray(r.neighbours))) fail(ip, `a ${geometry} hydrogen needs its distance and the neighbours that place it`);
    if ((geometry === "methyl" || geometry === "hydroxyl") && (r.torsion === undefined || r.reference === undefined)) fail(ip, `a ${geometry} hydrogen needs its group's torsion and reference`);
  }));
  opt(ws.merged, `${path}.merged`, bool);
  opt(ws.restraints, `${path}.restraints`, (v, p) => each(v, p, (item, ip) => {
    const r = rec(item, ip);
    const kind = oneOf(["dfix", "sadi"] as const)(r.kind, `${ip}.kind`);
    num(r.sigma, `${ip}.sigma`);
    opt(r.target, `${ip}.target`, num);
    if (kind === "dfix" && r.target === undefined) fail(ip, "a DFIX needs its target distance");
    const pairs = each(r.pairs, `${ip}.pairs`, (pv, pp) => {
      const pr = rec(pv, pp);
      str(pr.from, `${pp}.from`);
      str(pr.to, `${pp}.to`);
      int(pr.op, `${pp}.op`);
      vec3(pr.cell, `${pp}.cell`);
    });
    if (pairs.length === 0 || (kind === "sadi" && pairs.length < 2)) fail(`${ip}.pairs`, kind === "sadi" ? "a SADI needs two distances or more" : "a DFIX needs a distance");
  }));
  opt(ws.twinLaws, `${path}.twinLaws`, (v, p) => each(v, p, (item, ip) => {
    const law = rec(item, ip);
    each(law.matrix, `${ip}.matrix`, (row, rp) => each(row, rp, (x, xp) => int(x, xp)));
    if (!Array.isArray(law.matrix) || law.matrix.length !== 3 || law.matrix.some((row) => !Array.isArray(row) || row.length !== 3)) fail(`${ip}.matrix`, "a twin law is a 3×3 integer matrix");
  }));
  if (ws.weighting !== undefined && ws.weighting !== null) {
    const w = rec(ws.weighting, `${path}.weighting`);
    for (const term of ["a", "b"] as const) if (num(w[term], `${path}.weighting.${term}`) < 0) fail(`${path}.weighting.${term}`, "a weighting term cannot be negative");
  }
  opt(ws.extinctionModel, `${path}.extinctionModel`, oneOf(EXTINCTION_MODELS));
  opt(ws.wavelength, `${path}.wavelength`, num);
  if (ws.resolution !== undefined && ws.resolution !== null) {
    const r = rec(ws.resolution, `${path}.resolution`);
    opt(r.dMin, `${path}.resolution.dMin`, num);
    opt(r.dMax, `${path}.resolution.dMax`, num);
  }
  opt(ws.modulated, `${path}.modulated`, checkModulated);
}

function checkDistortionModes(v: unknown, path: string): void {
  const d = rec(v, path);
  const set = rec(d.set, `${path}.set`);
  checkStructure(set.parentized, `${path}.set.parentized`);
  vec3(set.originShift, `${path}.set.originShift`);
  checkRefinement({ parameters: set.parameters, bindings: set.bindings }, `${path}.set`);
  each(set.modes, `${path}.set.modes`, (item, p) => {
    const m = rec(item, p);
    str(m.id, `${p}.id`);
    str(m.label, `${p}.label`);
    num(m.observedAmplitude, `${p}.observedAmplitude`);
    each(m.axes, `${p}.axes`, (ax, ap) => {
      const a = rec(ax, ap);
      str(a.siteLabel, `${ap}.siteLabel`);
      vec3(a.axis, `${ap}.axis`);
    });
    opt(m.star, `${p}.star`, str);
    opt(m.active, `${p}.active`, bool);
  });
  num(set.totalAmplitude, `${path}.set.totalAmplitude`);
  each(set.unpaired, `${path}.set.unpaired`, (x, p) => str(x, p));
  opt(set.acousticExcluded, `${path}.set.acousticExcluded`, int);
  str(d.parentName, `${path}.parentName`);
  opt(d.fromActivation, `${path}.fromActivation`, bool);
}

function checkBoxcarRun(v: unknown, path: string): void {
  const r = rec(v, path);
  each(r.windows, `${path}.windows`, (item, p) => {
    const w = rec(item, p);
    for (const k of ["center", "min", "max"]) num(w[k], `${p}.${k}`);
  });
  each(r.series, `${path}.series`, (item, p) => {
    const s = rec(item, p);
    oneOf(["up", "down"] as const)(s.direction, `${p}.direction`);
    const res = rec(s.result, `${p}.result`);
    each(res.steps, `${p}.result.steps`, (st, sp) => {
      const step = rec(st, sp);
      str(step.datasetId, `${sp}.datasetId`);
      checkResult(step.result, `${sp}.result`);
      arr(step.parameters, `${sp}.parameters`);
      bool(step.carried, `${sp}.carried`);
    });
    arr(res.evolution, `${p}.result.evolution`);
  });
  num(r.width, `${path}.width`);
  int(r.restarts, `${path}.restarts`);
  each(r.freeIds, `${path}.freeIds`, (x, p) => str(x, p));
  opt(r.partial, `${path}.partial`, bool);
  if (r.bondSites !== undefined && r.bondSites !== null) each(r.bondSites, `${path}.bondSites`, (x, p) => str(x, p));
}

/** Retained S(Q)/F(Q): equal-length numeric columns (σ optional, ≥ 0). */
function checkReciprocal(v: unknown, path: string): void {
  const r = rec(v, path);
  oneOf(["sq", "fq"] as const)(r.kind, `${path}.kind`);
  const q = each(r.q, `${path}.q`, (x, p) => num(x, p));
  const y = each(r.y, `${path}.y`, (x, p) => num(x, p));
  if (y.length !== q.length) fail(`${path}.y`, `expected ${q.length} values (one per Q), got ${y.length}`);
  if (r.sigma !== undefined && r.sigma !== null) {
    const s = each(r.sigma, `${path}.sigma`, (x, p) => {
      if (num(x, p) < 0) fail(p, "an uncertainty cannot be negative");
    });
    if (s.length !== q.length) fail(`${path}.sigma`, `expected ${q.length} values (one per Q), got ${s.length}`);
  }
}

function checkPdfWorkspace(ws: Rec, path: string, ctx: PhaseContext): void {
  const pat = rec(ws.pattern, `${path}.pattern`);
  str(pat.id, `${path}.pattern.id`);
  str(pat.name, `${path}.pattern.name`);
  oneOf(["neutron", "xray"] as const)(pat.scatteringType, `${path}.pattern.scatteringType`);
  const points = arr(pat.points, `${path}.pattern.points`);
  refuseForeignData(points[0], `${path}.pattern.points`, "pdf");
  points.forEach((pt, i) => {
    const p = rec(pt, `${path}.pattern.points[${i}]`);
    num(p.r, `${path}.pattern.points[${i}].r`);
    num(p.gObs, `${path}.pattern.points[${i}].gObs`);
    opt(p.sigma, `${path}.pattern.points[${i}].sigma`, num);
  });
  for (const k of ["qmax", "qmin", "qmaxInst", "qdamp", "qbroad", "rpoly", "rstep"]) opt(pat[k], `${path}.pattern.${k}`, num);
  opt(pat.composition, `${path}.pattern.composition`, str);
  opt(pat.sourceKind, `${path}.pattern.sourceKind`, oneOf(PDF_SOURCE_KINDS));
  opt(pat.reciprocal, `${path}.pattern.reciprocal`, checkReciprocal);
  if (pat.transform !== undefined && pat.transform !== null) {
    const t = rec(pat.transform, `${path}.pattern.transform`);
    num(t.qmin, `${path}.pattern.transform.qmin`);
    num(t.qmax, `${path}.pattern.transform.qmax`);
    oneOf(["none", "lorch"] as const)(t.modification, `${path}.pattern.transform.modification`);
    oneOf(["none", "linear"] as const)(t.lowQ, `${path}.pattern.transform.lowQ`);
  }

  checkRefinement(ws.refinement, `${path}.refinement`);
  checkWindow(ws.fitRange, `${path}.fitRange`);
  oneOf(PDF_POSITION_MODES)(ws.positionMode, `${path}.positionMode`);
  opt(ws.adpModel, `${path}.adpModel`, oneOf(["isotropic", "anisotropic"] as const));
  opt(ws.distortionModes, `${path}.distortionModes`, checkDistortionModes);
  if (ws.spinModel !== undefined && ws.spinModel !== null) {
    const s = rec(ws.spinModel, `${path}.spinModel`);
    checkMagnetic(ctx)(s.magnetic, `${path}.spinModel.magnetic`);
    checkRefinement({ parameters: s.parameters, bindings: s.bindings }, `${path}.spinModel`);
  }
  if (ws.boxcar !== undefined && ws.boxcar !== null) {
    const b = rec(ws.boxcar, `${path}.boxcar`);
    const plan = rec(b.plan, `${path}.boxcar.plan`);
    num(plan.width, `${path}.boxcar.plan.width`);
    num(plan.step, `${path}.boxcar.plan.step`);
    oneOf(["up", "down", "both"] as const)(plan.direction, `${path}.boxcar.plan.direction`);
    bool(plan.randomStart, `${path}.boxcar.plan.randomStart`);
    int(plan.restarts, `${path}.boxcar.plan.restarts`);
    opt(b.lastRun, `${path}.boxcar.lastRun`, checkBoxcarRun);
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * Validate a parsed (and already migrated) document and return it typed.
 * Throws `ProjectFileError` naming the first offending field.
 */
export function validateProjectFile(raw: unknown): ProjectFile {
  const root = rec(raw, "project");
  const version = int(root.schemaVersion, "schemaVersion");
  if (version !== PROJECT_SCHEMA_VERSION) {
    fail("schemaVersion", `expected ${PROJECT_SCHEMA_VERSION}, got ${version} (migration did not bring the file up to date)`);
  }
  const meta = rec(root.metadata, "metadata");
  for (const k of ["title", "createdAt", "modifiedAt", "appVersion"]) str(meta[k], `metadata.${k}`);
  opt(meta.notes, "metadata.notes", str);

  checkPhasesAndWorkspace(root.structures, "structures", root.workspace, "workspace");

  if (root.view !== undefined && root.view !== null) {
    const view = rec(root.view, "view");
    opt(view.step, "view.step", int);
  }
  if (root.history !== undefined && root.history !== null) checkHistory(root.history, "history");
  if (root.agent !== undefined && root.agent !== null) checkAgent(root.agent, "agent");
  return root as unknown as ProjectFile;
}

/** The Agent's records: one per analysis, each with its checks, exceptions, stages and notes. */
function checkAgent(v: unknown, path: string): void {
  const agent = rec(v, path);
  arr(agent.records, `${path}.records`).forEach((r, i) => {
    const p = `${path}.records[${i}]`;
    const record = rec(r, p);
    str(record.key, `${p}.key`);
    if (record.dataCheck !== undefined && record.dataCheck !== null) {
      const check = rec(record.dataCheck, `${p}.dataCheck`);
      num(check.at, `${p}.dataCheck.at`);
      str(check.summary, `${p}.dataCheck.summary`);
    }
    if (record.rangeCheck !== undefined && record.rangeCheck !== null) {
      const check = rec(record.rangeCheck, `${p}.rangeCheck`);
      num(check.at, `${p}.rangeCheck.at`);
      str(check.summary, `${p}.rangeCheck.summary`);
    }
    if (record.cellCheck !== undefined && record.cellCheck !== null) {
      const check = rec(record.cellCheck, `${p}.cellCheck`);
      bool(check.passed, `${p}.cellCheck.passed`);
      num(check.at, `${p}.cellCheck.at`);
      str(check.summary, `${p}.cellCheck.summary`);
    }
    if (record.symmetryReviewed !== undefined && record.symmetryReviewed !== null) {
      const review = rec(record.symmetryReviewed, `${p}.symmetryReviewed`);
      num(review.at, `${p}.symmetryReviewed.at`);
      str(review.summary, `${p}.symmetryReviewed.summary`);
    }
    if (record.start !== undefined && record.start !== null) {
      const start = rec(record.start, `${p}.start`);
      num(start.at, `${p}.start.at`);
      num(start.agreement, `${p}.start.agreement`);
      opt(start.r1, `${p}.start.r1`, num);
    }
    if (record.diagnoses !== undefined && record.diagnoses !== null) {
      arr(record.diagnoses, `${p}.diagnoses`).forEach((d, j) => {
        const dx = rec(d, `${p}.diagnoses[${j}]`);
        num(dx.at, `${p}.diagnoses[${j}].at`);
        opt(dx.step, `${p}.diagnoses[${j}].step`, str);
        str(dx.summary, `${p}.diagnoses[${j}].summary`);
      });
    }
    arr(record.exceptions, `${p}.exceptions`).forEach((e, j) => {
      const ex = rec(e, `${p}.exceptions[${j}]`);
      oneOf(["bare-occupancy", "instrument-with-thermal"])(ex.rule, `${p}.exceptions[${j}].rule`);
      str(ex.reason, `${p}.exceptions[${j}].reason`);
      num(ex.at, `${p}.exceptions[${j}].at`);
    });
    if (record.kept !== undefined && record.kept !== null) {
      arr(record.kept, `${p}.kept`).forEach((k, j) => {
        const kept = rec(k, `${p}.kept[${j}]`);
        str(kept.measurement, `${p}.kept[${j}].measurement`);
        str(kept.reason, `${p}.kept[${j}].reason`);
        num(kept.at, `${p}.kept[${j}].at`);
      });
    }
    arr(record.stagesDone, `${p}.stagesDone`).forEach((st, j) => str(st, `${p}.stagesDone[${j}]`));
    arr(record.notes, `${p}.notes`).forEach((n, j) => {
      const note = rec(n, `${p}.notes[${j}]`);
      str(note.text, `${p}.notes[${j}].text`);
      num(note.at, `${p}.notes[${j}].at`);
    });
  });
}

/** The phases and the workspace that uses them — a project's model, or a history step's. */
function checkPhasesAndWorkspace(rawStructures: unknown, sPath: string, rawWorkspace: unknown, wPath: string): void {
  const structures = each(rawStructures, sPath, checkStructure);
  if (structures.length === 0) fail(sPath, "a project needs at least one phase");
  const ids = new Set<string>();
  structures.forEach((s, i) => {
    const id = (s as Rec).id as string;
    if (ids.has(id)) fail(`${sPath}[${i}].id`, `duplicate phase id ${JSON.stringify(id)}`);
    ids.add(id);
  });
  const primary = structures[0] as unknown as StructureModel;
  const ctx: PhaseContext = { primaryId: primary.id, siteLabels: new Set(primary.sites.map((s) => s.label)) };

  const ws = rec(rawWorkspace, wPath);
  const technique = oneOf(TECHNIQUES)(ws.technique, `${wPath}.technique`);
  switch (technique) {
    case "powder":
      checkPowderWorkspace(ws, wPath, ctx);
      break;
    case "singleCrystal":
      checkSingleCrystalWorkspace(ws, wPath, ctx);
      break;
    case "pdf":
      checkPdfWorkspace(ws, wPath, ctx);
      break;
  }
}

/**
 * Validate a history step's restored snapshot with the same rules as a file's
 * own model. Run when the user goes back to the step, so a damaged old step is
 * reported then — it never blocks opening the project.
 */
export function validateSnapshot(structures: unknown, workspace: unknown, path: string): { structures: StructureModel[]; workspace: Workspace } {
  checkPhasesAndWorkspace(structures, `${path}.structures`, workspace, `${path}.workspace`);
  return { structures: structures as StructureModel[], workspace: workspace as Workspace };
}

/**
 * The history's shape: unique step ids, parents that exist and come first (so
 * the tree has no cycles), blob references that resolve, a current step that
 * exists. Step snapshots are checked in full only when restored.
 */
function checkHistory(raw: unknown, path: string): void {
  const h = rec(raw, path);
  const blobs = rec(h.blobs, `${path}.blobs`);
  const seen = new Set<string>();
  const blobRef = (v: unknown, p: string): void => {
    const ref = rec(v, p);
    const key = str(ref.blob, `${p}.blob`);
    if (!(key in blobs)) fail(`${p}.blob`, `no blob ${JSON.stringify(key)} in the history`);
  };
  each(h.steps, `${path}.steps`, (item, p) => {
    const step = rec(item, p);
    const id = str(step.id, `${p}.id`);
    if (seen.has(id)) fail(`${p}.id`, `duplicate step id ${JSON.stringify(id)}`);
    const parent = opt(step.parent, `${p}.parent`, str);
    if (parent !== undefined && !seen.has(parent)) fail(`${p}.parent`, `step ${JSON.stringify(parent)} does not come before it`);
    seen.add(id);
    str(step.at, `${p}.at`);
    oneOf(STEP_KINDS)(step.kind, `${p}.kind`);
    str(step.label, `${p}.label`);
    opt(step.actor, `${p}.actor`, oneOf(STEP_ACTORS));
    opt(step.name, `${p}.name`, str);
    const summary = rec(step.summary, `${p}.summary`);
    int(summary.nFree, `${p}.summary.nFree`);
    opt(summary.wR, `${p}.summary.wR`, num);
    opt(summary.gof, `${p}.summary.gof`, num);
    opt(summary.status, `${p}.summary.status`, str);
    blobRef(step.structures, `${p}.structures`);
    const ws = rec(step.workspace, `${p}.workspace`);
    oneOf(TECHNIQUES)(ws.technique, `${p}.workspace.technique`);
    for (const [k, v] of Object.entries(ws)) if (isRecord(v) && Object.keys(v).length === 1 && "blob" in v) blobRef(v, `${p}.workspace.${k}`);
    const refinement = rec(ws.refinement, `${p}.workspace.refinement`);
    blobRef(refinement.bindings, `${p}.workspace.refinement.bindings`);
  });
  if (seen.size === 0) fail(`${path}.steps`, "a history needs at least one step");
  const current = str(h.current, `${path}.current`);
  if (!seen.has(current)) fail(`${path}.current`, `no step ${JSON.stringify(current)} in the history`);
}
