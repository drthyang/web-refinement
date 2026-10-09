/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalize, resolve, sep } from "node:path";
import { anthropicProxy } from "./src/copilot/proxy";

// GitHub Pages serves from a repo subpath; override with VITE_BASE if needed.
const base = process.env.VITE_BASE ?? "/web-refinement/";

/**
 * Dev-only static server for the git-ignored `data/` folder, so the app can
 * `fetch` the real (local-only) datasets — e.g. the POWGEN high-entropy pattern —
 * at runtime during development. Not applied to production builds (`apply:
 * "serve"`), so a deployed static site simply falls back to bundled structures.
 * Matches `…/data/<path>` anywhere in the URL (robust to the configured base) and
 * guards against path traversal outside `data/`.
 */
function serveLocalData(): Plugin {
  const dataDir = fileURLToPath(new URL("./data", import.meta.url));
  const dataDirWithSep = dataDir.endsWith(sep) ? dataDir : dataDir + sep;
  return {
    name: "serve-local-data",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0]!;
        const match = url.match(/\/data\/(.+)$/);
        if (!match) return next();
        let decoded: string;
        try {
          decoded = decodeURIComponent(match[1]!);
        } catch {
          res.statusCode = 400;
          res.end("Bad request");
          return;
        }
        const filePath = normalize(resolve(dataDir, decoded));
        if (filePath !== dataDir && !filePath.startsWith(dataDirWithSep)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        if (!existsSync(filePath)) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        readFile(filePath)
          .then((buf) => {
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(buf);
          })
          .catch(() => {
            res.statusCode = 500;
            res.end("Read error");
          });
      });
    },
  };
}

/**
 * The Copilot's local proxy (src/copilot/proxy.ts): `<base>api/anthropic/…`
 * forwarded to the Anthropic API with ANTHROPIC_API_KEY from the environment
 * or .env.local, so the key never reaches the page. Dev and preview servers
 * only; the static build has no server and so no proxy.
 */
function copilotProxy(apiKey: string | undefined): Plugin {
  const handler = anthropicProxy(apiKey);
  return {
    name: "copilot-anthropic-proxy",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base,
  // Read without a prefix filter, server side only: never exposed to the page.
  plugins: [react(), serveLocalData(), copilotProxy(loadEnv(mode, process.cwd(), "").ANTHROPIC_API_KEY)],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  worker: {
    format: "es",
  },
  build: {
    // The bundled Mn₃Ga POWGEN example pattern (~240 KB, embedded via ?raw) puts
    // the main chunk over Vite's default 500 KB notice; that is expected here.
    chunkSizeWarningLimit: 800,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
}));
