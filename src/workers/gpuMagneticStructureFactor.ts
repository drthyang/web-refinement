/**
 * WebGPU magnetic structure-factor kernel — |F_M|² for a BATCH of models × a
 * shared reflection list, the magnetic peer of gpuStructureFactor.ts.
 *
 * The magnetic structure factor is a complex VECTOR,
 *   F_M(hkl) = p · Σ_j occ_j·f_j(s)·T_j · M⊥,j · exp[2πi(h·x+k·y+l·z)],
 * and the intensity is |F_M|² = |Fx|² + |Fy|² + |Fz|². Thread (r, m) sums
 * reflection r over model m's magnetic atoms — the (moment, distinct-op) orbit
 * `magneticStructureFactor` sums (via `expandMagneticAtoms`), so the two agree by
 * construction up to f32 precision. The op-rotated moment travels ALREADY in
 * Cartesian (μ_B); the kernel applies the per-reflection perpendicular projection
 * M⊥ = M − q̂(M·q̂) with the unit scattering vector q̂ marshaled per reflection,
 * and the ⟨j0⟩ magnetic form factor from per-ion coefficients.
 *
 * PRECISION CONTRACT — identical to the nuclear kernel: f32, APPROXIMATE, never
 * bit-identical; validate every problem class via `gpuMagneticValidation` before
 * a refinement path trusts a GPU |F_M|². Fractional coordinates travel as
 * double-f32 (hi, lo) so the phase stays precise for high-index satellites.
 * SCOPE (v1): spin-only ⟨j0⟩, iso/aniso Debye-Waller, shared cell across the
 * model batch (moment/position/ADP columns — the geometry-heavy magnetic case).
 *
 * MEASURED on hardware (Apple GPU, metal-3) via gpuValidationHarness.ts: max
 * relative |F_M|² deviation vs the CPU f64 truth 4.5e-7 on the Mn₃Ga AFM
 * (k=(½,0,0), 175 satellites) — far under the 1e-3 esd floor.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { expandMagneticAtoms, MAGNETIC_PREFACTOR, type ExpandedMagneticAtom } from "@/core/magnetic/structureFactor";
import { qCartesian } from "@/core/magnetic/moment";
import { dSpacing, reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { normalize } from "@/core/math/vec3";
import { J0_COEFFS } from "@/core/scattering/magneticFormFactorData";

const WGSL = /* wgsl */ `
struct Params {
  nRefl: u32,
  nModels: u32,
  _p0: u32,
  _p1: u32,
  asr: f32, bsr: f32, csr: f32, _p2: f32,   // reciprocal edges a*, b*, c*
}
struct Refl {
  h: f32, k: f32, l: f32, s: f32,
  qx: f32, qy: f32, qz: f32, _r: f32,        // q̂ (unit scattering vector, Cartesian)
}
struct MAtom {                                // 20 f32 = 80 bytes, matching MATOM_STRIDE
  xHi: f32, yHi: f32, zHi: f32,
  xLo: f32, yLo: f32, zLo: f32,
  mx: f32, my: f32, mz: f32,                 // op-rotated Cartesian moment (μ_B)
  occ: f32,
  ion: u32,
  dwKind: u32,                               // 0 iso, 1 aniso
  bIso: f32,
  u0: f32, u1: f32, u2: f32, u3: f32, u4: f32, u5: f32,
  _pad: f32,
}
struct Ion {                                  // 8 f32 = 32 bytes, matching ION_STRIDE
  a0: f32, a: f32, b0: f32, b: f32, c0: f32, c: f32, d: f32, _pad: f32,   // ⟨j0⟩ = a0 e^{-a s²}+b0 e^{-b s²}+c0 e^{-c s²}+d
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> refls: array<Refl>;
@group(0) @binding(2) var<storage, read> atoms: array<MAtom>;
@group(0) @binding(3) var<storage, read> ranges: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read> ions: array<Ion>;
@group(0) @binding(5) var<storage, read_write> out: array<f32>;

const TWO_PI: f32 = 6.283185307179586;
const PI2: f32 = 9.869604401089358;
const PREFACTOR: f32 = ${MAGNETIC_PREFACTOR};

fn debyeWaller(a: MAtom, h: f32, k: f32, l: f32, s2: f32) -> f32 {
  if (a.dwKind == 0u) { return exp(-a.bIso * s2); }
  let asr = params.asr; let bsr = params.bsr; let csr = params.csr;
  let expo = a.u0 * h * h * asr * asr + a.u1 * k * k * bsr * bsr + a.u2 * l * l * csr * csr
    + 2.0 * a.u3 * h * k * asr * bsr + 2.0 * a.u4 * h * l * asr * csr + 2.0 * a.u5 * k * l * bsr * csr;
  return exp(-2.0 * PI2 * expo);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  let m = gid.y;
  if (r >= params.nRefl || m >= params.nModels) { return; }
  let refl = refls[r];
  let h = refl.h; let k = refl.k; let l = refl.l;
  let s2 = refl.s * refl.s;
  let qhat = vec3<f32>(refl.qx, refl.qy, refl.qz);
  let range = ranges[m];
  // Complex vector accumulator (real, imag) per Cartesian component.
  var fxr = 0.0; var fxi = 0.0;
  var fyr = 0.0; var fyi = 0.0;
  var fzr = 0.0; var fzi = 0.0;
  for (var p: u32 = range.x; p < range.y; p = p + 1u) {
    let at = atoms[p];
    let io = ions[at.ion];
    let fMag = io.a0 * exp(-io.a * s2) + io.b0 * exp(-io.b * s2) + io.c0 * exp(-io.c * s2) + io.d;
    let w = PREFACTOR * at.occ * fMag * debyeWaller(at, h, k, l, s2);
    // Perpendicular projection M⊥ = M − q̂(M·q̂); q̂ is 0 for |Q|=0 → M⊥ = M.
    let mvec = vec3<f32>(at.mx, at.my, at.mz);
    let mperp = mvec - qhat * dot(mvec, qhat);
    let argHi = h * at.xHi + k * at.yHi + l * at.zHi;
    let argLo = h * at.xLo + k * at.yLo + l * at.zLo;
    let arg = argHi + argLo;
    let phase = TWO_PI * (arg - floor(arg));
    let cr = cos(phase); let ci = sin(phase);
    let wm = w;
    fxr = fxr + wm * mperp.x * cr; fxi = fxi + wm * mperp.x * ci;
    fyr = fyr + wm * mperp.y * cr; fyi = fyi + wm * mperp.y * ci;
    fzr = fzr + wm * mperp.z * cr; fzi = fzi + wm * mperp.z * ci;
  }
  out[m * params.nRefl + r] = fxr * fxr + fxi * fxi + fyr * fyr + fyi * fyi + fzr * fzr + fzi * fzi;
}
`;

