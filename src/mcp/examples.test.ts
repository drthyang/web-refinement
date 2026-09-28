import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMateriaServer } from "@/mcp/host";
import { MN3GA_CIF } from "@/examples/mn3ga";
import { MNO_CIF } from "@/examples/mn3gaPowgen";
import { GATA4SE8_CIF, GATA4SE8_GR } from "@/examples/gata4se8PdfData";

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

const FILES: Readonly<Record<string, string>> = {
  "mn3ga.cif": MN3GA_CIF.trimStart(),
  "mno.cif": MNO_CIF.trimStart(),
  "powgen_600k.irf": POWGEN_IRF,
  "gata4se8.cif": GATA4SE8_CIF.trimStart(),
  "gata4se8_299k.gr": GATA4SE8_GR,
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
});

describe("worked examples, replayed through an MCP client", () => {
  let client: Client;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  }

  beforeAll(async () => {
    const server = createMateriaServer({ roots: [REPO] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "examples-test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => { await client.close(); });

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
  }, 300_000);
});
