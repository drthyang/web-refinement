import { describe, it, expect } from "vitest";
import {
  makeExamplePdfProject,
  makeExamplePowderProject,
  makeExampleProjects,
  makeExampleSingleCrystalProject,
} from "@/core/project/fixture";
import { PROJECT_SCHEMA_VERSION, TECHNIQUES, type ProjectFile, type Workspace } from "@/core/project/types";
import { ProjectFileError, looksLikeProjectFile, parseProject, projectFileName, serializeProject } from "@/core/project/io";

// Compile-time guard: every Workspace member's tag is one of TECHNIQUES, and
// vice versa — adding a technique to one without the other fails to build.
const tagsCovered: Record<Workspace["technique"], true> = { powder: true, singleCrystal: true, pdf: true };
const techniquesCovered: Record<(typeof TECHNIQUES)[number], true> = tagsCovered;
void techniquesCovered;

/** Deep-clone a project as loose JSON, set one dotted path, and stringify. */
function corrupt(file: ProjectFile, path: string, value: unknown): string {
  const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
  const keys = path.split(".");
  let cur = doc;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys[keys.length - 1]!] = value;
  return JSON.stringify(doc);
}

const powder = makeExamplePowderProject();
const sc = makeExampleSingleCrystalProject();
const pdf = makeExamplePdfProject();

