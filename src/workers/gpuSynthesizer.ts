/**
 * WebGPU peak-profile synthesis — the browser-side accelerator foundation.
 *
 * Evaluates BATCHES of patterns (e.g. every Jacobian column of an iteration)
 * in one dispatch: thread (i, b) sums the Gaussian / pseudo-Voigt peaks of
 * batch b at grid point i. Peaks are windowed to ±20 FWHM exactly like the
 * CPU path (profile.ts).
 *
 * PRECISION CONTRACT — read before wiring this anywhere:
 * WebGPU compute is f32; the CPU engine is f64. GPU results are APPROXIMATE
 * and NOT bit-identical — the exactness guarantees of the CPU pool
 * (peakCache / engineParallel identity tests) do not extend here. The
 * abscissa and peak centers travel as double-f32 (hi, lo) splits so the
 * precision-critical x − center subtraction keeps ~1e-7; the residual error
 * is f32 exp() and accumulation. MEASURED on hardware (Apple GPU, 20k points
 * × 5.5k sharp pseudo-Voigt peaks × 24 batches): max deviation 1.1e-5 of the
 * pattern maximum, GPU 52 ms vs CPU 884 ms (17×). That deviation is far
 * below counting statistics and esd scales (≥1e-3 relative), but any
 * integration must stay opt-in, labelled, and re-validated per problem class
 * via `gpuValidation`, which returns the max relative deviation for callers
 * to bound. TOF back-to-back-exponential peaks are not implemented yet;
 * `supports()` reports what is.
 */

import type { ProfilePeak, ProfileOptions } from "@/core/diffraction/profile";

const WGSL = /* wgsl */ `
struct Params {
  nPoints: u32,
  nBatches: u32,
  globalEta: f32,   // pseudo-Voigt fallback mix; <0 means pure Gaussian shape
  _pad: u32,
}
struct Peak {
  centerHi: f32,    // f64 center split into hi + lo f32 parts: the x − center
  centerLo: f32,    // subtraction is the precision-critical step (both ~10²,
  intensity: f32,   // naive f32 rounding costs ~1e-4 relative on sharp peaks;
  fwhm: f32,        // the double-f32 split recovers ~1e-7).
  eta: f32,         // <0: use globalEta (or Gaussian when that is <0)
  _pad: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
// Grid points as (hi, lo) f32 pairs split from the f64 abscissa.
@group(0) @binding(1) var<storage, read> xs: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> peaks: array<Peak>;
// Per-batch [start, end) into the peaks array.
@group(0) @binding(3) var<storage, read> ranges: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;

const LN2: f32 = 0.6931471805599453;
const PI: f32 = 3.141592653589793;

fn gaussianAt(d: f32, fwhm: f32) -> f32 {
  let t = d / fwhm;
  let sigmaFactor = (2.0 * sqrt(LN2 / PI)) / fwhm;
  return sigmaFactor * exp(-4.0 * LN2 * t * t);
}

fn lorentzianAt(d: f32, fwhm: f32) -> f32 {
  let hwhm = fwhm * 0.5;
  return (hwhm / PI) / (d * d + hwhm * hwhm);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;            // grid point
  let b = gid.y;            // batch index
  if (i >= params.nPoints || b >= params.nBatches) { return; }
  let x = xs[i];
  let range = ranges[b];
  var sum: f32 = 0.0;
  for (var p: u32 = range.x; p < range.y; p = p + 1u) {
    let pk = peaks[p];
    // Double-f32 difference: exact hi-part subtraction + lo-part correction.
    let d = (x.x - pk.centerHi) + (x.y - pk.centerLo);
    if (abs(d) > 20.0 * pk.fwhm) { continue; }
    var eta = pk.eta;
    if (eta < 0.0) { eta = params.globalEta; }
    var shape: f32;
    if (eta < 0.0) {
      shape = gaussianAt(d, pk.fwhm);
    } else {
      let e = clamp(eta, 0.0, 1.0);
      shape = e * lorentzianAt(d, pk.fwhm) + (1.0 - e) * gaussianAt(d, pk.fwhm);
    }
    sum = sum + pk.intensity * shape;
  }
  out[b * params.nPoints + i] = sum;
}
`;

