# Project File Format

A project is a single JSON document — the reproducible unit of work. It captures
the structures, magnetic models, datasets, parameters, and last refinement
result so a session can be saved, shared, and reopened exactly.

The authoritative schema is the `ProjectFile` type in
`src/core/project/types.ts`. A minimal valid example is built by
`src/core/project/fixture.ts` and exercised by the round-trip test.

## Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "metadata": {
    "title": "…",
    "createdAt": "2026-01-01T00:00:00.000Z",  // ISO-8601
    "modifiedAt": "2026-01-01T00:00:00.000Z",
    "appVersion": "0.0.0",
    "notes": "…"                               // optional
  },
  "structures":     [ /* StructureModel[]  */ ],
  "magneticModels": [ /* MagneticModel[]   */ ],  // [] for nuclear-only
  "datasets":       [ /* DiffractionDataset[] */ ],
  "parameters":     [ /* RefinementParameter[] */ ],
  "bindings":       [ /* ParameterBinding[] */ ],
  "lastResult":     { /* RefinementResult */ }    // optional
}
```

## Design rules

- **Plain JSON, no methods.** Every referenced type is a methods-free data
  object, so `JSON.stringify(project)` / `JSON.parse` round-trips losslessly.
  This invariant is a test (`core/project/project.test.ts`), not just a promise.
- **References by id.** `MagneticModel.structureId`, `ParameterBinding.targetId`,
  and dataset ids link parts together, avoiding duplicated nested state.
- **Separation of concerns.** Nuclear structures and magnetic models are distinct
  arrays; a nuclear-only project simply has `magneticModels: []`.
- **Timestamps as strings.** ISO-8601 strings, not `Date` objects, for portable
  serialization.

## Versioning & migration

- `schemaVersion` is an integer, currently `1`
  (`PROJECT_SCHEMA_VERSION` in `src/app/constants.ts`).
- On load, the reader compares the file's version to the current one:
  - equal → load directly;
  - older → run migration steps up to current (added as the schema evolves);
  - newer → refuse with a clear message rather than silently misreading.
- Any breaking change to a persisted type **must** bump `schemaVersion` and add a
  migration. This is what protects older saved projects.

## Reproducibility

The file records the writing `appVersion` for traceability. Because the
scientific core is pure and deterministic (no randomness in the calculation
path), reopening a project and re-running refinement from the same inputs yields
the same numbers — a precondition for the validation strategy in
[VALIDATION.md](./VALIDATION.md).