describe("ProjectFile fixtures (one per technique)", () => {
  it.each(makeExampleProjects().map((p) => [p.workspace.technique, p] as const))("%s: stamps the current schema version", (_t, p) => {
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it.each(makeExampleProjects().map((p) => [p.workspace.technique, p] as const))("%s: validates and round-trips losslessly", (_t, p) => {
    const text = serializeProject(p);
    expect(parseProject(text)).toEqual(p);
    // The plain-JSON invariant: no methods, no typed arrays, nothing lost.
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it("writes a readable file: tagged workspace, one observation per line", () => {
    const text = serializeProject(powder);
    expect(text).toContain('"technique": "powder"');
    expect(text).toMatch(/\n\s+\{"x": 40, "yObs": 12\.1, "sigma": 3\.5\},\n/);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("parseProject — envelope", () => {
  it("rejects text that is not JSON, not an object, or has no schemaVersion", () => {
    expect(() => parseProject("data_Fe\n_cell_length_a 2.87")).toThrow(ProjectFileError);
    expect(() => parseProject("[1, 2, 3]")).toThrow(/not a JSON object/);
    expect(() => parseProject(JSON.stringify({ metadata: {} }))).toThrow(/missing schemaVersion/);
  });

  it("refuses a file from a newer build rather than misreading it", () => {
    expect(() => parseProject(corrupt(powder, "schemaVersion", PROJECT_SCHEMA_VERSION + 1))).toThrow(/newer version of the app/);
  });

  it("refuses an unknown technique tag, naming the known ones", () => {
    expect(() => parseProject(corrupt(powder, "workspace.technique", "xrd"))).toThrow(
      /workspace\.technique: expected one of "powder", "singleCrystal", "pdf", got "xrd"/,
    );
  });

  it("requires at least one phase and unique phase ids", () => {
    expect(() => parseProject(corrupt(powder, "structures", []))).toThrow(/at least one phase/);
    const dup = JSON.parse(JSON.stringify(powder)) as ProjectFile;
    expect(() => parseProject(JSON.stringify({ ...dup, structures: [dup.structures[0], dup.structures[0]] }))).toThrow(/duplicate phase id/);
  });

  it("reports the JSON path of a malformed field", () => {
    expect(() => parseProject(corrupt(powder, "structures.0.cell.alpha", "ninety"))).toThrow(/^structures\[0\]\.cell\.alpha: expected a finite number, got "ninety"/);
    expect(() => parseProject(corrupt(powder, "workspace.pattern.points.2.yObs", null))).toThrow(/workspace\.pattern\.points\[2\]\.yObs: expected a finite number, got null/);
  });
});

describe("parseProject — the technique guard (data must match the tag)", () => {
  it("refuses PDF points inside a powder workspace", () => {
    expect(() => parseProject(corrupt(powder, "workspace.pattern.points", pdf.workspace.technique === "pdf" ? pdf.workspace.pattern.points : []))).toThrow(
      /contains PDF points \(r, gObs\) but workspace\.technique is "powder"/,
    );
  });

  it("refuses powder points inside a PDF workspace", () => {
    expect(() => parseProject(corrupt(pdf, "workspace.pattern.points", powder.workspace.technique === "powder" ? powder.workspace.pattern.points : []))).toThrow(
      /contains powder-pattern points \(x, yObs\) but workspace\.technique is "pdf"/,
    );
  });

  it("refuses powder points where single-crystal reflections belong", () => {
    expect(() => parseProject(corrupt(sc, "workspace.dataset.reflections", powder.workspace.technique === "powder" ? powder.workspace.pattern.points : []))).toThrow(
      /contains powder-pattern points \(x, yObs\) but workspace\.technique is "singleCrystal"/,
    );
  });

  it("refuses a whole workspace relabelled as another technique", () => {
    // A powder block claiming to be PDF has no scatteringType / r-points; a PDF
    // block claiming to be powder has no xUnit. Either way: refused, never loaded.
    expect(() => parseProject(corrupt(powder, "workspace.technique", "pdf"))).toThrow(ProjectFileError);
    expect(() => parseProject(corrupt(pdf, "workspace.technique", "powder"))).toThrow(ProjectFileError);
    expect(() => parseProject(corrupt(sc, "workspace.technique", "powder"))).toThrow(ProjectFileError);
  });
});

describe("parseProject — referential integrity", () => {
  it("rejects a binding that points at a parameter not in the file", () => {
    const bad = corrupt(powder, "workspace.refinement.bindings.0.parameterId", "ghost");
    expect(() => parseProject(bad)).toThrow(/bindings\[0\]\.parameterId: refers to a parameter that is not in the file: "ghost"/);
  });

  it("rejects duplicate parameter ids", () => {
    expect(() => parseProject(corrupt(powder, "workspace.refinement.parameters.1.id", "scale"))).toThrow(/duplicate parameter id "scale"/);
  });

  it("rejects a magnetic model that does not decorate the primary phase or its sites", () => {
    const magnetic = {
      id: "mag", structureId: "struct-fe", propagation: [[0, 0, 0]],
      moments: [{ siteLabel: "Fe1", frame: "crystallographic", components: [0, 0, 2] }],
    };
    expect(() => parseProject(corrupt(powder, "workspace.magnetic", magnetic))).not.toThrow();
    expect(() => parseProject(corrupt(powder, "workspace.magnetic", { ...magnetic, structureId: "other" }))).toThrow(/must be the primary phase "struct-fe"/);
    expect(() => parseProject(corrupt(powder, "workspace.magnetic", { ...magnetic, moments: [{ ...magnetic.moments[0], siteLabel: "Xx1" }] }))).toThrow(
      /no site "Xx1" in the primary phase \(sites: Fe1\)/,
    );
  });

  it("rejects an empty or inverted fit window", () => {
    expect(() => parseProject(corrupt(powder, "workspace.fitRange", { min: 47, max: 41 }))).toThrow(/min \(47\) must be below max \(41\)/);
    expect(() => parseProject(corrupt(pdf, "workspace.fitRange", { min: 2, max: 2 }))).toThrow(/must be below/);
  });

  it("rejects a view-only overlay that does not match the pattern length", () => {
    expect(() => parseProject(corrupt(powder, "workspace.overlay", { calc: [1, 2], background: [0, 0] }))).toThrow(/one value per pattern point \(5\)/);
  });

  it("accepts null for an optional field (lenient read, strict write)", () => {
    expect(() => parseProject(corrupt(powder, "workspace.fitRange", null))).not.toThrow();
    expect(() => parseProject(corrupt(sc, "workspace.magneticDataset", null))).not.toThrow();
  });
});

describe("migration v1 → v2", () => {
  const v1Base = {
    schemaVersion: 1,
    metadata: { title: "old", createdAt: "2026-01-01T00:00:00.000Z", modifiedAt: "2026-01-01T00:00:00.000Z", appVersion: "0.0.9" },
    structures: powder.structures,
    magneticModels: [],
  };

  it("lifts a v1 powder export into a powder workspace with default instrument settings", () => {
    if (powder.workspace.technique !== "powder") throw new Error("fixture");
    const v1 = { ...v1Base, datasets: [powder.workspace.pattern], parameters: powder.workspace.refinement.parameters, bindings: powder.workspace.refinement.bindings };
    const out = parseProject(JSON.stringify(v1));
    expect(out.schemaVersion).toBe(2);
    expect(out.workspace.technique).toBe("powder");
    if (out.workspace.technique !== "powder") return;
    expect(out.workspace.pattern).toEqual(powder.workspace.pattern);
    expect(out.workspace.refinement.parameters).toEqual(powder.workspace.refinement.parameters);
    expect(out.workspace.instrument).toEqual({ kind: "constantWavelength", wavelength: 1.54, radiationKind: "neutron" });
    expect(out.workspace.instrumentLoaded).toBe(false);
    expect(out.workspace.backgroundTerms).toBe(2);
    expect(out.metadata.notes).toMatch(/Migrated from schema v1/);
  });

  it("lifts a v1 single-crystal document into a single-crystal workspace", () => {
    if (sc.workspace.technique !== "singleCrystal") throw new Error("fixture");
    const v1 = { ...v1Base, datasets: [sc.workspace.dataset], parameters: sc.workspace.refinement.parameters, bindings: sc.workspace.refinement.bindings };
    const out = parseProject(JSON.stringify(v1));
    expect(out.workspace.technique).toBe("singleCrystal");
    if (out.workspace.technique !== "singleCrystal") return;
    expect(out.workspace.probe).toBe("neutron");
    expect(out.workspace.dataset).toEqual(sc.workspace.dataset);
  });

  it("refuses a v1 document whose dataset is neither", () => {
    const v1 = { ...v1Base, datasets: [{ id: "x", name: "x" }], parameters: [], bindings: [] };
    expect(() => parseProject(JSON.stringify(v1))).toThrow(/cannot migrate/);
  });
});

describe("helpers", () => {
  it("looksLikeProjectFile sniffs the envelope only", () => {
    expect(looksLikeProjectFile(serializeProject(powder))).toBe(true);
    expect(looksLikeProjectFile("data_Fe\n_cell_length_a 2.8665\n")).toBe(false);
    expect(looksLikeProjectFile("10.00 120\n10.05 131\n")).toBe(false);
    expect(looksLikeProjectFile('{"points": [1, 2]}')).toBe(false);
  });

  it("projectFileName slugs the title and adds the suffix", () => {
    expect(projectFileName(powder)).toBe("Example-bcc-iron-powder.materia.json");
    expect(projectFileName({ ...powder, metadata: { ...powder.metadata, title: "  —  " } })).toBe("project.materia.json");
  });
});
