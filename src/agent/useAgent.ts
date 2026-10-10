/**
 * The Agent's state for the drawer: settings, the conversation, the tool
 * activity, and approvals waiting on the user. Lives in the app shell (always
 * mounted), so a call can ask for approval while the drawer is closed —
 * `onAttention` opens it.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ActivityEntry, AgentExecutor, AgentHost, ToolRunner } from "@/agent/executor";
import type { ChatConfig, ChatEffort, AgentChat } from "@/agent/chat";
import { API_KEY_KEY, SETTINGS_KEY, migrateLegacyKeys } from "@/agent/storage";
import { DEFAULT_OLLAMA_URL } from "@/agent/ollama";
import { DEFAULT_LMSTUDIO_URL } from "@/agent/lmstudio";

/** How the Agent reaches a model: Claude two ways, or a local model on Ollama or LM Studio. */
export type AgentMode = "api-key" | "proxy" | "ollama" | "lmstudio";
export const AGENT_MODES: readonly AgentMode[] = ["api-key", "proxy", "ollama", "lmstudio"];

export interface AgentSettings {
  readonly mode: AgentMode;
  readonly model: string;
  readonly effort: ChatEffort;
  /** Run changes without an approval card. Off unless the user turns it on. */
  readonly autoApprove: boolean;
  /** Keep the API key in this browser's local storage, not just for the tab. */
  readonly rememberKey: boolean;
  /** Let the API answer a declined turn with another model (off: every turn stays on `model`). */
  readonly fallback: boolean;
  /** The Ollama server, and the model on it (kept apart from `model`, the Claude choice). */
  readonly ollamaUrl: string;
  readonly ollamaModel: string;
  /** The LM Studio server, and the model on it (its key). */
  readonly lmstudioUrl: string;
  readonly lmstudioModel: string;
}

export type TranscriptItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string; readonly thinking: string }
  | { readonly kind: "tool"; readonly id: string; readonly entryId: string }
  | { readonly kind: "notice"; readonly id: string; readonly text: string; readonly tone: "info" | "error" };

export interface AgentController {
  readonly settings: AgentSettings;
  readonly updateSettings: (patch: Partial<AgentSettings>) => void;
  readonly apiKey: string;
  readonly setApiKey: (key: string) => void;
  readonly transcript: readonly TranscriptItem[];
  readonly activity: Readonly<Record<string, ActivityEntry>>;
  /** Changes waiting for the user's decision. */
  readonly pending: readonly ActivityEntry[];
  readonly decide: (entryId: string, approve: boolean) => void;
  /** A chat turn is running. */
  readonly thinking: boolean;
  readonly send: (text: string) => void;
  readonly stop: () => void;
  readonly clear: () => void;
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number };
}

const KEY_KEY = API_KEY_KEY;
const DEFAULTS: AgentSettings = {
  mode: "api-key",
  model: "claude-opus-5-5",
  effort: "high",
  autoApprove: false,
  rememberKey: false,
  fallback: false,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: "",
  lmstudioUrl: DEFAULT_LMSTUDIO_URL,
  lmstudioModel: "",
};

let nextItem = 1;
const itemId = (): string => `t${nextItem++}`;

