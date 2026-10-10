/**
 * The Agent drawer: the conversation with the model, every tool call as a
 * card, and an approval card for each change waiting on the user. It sits beside the page, not over
 * it, so the plot and the parameter panel stay in view while Claude works.
 */

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { color, fz, mono, radius } from "@/app/theme";
import type { ActivityEntry } from "@/agent/executor";
import { AGENT_MODES, type AgentController, type AgentMode, type AgentSettings, type TranscriptItem } from "@/agent/useAgent";
import { CHAT_MODELS, hasRefusalFallback } from "@/agent/chat-models";
import { listOllamaModels, unreachableHint, type OllamaModel } from "@/agent/ollama";
import { listLmStudioModels, lmstudioUnreachableHint, type LmStudioModel } from "@/agent/lmstudio";
import { MIN_AGENT_CONTEXT } from "@/agent/localServer";
import { MATH_SPAN_SOURCE, mathInside, texPieces } from "@/agent/ui/texText";
import { DRAWER_MAX, DRAWER_MIN, KEY_STEP, clampDrawerWidth, readDrawerWidth, writeDrawerWidth } from "@/agent/ui/drawerWidth";
import { cssZoom } from "@/app/ui/cssZoom";

interface Props {
  readonly agent: AgentController;
  readonly onClose: () => void;
}

const MODE_LABEL: Record<AgentMode, string> = { "api-key": "API key", proxy: "Local proxy", ollama: "Ollama", lmstudio: "LM Studio" };

/** The model a local mode will use ("" with none picked); null for the Claude modes. */
function localModel(s: AgentSettings): string | null {
  return s.mode === "ollama" ? s.ollamaModel : s.mode === "lmstudio" ? s.lmstudioModel : null;
}

export function AgentDrawer({ agent, onClose }: Props): JSX.Element {
  const { settings } = agent;
  const [showSettings, setShowSettings] = useState(false);
  const needsSetup = (settings.mode === "api-key" && !agent.apiKey) || localModel(settings) === "";
  // First open with nothing set up: show the settings.
  useEffect(() => {
    if (needsSetup) setShowSettings(true);
  }, [needsSetup]);

  const [width, setWidth] = useDrawerWidth();
  const aside = useRef<HTMLElement>(null);
  return (
    <aside ref={aside} className="wb-agent" style={width === null ? drawer : { ...drawer, ["--wb-agent-w" as string]: `${width}px` }} aria-label="Agent">
      <ResizeHandle drawer={aside} width={width} onResize={setWidth} />
      <div style={head}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <SparkIcon />
          <b style={{ fontSize: 15, color: color.ink }}>Agent</b>
          <StatusChip agent={agent} />
        </span>
        <span style={{ display: "flex", gap: 4 }}>
          <IconButton title="Settings" active={showSettings} onClick={() => setShowSettings((v) => !v)}>⚙</IconButton>
          <IconButton title="Clear the conversation" onClick={agent.clear} disabled={agent.thinking}>⌫</IconButton>
          <IconButton title="Close the Agent" onClick={onClose}>✕</IconButton>
        </span>
      </div>
      {showSettings && <Settings agent={agent} />}
      <Transcript agent={agent} />
      <Composer agent={agent} disabled={needsSetup} />
    </aside>
  );
}

// ── width ───────────────────────────────────────────────────────────────────

/** The width the user dragged the drawer to (null: the default), remembered by the browser. */
function useDrawerWidth(): [number | null, (w: number | null, commit?: boolean) => void] {
  const [width, setWidth] = useState<number | null>(() => (typeof localStorage === "undefined" ? null : readDrawerWidth(localStorage)));
  const update = (w: number | null, commit = true): void => {
    setWidth(w);
    if (commit && typeof localStorage !== "undefined") writeDrawerWidth(localStorage, w);
  };
  return [width, update];
}

/**
 * The drawer's left edge: drag to resize, ← / → by a step, Enter or a double
 * click for the default width. Hidden where the drawer covers the page or docks
 * under it (workbench.css).
 */