/** One reflection's indices, s = sinθ/λ, and the unit scattering vector q̂. */
export interface MagReflection {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly s: number;
  readonly qHat: readonly [number, number, number];
}

export const MATOM_STRIDE = 20;
export const ION_STRIDE = 8;
export const REFL_STRIDE = 8;
export const MAGNETIC_STRUCTURE_FACTOR_WGSL = WGSL;

export class GpuMagneticStructureFactor {
  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
  ) {}

  static async create(): Promise<GpuMagneticStructureFactor | null> {
    try {
      const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const module = device.createShaderModule({ code: WGSL });
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      return new GpuMagneticStructureFactor(device, pipeline);
    } catch {
      return null;
    }
  }

  /**
   * |F_M|² for every (model, reflection). `models` are pre-expanded magnetic atom
   * lists (one per Jacobian column, from `expandMagneticAtoms`); `reflections`
   * (with q̂) and the reciprocal edges are shared across the batch.
   */
  async computeIntensities(
    models: readonly (readonly ExpandedMagneticAtom[])[],
    reflections: readonly MagReflection[],
    reciprocal: { as: number; bs: number; cs: number },
  ): Promise<Float32Array[]> {
    const nRefl = reflections.length;
    const nModels = models.length;

    // Ion table: one row per distinct form-factor id; ⟨j0⟩ coefficients or, when
    // the ion has none, the constant 1 the CPU falls back to (a0=b0=c0=0, d=1).
    const ionIndex = new Map<string, number>();
    const marshalAtoms = models.map((atoms) =>
      atoms.map((atom) => {
        let idx = ionIndex.get(atom.formFactorId);
        if (idx === undefined) {
          idx = ionIndex.size;
          ionIndex.set(atom.formFactorId, idx);
        }
        return { atom, ion: idx };
      }),
    );
    const ionData = new Float32Array(Math.max(ionIndex.size, 1) * ION_STRIDE);
    for (const [id, idx] of ionIndex) {
      const k = J0_COEFFS[id];
      const base = idx * ION_STRIDE;
      if (k) {
        ionData[base] = k.A; ionData[base + 1] = k.a;
        ionData[base + 2] = k.B; ionData[base + 3] = k.b;
        ionData[base + 4] = k.C; ionData[base + 5] = k.c;
        ionData[base + 6] = k.D;
      } else {
        ionData[base + 6] = 1; // no ⟨j0⟩ table ⇒ fMag ≡ 1
      }
    }

    const totalAtoms = marshalAtoms.reduce((n, a) => n + a.length, 0);
    const atomData = new Float32Array(Math.max(totalAtoms, 1) * MATOM_STRIDE);
    const atomU32 = new Uint32Array(atomData.buffer);
    const rangeData = new Uint32Array(Math.max(nModels, 1) * 2);
    let off = 0;
    marshalAtoms.forEach((atoms, m) => {
      rangeData[m * 2] = off;
      for (const { atom, ion } of atoms) {
        const b = off * MATOM_STRIDE;
        for (let c = 0; c < 3; c++) {
          const hi = Math.fround(atom.position[c]!);
          atomData[b + c] = hi;
          atomData[b + 3 + c] = atom.position[c]! - hi;
        }
        atomData[b + 6] = atom.momentCart[0]!;
        atomData[b + 7] = atom.momentCart[1]!;
        atomData[b + 8] = atom.momentCart[2]!;
        atomData[b + 9] = atom.occupancy;
        atomU32[b + 10] = ion;
        if (atom.adp.kind === "isotropic") {
          atomU32[b + 11] = 0;
          atomData[b + 12] = atom.adp.bIso;
        } else {
          atomU32[b + 11] = 1;
          for (let i = 0; i < 6; i++) atomData[b + 13 + i] = atom.adp.uAniso[i]!;
        }
        off++;
      }
      rangeData[m * 2 + 1] = off;
    });

    const reflData = new Float32Array(Math.max(nRefl, 1) * REFL_STRIDE);
    reflections.forEach((r, i) => {
      const base = i * REFL_STRIDE;
      reflData[base] = r.h; reflData[base + 1] = r.k; reflData[base + 2] = r.l; reflData[base + 3] = r.s;
      reflData[base + 4] = r.qHat[0]!; reflData[base + 5] = r.qHat[1]!; reflData[base + 6] = r.qHat[2]!;
    });

    const paramsBuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([nRefl, nModels, 0, 0]));
    this.device.queue.writeBuffer(paramsBuf, 16, new Float32Array([reciprocal.as, reciprocal.bs, reciprocal.cs, 0]));

    const reflBuf = this.storage(reflData);
    const atomBuf = this.storage(atomData);
    const rangeBuf = this.storage(rangeData);
    const ionBuf = this.storage(ionData);
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
        { binding: 4, resource: { buffer: ionBuf } },
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
    for (const buf of [paramsBuf, reflBuf, atomBuf, rangeBuf, ionBuf, outBuf, readBuf]) buf.destroy();

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

