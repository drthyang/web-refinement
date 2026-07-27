// Regenerates the tri/cant/cant_dr sections of src/core/magnetic/mpdfGolden.ts
// from a synthetic_cases.json produced by scripts/gen_mpdf_goldens.py.
// Usage: node scripts/gen-mpdf-golden-fixture.mjs [path/to/synthetic_cases.json]
// Idempotent: strips a previously appended block (marked by the TRI_CELL
// comment) before re-appending.
import { readFileSync, writeFileSync } from "node:fs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TS = `${REPO}/src/core/magnetic/mpdfGolden.ts`;
const JSON_PATH = process.argv[2] ?? "synthetic_cases.json"; // from scripts/gen_mpdf_goldens.py

const cases = JSON.parse(readFileSync(JSON_PATH, "utf8"));
let src = readFileSync(TS, "utf8");

// Python-style %.10e (2-digit signed exponent) to match the existing arrays.
function fmt(v) {
  const s = v.toExponential(10);
  const m = s.match(/^(-?\d\.\d+)e([+-])(\d+)$/);
  if (!m) throw new Error(`bad number ${s}`);
  return `${m[1]}e${m[2]}${m[3].padStart(2, "0")}`;
}
const yLine = (ys) => `[${ys.map(fmt).join(", ")}]`;
// Full-precision round-trip repr for the small vectors (positions/moments).
const vecs = (vv) => vv.map((v) => `[${v.map((x) => String(x)).join(", ")}]`).join(", ");

// 1. Extend the GENERATED header (only once).
const headerAnchor = " * g = 1, K1 = (2/3)(γr₀/2)², K2 = K1·⟨m²⟩ — see magnetic/mpdf.ts.\n */";
const headerExt =
  " * g = 1, K1 = (2/3)(γr₀/2)², K2 = K1·⟨m²⟩ — see magnetic/mpdf.ts.\n" +
  " * Cases tri/cant/cant_dr (second box cell): a non-collinear 120° triangle,\n" +
  " * a canted triangle with a net moment under a finite exp(−r/ξ) SRO envelope,\n" +
  " * and the canted D(r). All fixture grids END at the last sample — there is\n" +
  " * no extension; the tests hand the kernel the bare grid r = k·rstep,\n" +
  " * k = 0…n−1, exactly as the reference was evaluated.\n */";
if (!src.includes("Cases tri/cant/cant_dr")) {
  if (!src.includes(headerAnchor)) throw new Error("header anchor not found");
  src = src.replace(headerAnchor, headerExt);
}

// 2. Optional xi on the interface (only once).
const ifaceAnchor = "  readonly qdamp: number;\n";
const ifaceExt =
  "  readonly qdamp: number;\n" +
  "  /** SRO correlation length ξ (Å): exp(−r/ξ) envelope on pair terms and the\n" +
  "   *  net-moment line. Set only for the cant/cant_dr cases. */\n" +
  "  readonly xi?: number;\n";
if (!src.includes("readonly xi?: number;")) {
  if (!src.includes(ifaceAnchor)) throw new Error("interface anchor not found");
  src = src.replace(ifaceAnchor, ifaceExt);
}

// 2b. Widen the y doc comment to name the new cases (only once).
const yDocOld = "  /** f(r) (cases afm/fm) or D(r) (case dr) on r = k·rstep, k = 0…n−1. */";
const yDocNew = "  /** f(r) (afm/fm/tri/cant) or D(r) (dr/cant_dr) on r = k·rstep, k = 0…n−1. */";
if (src.includes(yDocOld)) src = src.replace(yDocOld, yDocNew);

// 3. Strip a previous appended block, then append fresh.
const MARK = "/** Second box cell";
const at = src.indexOf(MARK);
if (at >= 0) src = src.slice(0, at).replace(/\n+$/, "\n") + "\n";
else src = src.replace(/\n*$/, "\n") + "\n";

const { cell, positions, tri, cant, cant_dr } = cases;

const block = `${MARK} (Å) for the tri/cant cases: a = b = ${cell.a}, c = ${cell.c}, all angles 90°. */
export const MPDF_GOLDEN_TRI_CELL = { a: ${cell.a}, b: ${cell.b}, c: ${cell.c} } as const;

/** Spin sites (fractional) shared by the tri/cant/cant_dr cases. */
export const MPDF_GOLDEN_TRI_POSITIONS = [${vecs(positions)}] as const;

/** 120° moments (Cartesian μB): |m| = 2.5 in the y–z plane, zero net moment. */
export const MPDF_GOLDEN_TRI_MOMENTS = [${vecs(tri.moments)}] as const;

/** Canted moments (Cartesian μB): non-collinear with a NONZERO net moment. */
export const MPDF_GOLDEN_CANT_MOMENTS = [${vecs(cant.moments)}] as const;

/** Non-collinear 120° f(r) — exercises the transverse/longitudinal (Aᵢⱼ/Bᵢⱼ)
 *  projection split for moments that are neither parallel nor antiparallel. */
export const MPDF_GOLDEN_TRI: MpdfGoldenCase = {
  rstep: ${tri.rstep}, n: ${tri.n}, psigma: ${tri.psigma}, qdamp: ${tri.qdamp},
  y: ${yLine(tri.y)},
};

/** Canted f(r): finite ξ — exp(−r/ξ) on the pair terms AND the net-moment line. */
export const MPDF_GOLDEN_CANT: MpdfGoldenCase & { readonly xi: number } = {
  rstep: ${cant.rstep}, n: ${cant.n}, psigma: ${cant.psigma}, qdamp: ${cant.qdamp}, xi: ${cant.xi},
  y: ${yLine(cant.y)},
};

/** Unnormalized D(r) of the cant case: Mn²⁺ ⟨j0⟩ (Q ≤ 25, ΔQ 0.01), envelope
 *  half-width 5 Å, paraScale ${cant_dr.paraScale}, ⟨m²⟩ = mean |m|² of the canted moments.
 *  Units barn·μB². */
export const MPDF_GOLDEN_CANT_DR: MpdfGoldenCase & {
  readonly xi: number; readonly paraScale: number; readonly mSqAvg: number;
} = {
  rstep: ${cant_dr.rstep}, n: ${cant_dr.n}, psigma: ${cant_dr.psigma}, qdamp: ${cant_dr.qdamp}, xi: ${cant_dr.xi},
  paraScale: ${cant_dr.paraScale}, mSqAvg: ${cant_dr.mSqAvg},
  y: ${yLine(cant_dr.y)},
};
`;

writeFileSync(TS, src + block);
console.log("wrote", TS);
console.log("tri n:", tri.y.length, "cant n:", cant.y.length, "cant_dr n:", cant_dr.y.length);