export function useAgent(host: AgentHost, onAttention: () => void): AgentController {
  const [settings, setSettings] = useState<AgentSettings>(readSettings);
  const [apiKey, setApiKeyState] = useState<string>(readKey);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [activity, setActivity] = useState<Record<string, ActivityEntry>>({});
  const [thinking, setThinking] = useState(false);
  const [usage, setUsage] = useState({ input: 0, output: 0, cacheRead: 0 });
  const approvals = useRef(new Map<string, (ok: boolean) => void>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const attention = useRef(onAttention);
  attention.current = onAttention;

  // The executor (and the MATERIA tool handlers and zod behind it) loads on the
  // first call, so a session that never uses the Agent never downloads it.
  const executor = useMemo<ToolRunner>(() => {
    let loaded: Promise<AgentExecutor> | null = null;
    const load = (): Promise<AgentExecutor> =>
      (loaded ??= import("@/agent/executor").then(
        (m) =>
          new m.AgentExecutor(host, {
            approve: (entry) => {
              if (settingsRef.current.autoApprove) return Promise.resolve(true);
              attention.current();
              return new Promise<boolean>((resolve) => approvals.current.set(entry.id, resolve));
            },
            onActivity: (entry) => {
              setActivity((a) => ({ ...a, [entry.id]: entry }));
              // A card joins the conversation as its call starts, in the same update
              // queue as the chat text: an effect would run after the next turn has
              // already begun and put the card below that turn's reply.
              setTranscript((t) => (t.some((i) => i.kind === "tool" && i.entryId === entry.id) ? t : [...t, { kind: "tool", id: itemId(), entryId: entry.id }]));
            },
          }),
      ));
    return { run: async (name, input) => (await load()).run(name, input) };
  }, [host]);

  const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      writeSettings(next);
      if (patch.rememberKey !== undefined) moveKey(next.rememberKey);
      return next;
    });
  }, []);

  const setApiKey = useCallback((key: string) => {
    setApiKeyState(key);
    storeKey(key, settingsRef.current.rememberKey);
  }, []);

  const decide = useCallback((entryId: string, ok: boolean) => {
    const resolve = approvals.current.get(entryId);
    approvals.current.delete(entryId);
    resolve?.(ok);
  }, []);

  // ── the in-app chat ─────────────────────────────────────────────────────
  const chat = useRef<AgentChat | null>(null);
  const turn = useRef<AbortController | null>(null);

  const send = useCallback((text: string) => {
    const message = text.trim();
    if (!message || turn.current) return;
    const config = chatConfig(settingsRef.current, apiKeyRef.current);
    const ctrl = new AbortController();
    turn.current = ctrl;
    setThinking(true);
    setTranscript((t) => [...t, { kind: "user", id: itemId(), text: message }]);
    let current: string | null = null;
    const patchAssistant = (fn: (item: { text: string; thinking: string }) => { text: string; thinking: string }): void => {
      const id = current;
      if (!id) return;
      setTranscript((t) => t.map((i) => (i.id === id && i.kind === "assistant" ? { ...i, ...fn(i) } : i)));
    };
    void (async () => {
      // Loaded on first use: the SDK and the system prompt stay out of the main bundle.
      const mod = await import("@/agent/chat");
      try {
        chat.current ??= new mod.AgentChat(executor);
        await chat.current.send(
          message,
          config,
          {
            onAssistantStart: () => {
              const id = itemId();
              current = id;
              setTranscript((t) => [...t, { kind: "assistant", id, text: "", thinking: "" }]);
            },
            onText: (d) => patchAssistant((i) => ({ text: i.text + d, thinking: i.thinking })),
            onThinking: (d) => patchAssistant((i) => ({ text: i.text, thinking: i.thinking + d })),
            onNotice: (msg, tone) => setTranscript((t) => [...t, { kind: "notice", id: itemId(), text: msg, tone }]),
            onUsage: (u) =>
              setUsage((x) => ({
                input: x.input + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
                output: x.output + (u.output_tokens ?? 0),
                cacheRead: x.cacheRead + (u.cache_read_input_tokens ?? 0),
              })),
          },
          ctrl.signal,
        );
      } catch (e) {
        setTranscript((t) => [...t, { kind: "notice", id: itemId(), text: mod.describeChatError(e, config), tone: "error" }]);
      } finally {
        turn.current = null;
        setThinking(false);
        // Drop empty assistant bubbles left by tool-only turns.
        setTranscript((t) => t.filter((i) => !(i.kind === "assistant" && !i.text && !i.thinking)));
      }
    })();
  }, [executor]);

  const stop = useCallback(() => {
    turn.current?.abort();
    // A stopped turn declines what it was waiting on.
    for (const resolve of approvals.current.values()) resolve(false);
    approvals.current.clear();
  }, []);

  const clear = useCallback(() => {
    if (turn.current) return;
    chat.current = null;
    // A change still waiting for approval keeps its card, or its call would hang unseen.
    const waiting = Object.values(activity).filter((e) => e.status === "waiting");
    setTranscript(waiting.map((e) => ({ kind: "tool", id: itemId(), entryId: e.id })));
    setActivity(Object.fromEntries(waiting.map((e) => [e.id, e])));
    setUsage({ input: 0, output: 0, cacheRead: 0 });
  }, [activity]);

  const pending = Object.values(activity).filter((e) => e.status === "waiting");

  return { settings, updateSettings, apiKey, setApiKey, transcript, activity, pending, decide, thinking, send, stop, clear, usage };
}

/** What one chat message runs on, from the settings. */
function chatConfig(s: AgentSettings, apiKey: string): ChatConfig {
  if (s.mode === "ollama") return { transport: "ollama", serverUrl: s.ollamaUrl, model: s.ollamaModel, effort: s.effort };
  if (s.mode === "lmstudio") return { transport: "lmstudio", serverUrl: s.lmstudioUrl, model: s.lmstudioModel, effort: s.effort };
  return { transport: s.mode === "proxy" ? "proxy" : "api-key", apiKey, model: s.model, effort: s.effort, fallback: s.fallback };
}

// ── storage (guarded: private windows and blocked site data throw) ─────────

function readSettings(): AgentSettings {
  try {
    migrateLegacyKeys(localStorage, sessionStorage);
    return settingsFrom(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULTS;
  }
}

/**
 * The stored settings over the defaults. Only known keys come back, and a mode
 * this version no longer has (the Claude Code bridge, removed) falls back to
 * the default.
 */
export function settingsFrom(raw: string | null): AgentSettings {
  if (!raw) return DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULTS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
  const stored = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof AgentSettings)[]) {
    if (typeof stored[k] === typeof DEFAULTS[k]) out[k] = stored[k];
  }
  if (!AGENT_MODES.includes(out.mode as AgentMode)) out.mode = DEFAULTS.mode;
  // Auto-approve is a per-session choice: it never comes back on by itself.
  out.autoApprove = false;
  return out as unknown as AgentSettings;
}

function writeSettings(s: AgentSettings): void {
  try {
    const { autoApprove: _auto, ...kept } = s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(kept));
  } catch {
    // Not remembered; the session still uses it.
  }
}

function readKey(): string {
  try {
    migrateLegacyKeys(localStorage, sessionStorage);
    return sessionStorage.getItem(KEY_KEY) ?? localStorage.getItem(KEY_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeKey(key: string, remember: boolean): void {
  try {
    sessionStorage.removeItem(KEY_KEY);
    localStorage.removeItem(KEY_KEY);
    if (!key) return;
    (remember ? localStorage : sessionStorage).setItem(KEY_KEY, key);
  } catch {
    // Kept in memory for this page only.
  }
}

function moveKey(remember: boolean): void {
  const key = readKey();
  if (key) storeKey(key, remember);
}
