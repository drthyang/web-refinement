/**
 * Drive the app open in the browser through the `materia-live` bridge, the way
 * Claude Code does — a smoke test of the whole path without a model.
 *
 *   1. npm run dev, load a powder analysis (e.g. Demos ▸ Rietveld), open the
 *      Copilot and choose "Claude Code".
 *   2. node scripts/live-bridge-demo.mjs
 *
 * It starts the server exactly as .mcp.json does (stdio), then reads the fit,
 * asks to refine it (approve the card in the app), and judges the result.
 * Each change waits for your approval in the Copilot panel.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["scripts/build-mcp.mjs", "--live", "--serve"],
  stderr: "inherit",
});
const client = new Client({ name: "live-bridge-demo", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`materia-live: ${tools.length} tools — ${tools.map((t) => t.name).join(", ")}\n`);

async function call(name, args = {}) {
  process.stdout.write(`→ ${name} ${JSON.stringify(args)}\n`);
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60_000 });
  const text = r.content[0]?.text ?? "";
  const out = text.startsWith("Error:") ? text : JSON.parse(text);
  return { isError: !!r.isError, out };
}

/** Wait until the page connects (the bridge says so on every call). */
async function connected() {
  for (let i = 0; i < 60; i++) {
    const r = await client.callTool({ name: "get_state", arguments: {} });
    const text = r.content[0]?.text ?? "";
    if (!/not connected/.test(text)) return;
    if (i === 0) console.log("waiting for the app (open the Copilot, choose Claude Code)…");
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("the app never connected");
}

try {
  await connected();
  const state = (await call("get_state")).out;
  console.log(`  ${state.phases.map((p) => `${p.name} (${p.spaceGroup})`).join(" + ")}; ${state.data.points} points, ${state.data.axis}`);
  console.log(`  wR on screen ${state.wR}%; free: ${state.parameterGroups.filter((g) => g.free).map((g) => `${g.kind} ${g.free}/${g.count}`).join(", ")}`);
  console.log(`  last refinement: ${state.lastRefinement ? `${state.lastRefinement.status}, wR ${state.lastRefinement.wR}%` : "none yet"}\n`);

  console.log("Asking to refine — approve the card in the Copilot panel.");
  const refined = await call("refine");
  console.log(`  ${refined.isError ? refined.out : refined.out.refined ? `${refined.out.status}: wR ${refined.out.wRBefore}% → ${refined.out.wR}%, GoF ${refined.out.gof}, ${refined.out.iterations} iterations, step ${refined.out.step?.id} "${refined.out.step?.label}"` : JSON.stringify(refined.out)}\n`);

  const assessed = await call("assess_refinement");
  if (assessed.isError) console.log(`  ${assessed.out}\n`);
  else {
    console.log(`  ${assessed.out.summary}`);
    const findings = Array.isArray(assessed.out.findings) ? assessed.out.findings : [];
    for (const f of findings.slice(0, 4)) console.log(`   · [${f.severity}] ${f.summary}`);
    console.log("");
  }

  const next = await call("suggest_next_steps");
  const steps = Array.isArray(next.out.steps) ? next.out.steps : [];
  for (const s of steps.slice(0, 3)) console.log(`   · ${s.priority}. ${s.action}`);
  console.log("");

  const peaks = await call("find_unexplained_peaks");
  console.log(`  ${peaks.isError ? peaks.out : `${peaks.out.count} unexplained peak(s)${peaks.out.peaks.length ? `: d = ${peaks.out.peaks.slice(0, 5).map((p) => p.d).join(", ")} Å` : ""}`}\n`);

  const after = (await call("get_state")).out;
  console.log("  history (newest first):");
  for (const st of after.history.recent.slice(0, 4)) console.log(`   · ${st.id} ${st.label}${st.wR !== undefined ? ` — wR ${st.wR}%` : ""} [${st.by}]`);
} finally {
  await client.close();
}