export interface GpuSynthesisBatch {
  readonly peaks: readonly ProfilePeak[];
}

export class GpuSynthesizer {
  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
  ) {}

  /** Null when WebGPU is unavailable (feature detection, never throws). */
  static async create(): Promise<GpuSynthesizer | null> {
    try {
      const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const module = device.createShaderModule({ code: WGSL });
      const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      return new GpuSynthesizer(device, pipeline);
    } catch {
      return null;
    }
  }

  /** Which profile options this kernel covers (TOF back-to-back is CPU-only). */
  static supports(opts: Pick<ProfileOptions, "shape">): boolean {
    return opts.shape === "gaussian" || opts.shape === "pseudoVoigt";
  }

  /**
   * Synthesize every batch's pattern in one dispatch. Background is NOT
   * added here (it is f64-cheap on CPU and keeps the kernel shape-only).
   * Returns one Float32Array per batch, in order.
   */
  async synthesizeBatches(
    xValues: readonly number[],
    batches: readonly GpuSynthesisBatch[],
    opts: Pick<ProfileOptions, "shape" | "eta">,
  ): Promise<Float32Array[]> {
    const nPoints = xValues.length;
    const nBatches = batches.length;
    const totalPeaks = batches.reduce((n, b) => n + b.peaks.length, 0);

    // Split every f64 into hi (f32-rounded) + lo (residual) so the kernel's
    // x − center difference keeps ~1e-7 relative precision.
    const xsData = new Float32Array(nPoints * 2);
    for (let i = 0; i < nPoints; i++) {
      const hi = Math.fround(xValues[i]!);
      xsData[i * 2] = hi;
      xsData[i * 2 + 1] = xValues[i]! - hi;
    }
    const xsBuf = this.storage(xsData, GPUBufferUsage.STORAGE);
    const peakData = new Float32Array(Math.max(totalPeaks, 1) * 6);
    const rangeData = new Uint32Array(Math.max(nBatches, 1) * 2);
    let off = 0;
    batches.forEach((batch, b) => {
      rangeData[b * 2] = off;
      for (const pk of batch.peaks) {
        const hi = Math.fround(pk.center);
        peakData[off * 6] = hi;
        peakData[off * 6 + 1] = pk.center - hi;
        peakData[off * 6 + 2] = pk.intensity;
        peakData[off * 6 + 3] = pk.fwhm;
        peakData[off * 6 + 4] = pk.eta ?? -1;
        off++;
      }
      rangeData[b * 2 + 1] = off;
    });
    const peaksBuf = this.storage(peakData, GPUBufferUsage.STORAGE);
    const rangesBuf = this.storage(rangeData, GPUBufferUsage.STORAGE);

    const isGaussian = opts.shape === "gaussian";
    const globalEta = isGaussian ? -1 : opts.eta ?? 0.5;
    const paramsBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([nPoints, nBatches, 0, 0]));
    this.device.queue.writeBuffer(paramsBuf, 8, new Float32Array([globalEta]));

    const outSize = nPoints * nBatches * 4;
    const outBuf = this.device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = this.device.createBuffer({ size: outSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: xsBuf } },
        { binding: 2, resource: { buffer: peaksBuf } },
        { binding: 3, resource: { buffer: rangesBuf } },
        { binding: 4, resource: { buffer: outBuf } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(nPoints / 64), nBatches);
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, outSize);
    this.device.queue.submit([encoder.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const all = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    for (const b of [xsBuf, peaksBuf, rangesBuf, paramsBuf, outBuf, readBuf]) b.destroy();

    const out: Float32Array[] = [];
    for (let b = 0; b < nBatches; b++) out.push(all.subarray(b * nPoints, (b + 1) * nPoints).slice());
    return out;
  }

  private storage(data: Float32Array | Uint32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buf = this.device.createBuffer({ size: Math.max(data.byteLength, 16), usage: usage | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data as unknown as ArrayBufferView<ArrayBuffer>);
    return buf;
  }

  dispose(): void {
    this.device.destroy();
  }
}

