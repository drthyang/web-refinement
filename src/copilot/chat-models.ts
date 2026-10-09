/**
 * The models the in-app Copilot offers. Kept apart from chat.ts so the drawer
 * can list them without loading the SDK and the system prompt.
 */

export const CHAT_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", fallback: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", fallback: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", fallback: false },
] as const;

export const DEFAULT_CHAT_MODEL = "claude-opus-5-5";

/** The model takes the API's server-side refusal fallback (the `"default"` chain). */
export function hasRefusalFallback(model: string): boolean {
  return CHAT_MODELS.some((m) => m.id === model && m.fallback);
}
