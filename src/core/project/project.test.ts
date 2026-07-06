import { describe, it, expect } from "vitest";
import { makeExampleProject } from "@/core/project/fixture";
import { PROJECT_SCHEMA_VERSION } from "@/app/constants";

describe("ProjectFile", () => {
  it("round-trips losslessly through JSON", () => {
    const project = makeExampleProject();
    const roundTripped = JSON.parse(JSON.stringify(project));
    expect(roundTripped).toEqual(project);
  });

  it("stamps the current schema version", () => {
    expect(makeExampleProject().schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it("keeps nuclear and magnetic models separable (magnetic empty by default)", () => {
    expect(makeExampleProject().magneticModels).toHaveLength(0);
  });
});
