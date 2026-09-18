/**
 * Project file (de)serialization. The implementation lives with the format in
 * `core/project/io` (schema gate, migration, validation by technique); this
 * module re-exports it for callers that reach for the parsers layer.
 */

export { parseProject, serializeProject, looksLikeProjectFile, ProjectFileError } from "@/core/project/io";
/** @deprecated Use `ProjectFileError`. */
export { ProjectFileError as ProjectVersionError } from "@/core/project/io";
