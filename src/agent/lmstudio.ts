/**
 * The Agent on a local model in LM Studio, reached straight from this browser.
 * LM Studio 0.4.1 and later answer the Anthropic Messages API at
 * `<server>/v1/messages`, so the chat loop (chat.ts) drives it as it drives
 * Ollama: the same SDK, tools and executor, with only plain headers
 * (`plainFetch`, localServer.ts). Nothing leaves this machine.
 *
 * What differs from Ollama:
 *  - LM Studio admits no other origin until "Enable CORS" is on in its server
 *    settings (or `lms server start --cors`). Its server listens on its own
 *    port, so even the dev server's pages are another origin.
 *  - The models come from LM Studio's REST API, `/api/v1/models`: their key,
 *    whether each was trained for tool use, the longest context it takes, and
 *    the context each loaded copy was given. LM Studio can run tools on a model
 *    not trained for them (through its own prompt), so none is ruled out.
 *  - A model loads with the context length set for it in LM Studio, which can
 *    be far below what the Agent needs; the loaded context is what counts.
 *
 * Kept free of the SDK so the drawer can list models without loading it.
 */

import { HttpError, getJson, serverBase } from "@/agent/localServer";

export const DEFAULT_LMSTUDIO_URL = "http://localhost:1234";

export interface LmStudioModel {
  /** The key LM Studio knows it by, e.g. "qwen/qwen3-32b": the request's `model`. */
  readonly key: string;
  /** Trained for tool calling (LM Studio's `trained_for_tool_use`). */
  readonly toolUse: boolean;
  /** The longest context the model takes, in tokens (null when LM Studio does not say). */
  readonly maxContext: number | null;
  /** The context the loaded copy was given, in tokens; null when it is not loaded. */
  readonly loadedContext: number | null;
  /** e.g. "32B". */
  readonly parameterSize: string | null;
}

export function lmstudioBase(url: string): string {
  return serverBase(url, DEFAULT_LMSTUDIO_URL);
}

interface RestModel {
  type?: string;
  key?: string;
  params_string?: string | null;
  max_context_length?: number;
  loaded_instances?: { config?: { context_length?: number } }[];
  capabilities?: { trained_for_tool_use?: boolean };
}

/**
 * The server's language models (embedding models left out), those trained for
 * tool use first (then by key). Throws when the server cannot be reached or
 * does not answer as LM Studio does.
 */
export async function listLmStudioModels(url: string, signal?: AbortSignal): Promise<LmStudioModel[]> {
  const base = lmstudioBase(url);
  let body: { models?: RestModel[] };
  try {
    body = (await getJson(`${base}/api/v1/models`, undefined, signal)) as { models?: RestModel[] };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new Error(`${base} has no /api/v1/models. The Agent needs LM Studio 0.4.1 or later.`, { cause: e });
    throw e;
  }
  if (!Array.isArray(body.models)) throw new Error(`${base} did not answer as an LM Studio server.`);
  return body.models
    .filter((m): m is RestModel & { key: string } => m.type === "llm" && typeof m.key === "string")
    .map((m) => {
      const loaded = m.loaded_instances?.map((i) => i.config?.context_length).filter((c): c is number => typeof c === "number") ?? [];
      return {
        key: m.key,
        toolUse: m.capabilities?.trained_for_tool_use === true,
        maxContext: typeof m.max_context_length === "number" ? m.max_context_length : null,
        // Several loaded copies: the request may reach any, so count the smallest.
        loadedContext: loaded.length ? Math.min(...loaded) : null,
        parameterSize: m.params_string ?? null,
      };
    })
    .sort((a, b) => Number(b.toolUse) - Number(a.toolUse) || a.key.localeCompare(b.key));
}

/** Why a page cannot reach the server, as a sentence. LM Studio admits another origin only with CORS on. */
export function lmstudioUnreachableHint(url: string): string {
  return `Could not reach LM Studio at ${lmstudioBase(url)}. Is its server running, with CORS on? In LM Studio's Developer tab, start the server and turn on Enable CORS in its settings (or run lms server start --cors).`;
}