function ResizeHandle({ drawer, width, onResize }: { drawer: RefObject<HTMLElement>; width: number | null; onResize: (w: number | null, commit?: boolean) => void }): JSX.Element {
  const drag = useRef<{ x: number; w: number; last: number } | null>(null);
  // Widths are CSS px: under the large-screen UI zoom, screen px divide by it.
  const viewport = (): number => window.innerWidth / cssZoom();
  const current = (): number => (drawer.current ? drawer.current.getBoundingClientRect().width / cssZoom() : width ?? DRAWER_MIN);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const w = current();
    drag.current = { x: e.clientX, w, last: w };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    d.last = clampDrawerWidth(d.w + (d.x - e.clientX) / cssZoom(), viewport());
    onResize(d.last, false);
  };
  const onPointerUp = (): void => {
    const d = drag.current;
    drag.current = null;
    if (d && d.last !== d.w) onResize(d.last);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
    if (step !== 0) {
      e.preventDefault();
      onResize(clampDrawerWidth(current() + step, viewport()));
    } else if (e.key === "Enter") {
      e.preventDefault();
      onResize(null);
    }
  };
  return (
    <div
      className="wb-agent-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Agent panel"
      aria-valuemin={DRAWER_MIN}
      aria-valuemax={DRAWER_MAX}
      aria-valuenow={Math.round(width ?? current())}
      title="Drag to resize · double-click for the default width"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onResize(null)}
      onKeyDown={onKeyDown}
    />
  );
}

// ── status ──────────────────────────────────────────────────────────────────

