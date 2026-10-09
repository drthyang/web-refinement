/**
 * The Copilot's state for the drawer: settings, the conversation, the tool
 * activity, approvals waiting on the user, and the Claude Code bridge. Lives in
 * the app shell (always mounted), so the bridge stays connected and a call can
 * ask for approval while the drawer is closed — `onAttention` opens it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEntry, CopilotExecutor, CopilotHost, ToolRunner } from "@/copilot/executor";
import { BridgeClient, DEFAULT_BRIDGE_URL, type BridgeStatus } from "@/copilot/bridgeClient";
import type { ChatEffort, CopilotChat } from "@/copilot/chat";

/** How the Copilot reaches Claude. */
export type CopilotMode = "claude-code" | "api-key" | "proxy";

export interface CopilotSettings {
  readonly mode: CopilotMode;
  readonly model: string;
  readonly effort: ChatEffort;
  /** Run changes without an approval card. Off unless the user turns it on. */
  readonly autoApprove: boolean;
  /** Keep the API key in this browser's local storage, not just for the tab. */
  readonly rememberKey: boolean;
  readonly bridgeUrl: string;
}

export type TranscriptItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string; readonly thinking: string }
  | { readonly kind: "tool"; readonly id: string; readonly entryId: string }
  | { readonly kind: "notice"; readonly id: string; readonly text: string; readonly tone: "info" | "error" };

export interface CopilotController {
  readonly settings: CopilotSettings;
  readonly updateSettings: (patch: Partial<CopilotSettings>) => void;
  readonly apiKey: string;
  readonly setApiKey: (key: string) => void;
  readonly transcript: readonly TranscriptItem[];
  readonly activity: Readonly<Record<string, ActivityEntry>>;
  /** Changes waiting for the user's decision. */
  readonly pending: readonly ActivityEntry[];
  readonly decide: (entryId: string, approve: boolean) => void;
  readonly bridge: BridgeStatus;
  /** A chat turn is running. */
  readonly thinking: boolean;
  readonly send: (text: string) => void;
  readonly stop: () => void;
  readonly clear: () => void;
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number };
}

const SETTINGS_KEY = "materia.copilot.settings";
const KEY_KEY = "materia.copilot.apiKey";
const DEFAULTS: CopilotSettings = {
  mode: "claude-code",
  model: "claude-opus-5-5",
  effort: "high",
  autoApprove: false,
  rememberKey: false,
  bridgeUrl: DEFAULT_BRIDGE_URL,
};

let nextItem = 1;
const itemId = (): string => `t${nextItem++}`;

/**
 * `enabled`: the user has opened the Copilot in this page. Until then nothing
 * connects anywhere — the bridge does not poll a server nobody asked for.
 */
export function useCopilot(host: CopilotHost, enabled: boolean, onAttention: () => void): CopilotController {
  const [settings, setSettings] = useState<CopilotSettings>(readSettings);
  const [apiKey, setApiKeyState] = useState<string>(readKey);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [activity, setActivity] = useState<Record<string, ActivityEntry>>({});
  const [bridge, setBridge] = useState<BridgeStatus>({ state: "off" });
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
  // first call, so a session that never uses the Copilot never downloads it.
  const executor = useMemo<ToolRunner>(() => {
    let loaded: Promise<CopilotExecutor> | null = null;
    const load = (): Promise<CopilotExecutor> =>
      (loaded ??= import("@/copilot/executor").then(
        (m) =>
          new m.CopilotExecutor(host, {
            approve: (entry) => {
              if (settingsRef.current.autoApprove) return Promise.resolve(true);
              attention.current();
              return new Promise<boolean>((resolve) => approvals.current.set(entry.id, resolve));
            },
            onActivity: (entry) => {
              setActivity((a) => ({ ...a, [entry.id]: entry }));
              // A call from Claude Code has no chat turn to sit in: list it as it arrives.
              if (entry.source === "claude-code") {
                setTranscript((t) => (t.some((i) => i.kind === "tool" && i.entryId === entry.id) ? t : [...t, { kind: "tool", id: itemId(), entryId: entry.id }]));
              }
            },
          }),
      ));
    return { run: async (name, input, source) => (await load()).run(name, input, source) };
  }, [host]);

  // The Claude Code bridge runs while that mode is chosen (once the Copilot is in use).
  useEffect(() => {
    if (!enabled || settings.mode !== "claude-code") return;
    const client = new BridgeClient(settings.bridgeUrl, executor, setBridge);
    client.start();
    return () => client.stop();
  }, [enabled, settings.mode, settings.bridgeUrl, executor]);

  const updateSettings = useCallback((patch: Partial<CopilotSettings>) => {
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
  const chat = useRef<CopilotChat | null>(null);
  const turn = useRef<AbortController | null>(null);

  const send = useCallback((text: string) => {
    const message = text.trim();
    if (!message || turn.current) return;
    const s = settingsRef.current;
    if (s.mode === "claude-code") return;
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
      const mod = await import("@/copilot/chat");
      try {
        chat.current ??= new mod.CopilotChat(executor);
        await chat.current.send(
          message,
          { transport: s.mode === "proxy" ? "proxy" : "api-key", apiKey: apiKeyRef.current, model: s.model, effort: s.effort },
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
        setTranscript((t) => [...t, { kind: "notice", id: itemId(), text: mod.describeChatError(e, s.mode === "proxy" ? "proxy" : "api-key"), tone: "error" }]);
      } finally {
        turn.current = null;
        setThinking(false);
        // Drop empty assistant bubbles left by tool-only turns.
        setTranscript((t) => t.filter((i) => !(i.kind === "assistant" && !i.text && !i.thinking)));
      }
    })();
  }, [executor]);

  // Tool cards join the chat as their calls start.
  useEffect(() => {
    const chatEntries = Object.values(activity).filter((e) => e.source === "chat");
    setTranscript((t) => {
      const shown = new Set(t.filter((i) => i.kind === "tool").map((i) => (i as { entryId: string }).entryId));
      const fresh = chatEntries.filter((e) => !shown.has(e.id));
      return fresh.length ? [...t, ...fresh.map((e) => ({ kind: "tool" as const, id: itemId(), entryId: e.id }))] : t;
    });
  }, [activity]);

  const stop = useCallback(() => {
    turn.current?.abort();
    // A stopped turn declines what it was waiting on.
    for (const [id, resolve] of approvals.current) {
      if (activity[id]?.source === "chat") {
        approvals.current.delete(id);
        resolve(false);
      }
    }
  }, [activity]);

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

  return { settings, updateSettings, apiKey, setApiKey, transcript, activity, pending, decide, bridge, thinking, send, stop, clear, usage };
}

// ── storage (guarded: private windows and blocked site data throw) ─────────

function readSettings(): CopilotSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<CopilotSettings>;
    return {
      ...DEFAULTS,
      ...parsed,
      // Auto-approve is a per-session choice: it never comes back on by itself.
      autoApprove: false,
    };
  } catch {
    return DEFAULTS;
  }
}

function writeSettings(s: CopilotSettings): void {
  try {
    const { autoApprove: _auto, ...kept } = s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(kept));
  } catch {
    // Not remembered; the session still uses it.
  }
}

function readKey(): string {
  try {
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
