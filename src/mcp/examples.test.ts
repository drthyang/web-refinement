import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MN3GA_CIF } from "@/examples/mn3ga";
import { MNO_CIF } from "@/examples/mn3gaPowgen";
import { GATA4SE8_CIF, GATA4SE8_GR } from "@/examples/gata4se8PdfData";
import { exampleMagnetic } from "@/examples/mn3gaMagnetic";
import { parse_instrument, simulate_pattern } from "@/mcp/tools";

/**
 * The worked examples in docs/AGENT_EXAMPLES.md, kept honest.
 *
 * 1. The files in examples/mcp/ are the app's own bundled data written out, so
 *    an MCP client can load them by `path`. They must not drift from their
 *    sources: run with UPDATE_MCP_EXAMPLES=1 to rewrite them.
 * 2. Each example's tool sequence is replayed through a real MCP client, and
 *    the outcomes the page promises are asserted — a changed tool cannot leave
 *    the page describing a result it no longer gives.
 */

const REPO = resolve(__dirname, "../..");
const DIR = resolve(REPO, "examples/mcp");
const UPDATE = process.env.UPDATE_MCP_EXAMPLES === "1";
/** The slow parts (a second boxcar scan) run only on request: MCP_EXAMPLES_FULL=1. */
const FULL = process.env.MCP_EXAMPLES_FULL === "1";

/** POWGEN 600 K bank: difC from the PG3_45607.gsa header, as a FullProf .irf. */
const POWGEN_IRF = `! POWGEN 600 K bank — the TOF calibration of src/examples/datasets/mn3ga_powgen_600k.dat
! (difC from the PG3_45607.gsa header). D2TOF: difC difA difB zero.
D2TOF  22585.80  0.0000  0.0000  0.0000
`;

/** Example 3's instrument: constant-wavelength neutrons, GSAS-II parameters. */
const MN3GA_30K_INSTPRM = `#GSAS-II instrument parameter file; do not add/delete items!
Type:PNC
Bank:1.0
Lam:1.54
Zero:0.0
Polariz.:0.0
Azimuth:0.0
U:27.0
V:-27.0
W:27.0
X:0.0
Y:5.0
Z:0.0
SH/L:0.002
`;

/**
 * Example 3's structure: the nuclear part of the bundled 30 K Mn₃Ga magnetic
 * structure (src/examples/mn3gaMagnetic.ts), moments removed, in its parent
 * group P2₁/m. Written from the model, not by hand, so it cannot drift.
 */
function mn3ga30kNuclearCif(): string {
  const { structure } = exampleMagnetic();
  const { a, b, c, alpha, beta, gamma } = structure.cell;
  const sites = structure.sites.map((s) => {
    const u = s.adp.kind === "isotropic" ? s.adp.bIso / (8 * Math.PI ** 2) : 0;
    return `${s.label} ${s.element} ${s.position.map((x) => x.toFixed(5)).join(" ")} ${s.occupancy.toFixed(4)} ${u.toFixed(5)}`;
  });
  return `# Mn3Ga at 30 K: the nuclear part of the P2_1'/m' magnetic structure in
# src/examples/mn3gaMagnetic.ts (GSAS-II validation data), without moments.
data_Mn3Ga_30K_nuclear
_cell_length_a ${a.toFixed(5)}
_cell_length_b ${b.toFixed(5)}
_cell_length_c ${c.toFixed(5)}
_cell_angle_alpha ${alpha.toFixed(4)}
_cell_angle_beta ${beta.toFixed(4)}
_cell_angle_gamma ${gamma.toFixed(4)}
_symmetry_space_group_name_H-M 'P 1 21/m 1'
loop_
_space_group_symop_operation_xyz
'x,y,z'
'-x,y+1/2,-z'
'-x,-y,-z'
'x,-y+1/2,z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_U_iso_or_equiv
${sites.join("\n")}
`;
}

/**
 * Example 3's data: a neutron pattern simulated from the full magnetic model
 * with the instrument above — 30 000 counts at the strongest peak on a sloping
 * background, with seeded Gaussian noise of √y. Values and σ are written to 4
 * decimals.
 */
