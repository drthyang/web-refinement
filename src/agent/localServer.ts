/**
 * What the two local-model servers (Ollama, LM Studio) share. Both answer the
 * Anthropic Messages API at `<server>/v1/messages`, so the chat loop (chat.ts)
 * drives them with the same SDK, tools and executor as Claude, straight from
 * this browser. Nothing leaves this machine.
 *
 * Kept free of the SDK so the drawer can list models without loading it.
 */

/**
 * The Agent's instructions alone are about 15k tokens (the system prompt with
 * the user's method and two reference notes), plus the tool list and the
 * conversation. Below this, the model is likely to lose the start of it.
 */
export const MIN_AGENT_CONTEXT = 32_768;

/** The server address with no trailing slash (the SDK and `fetch` add the paths). */
export function serverBase(url: string, fallback: string): string {
  return (url.trim() || fallback).replace(/\/+$/, "");
}

/** The headers a local server's CORS rules let a page send, and all a request to it needs. */
const PLAIN_HEADERS = ["content-type", "accept"];

/**
 * `fetch` for the SDK, sending only plain headers. The SDK's own (`x-api-key`,
 * `anthropic-version`, `anthropic-beta`, `x-stainless-*`) would fail a local
 * server's CORS preflight, and neither server needs them.
 */
export function plainFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const given = new Headers(init?.headers);
  const headers = new Headers();
  for (const h of PLAIN_HEADERS) {
    const v = given.get(h);
    if (v !== null) headers.set(h, v);
  }
  return globalThis.fetch(input, { ...init, headers });
}

/** GET (or POST `body` as JSON) and parse the answer; throws on a network error or a non-2xx status. */
export async function getJson(url: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
  const init: RequestInit = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  if (signal) init.signal = signal;
  const res = await globalThis.fetch(url, init);
  if (!res.ok) throw new HttpError(url, res.status);
  return res.json();
}

export class HttpError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`${url} answered ${status}`);
  }
}

/** The page is served from this machine (localhost, 127.0.0.1 or [::1]). */
export function isMachineOrigin(pageOrigin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(pageOrigin);
}
