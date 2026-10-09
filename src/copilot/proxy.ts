/**
 * The Copilot's local proxy to the Anthropic API, for the dev and preview
 * servers (vite.config.ts): the page calls `<base>api/anthropic/…`, and the
 * server forwards it with the key from ANTHROPIC_API_KEY, so the key never
 * reaches the browser. Not part of the static build.
 *
 * Only the app's own pages may use it: a request carrying an Origin must come
 * from the server's own host, so another site open in the browser cannot spend
 * the key through it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

const UPSTREAM = "https://api.anthropic.com";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Request headers passed upstream; everything else (cookies, the placeholder key) stays here. */
const FORWARD = ["content-type", "accept", "anthropic-version", "anthropic-beta"];
/** Response headers passed back. */
const RETURN = ["content-type", "request-id", "retry-after", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-remaining"];

type Next = (err?: unknown) => void;

export function anthropicProxy(apiKey: string | undefined, mount = "/api/anthropic") {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const url = req.url ?? "";
    const at = url.indexOf(mount + "/");
    if (at < 0) return next();
    void forward(req, res, url.slice(at + mount.length), apiKey).catch((e) => {
      if (!res.headersSent) fail(res, 502, "proxy_error", `The proxy could not reach the API: ${e instanceof Error ? e.message : String(e)}`);
      else res.end();
    });
  };
}

async function forward(req: IncomingMessage, res: ServerResponse, path: string, apiKey: string | undefined): Promise<void> {
  if (!sameOrigin(req)) return fail(res, 403, "forbidden", "Only this app's own pages may use the proxy.");
  if (!apiKey) {
    return fail(res, 503, "proxy_not_configured", "The proxy has no API key. Start the dev server with ANTHROPIC_API_KEY set (in the shell, or in .env.local), or use your own key in the Copilot settings.");
  }
  if (!path.startsWith("/v1/")) return fail(res, 404, "not_found", "The proxy forwards /v1/ API paths only.");
  const headers = new Headers();
  for (const h of FORWARD) {
    const v = req.headers[h];
    if (typeof v === "string") headers.set(h, v);
  }
  headers.set("x-api-key", apiKey);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  const upstream = await fetch(UPSTREAM + path, { method: req.method ?? "POST", headers, ...(body ? { body: new Uint8Array(body) } : {}), signal: ctrl.signal });
  res.statusCode = upstream.status;
  for (const h of RETURN) {
    const v = upstream.headers.get(h);
    if (v !== null) res.setHeader(h, v);
  }
  res.setHeader("Cache-Control", "no-store");
  if (!upstream.body) {
    res.end();
    return;
  }
  // Stream it back as it arrives (server-sent events for a streaming request).
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
}

/**
 * A browser sends Origin on every cross-origin request and on same-origin
 * POSTs; it must name this server. A request with no Origin and no Fetch
 * metadata is not from a web page (curl, a script on this machine) and passes.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin === undefined) {
    const site = req.headers["sec-fetch-site"];
    return site === undefined || site === "same-origin" || site === "none";
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function fail(res: ServerResponse, status: number, type: string, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}