/** Reflection list + s + unit q̂ + reciprocal edges the magnetic kernel needs. */
export function magneticStructureFactorInputs(
  structure: StructureModel,
  hkls: readonly { h: number; k: number; l: number }[],
): { reflections: MagReflection[]; reciprocal: { as: number; bs: number; cs: number } } {
  const g = reciprocalMetricTensor(structure.cell);
  const reciprocal = { as: Math.sqrt(g[0][0]), bs: Math.sqrt(g[1][1]), cs: Math.sqrt(g[2][2]) };
  const reflections = hkls.map(({ h, k, l }) => {
    const d = dSpacing(structure.cell, h, k, l);
    const q = qCartesian(structure.cell, h, k, l);
    const qn = Math.hypot(q[0], q[1], q[2]);
    const qHat: [number, number, number] = qn === 0 ? [0, 0, 0] : (normalize(q) as [number, number, number]);
    return { h, k, l, s: d === Infinity ? 0 : 1 / (2 * d), qHat };
  });
  return { reflections, reciprocal };
}

/**
 * Validation harness: |F_M|² on the GPU vs the CPU f64 truth, returning the max
 * relative deviation (normalized to the strongest reflection) and timings. The
 * oracle for the magnetic precision contract; null when WebGPU is unavailable.
 */
export async function gpuMagneticValidation(
  structure: StructureModel,
  magnetic: MagneticModel,
  hkls: readonly { h: number; k: number; l: number }[],
  cpuIntensity: (h: number, k: number, l: number) => number,
): Promise<{ maxRelError: number; nRefl: number; gpuMs: number; cpuMs: number } | null> {
  const gpu = await GpuMagneticStructureFactor.create();
  if (!gpu) return null;
  try {
    const atoms = expandMagneticAtoms(structure, magnetic);
    const { reflections, reciprocal } = magneticStructureFactorInputs(structure, hkls);
    const t0 = performance.now();
    const [gpuOut] = await gpu.computeIntensities([atoms], reflections, reciprocal);
    const gpuMs = performance.now() - t0;
    const t1 = performance.now();
    const cpu = hkls.map(({ h, k, l }) => cpuIntensity(h, k, l));
    const cpuMs = performance.now() - t1;
    const scale = Math.max(...cpu.map(Math.abs), 1e-30);
    let maxRel = 0;
    for (let i = 0; i < hkls.length; i++) maxRel = Math.max(maxRel, Math.abs(gpuOut![i]! - cpu[i]!) / scale);
    return { maxRelError: maxRel, nRefl: hkls.length, gpuMs, cpuMs };
  } finally {
    gpu.dispose();
  }
}
