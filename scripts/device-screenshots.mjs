/**
 * Regenerate the README device screenshots (docs/screenshots/*.png).
 *
 * Drives the locally-installed Chrome via playwright-core (no browser
 * download) against a running dev server, runs a real refinement of the
 * bundled Mn₃Ga + MnO POWGEN dataset so the plots show a converged fit, and
 * captures the workbench at desktop / iPad / iPhone viewports.
 *
 * Usage:  npm run dev   (in another terminal)
 *         node scripts/device-screenshots.mjs [baseUrl]
 */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5173/web-refinement/";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;

/** Viewports: CSS px; 2x scale for crisp README rendering. */
const DEVICES = {
  desktop: { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 },
  ipad: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, hasTouch: true },
  iphone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function preparePage(context) {
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("header");
  // Run the real refinement so the screenshots show a converged fit
  // (wR ~8% two-phase Mn₃Ga + MnO) instead of the unrefined overlay.
  await page.getByRole("button", { name: "Refine", exact: true }).click();
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

    if (name === "ipad") {
      // iPad shows the magnetic symmetry analysis — the workbench's second step —
      // with a magnetic space group selected so the 3D cell carries its
      // symmetry-allowed moment arrows.
      await page.getByRole("button", { name: /Magnetic$/ }).click();
      await page.waitForSelector("text=Magnetic symmetry analysis");
      await page.getByRole("button", { name: /BNS 194\.271/ }).click();
      await page.waitForTimeout(900); // let three.js draw the moments
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