function StatusChip({ agent }: { agent: AgentController }): JSX.Element {
  const { settings } = agent;
  const local = localModel(settings);
  let text = MODE_LABEL[settings.mode];
  let ok = true;
  if (settings.mode === "api-key" && !agent.apiKey) {
    text = "API key · not set";
    ok = false;
  } else if (local !== null) {
    text = `${MODE_LABEL[settings.mode]} · ${local || "no model"}`;
    ok = local !== "";
  }
  const palette = ok ? { bg: color.okBg, bd: color.okBorder, ink: color.okInk } : { bg: color.chipBg, bd: color.border, ink: color.secondary };
  return (
    <span role="status" style={{ fontSize: fz.micro, padding: "2px 8px", borderRadius: 999, background: palette.bg, border: `1px solid ${palette.bd}`, color: palette.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {text}
    </span>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

function Settings({ agent }: { agent: AgentController }): JSX.Element {
  const { settings, updateSettings } = agent;
  return (
    <div style={settingsBox}>
      <div style={{ display: "flex", gap: 0, border: `1px solid ${color.control}`, borderRadius: radius.button, overflow: "hidden" }} role="radiogroup" aria-label="How the Agent reaches a model">
        {AGENT_MODES.map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={settings.mode === m}
            onClick={() => updateSettings({ mode: m })}
            style={{ flex: 1, border: "none", padding: "6px 4px", fontSize: 12.5, cursor: "pointer", background: settings.mode === m ? color.primaryTintBg : color.surface, color: settings.mode === m ? color.primary : color.ink, fontWeight: settings.mode === m ? 600 : 500 }}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {settings.mode === "api-key" && (
        <>
          <label style={field}>
            <span style={fieldLabel}>Anthropic API key</span>
            <input style={input} type="password" autoComplete="off" placeholder="sk-ant-…" value={agent.apiKey} onChange={(e) => agent.setApiKey(e.target.value.trim())} spellCheck={false} />
          </label>
          <label style={{ ...field, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={settings.rememberKey} onChange={(e) => updateSettings({ rememberKey: e.target.checked })} />
            <span style={{ fontSize: 12.5 }}>Remember on this device</span>
          </label>
          <p style={note}>Sent only from this browser to api.anthropic.com, and billed to the key. Kept for this tab unless you tick Remember; never saved in a project or report.</p>
        </>
      )}
      {settings.mode === "proxy" && (
        <p style={note}>
          The dev server forwards to the API with <code style={code}>ANTHROPIC_API_KEY</code> from where you ran <code style={code}>npm run dev</code> (or <code style={code}>.env.local</code>), so the key never reaches this page. Local only: the published site has no proxy.
        </p>
      )}
      {settings.mode === "ollama" && <OllamaSettings agent={agent} />}
      {settings.mode === "lmstudio" && <LmStudioSettings agent={agent} />}
      {(settings.mode === "api-key" || settings.mode === "proxy") && (
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ ...field, flex: 1 }}>
            <span style={fieldLabel}>Model</span>
            <select style={input} value={settings.model} onChange={(e) => updateSettings({ model: e.target.value })}>
              {CHAT_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label style={{ ...field, width: 110 }}>
            <span style={fieldLabel}>Effort</span>
            <select style={input} value={settings.effort} onChange={(e) => updateSettings({ effort: e.target.value as typeof settings.effort })}>
              {(["low", "medium", "high", "xhigh", "max"] as const).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        </div>
      )}
      {(settings.mode === "api-key" || settings.mode === "proxy") && hasRefusalFallback(settings.model) && (
        <label style={{ ...field, flexDirection: "row", alignItems: "center", gap: 6 }} title="Off: every turn stays on the chosen model, so a session can be reproduced. On: if the model declines a turn, the API answers it with another model, and the conversation says which.">
          <input type="checkbox" checked={settings.fallback} onChange={(e) => updateSettings({ fallback: e.target.checked })} />
          <span style={{ fontSize: 12.5 }}>Fall back to another model if this one declines</span>
        </label>
      )}
    </div>
  );
}

type ModelList<T> = { readonly status: "loading" } | { readonly status: "ok"; readonly models: readonly T[] } | { readonly status: "error"; readonly message: string };

/**
 * A local server's models, asked of the server itself whenever its address
 * changes (once typing pauses) or the user asks again. `onListed` gets each
 * fresh list, to keep or replace the chosen model.
 */
function useModelList<T>(url: string, list: (url: string, signal: AbortSignal) => Promise<T[]>, hint: (url: string) => string, onListed: (models: T[]) => void): { list: ModelList<T>; refresh: () => void } {
  const [state, setState] = useState<ModelList<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  const fresh = useRef({ list, hint, onListed });
  fresh.current = { list, hint, onListed };
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      fresh.current.list(url, ctrl.signal).then(
        (models) => {
          if (ctrl.signal.aborted) return;
          setState({ status: "ok", models });
          fresh.current.onListed(models);
        },
        (e: unknown) => {
          if (ctrl.signal.aborted) return;
          // A server that answered, but not as expected, says why; one that did not answer gets the setup hint.
          const answered = e instanceof Error && /did not answer as|needs LM Studio/.test(e.message);
          setState({ status: "error", message: answered ? (e as Error).message : fresh.current.hint(url) });
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [url, round]);
  return { list: state, refresh: () => setRound((n) => n + 1) };
}

const kTokens = (n: number): string => `${Math.round(n / 1024)}k`;

/** The Ollama server and a model on it, listed from the server itself. */
function OllamaSettings({ agent }: { agent: AgentController }): JSX.Element {
  const { settings, updateSettings } = agent;
  const { list, refresh } = useModelList<OllamaModel>(
    settings.ollamaUrl,
    listOllamaModels,
    (url) => unreachableHint(url, window.location.origin),
    // Nothing chosen yet, or the choice is gone: take the first that can call tools.
    (models) => {
      if (!models.some((m) => m.tools && m.name === settings.ollamaModel)) updateSettings({ ollamaModel: models.find((m) => m.tools)?.name ?? "" });
    },
  );
  const models = list.status === "ok" ? list.models : [];
  const picked = models.find((m) => m.name === settings.ollamaModel);
  return (
    <>
      <label style={field}>
        <span style={fieldLabel}>Ollama server</span>
        <input style={input} value={settings.ollamaUrl} onChange={(e) => updateSettings({ ollamaUrl: e.target.value })} spellCheck={false} placeholder="http://localhost:11434" />
      </label>
      <ModelPicker label="Ollama model" list={list} value={picked ? settings.ollamaModel : ""} onChange={(v) => updateSettings({ ollamaModel: v })} onRefresh={refresh}>
        {models.map((m) => (
          <option key={m.name} value={m.name} disabled={!m.tools}>
            {[m.name, m.parameterSize, m.context ? `${kTokens(m.context)} context` : null, m.tools ? null : "no tools"].filter(Boolean).join(" · ")}
          </option>
        ))}
      </ModelPicker>
      {list.status === "error" && <p style={{ ...note, color: color.warnInk }}>{list.message}</p>}
      {list.status === "ok" && models.length > 0 && !models.some((m) => m.tools) && (
        <p style={{ ...note, color: color.warnInk }}>None of these models can call tools, and the Agent works only through them. Pull one that can (e.g. <code style={code}>ollama pull qwen3</code>).</p>
      )}
      {list.status === "ok" && models.length === 0 && <p style={{ ...note, color: color.warnInk }}>The server has no models. Pull one that can call tools (e.g. <code style={code}>ollama pull qwen3</code>).</p>}
      {picked?.context != null && picked.context < MIN_AGENT_CONTEXT && (
        <p style={{ ...note, color: color.noteInk }}>This model takes {kTokens(picked.context)} tokens of context; the Agent's instructions alone are about 15k. Expect it to lose track in a long session.</p>
      )}
      <p style={note}>
        The conversation goes only to this server. Local models follow the method less reliably than Claude: watch the approval cards. A page not served from this machine (the published site) also needs <code style={code}>OLLAMA_ORIGINS</code> set to its address where Ollama runs.
      </p>
    </>
  );
}

/** The LM Studio server and a model on it, listed from the server itself. */
function LmStudioSettings({ agent }: { agent: AgentController }): JSX.Element {
  const { settings, updateSettings } = agent;
  const { list, refresh } = useModelList<LmStudioModel>(
    settings.lmstudioUrl,
    listLmStudioModels,
    lmstudioUnreachableHint,
    // Nothing chosen yet, or the choice is gone: take the first trained for tools
    // and not loaded with too short a context (else the first trained, else the first).
    (models) => {
      if (models.some((m) => m.key === settings.lmstudioModel)) return;
      const roomy = (m: LmStudioModel): boolean => m.loadedContext == null || m.loadedContext >= MIN_AGENT_CONTEXT;
      updateSettings({ lmstudioModel: (models.find((m) => m.toolUse && roomy(m)) ?? models.find((m) => m.toolUse) ?? models[0])?.key ?? "" });
    },
  );
  const models = list.status === "ok" ? list.models : [];
  const picked = models.find((m) => m.key === settings.lmstudioModel);
  return (
    <>
      <label style={field}>
        <span style={fieldLabel}>LM Studio server</span>
        <input style={input} value={settings.lmstudioUrl} onChange={(e) => updateSettings({ lmstudioUrl: e.target.value })} spellCheck={false} placeholder="http://localhost:1234" />
      </label>
      <ModelPicker label="LM Studio model" list={list} value={picked ? settings.lmstudioModel : ""} onChange={(v) => updateSettings({ lmstudioModel: v })} onRefresh={refresh}>
        {models.map((m) => (
          <option key={m.key} value={m.key}>
            {[m.key, m.parameterSize, m.loadedContext != null ? `loaded, ${kTokens(m.loadedContext)} context` : "not loaded", m.toolUse ? null : "not trained for tools"].filter(Boolean).join(" · ")}
          </option>
        ))}
      </ModelPicker>
      {list.status === "error" && <p style={{ ...note, color: color.warnInk }}>{list.message}</p>}
      {list.status === "ok" && models.length === 0 && <p style={{ ...note, color: color.warnInk }}>LM Studio has no language models. Download one trained for tool use (e.g. Qwen3) in its Discover tab.</p>}
      {picked && !picked.toolUse && (
        <p style={{ ...note, color: color.noteInk }}>This model was not trained for tool use. LM Studio still offers it the tools, but it may call them poorly; one marked for tool use works better.</p>
      )}
      {picked?.loadedContext != null && picked.loadedContext < MIN_AGENT_CONTEXT && (
        <p style={{ ...note, color: color.noteInk }}>
          LM Studio loaded this model with {kTokens(picked.loadedContext)} tokens of context; the Agent's instructions alone are about 15k, so it will not send to it. Eject the model in LM Studio and the Agent loads it with 32k on your next message (or <code style={code}>lms load {picked.key} --context-length 32768</code>{picked.maxContext != null && picked.maxContext < MIN_AGENT_CONTEXT ? `; it takes at most ${kTokens(picked.maxContext)}` : ""}).
        </p>
      )}
      {picked && picked.loadedContext == null && (
        <p style={note}>Not loaded yet: the Agent loads it with a 32k context on your first message.</p>
      )}
      <p style={note}>
        The conversation goes only to this server. Needs LM Studio 0.4.1 or later with its server running and <b>Enable CORS</b> on (Developer tab → server settings, or <code style={code}>lms server start --cors</code>). Local models follow the method less reliably than Claude: watch the approval cards.
      </p>
    </>
  );
}

/** A local server's model list, with a button to ask again. */
function ModelPicker<T>({ label, list, value, onChange, onRefresh, children }: { label: string; list: ModelList<T>; value: string; onChange: (v: string) => void; onRefresh: () => void; children: ReactNode }): JSX.Element {
  const empty = list.status !== "ok" || list.models.length === 0;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
      <label style={{ ...field, flex: 1, minWidth: 0 }}>
        <span style={fieldLabel}>Model</span>
        <select style={input} value={value} disabled={empty} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          {empty && <option value="">{list.status === "loading" ? "Asking the server…" : "No models"}</option>}
          {children}
        </select>
      </label>
      <IconButton title="List the server's models again" onClick={onRefresh}>↻</IconButton>
    </div>
  );
}

// ── transcript ──────────────────────────────────────────────────────────────

function Transcript({ agent }: { agent: AgentController }): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  const items = agent.transcript;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items, agent.activity]);
  return (
    <div style={transcriptBox} aria-live="polite">
      {items.length === 0 && <EmptyState mode={agent.settings.mode} />}
      {items.map((item) => <Item key={item.id} item={item} agent={agent} />)}
      {agent.thinking && <div style={{ fontSize: 12.5, color: color.faint, padding: "0 2px" }}>Working…</div>}
      <div ref={end} />
    </div>
  );
}

function EmptyState({ mode }: { mode: AgentMode }): JSX.Element {
  return (
    <div style={{ color: color.secondary, fontSize: fz.small, lineHeight: 1.5, padding: "6px 2px" }}>
      <p style={{ margin: "0 0 8px" }}>Ask about the fit on screen, or ask {mode === "ollama" || mode === "lmstudio" ? "the model" : "Claude"} to take the next step. It reads the analysis, judges it with MATERIA's tools, and asks before it changes anything.</p>
      <p style={{ margin: 0 }}>For example: <i>“Assess the fit and suggest what to free next.”</i></p>
    </div>
  );
}

function Item({ item, agent }: { item: TranscriptItem; agent: AgentController }): JSX.Element | null {
  switch (item.kind) {
    case "user":
      return <div style={userBubble}>{item.text}</div>;
    case "assistant":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {item.thinking && (
            <details style={{ fontSize: fz.micro, color: color.faint }}>
              <summary style={{ cursor: "pointer" }}>Reasoning</summary>
              <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{item.thinking}</div>
            </details>
          )}
          {item.text && (
            <div style={assistantText} onMouseEnter={() => agent.hoverReply(item.text)} onMouseLeave={() => agent.hoverReply(null)}>
              <Markdown text={item.text} />
            </div>
          )}
        </div>
      );
    case "tool": {
      const entry = agent.activity[item.entryId];
      return entry ? <ToolCard entry={entry} onDecide={agent.decide} /> : null;
    }
    case "notice":
      return <div style={noticeStyle(item.tone)}>{item.text}</div>;
  }
}

function ToolCard({ entry, onDecide }: { entry: ActivityEntry; onDecide: (id: string, ok: boolean) => void }): JSX.Element {
  const waiting = entry.status === "waiting";
  const tone = entry.status === "failed" ? color.warnInk : entry.status === "declined" ? color.faint : entry.status === "done" ? color.okInk : color.primary;
  const statusText = { waiting: "Needs approval", running: "Running…", done: "Done", declined: "Declined", failed: "Failed" }[entry.status];
  return (
    <div style={{ ...toolCard, ...(waiting ? { border: `1px solid ${color.primaryTintBorder}`, background: color.primaryTintBg } : {}) }} data-tool={entry.tool} data-status={entry.status}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, fontSize: 12.5, color: color.ink }}>
          {entry.effect === "read" ? "◦ " : "● "}{entry.title}
        </span>
        <span style={{ fontSize: fz.micro, color: tone, whiteSpace: "nowrap" }}>
          {statusText}
        </span>
      </div>
      {entry.preview && <div style={{ fontSize: 12.5, color: color.ink, marginTop: 3 }}>{entry.preview}</div>}
      {entry.outcome && entry.status !== "waiting" && <div style={{ fontSize: 12, color: entry.status === "failed" ? color.warnInk : color.secondary, marginTop: 3, fontFamily: entry.tool === "refine" ? mono : undefined }}>{entry.outcome}</div>}
      {waiting && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button style={primaryButton} onClick={() => onDecide(entry.id, true)}>Approve</button>
          <button style={secondaryButton} onClick={() => onDecide(entry.id, false)}>Decline</button>
        </div>
      )}
    </div>
  );
}

