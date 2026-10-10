/**
 * The Agent's skills: the user's methods, and the references behind them, as
 * Claude Code loads them in this repository (`.claude/skills/<name>/SKILL.md`).
 *
 * Progressive disclosure: the system prompt lists each skill's name and
 * description only; the Agent reads a skill's body with `read_skill` when the
 * task calls for it, and a reference (listed in the skill's "## References"
 * section) the same way. The fixed context stays small — which a local model
 * with a 32k window needs — and each page gets its own method. A page's
 * method skill must be read before the Agent changes anything on that page
 * (the executor enforces it, per conversation).
 *
 * One source for both agents: a reference is a relative Markdown link, which
 * Claude Code follows as a path and this module resolves to the bundled file.
 */

import type { AgentPage } from "@/agent/tools";

/** Every Markdown file under the skills folder (SKILL.md and any file beside it), keyed by repo path. */
const SKILL_TREE = repoKeyed(import.meta.glob("../../.claude/skills/**/*.md", { query: "?raw", import: "default", eager: true }));
/** The knowledge base the skills cite. */
const KNOWLEDGE = repoKeyed(import.meta.glob("../../knowledge/*.md", { query: "?raw", import: "default", eager: true }));

/** Which skill is each page's method: read before any change on that page. */
export const PAGE_METHOD: Readonly<Record<AgentPage, string>> = {
  powder: "my-rietveld-workflow",
  pdf: "pdf-workflow",
};

export interface SkillReference {
  /** What read_skill's `reference` takes: the link's label. */
  readonly name: string;
  /** Repo path of the file. */
  readonly path: string;
  /** What the reference covers (the text after the link). */
  readonly description: string;
  readonly text: string;
}

export interface Skill {
  readonly name: string;
  readonly description: string;
  /** SKILL.md without its frontmatter. */
  readonly body: string;
  readonly references: readonly SkillReference[];
}

/** Parse a SKILL.md (frontmatter `name` and `description`, a "## References" list). */
export function parseSkill(source: string, dir: string, files: Readonly<Record<string, string>>): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!m) throw new Error(`${dir}/SKILL.md has no frontmatter`);
  const meta = frontmatter(m[1]!);
  const name = meta.name;
  const description = meta.description;
  if (!name || !description) throw new Error(`${dir}/SKILL.md needs a name and a description`);
  const body = source.slice(m[0].length).trim();
  return { name, description, body, references: referencesOf(body, dir, files) };
}

/**
 * The frontmatter's top-level scalars: `key: value`, a quoted value, or a
 * folded / literal block (`>-`, `|`) of indented lines. Nested keys are
 * ignored; the loader needs only the name and the description.
 */
export function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const [, key, raw] = kv as unknown as [string, string, string];
    if (/^[>|][-+]?$/.test(raw)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      out[key] = raw.startsWith(">") ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    } else {
      out[key] = raw.replace(/^(["'])(.*)\1$/, "$2").trim();
    }
  }
  return out;
}

/** The "## References" section: `- [label](relative/path.md) — what it covers`. */
function referencesOf(body: string, dir: string, files: Readonly<Record<string, string>>): SkillReference[] {
  const section = /^## References\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  if (!section) return [];
  const out: SkillReference[] = [];
  for (const line of section[1]!.split("\n")) {
    const ref = /^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]+\s*)?(.*)$/.exec(line);
    if (!ref) continue;
    const name = ref[1]!.replace(/`/g, "").trim();
    const path = joinPath(dir, ref[2]!.trim());
    const text = files[path];
    if (text === undefined) throw new Error(`${dir}/SKILL.md cites ${ref[2]}, which is not bundled (${path})`);
    out.push({ name, path, description: ref[3]!.trim(), text });
  }
  return out;
}

/** `dir` joined with a relative path, `..` resolved: a repo path. */
export function joinPath(dir: string, rel: string): string {
  const parts = [...dir.split("/"), ...rel.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** Glob results keyed by repo path ("../../knowledge/x.md" → "knowledge/x.md"). */
function repoKeyed(files: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [joinPath("src/agent", k), String(v)]));
}

let cached: readonly Skill[] | null = null;

/** Every skill in the repository, sorted by name. */
export function allSkills(): readonly Skill[] {
  if (cached) return cached;
  const files = { ...SKILL_TREE, ...KNOWLEDGE };
  cached = Object.entries(SKILL_TREE)
    .filter(([path]) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(path))
    .map(([path, source]) => parseSkill(source, path.replace(/\/SKILL\.md$/, ""), files))
    .sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

export function skillNamed(name: string): Skill | undefined {
  return allSkills().find((s) => s.name === name);
}

/** The system prompt's list of skills: names and descriptions, and which is each page's method. */
export function skillIndex(): string {
  const pageOf = new Map(Object.entries(PAGE_METHOD).map(([page, skill]) => [skill, page]));
  return allSkills()
    .map((s) => `- ${s.name}${pageOf.has(s.name) ? ` (the ${PAGE_LABEL[pageOf.get(s.name) as AgentPage]} page's method)` : ""}: ${s.description}`)
    .join("\n");
}

const PAGE_LABEL: Record<AgentPage, string> = { powder: "Powder", pdf: "PDF" };

/**
 * What read_skill returns: the skill's body and its references' names, or
 * one reference's text. Plain Markdown, not JSON, so the model reads it as
 * written.
 */
export function readSkill(name: string, reference?: string): string {
  const skill = skillNamed(name);
  if (!skill) throw new Error(`no skill named "${name}" — the skills are ${allSkills().map((s) => s.name).join(", ")}`);
  if (reference !== undefined) {
    const ref = skill.references.find((r) => r.name === reference);
    if (!ref) {
      const names = skill.references.map((r) => r.name);
      throw new Error(`${name} has no reference "${reference}"${names.length ? ` — it has ${names.join(", ")}` : ""}`);
    }
    return `Reference "${ref.name}" of skill ${name} (${ref.path})\n\n${ref.text.trim()}`;
  }
  const refs = skill.references.length
    ? `\n\n---\nReferences of this skill (read one with read_skill and \`reference\`):\n${skill.references.map((r) => `- ${r.name}: ${r.description}`).join("\n")}`
    : "";
  return `Skill ${skill.name}\n\n${skill.body}${refs}`;
}
