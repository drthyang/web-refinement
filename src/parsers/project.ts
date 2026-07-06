/**
 * Project file (de)serialization with schema-version gating.
 *
 * The format is plain JSON, so serialization is `JSON.stringify`. Parsing adds
 * validation: it refuses files newer than this build and runs migrations for
 * older ones (none needed yet at version 1).
 */

import { PROJECT_SCHEMA_VERSION } from "@/app/constants";
import type { ProjectFile } from "@/core/project/types";

export function serializeProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

export class ProjectVersionError extends Error {}

export function parseProject(text: string): ProjectFile {
  const data = JSON.parse(text) as ProjectFile;
  if (typeof data.schemaVersion !== "number") {
    throw new ProjectVersionError("Not a project file: missing schemaVersion");
  }
  if (data.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new ProjectVersionError(
      `Project schema v${data.schemaVersion} is newer than this build (v${PROJECT_SCHEMA_VERSION}). Update the app.`,
    );
  }
  // Older versions would be migrated here as the schema evolves.
  return data;
}