// ── input ───────────────────────────────────────────────────────────────────

function Composer({ agent, disabled }: { agent: AgentController; disabled: boolean }): JSX.Element {
  const [text, setText] = useState("");
  const submit = (): void => {
    if (!text.trim() || agent.thinking || disabled) return;
    agent.send(text);
    setText("");
  };
  return (
    <div style={composer}>
      <textarea
        aria-label="Message the Agent"
        style={{ ...input, resize: "none", minHeight: 58, fontFamily: "inherit", lineHeight: 1.4 }}
        placeholder={disabled ? (localModel(agent.settings) !== null ? "Pick a model in the settings first" : "Add your API key in the settings first") : "Ask about the fit, or ask for the next step…"}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <AutonomySwitch agent={agent} />
        <span className="wb-agent-hint" style={{ fontSize: fz.micro, color: color.faint, fontFamily: mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {agent.usage.input + agent.usage.output > 0
            ? `${fmtTokens(agent.usage.input)} in · ${fmtTokens(agent.usage.cacheRead)} cached · ${fmtTokens(agent.usage.output)} out`
            : "Enter to send · Shift+Enter for a new line"}
        </span>
        {agent.thinking
          ? <button style={secondaryButton} onClick={agent.stop}>Stop</button>
          : <button style={primaryButton} onClick={submit} disabled={disabled || !text.trim()}>Send</button>}
      </div>
    </div>
  );
}

/**
 * Ask first: every change waits for approval, and the agent stops at each
 * gate. Auto: changes run without a card (still undoable History steps), and
 * the agent works through the stages, stopping at a failed gate or a decision
 * the method leaves to the user. Off again on reload.
 */
function AutonomySwitch({ agent }: { agent: AgentController }): JSX.Element {
  const auto = agent.settings.autoApprove;
  const option = (on: boolean, label: string, title: string): JSX.Element => (
    <button
      type="button"
      role="radio"
      aria-checked={auto === on}
      title={title}
      onClick={() => agent.updateSettings({ autoApprove: on })}
      style={{ border: "none", padding: "3px 9px", fontSize: 12, cursor: "pointer", background: auto === on ? (on ? color.noteBg : color.primaryTintBg) : color.surface, color: auto === on ? (on ? color.noteInk : color.primary) : color.secondary, fontWeight: auto === on ? 600 : 500 }}
    >
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="Approval mode" style={{ display: "flex", border: `1px solid ${color.control}`, borderRadius: radius.button, overflow: "hidden", flexShrink: 0 }}>
      {option(false, "Ask first", "Every change waits for your approval, and the agent stops at each gate of the method to report.")}
      {option(true, "Auto", "Changes run without an approval card (each is still a History step you can undo), and the agent works through the method's stages on its own, stopping at a failed gate or a decision that is yours. Back to Ask first on reload.")}
    </div>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────

/** A safe, minimal Markdown subset: paragraphs, bullet/numbered lists, **bold**, `code`, and inline $math$ read as text. */
function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]!);
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>);
          return ordered ? <ol key={i} style={list}>{items}</ol> : <ul key={i} style={list}>{items}</ul>;
        }
        if (/^#{1,4}\s/.test(block)) return <p key={i} style={{ margin: "0 0 6px", fontWeight: 600 }}>{inline(block.replace(/^#{1,4}\s/, ""))}</p>;
        return <p key={i} style={{ margin: "0 0 6px", whiteSpace: "pre-wrap" }}>{inline(block)}</p>;
      })}
    </>
  );
}