function mn3ga30kPattern(): string {
  const truth = exampleMagnetic();
  const instrument = parse_instrument({ text: MN3GA_30K_INSTPRM });
  const sim = simulate_pattern({ structure: truth.structure, magnetic: truth.magnetic, instrument, xMin: 5, xMax: 130, points: 6251 });
  const top = Math.max(...sim.curves.yCalc);
  let seed = 4242;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gauss = (): number => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const rows = sim.curves.x.map((x, i) => {
    const y = (30000 * sim.curves.yCalc[i]!) / top + 400 - 1.2 * x;
    return `${x.toFixed(4)} ${(y + Math.sqrt(y) * gauss()).toFixed(4)} ${Math.sqrt(y).toFixed(4)}`;
  });
  return `# Mn3Ga 30 K, SIMULATED: constant-wavelength neutrons (1.54 A), from the magnetic
# model in src/examples/mn3gaMagnetic.ts with mn3ga_30k.instprm. 2theta intensity sigma.
${rows.join("\n")}
`;
}

const FILES: Readonly<Record<string, string>> = {
  "mn3ga.cif": MN3GA_CIF.trimStart(),
  "mno.cif": MNO_CIF.trimStart(),
  "powgen_600k.irf": POWGEN_IRF,
  "gata4se8.cif": GATA4SE8_CIF.trimStart(),
  "gata4se8_299k.gr": GATA4SE8_GR,
  "mn3ga_30k_nuclear.cif": mn3ga30kNuclearCif(),
  "mn3ga_30k.instprm": MN3GA_30K_INSTPRM,
};

describe("examples/mcp files", () => {
  for (const [name, text] of Object.entries(FILES)) {
    it(`${name} is its source, written out`, () => {
      const file = resolve(DIR, name);
      if (UPDATE) writeFileSync(file, text);
      expect(existsSync(file), `${name} is missing — run UPDATE_MCP_EXAMPLES=1 npx vitest run src/mcp/examples.test.ts`).toBe(true);
      expect(readFileSync(file, "utf8"), `${name} drifted from its source — rerun with UPDATE_MCP_EXAMPLES=1`).toBe(text);
    });
  }

  // The simulated pattern is data, not source: a change to the pattern model
  // must not silently rewrite it. It is checked against a fresh simulation to
  // a small fraction of its noise, which catches a wrong or stale file.
  it("mn3ga_30k_sim.xye is the simulation it claims to be", () => {
    const file = resolve(DIR, "mn3ga_30k_sim.xye");
    const text = mn3ga30kPattern();
    if (UPDATE) writeFileSync(file, text);
    const rows = (t: string): number[][] => t.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(" ").map(Number));
    const [have, want] = [rows(readFileSync(file, "utf8")), rows(text)];
    expect(have.length).toBe(want.length);
    have.forEach((r, i) => expect(Math.abs(r[1]! - want[i]![1]!), `point ${i}`).toBeLessThan(0.05 * want[i]![2]!));
  });
});

/** Per example, and so per call: the client's default request timeout is 60 s. */
const EXAMPLE_TIMEOUT = 300_000;

