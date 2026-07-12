/**
 * WebGPU nuclear structure-factor kernel — the geometry-heavy accelerator.
 *
 * Where the profile-synthesis kernel (gpuSynthesizer.ts) spreads peaks, THIS
 * kernel computes the quantity that actually dominates a geometry-heavy Jacobian:
 *
 *   |F_N(hkl)|²  for a BATCH of models × a shared reflection list.
 *
 * A "model" is one perturbed structure — a Jacobian column (a shifted position,
 * an ADP mode, an occupancy). Thread (r, m) sums the reflection r over every
 * atom of model m:  F = Σ_atoms occ·b(s)·T_DW·exp[2πi(h·x+k·y+l·z)], then writes
 * |F|². The atom list is the same (site, distinct-op) orbit expansion the CPU
 * `nuclearStructureFactor` sums (via `expandStructureAtoms`), so the two agree by
 * construction up to f32 precision — the whole point of the validation campaign.
 *
 * PRECISION CONTRACT — read before wiring this anywhere:
 * WebGPU compute is f32; the CPU engine is f64. GPU |F|² is APPROXIMATE and NOT
 * bit-identical, so the CPU pool's exactness guarantees do NOT extend here.
 * Fractional coordinates travel as double-f32 (hi, lo) splits so the phase
 * 2π(h·x+k·y+l·z) keeps precision even for high-index reflections (h·x ~ 60 rad);
 * the residual error is f32 exp/sin/cos and accumulation. Every problem class
 * must be re-validated via `gpuStructureFactorValidation`, which returns the max
 * relative |F|² deviation against the CPU f64 truth. That deviation must stay far
 * below counting statistics and esd scales (≥1e-3 relative) before any refinement
 * path trusts a GPU |F|².
 *
 * MEASURED on hardware (Apple GPU, metal-3) via gpuValidationHarness.ts, max
 * relative |F|² deviation vs the CPU f64 truth on Mn₃Ga (83 reflections):
 *   neutron isotropic 3.9e-7 · X-ray isotropic 7.9e-8 · neutron anisotropic ADP
 *   5.0e-7 · 8-model perturbed batch 4.7e-7 — all far under the 1e-3 esd floor.
 *   Throughput 1439 reflections × 24 models: 2.5 ms GPU vs 34 ms CPU (13.6×);
 *   the win grows with atom count (the per-thread orbit sum dominates).
 *
 * SCOPE (v1): nuclear |F|² only; neutron (constant b) and X-ray (Cromer-Mann
 * four-Gaussian) scattering; isotropic and anisotropic Debye-Waller. The
 * reflection list, s = sinθ/λ and reciprocal metric are SHARED across the model
 * batch — valid for position/occupancy/ADP columns (fixed cell). Cell columns
 * (which change s/metric, and are few) stay on the CPU. Magnetic |F_M|² is a
 * separate future kernel.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { Radiation } from "@/core/diffraction/types";
import { expandStructureAtoms, type ExpandedAtom } from "@/core/diffraction/structureFactor";
import { dSpacing, reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { neutronScatteringLength } from "@/core/scattering/neutron";
import { CROMER_MANN } from "@/core/scattering/xray";

const WGSL = /* wgsl */ `
struct Params {
  nRefl: u32,
  nModels: u32,
  radiationKind: u32,  // 0 = neutron (constant b), 1 = X-ray (Cromer-Mann)
  _p0: u32,
  asr: f32, bsr: f32, csr: f32, _p1: f32,  // reciprocal cell edges a*, b*, c*
}
struct Refl { h: f32, k: f32, l: f32, s: f32 }  // s = sinθ/λ = 1/(2d)
struct Atom {
  xHi: f32, yHi: f32, zHi: f32,   // fractional position, f64 split into hi + lo
  xLo: f32, yLo: f32, zLo: f32,
  occ: f32,
  elem: u32,                       // index into elems[]
  dwKind: u32,                     // 0 = isotropic, 1 = anisotropic
  bIso: f32,
  u0: f32, u1: f32, u2: f32, u3: f32, u4: f32, u5: f32,  // [U11,U22,U33,U12,U13,U23]
}
struct Elem {                           // 16 f32 = 64 bytes, matching ELEM_STRIDE
  neutronB: f32,
  a0: f32, a1: f32, a2: f32, a3: f32,   // Cromer-Mann a_i
  b0: f32, b1: f32, b2: f32, b3: f32,   // Cromer-Mann b_i
  c: f32,
  _e0: f32, _e1: f32, _e2: f32, _e3: f32, _e4: f32, _e5: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> refls: array<Refl>;
@group(0) @binding(2) var<storage, read> atoms: array<Atom>;
@group(0) @binding(3) var<storage, read> ranges: array<vec2<u32>>;  // per model [start,end)
@group(0) @binding(4) var<storage, read> elems: array<Elem>;
@group(0) @binding(5) var<storage, read_write> out: array<f32>;     // |F|² per (model, refl)

const TWO_PI: f32 = 6.283185307179586;
const PI2: f32 = 9.869604401089358;  // π²

fn scatter(elem: u32, s2: f32) -> f32 {
  let e = elems[elem];
  if (params.radiationKind == 0u) { return e.neutronB; }
  return e.a0 * exp(-e.b0 * s2) + e.a1 * exp(-e.b1 * s2)
       + e.a2 * exp(-e.b2 * s2) + e.a3 * exp(-e.b3 * s2) + e.c;
}

fn debyeWaller(a: Atom, h: f32, k: f32, l: f32, s2: f32) -> f32 {
  if (a.dwKind == 0u) { return exp(-a.bIso * s2); }
  let asr = params.asr; let bsr = params.bsr; let csr = params.csr;
  let expo = a.u0 * h * h * asr * asr + a.u1 * k * k * bsr * bsr + a.u2 * l * l * csr * csr
    + 2.0 * a.u3 * h * k * asr * bsr + 2.0 * a.u4 * h * l * asr * csr + 2.0 * a.u5 * k * l * bsr * csr;
  return exp(-2.0 * PI2 * expo);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;  // reflection
  let m = gid.y;  // model / column
  if (r >= params.nRefl || m >= params.nModels) { return; }
  let refl = refls[r];
  let h = refl.h; let k = refl.k; let l = refl.l;
  let s2 = refl.s * refl.s;
  let range = ranges[m];
  var fr: f32 = 0.0;
  var fi: f32 = 0.0;
  for (var p: u32 = range.x; p < range.y; p = p + 1u) {
    let a = atoms[p];
    let w = a.occ * scatter(a.elem, s2) * debyeWaller(a, h, k, l, s2);
    // Phase 2π(h·x + k·y + l·z). Accumulate the hi part and the lo correction
    // separately (double-f32), reduce mod 1 before scaling so sin/cos see a small
    // argument even for high-index reflections.
    let argHi = h * a.xHi + k * a.yHi + l * a.zHi;
    let argLo = h * a.xLo + k * a.yLo + l * a.zLo;
    let arg = argHi + argLo;
    let frac = arg - floor(arg);
    let phase = TWO_PI * frac;
    fr = fr + w * cos(phase);
    fi = fi + w * sin(phase);
  }
  out[m * params.nRefl + r] = fr * fr + fi * fi;
}
`;

