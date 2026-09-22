/**
 * Project file I/O: text ↔ validated `ProjectFile`.
 *
 * Reading: JSON.parse → schema-version gate (refuse files from a newer build,
 * migrate older ones) → structural validation by technique. Anything that
 * fails raises a `ProjectFileError` with the JSON path of the problem, so the
 * UI can show the user exactly what is wrong rather than half-loading a file.
 *
 * Writing: the readable serializer in `serialize.ts`. Files carry the
 * `.materia.json` suffix so they are recognizable next to the plain `.json`
 * exports of other tools; any `.json` is accepted on load.
 */

import { PROJECT_SCHEMA_VERSION, type ProjectFile } from "@/core/project/types";
import { stringifyProject } from "@/core/project/serialize";
import { migrateProjectData } from "@/core/project/migrate";
import { ProjectFileError, isRecord, validateProjectFile } from "@/core/project/validate";

export { ProjectFileError };

const PROJECT_FILE_EXTENSION = ".materia.json";

export function serializeProject(file: ProjectFile): string {
  return `${stringifyProject(file)}\n`;
}

/** Parse, migrate and validate. Throws `ProjectFileError` on any problem. */
export function parseProject(text: string): ProjectFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ProjectFileError(`not a JSON document (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isRecord(data)) throw new ProjectFileError("not a project file: the document is not a JSON object");
  const version = data.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ProjectFileError("not a project file: missing schemaVersion");
  }
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFileError(
      `this project was saved by a newer version of the app (schema v${version}; this build reads up to v${PROJECT_SCHEMA_VERSION}) — update the app to open it`,
    );
  }
  return validateProjectFile(version < PROJECT_SCHEMA_VERSION ? migrateProjectData(data) : data);
}

/**
 * Cheap sniff for the unified data loader: does this text look like a project
 * file (as opposed to a CIF, a powder pattern, a reflection list…)? Only the
 * envelope keys are checked; `parseProject` does the real work.
 */
export function looksLikeProjectFile(text: string): boolean {
  const head = text.slice(0, 64).trimStart();
  if (!head.startsWith("{")) return false;
  return /"schemaVersion"\s*:/.test(text) && /"structures"\s*:/.test(text);
}

/** Suggested file name for a project: its title as a safe slug + the suffix. */
export function projectFileName(file: ProjectFile): string {
  const slug = file.metadata.title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "project"}${PROJECT_FILE_EXTENSION}`;
}
