/**
 * The Agent on a local model: an Ollama server, reached straight from this
 * browser. Ollama answers the Anthropic Messages API at `<server>/v1/messages`
 * (checked on 0.40), so the chat loop (chat.ts) drives it with the same
 * SDK, tools and executor as Claude. Nothing leaves this machine.
 *
 * Two things differ from the Anthropic API:
 *  - Ollama's CORS rules admit only plain headers (Content-Type, Accept, …),
 *    not the SDK's `x-api-key` / `anthropic-*`, so `plainFetch` sends the
 *    request without them. Ollama needs none of them.
 *  - Which models exist, and which can call tools, is the server's to say:
 *    `listOllamaModels` reads it from `/api/tags` and `/api/show`.
 *
 * Kept free of the SDK so the drawer can list models without loading it.
 */

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/**
 * The Agent's instructions alone are about 15k tokens (the system prompt with
 * the user's method and two reference notes), plus the tool list and the
 * conversation. Below this, the model is likely to lose the start of it.
 */
export const MIN_AGENT_CONTEXT = 32_768;

export interface OllamaModel {
  /** The tag Ollama knows it by, e.g. "qwen3:32b". */
  readonly name: string;
  /** It can call tools — the Agent cannot work without them. */
  readonly tools: boolean;
  readonly thinking: boolean;
  /** The longest context the model takes, in tokens (null when Ollama does not say). */
  readonly context: number | null;
  /** e.g. "32.8B". */
  readonly parameterSize: string | null;
}

/** The server address with no trailing slash (the SDK and `fetch` add the paths). */
export function ollamaBase(url: string): string {
  return (url.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

/** The headers Ollama's CORS rules let a page send, and all a request to it needs. */
const PLAIN_HEADERS = ["content-type", "accept"];

/**
 * `fetch` for the SDK, sending only plain headers. The SDK's own (`x-api-key`,
 * `anthropic-version`, `anthropic-beta`, `x-stainless-*`) would fail Ollama's
 * CORS preflight, and Ollama reads none of them.
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

/**
 * The server's models, those that can call tools first (then by name). Throws
 * when the server cannot be reached or does not answer as Ollama does.
 */
export async function listOllamaModels(url: string, signal?: AbortSignal): Promise<OllamaModel[]> {
  const base = ollamaBase(url);
  const tags = (await getJson(`${base}/api/tags`, undefined, signal)) as { models?: { name: string; details?: { parameter_size?: string } }[] };
  if (!Array.isArray(tags.models)) throw new Error(`${base} did not answer as an Ollama server.`);
  const models = await Promise.all(
    tags.models.map(async (m): Promise<OllamaModel> => {
      const show = (await getJson(`${base}/api/show`, { model: m.name }, signal).catch(() => ({}))) as {
        capabilities?: string[];
        model_info?: Record<string, unknown>;
      };
      const caps = show.capabilities ?? [];
      const ctxEntry = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
      return {
        name: m.name,
        tools: caps.includes("tools"),
        thinking: caps.includes("thinking"),
        context: typeof ctxEntry?.[1] === "number" ? ctxEntry[1] : null,
        parameterSize: m.details?.parameter_size ?? null,
      };
    }),
  );
  return models.sort((a, b) => Number(b.tools) - Number(a.tools) || a.name.localeCompare(b.name));
}

async function getJson(url: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
  const init: RequestInit = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  if (signal) init.signal = signal;
  const res = await globalThis.fetch(url, init);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/**
 * Why a page cannot reach the server, as a sentence. A page on this machine's
 * own address is allowed by Ollama's defaults; any other origin (the published
 * site) must be added to OLLAMA_ORIGINS where Ollama runs.
 */
export function unreachableHint(url: string, pageOrigin: string | null): string {
  const base = ollamaBase(url);
  const local = pageOrigin !== null && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(pageOrigin);
  return local || pageOrigin === null
    ? `Could not reach Ollama at ${base}. Is it running (ollama serve, or the Ollama app)?`
    : `Could not reach Ollama at ${base}. Is it running? This page is served from ${pageOrigin}, so Ollama must also allow that origin: start it with OLLAMA_ORIGINS=${pageOrigin}.`;
}
