import { describe, it, expect } from "vitest";
import { PAGE_METHOD, allSkills, frontmatter, joinPath, parseSkill, readSkill, skillIndex } from "@/agent/skills";
import { agentSystemPrompt } from "@/agent/systemPrompt";

describe("the Agent's skills", () => {
  it("finds every skill in the repository, with each page's method among them", () => {
    const names = allSkills().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["my-rietveld-workflow", "pdf-workflow"]));
    for (const method of Object.values(PAGE_METHOD)) expect(names).toContain(method);
    for (const s of allSkills()) {
      expect(s.description.length).toBeGreaterThan(80);
      expect(s.body).not.toMatch(/^---/);
    }
  });

  it("resolves every reference a skill cites to a bundled file", () => {
    const rietveld = allSkills().find((s) => s.name === "my-rietveld-workflow")!;
    expect(rietveld.references.map((r) => [r.name, r.path])).toEqual([
      ["powder_structural_refinement", "knowledge/powder_structural_refinement_knowledge.md"],
      ["refinement_fitting_algorithms", "knowledge/refinement_fitting_algorithms_knowledge.md"],
      ["powder_background_texture", "knowledge/powder_background_texture_knowledge.md"],
      ["magnetic_structure_symmetry", "knowledge/magnetic_structure_symmetry_knowledge.md"],
    ]);
    for (const s of allSkills()) for (const r of s.references) {
      expect(r.text.length).toBeGreaterThan(1000);
      expect(r.description.length).toBeGreaterThan(20);
    }
    const pdf = allSkills().find((s) => s.name === "pdf-workflow")!;
    expect(pdf.references.map((r) => r.name)).toContain("total_scattering_pdf_conventions");
  });

  it("reads a folded description, quoted values, and literal blocks", () => {
    expect(frontmatter("name: a-skill\ndescription: >-\n  One line\n  and the next.\nother: x")).toEqual({ name: "a-skill", description: "One line and the next.", other: "x" });
    expect(frontmatter('name: "quoted"\ndescription: |\n  kept\n  as lines')).toEqual({ name: "quoted", description: "kept\nas lines" });
    expect(joinPath(".claude/skills/x", "../../../knowledge/k.md")).toBe("knowledge/k.md");
    expect(joinPath(".claude/skills/x", "./refs/r.md")).toBe(".claude/skills/x/refs/r.md");
  });

  it("refuses a skill without frontmatter or one citing a file that is not there", () => {
    expect(() => parseSkill("# no frontmatter", ".claude/skills/x", {})).toThrow(/no frontmatter/);
    expect(() => parseSkill("---\nname: x\n---\nbody", ".claude/skills/x", {})).toThrow(/needs a name and a description/);
    const cites = "---\nname: x\ndescription: d\n---\n## References\n\n- [`k`](../../../knowledge/missing.md) — gone\n";
    expect(() => parseSkill(cites, ".claude/skills/x", {})).toThrow(/cites \.\.\/\.\.\/\.\.\/knowledge\/missing\.md, which is not bundled/);
    expect(parseSkill(cites, ".claude/skills/x", { "knowledge/missing.md": "here" }).references[0]).toMatchObject({ name: "k", description: "gone", text: "here" });
  });

  it("names the skills and their references when asked for one that is not there", () => {
    expect(() => readSkill("nope")).toThrow(/no skill named "nope" — the skills are .*my-rietveld-workflow/);
    expect(readSkill("pdf-workflow")).toMatch(/^Skill pdf-workflow\n\n# PDF refinement workflow/);
  });

  it("keeps the system prompt to the role and the index: the methods are read on demand", () => {
    const prompt = agentSystemPrompt();
    expect(prompt).toContain(skillIndex());
    expect(prompt).toContain("- pdf-workflow (the PDF page's method):");
    for (const s of allSkills()) expect(prompt).not.toContain(s.body.slice(0, 200));
    // It carried ~63 KB (the Rietveld skill and two knowledge files) on every request.
    expect(prompt.length).toBeLessThan(12000);
  });
});