/** One reflection's Miller indices and s = sinθ/λ (shared across the batch). */
export interface SfReflection {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly s: number;
}

/**
 * How many f32 slots each Atom / Elem struct occupies. MUST equal the field
 * count of the corresponding WGSL struct — a mismatch silently reads the wrong
 * bytes for every element past the first (an Elem field-count of 15 vs a stride
 * of 16 zeroed the second element's scattering, caught only by the in-browser
 * validation). `gpuStructureFactor.test.ts` parses the WGSL and asserts these.
 */
export const ATOM_STRIDE = 16;
export const ELEM_STRIDE = 16;
export const STRUCTURE_FACTOR_WGSL = WGSL;

export class GpuStructureFactor {
  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
  ) {}

  /** Null when WebGPU is unavailable (feature detection, never throws). */
  static async create(): Promise<GpuStructureFactor | null> {
    try {
      const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const module = device.createShaderModule({ code: WGSL });
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      return new GpuStructureFactor(device, pipeline);
    } catch {
      return null;
    }
  }

  /**
   * |F_N|² for every (model, reflection). `models` are pre-expanded atom lists
   * (one per Jacobian column, from `expandStructureAtoms`); `reflections` and the
   * reciprocal cell edges are shared. Returns one Float32Array per model, each of
   * length `reflections.length`, ordered like the inputs.
   */
  async computeIntensities(
    models: readonly (readonly ExpandedAtom[])[],
    reflections: readonly SfReflection[],
    radiation: Radiation,
    reciprocal: { as: number; bs: number; cs: number },
  ): Promise<Float32Array[]> {
    const nRefl = reflections.length;
    const nModels = models.length;

    // Element table: one row per distinct element across all models.
    const elementIndex = new Map<string, number>();
    const marshalAtoms: { atom: ExpandedAtom; elem: number }[][] = models.map((atoms) =>
      atoms.map((atom) => {
        const key = atom.element + (atom.isotope !== undefined ? `-${atom.isotope}` : "");
        let idx = elementIndex.get(key);
        if (idx === undefined) {
          idx = elementIndex.size;
          elementIndex.set(key, idx);
        }
        return { atom, elem: idx };
      }),
    );

    const elemData = new Float32Array(Math.max(elementIndex.size, 1) * ELEM_STRIDE);
    for (const [key, idx] of elementIndex) {
      const [element, iso] = key.split("-");
      const isotope = iso !== undefined ? Number(iso) : undefined;
      const base = idx * ELEM_STRIDE;
      if (radiation.kind === "neutron" || radiation.kind === "neutron-tof") {
        elemData[base] = neutronScatteringLength(element!, isotope);
      } else {
        const cm = CROMER_MANN[element!];
        if (!cm) throw new Error(`No Cromer-Mann coefficients for element "${element}"`);
        for (let i = 0; i < 4; i++) {
          elemData[base + 1 + i] = cm.a[i]!;
          elemData[base + 5 + i] = cm.b[i]!;
        }
        elemData[base + 9] = cm.c;
      }
    }

    const totalAtoms = marshalAtoms.reduce((n, a) => n + a.length, 0);
    const atomData = new Float32Array(Math.max(totalAtoms, 1) * ATOM_STRIDE);
    const atomU32 = new Uint32Array(atomData.buffer);
    const rangeData = new Uint32Array(Math.max(nModels, 1) * 2);
    let off = 0;
    marshalAtoms.forEach((atoms, m) => {
      rangeData[m * 2] = off;
      for (const { atom, elem } of atoms) {
        const b = off * ATOM_STRIDE;
        for (let c = 0; c < 3; c++) {
          const hi = Math.fround(atom.position[c]!);
          atomData[b + c] = hi;
          atomData[b + 3 + c] = atom.position[c]! - hi;
        }
        atomData[b + 6] = atom.occupancy;
        atomU32[b + 7] = elem;
        if (atom.adp.kind === "isotropic") {
          atomU32[b + 8] = 0;
          atomData[b + 9] = atom.adp.bIso;
        } else {
          atomU32[b + 8] = 1;
          for (let i = 0; i < 6; i++) atomData[b + 10 + i] = atom.adp.uAniso[i]!;
        }
        off++;
      }
      rangeData[m * 2 + 1] = off;
    });

    const reflData = new Float32Array(Math.max(nRefl, 1) * 4);
    reflections.forEach((r, i) => {
      reflData[i * 4] = r.h;
      reflData[i * 4 + 1] = r.k;
      reflData[i * 4 + 2] = r.l;
      reflData[i * 4 + 3] = r.s;
    });

    const paramsBuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const radiationKind = radiation.kind === "xray" ? 1 : 0;
    this.device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([nRefl, nModels, radiationKind, 0]));
    this.device.queue.writeBuffer(paramsBuf, 16, new Float32Array([reciprocal.as, reciprocal.bs, reciprocal.cs, 0]));

    const reflBuf = this.storage(reflData);
    const atomBuf = this.storage(atomData);
    const rangeBuf = this.storage(rangeData);
    const elemBuf = this.storage(elemData);
    const outSize = Math.max(nRefl * nModels, 1) * 4;
    const outBuf = this.device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = this.device.createBuffer({ size: outSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: reflBuf } },
        { binding: 2, resource: { buffer: atomBuf } },
        { binding: 3, resource: { buffer: rangeBuf } },
        { binding: 4, resource: { buffer: elemBuf } },
        { binding: 5, resource: { buffer: outBuf } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(nRefl / 64), nModels);
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, outSize);
    this.device.queue.submit([encoder.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const all = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    for (const buf of [paramsBuf, reflBuf, atomBuf, rangeBuf, elemBuf, outBuf, readBuf]) buf.destroy();

    const result: Float32Array[] = [];
    for (let m = 0; m < nModels; m++) result.push(all.subarray(m * nRefl, (m + 1) * nRefl).slice());
    return result;
  }

  private storage(data: Float32Array | Uint32Array): GPUBuffer {
    const buf = this.device.createBuffer({
      size: Math.max(data.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, data as unknown as ArrayBufferView<ArrayBuffer>);
    return buf;
  }

  dispose(): void {
    this.device.destroy();
  }
}

/** Reflection list + s + reciprocal cell edges the kernel needs, from a model. */
export function structureFactorInputs(
  model: StructureModel,
  hkls: readonly { h: number; k: number; l: number }[],
): { reflections: SfReflection[]; reciprocal: { as: number; bs: number; cs: number } } {
  const g = reciprocalMetricTensor(model.cell);
  const reciprocal = { as: Math.sqrt(g[0][0]), bs: Math.sqrt(g[1][1]), cs: Math.sqrt(g[2][2]) };
  const reflections = hkls.map(({ h, k, l }) => {
    const d = dSpacing(model.cell, h, k, l);
    return { h, k, l, s: d === Infinity ? 0 : 1 / (2 * d) };
  });
  return { reflections, reciprocal };
}

/**
 * Validation harness: compute |F_N|² on the GPU and against the CPU f64 truth,
 * returning the maximum relative deviation (normalized to the strongest
 * reflection so weak ones near |F|²≈0 do not dominate) plus timings. The oracle
 * for the precision contract — run per problem class before trusting a GPU |F|².
 * Returns null when WebGPU is unavailable.
 */
export async function gpuStructureFactorValidation(
  model: StructureModel,
  radiation: Radiation,
  hkls: readonly { h: number; k: number; l: number }[],
  cpuIntensity: (h: number, k: number, l: number) => number,
): Promise<{ maxRelError: number; nRefl: number; gpuMs: number; cpuMs: number } | null> {
  const gpu = await GpuStructureFactor.create();
  if (!gpu) return null;
  try {
    const atoms = expandStructureAtoms(model);
    const { reflections, reciprocal } = structureFactorInputs(model, hkls);
    const t0 = performance.now();
    const [gpuOut] = await gpu.computeIntensities([atoms], reflections, radiation, reciprocal);
    const gpuMs = performance.now() - t0;
    const t1 = performance.now();
    const cpu = hkls.map(({ h, k, l }) => cpuIntensity(h, k, l));
    const cpuMs = performance.now() - t1;
    const scale = Math.max(...cpu.map(Math.abs), 1e-30);
    let maxRel = 0;
    for (let i = 0; i < hkls.length; i++) {
      const rel = Math.abs(gpuOut![i]! - cpu[i]!) / scale;
      if (rel > maxRel) maxRel = rel;
    }
    return { maxRelError: maxRel, nRefl: hkls.length, gpuMs, cpuMs };
  } finally {
    gpu.dispose();
  }
}
