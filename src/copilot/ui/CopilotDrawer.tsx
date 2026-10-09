/**
 * The Copilot drawer: the conversation with Claude (in-app chat) or the feed of
 * Claude Code's calls (bridge), every tool call as a card, and an approval
 * card for each change waiting on the user. It sits beside the page, not over
 * it, so the plot and the parameter panel stay in view while Claude works.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { color, fz, mono, radius } from "@/app/theme";
import type { ActivityEntry } from "@/copilot/executor";
import type { CopilotController, CopilotMode, TranscriptItem } from "@/copilot/useCopilot";
import { CHAT_MODELS } from "@/copilot/chat-models";

interface Props {
  readonly copilot: CopilotController;
  readonly onClose: () => void;
}

const MODE_LABEL: Record<CopilotMode, string> = { "claude-code": "Claude Code", "api-key": "API key", proxy: "Local proxy" };

export function CopilotDrawer({ copilot, onClose }: Props): JSX.Element {
  const { settings } = copilot;
  const [showSettings, setShowSettings] = useState(false);
  const chatMode = settings.mode !== "claude-code";
  const needsKey = settings.mode === "api-key" && !copilot.apiKey;
  // First open with nothing set up: show the settings.
  useEffect(() => {
    if (needsKey) setShowSettings(true);
  }, [needsKey]);

  return (
    <aside className="wb-copilot" style={drawer} aria-label="Copilot">
      <div style={head}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <SparkIcon />
          <b style={{ fontSize: 15, color: color.ink }}>Copilot</b>
          <StatusChip copilot={copilot} />
        </span>
        <span style={{ display: "flex", gap: 4 }}>
          <IconButton title="Settings" active={showSettings} onClick={() => setShowSettings((v) => !v)}>⚙</IconButton>
          <IconButton title="Clear the conversation" onClick={copilot.clear} disabled={copilot.thinking}>⌫</IconButton>
          <IconButton title="Close the Copilot" onClick={onClose}>✕</IconButton>
        </span>
      </div>
      {showSettings && <Settings copilot={copilot} />}
      <Transcript copilot={copilot} />
      {chatMode ? <Composer copilot={copilot} disabled={needsKey} /> : <BridgeHint copilot={copilot} />}
    </aside>
  );
}

// ── status ──────────────────────────────────────────────────────────────────

function StatusChip({ copilot }: { copilot: CopilotController }): JSX.Element {
  const { settings, bridge } = copilot;
  let text = MODE_LABEL[settings.mode];
  let tone: "ok" | "wait" | "off" = "ok";
  if (settings.mode === "claude-code") {
    if (bridge.state === "connected") text = "Claude Code · connected";
    else if (bridge.state === "replaced") { text = "Claude Code · another tab"; tone = "off"; }
    else { text = "Claude Code · waiting"; tone = "wait"; }
  } else if (settings.mode === "api-key" && !copilot.apiKey) {
    text = "API key · not set";
    tone = "off";
  }
  const palette = tone === "ok" ? { bg: color.okBg, bd: color.okBorder, ink: color.okInk } : tone === "wait" ? { bg: color.noteBg, bd: color.noteBorder, ink: color.noteInk } : { bg: color.chipBg, bd: color.border, ink: color.secondary };
  return (
    <span role="status" style={{ fontSize: fz.micro, padding: "2px 8px", borderRadius: 999, background: palette.bg, border: `1px solid ${palette.bd}`, color: palette.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {text}
    </span>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

function Settings({ copilot }: { copilot: CopilotController }): JSX.Element {
  const { settings, updateSettings } = copilot;
  return (
    <div style={settingsBox}>
      <div style={{ display: "flex", gap: 0, border: `1px solid ${color.control}`, borderRadius: radius.button, overflow: "hidden" }} role="radiogroup" aria-label="How the Copilot reaches Claude">
        {(Object.keys(MODE_LABEL) as CopilotMode[]).map((m) => (
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
      {settings.mode === "claude-code" && (
        <>
          <p style={note}>
            Claude Code drives this page through the <code style={code}>materia-live</code> MCP server. Open Claude Code in this repository; it starts the server from <code style={code}>.mcp.json</code> and this page connects to it.
          </p>
          <label style={field}>
            <span style={fieldLabel}>Bridge address</span>
            <input style={input} value={settings.bridgeUrl} onChange={(e) => updateSettings({ bridgeUrl: e.target.value })} spellCheck={false} />
          </label>
        </>
      )}
      {settings.mode === "api-key" && (
        <>
          <label style={field}>
            <span style={fieldLabel}>Anthropic API key</span>
            <input style={input} type="password" autoComplete="off" placeholder="sk-ant-…" value={copilot.apiKey} onChange={(e) => copilot.setApiKey(e.target.value.trim())} spellCheck={false} />
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
      {settings.mode !== "claude-code" && (
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
      <label style={{ ...field, flexDirection: "row", alignItems: "center", gap: 6 }} title="Changes run without an approval card. Each one is still a step in History you can undo.">
        <input type="checkbox" checked={settings.autoApprove} onChange={(e) => copilot.updateSettings({ autoApprove: e.target.checked })} />
        <span style={{ fontSize: 12.5 }}>Auto-approve changes (this session)</span>
      </label>
    </div>
  );
}

// ── transcript ──────────────────────────────────────────────────────────────

function Transcript({ copilot }: { copilot: CopilotController }): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  const items = copilot.transcript;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items, copilot.activity]);
  return (
    <div style={transcriptBox} aria-live="polite">
      {items.length === 0 && <EmptyState mode={copilot.settings.mode} />}
      {items.map((item) => <Item key={item.id} item={item} copilot={copilot} />)}
      {copilot.thinking && <div style={{ fontSize: 12.5, color: color.faint, padding: "0 2px" }}>Working…</div>}
      <div ref={end} />
    </div>
  );
}

function EmptyState({ mode }: { mode: CopilotMode }): JSX.Element {
  return (
    <div style={{ color: color.secondary, fontSize: fz.small, lineHeight: 1.5, padding: "6px 2px" }}>
      {mode === "claude-code" ? (
        <>
          <p style={{ margin: "0 0 8px" }}>Claude Code's calls on this analysis will show here, and each change waits for your approval.</p>
          <p style={{ margin: 0 }}>Try asking Claude Code: <i>“Use materia-live to look at the open fit and tell me what to refine next.”</i></p>
        </>
      ) : (
        <>
          <p style={{ margin: "0 0 8px" }}>Ask about the fit on screen, or ask Claude to take the next step. It reads the analysis, judges it with MATERIA's tools, and asks before it changes anything.</p>
          <p style={{ margin: 0 }}>For example: <i>“Assess the fit and suggest what to free next.”</i></p>
        </>
      )}
    </div>
  );
}

function Item({ item, copilot }: { item: TranscriptItem; copilot: CopilotController }): JSX.Element | null {
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
          {item.text && <div style={assistantText}><Markdown text={item.text} /></div>}
        </div>
      );
    case "tool": {
      const entry = copilot.activity[item.entryId];
      return entry ? <ToolCard entry={entry} onDecide={copilot.decide} /> : null;
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
    <div style={{ ...toolCard, ...(waiting ? { borderColor: color.primaryTintBorder, background: color.primaryTintBg } : {}) }} data-tool={entry.tool} data-status={entry.status}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, fontSize: 12.5, color: color.ink }}>
          {entry.effect === "read" ? "◦ " : "● "}{entry.title}
        </span>
        <span style={{ fontSize: fz.micro, color: tone, whiteSpace: "nowrap" }}>
          {entry.source === "claude-code" ? "Claude Code · " : ""}{statusText}
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

function Composer({ copilot, disabled }: { copilot: CopilotController; disabled: boolean }): JSX.Element {
  const [text, setText] = useState("");
  const submit = (): void => {
    if (!text.trim() || copilot.thinking || disabled) return;
    copilot.send(text);
    setText("");
  };
  return (
    <div style={composer}>
      <textarea
        aria-label="Message the Copilot"
        style={{ ...input, resize: "none", minHeight: 58, fontFamily: "inherit", lineHeight: 1.4 }}
        placeholder={disabled ? "Add your API key in the settings first" : "Ask about the fit, or ask for the next step…"}
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
        <span style={{ fontSize: fz.micro, color: color.faint, fontFamily: mono }}>
          {copilot.usage.input + copilot.usage.output > 0
            ? `${fmtTokens(copilot.usage.input)} in · ${fmtTokens(copilot.usage.cacheRead)} cached · ${fmtTokens(copilot.usage.output)} out`
            : "Enter to send · Shift+Enter for a new line"}
        </span>
        {copilot.thinking
          ? <button style={secondaryButton} onClick={copilot.stop}>Stop</button>
          : <button style={primaryButton} onClick={submit} disabled={disabled || !text.trim()}>Send</button>}
      </div>
    </div>
  );
}

function BridgeHint({ copilot }: { copilot: CopilotController }): JSX.Element {
  const { bridge } = copilot;
  return (
    <div style={{ ...composer, fontSize: 12.5, color: color.secondary, lineHeight: 1.45 }}>
      {bridge.state === "connected" && <span>Connected to Claude Code. Ask it in your terminal; its calls appear here.</span>}
      {bridge.state === "searching" && (
        <span>
          Waiting for Claude Code. Start <code style={code}>claude</code> in this repository: it runs the <code style={code}>materia-live</code> server from <code style={code}>.mcp.json</code>, and this page connects to it.
        </span>
      )}
      {bridge.state === "replaced" && <span>Another tab of the app is connected to Claude Code. Switch modes and back to take it over here.</span>}
      {bridge.state === "off" && <span>Bridge off.</span>}
    </div>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────

/** A safe, minimal Markdown subset: paragraphs, bullet/numbered lists, **bold**, `code`. */
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

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith("**") ? <b key={k++}>{t.slice(2, -2)}</b> : <code key={k++} style={code}>{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
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

/** The Copilot mark: a four-point spark. */
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
const userBubble: CSSProperties = { alignSelf: "flex-end", maxWidth: "88%", background: color.primaryTintBg, border: `1px solid ${color.primaryTintBorder}`, color: color.ink, padding: "7px 10px", borderRadius: 10, fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.45 };
const assistantText: CSSProperties = { fontSize: 13, color: color.ink, lineHeight: 1.5 };
const list: CSSProperties = { margin: "0 0 6px", paddingLeft: 18 };
const toolCard: CSSProperties = { border: `1px solid ${color.border}`, borderRadius: 8, padding: "8px 10px", background: color.surface };
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
