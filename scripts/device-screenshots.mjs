/**
 * Regenerate the README screenshot (docs/screenshots/desktop.png).
 *
 * Drives the locally-installed Chrome via playwright-core (no browser
 * download) against a running dev server, runs a real refinement of the
 * bundled Mn₃Ga + MnO POWGEN dataset so the plots show a converged fit, and
 * captures the workbench at a full-HD desktop viewport (wide enough that no
 * panel is squeezed; the app is fluid up to 2100px).
 *
 * Usage:  npm run dev   (in another terminal)
 *         node scripts/device-screenshots.mjs [baseUrl]
 */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5173/web-refinement/";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;

/** Full-HD desktop in CSS px; 2x scale for crisp README rendering. */
const DEVICES = {
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 },
};

async function preparePage(context) {
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("header");
  // The workbench opens clean; load the bundled Rietveld demo from the Demos
  // menu (it opens on the converged two-phase Mn₃Ga + MnO fit).
  await page.getByRole("button", { name: "Demos ▾", exact: true }).click();
  await page.getByRole("button", { name: "Rietveld · Mn₃Ga neutron TOF", exact: true }).click();
  const refine = page.getByRole("button", { name: "Refine", exact: true });
  await refine.waitFor({ timeout: 15000 });
  // Run the refinement so the parameter table shows final values with esds
  // (converges in ~2 cycles from the seeded fit; wR ~3.9%).
  await refine.click();
  await page.waitForSelector("text=Result: converged", { timeout: 60000 });
  // Let the plot repaint with the final curves.
  await page.waitForTimeout(600);
  return page;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  for (const [name, cfg] of Object.entries(DEVICES)) {
    const context = await browser.newContext(cfg);
    const page = await preparePage(context);

    if (name === "desktop") {
      // Parameter groups start collapsed; expand Scale + Lattice so the
      // README hero shot shows refined values with esds.
      await page.getByText("Scale", { exact: true }).click();
      await page.getByText("Lattice", { exact: true }).click();
      await page.waitForTimeout(250);
    }

    // Frame from the top of the page (the refine-wait may have scrolled).
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}${name}.png` });
    console.log(`captured ${name}.png (${cfg.viewport.width}×${cfg.viewport.height}@${cfg.deviceScaleFactor}x)`);
    await context.close();
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