const INLINE_SOURCE = String.raw`(\*\*[^*]+\*\*|\`[^\`]+\`|${MATH_SPAN_SOURCE})`;

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_SOURCE, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<b key={k++}>{inline(t.slice(2, -2))}</b>);
    else if (t.startsWith("`")) out.push(<code key={k++} style={code}>{t.slice(1, -1)}</code>);
    else out.push(<TexText key={k++} tex={mathInside(t)} />);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** Inline TeX as plain text with sub- and superscripts (texText.ts). */
function TexText({ tex }: { tex: string }): JSX.Element {
  return (
    <>
      {texPieces(tex).map((p, i) => (p.script === "sub" ? <sub key={i}>{p.text}</sub> : p.script === "sup" ? <sup key={i}>{p.text}</sup> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function IconButton({ children, title, onClick, active, disabled }: { children: ReactNode; title: string; onClick: () => void; active?: boolean; disabled?: boolean }): JSX.Element {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      style={{ border: `1px solid ${active ? color.primaryTintBorder : "transparent"}`, background: active ? color.primaryTintBg : "transparent", color: disabled ? color.faintest : color.secondary, borderRadius: 6, width: 28, height: 28, cursor: disabled ? "default" : "pointer", fontSize: 14, lineHeight: 1 }}
    >
      {children}
    </button>
  );
}

/** The Agent mark: a four-point spark. */
export function SparkIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ display: "block", flex: "none" }}>
      <path d="M8 1.2c.5 3.3 1.9 4.9 5.3 5.5-3.4.6-4.8 2.2-5.3 5.5-.5-3.3-1.9-4.9-5.3-5.5C6.1 6.1 7.5 4.5 8 1.2Z" fill={color.primary} />
      <circle cx="13" cy="12.6" r="1.4" fill={color.primary} opacity="0.55" />
    </svg>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────

const drawer: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  background: color.raised,
  borderLeft: `1px solid ${color.border}`,
};
const head: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${color.border}` };
const settingsBox: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${color.border}`, background: color.muted2 };
const transcriptBox: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 };
const composer: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px 12px", borderTop: `1px solid ${color.border}`, background: color.surface };
const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const fieldLabel: CSSProperties = { fontSize: fz.micro, color: color.secondary, fontWeight: 600 };
const input: CSSProperties = { border: `1px solid ${color.input}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: color.surface, color: color.ink, width: "100%", boxSizing: "border-box" };
const note: CSSProperties = { margin: 0, fontSize: 12, color: color.secondary, lineHeight: 1.45 };
const code: CSSProperties = { fontFamily: mono, fontSize: "0.92em", background: color.chipBg, padding: "0 4px", borderRadius: 4 };
// A long unbroken token (a parameter id list, a file name, a ref) wraps
// inside the drawer instead of widening the conversation past it.
const userBubble: CSSProperties = { alignSelf: "flex-end", maxWidth: "88%", background: color.primaryTintBg, border: `1px solid ${color.primaryTintBorder}`, color: color.ink, padding: "7px 10px", borderRadius: 10, fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.45, overflowWrap: "anywhere" };
const assistantText: CSSProperties = { fontSize: 13, color: color.ink, lineHeight: 1.5, overflowWrap: "anywhere" };
const list: CSSProperties = { margin: "0 0 6px", paddingLeft: 18 };
const toolCard: CSSProperties = { border: `1px solid ${color.border}`, borderRadius: 8, padding: "8px 10px", background: color.surface, overflowWrap: "anywhere" };
const primaryButton: CSSProperties = { border: `1px solid ${color.primary}`, background: color.primary, color: "#fff", borderRadius: 6, padding: "5px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" };
const secondaryButton: CSSProperties = { border: `1px solid ${color.control}`, background: color.surface, color: color.ink, borderRadius: 6, padding: "5px 14px", fontSize: 12.5, cursor: "pointer" };
const noticeStyle = (tone: "info" | "error"): CSSProperties => ({
  fontSize: 12.5,
  lineHeight: 1.45,
  padding: "6px 9px",
  borderRadius: 6,
  border: `1px solid ${tone === "error" ? color.warnBorder : color.noteBorder}`,
  background: tone === "error" ? color.warnBg : color.noteBg,
  color: tone === "error" ? color.warnInk : color.noteInk,
});