describe("worked examples, replayed through an MCP client", () => {
  // The server is the bundle `npm run mcp` serves, in its own process over
  // stdio, as a client runs it. In process, the in-memory transport never
  // yields, so a whole example ran as one blocking stretch on the vitest
  // worker (~64 s and ~88 s on a CI runner) and tripped vitest's fixed 60 s
  // worker RPC timeout ("Timeout calling onTaskUpdate") with every test green.
  let client: Client | undefined;
  let tmp = "";
  let serverLog = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client!.callTool({ name, arguments: args }, undefined, { timeout: EXAMPLE_TIMEOUT });
    const text = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "materia-examples-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(REPO, "scripts/build-mcp.mjs"), "--serve", "--outfile", join(tmp, "mcp-server.mjs")],
      env: { MATERIA_ROOTS: REPO },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => { serverLog += chunk.toString(); });
    client = new Client({ name: "examples-test", version: "0" });
    await client.connect(transport).catch((e: Error) => { throw new Error(`${e.message}\nserver stderr:\n${serverLog}`); });
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Example 1 — look at a structure before any data", async () => {
    const s = await call("parse_structure", { path: "examples/mcp/mn3ga.cif" });
    expect(s.structure).toMatchObject({ spaceGroup: "P 63/m m c" });
    const sym = await call("analyze_site_symmetry", { structure: s.structure });
    const wyckoff = Object.fromEntries((sym.sites as { label: string; wyckoff: string }[]).map((x) => [x.label, x.wyckoff]));
    expect(wyckoff).toMatchObject({ Mn1: "6h", Ga1: "2d" });
    const refl = await call("reflection_list", { structure: s.structure, dMin: 1.5, dMax: 6, instrument: { kind: "constantWavelength", wavelength: 1.5406 } });
    const first = (refl.reflections as { h: number; k: number; l: number; x: number }[]).slice(0, 4).map((r) => `${r.h}${r.k}${r.l}@${r.x.toFixed(1)}`);
    expect(first).toEqual(["100@18.9", "101@27.8", "2-10@33.0", "200@38.3"]);
    const bonds = await call("bond_geometry", { structure: s.structure, cutoff: 3.2 });
    expect(bonds.shortest).toMatchObject({ from: "Mn1", to: "Mn1" });
    expect(bonds.shortest.distance).toBeCloseTo(2.665, 3); // a normal metallic Mn–Mn contact
  });

  it("Example 3 — a magnetic structure from the peaks the nuclear model leaves", async () => {
    const s = await call("parse_structure", { path: "examples/mcp/mn3ga_30k_nuclear.cif" });
    const p = await call("parse_powder_data", { path: "examples/mcp/mn3ga_30k_sim.xye" });
    const instrument = await call("parse_instrument", { path: "examples/mcp/mn3ga_30k.instprm" });
    const m = await call("build_refinement", { structure: s.structure, pattern: p.pattern, instrument });
    // Nuclear only, atoms held: at k = 0 free positions would soak up the
    // magnetic intensity, which sits on the nuclear reflections.
    const nuc = await call("refine_powder", {
      structure: s.structure, pattern: p.pattern, instrument, parameters: m.parameters, bindings: m.bindings, profile: m.profile,
      free: ["scale", "bkg*", "cell_*", "profU", "profV", "profW"],
    });
    expect(nuc.result.agreement.rWeighted).toBeGreaterThan(0.11);
    expect(nuc.result.agreement.rWeighted).toBeLessThan(0.13); // 12.4 %
    const peaks = await call("find_unexplained_peaks", { residual: nuc.residual });
    const d = (peaks.peaks as { d: number }[]).map((x) => x.d);
    expect(d[0]).toBeCloseTo(3.167, 2);
    const ks = await call("search_propagation_vector", { structure: s.structure, peakD: d });
    expect(ks.candidates[0]).toMatchObject({ label: "(0 0 0)", matched: d.length });
    const subs = await call("list_magnetic_subgroups", { structure: s.structure, k: [0, 0, 0] });
    const candidates = subs.candidates as { bns: string; index: number }[];

    // Every maximal group, each with a moment search.
    const fit = async (bns: string, restarts: number) => {
      const i = candidates.findIndex((c) => c.bns === bns);
      const mm = await call("build_magnetic_model", {
        structure: s.structure, ionLabels: ["Mn1_0", "Mn2_1", "Mn3_2"], operations: { ref: `${subs.ref}/candidates/${i}/operations` }, k: [0, 0, 0], moment: 2,
      });
      const r = await call("refine_magnetic_powder", {
        structure: s.structure, magnetic: mm.magnetic, pattern: p.pattern, profile: m.profile,
        parameters: [nuc.parameters, mm.parameters], bindings: [m.bindings, mm.bindings], free: ["scale", "bkg*", "mom_*"], restarts,
      });
      return { mm, r, wR: r.result.agreement.rWeighted as number };
    };
    const maximal = candidates.filter((c) => c.index === 2).map((c) => c.bns);
    expect(maximal.sort()).toEqual(["P2_1'/m", "P2_1'/m'", "P2_1/m", "P2_1/m'"]);
    const fits = Object.fromEntries(await Promise.all(maximal.map(async (bns) => [bns, await fit(bns, 12)] as const)));
    const best = fits["P2_1'/m'"]!;
    expect(best.wR).toBeLessThan(0.047); // 4.61 %, GoF 1.07
    for (const bns of maximal.filter((b) => b !== "P2_1'/m'")) expect(fits[bns]!.wR, bns).toBeGreaterThan(0.09);
    // One LM run from the same start stops in a wrong minimum with Mn1 switched off.
    const once = await fit("P2_1'/m'", 0);
    expect(once.wR).toBeGreaterThan(0.048);

    // Everything free, atoms included.
    const final = await call("refine_magnetic_powder", {
      structure: s.structure, magnetic: best.r.magnetic, pattern: p.pattern, profile: m.profile,
      parameters: best.r.parameters, bindings: [m.bindings, best.mm.bindings],
      free: ["scale", "bkg*", "cell_*", "profU", "profV", "profW", "pos_*", "B_*", "mom_*"],
    });
    expect(final.result.agreement.goodnessOfFit).toBeLessThan(1.05);
    const values = (await call("read_ref", { ref: `${final.result.ref}/parameters` })).value as Record<string, number>;
    for (const [id, v] of Object.entries(values)) if (id.startsWith("pos_")) expect(Math.abs(v), id).toBeLessThan(1e-3);
    // The moments are the ones the pattern was simulated from, up to the global ±m.
    const found = (await call("read_ref", { ref: final.magnetic.ref })).value as { moments: { siteLabel: string; components: number[] }[] };
    const truth = exampleMagnetic().magnetic.moments;
    const sign = Math.sign(found.moments[0]!.components[0]! * truth[0]!.components[0]!);
    for (const t of truth) {
      const f = found.moments.find((x) => x.siteLabel === t.siteLabel)!;
      t.components.forEach((c, j) => expect(Math.abs(sign * f.components[j]! - c), `${t.siteLabel}[${j}]`).toBeLessThan(0.1));
    }
  }, EXAMPLE_TIMEOUT);

  it("Example 4 — a PDF fit block by block, then local vs average", async () => {
    const s = await call("parse_structure", { path: "examples/mcp/gata4se8.cif" });
    const p = await call("parse_pdf_data", { path: "examples/mcp/gata4se8_299k.gr" });
    const m = await call("build_pdf_model", { structure: s.structure, pattern: p.pattern });
    expect(m.warnings).toEqual([]);
    const common = { structure: s.structure, pattern: p.pattern, bindings: m.bindings, restraints: m.restraints, fitRange: { min: 1.5, max: 28 } };
    // The recorded run frees one block at a time; freeing them all at once
    // lands on the same minimum, which is what CI checks (the blocks cost ~5×).
    const allBlocks = ["pdfScale", "cell_a", "U_*", "qdamp", "delta1", "pos_*"];
    let parameters = m.parameters;
    if (FULL) {
      const blocks: [string[], number][] = [
        [["pdfScale", "cell_a"], 0.36],
        [["pdfScale", "cell_a", "U_*"], 0.2],
        [["pdfScale", "cell_a", "U_*", "qdamp", "qbroad"], 0.13],
        [["pdfScale", "cell_a", "U_*", "qdamp", "delta1"], 0.09],
      ];
      for (const [free, below] of blocks) {
        const r = await call("refine_pdf", { ...common, parameters, free });
        expect(r.result.agreement.rWeighted, free.join(",")).toBeLessThan(below);
        parameters = r.parameters;
      }
    }
    const final = await call("refine_pdf", { ...common, parameters, free: allBlocks, maxIterations: 40 });
    expect(final.result.agreement.rWeighted).toBeLessThan(0.085); // 8.33 %, beside the demo's 8.12 %
    const values = (await call("read_ref", { ref: `${final.result.ref}/parameters` })).value as Record<string, number>;
    expect(values.qdamp).toBeCloseTo(0.0439, 3);
    expect(values.delta1).toBeCloseTo(1.778, 2);
    parameters = final.parameters;
    // Local vs average: 6 Å boxes.
    const scan = (direction: "up" | "down") => call("refine_pdf_boxcar", {
      structure: s.structure, pattern: p.pattern, parameters, bindings: m.bindings, restraints: m.restraints,
      free: ["pdfScale", "cell_a", "U_Ta1_0", "U_Se1_0", "U_Se2_0"], width: 6, step: 3, range: { min: 1.5, max: 28 }, direction,
    });
    const up = await scan("up");
    const rw = (up.boxes as { rWeighted: number }[]).map((b) => b.rWeighted);
    const rest = rw.slice(1).sort((x, y) => x - y);
    expect(rw[0]!).toBeGreaterThan(2 * rest[rest.length >> 1]!); // the lowest box fits worst
    const track = (run: { evolution: { parameterId: string; values: number[] }[] }, id: string): number[] =>
      run.evolution.find((e) => e.parameterId === id)!.values;
    const se2 = track(up, "U_Se2_0");
    expect(se2[se2.length - 1]! / se2[0]!).toBeGreaterThan(1.5); // U(Se2) grows with r
    const a = track(up, "cell_a");
    expect((Math.max(...a) - Math.min(...a)) / a[0]!).toBeLessThan(5e-4); // the cell does not
    if (FULL) {
      // The reverse scan: the drift is in the data, not the path — the two
      // tracks agree well inside their esds (~2×10⁻⁴).
      const down = [...track(await scan("down"), "U_Se2_0")].reverse();
      down.forEach((v, i) => expect(Math.abs(v - se2[i]!)).toBeLessThan(1e-4));
    }
  }, EXAMPLE_TIMEOUT);
});
