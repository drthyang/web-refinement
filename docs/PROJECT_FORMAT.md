# Project File Format

A project is one JSON document — the reproducible unit of work. It captures
the crystallographic phases, the observed data, every refinement parameter with
its value and fixed/free state, the technique-specific model settings, and the
last result, so a session can be saved, shared, and reopened where it was left.

- **Save:** header ▸ *Project ▾* ▸ *Save project* — downloads `<title>.materia.json`.
- **Open:** *Project ▾* ▸ *Open project…*, the *open a saved project* link on the
  landing page, or drop the file on any *Load data…* button (the loader
  recognizes the envelope).

The authoritative schema is the `ProjectFile` type in
[`src/core/project/types.ts`](../src/core/project/types.ts); the reader is
[`src/core/project/io.ts`](../src/core/project/io.ts) (schema gate → migration →
validation). One minimal example per technique lives in
[`src/core/project/fixture.ts`](../src/core/project/fixture.ts).

## Top-level shape

```jsonc
{
  "schemaVersion": 2,
  "metadata": {
    "title": "Mn3Ga · Rietveld (powder)",
    "createdAt": "2026-09-15T10:00:00.000Z",   // ISO-8601
    "modifiedAt": "2026-09-15T10:42:11.000Z",
    "appVersion": "0.1.0",
    "notes": "…"                                 // optional
  },
  "structures": [ /* StructureModel[] — [0] is the primary phase */ ],
  "workspace":  { "technique": "powder" | "singleCrystal" | "pdf", /* … */ },
  "view":       { "step": 0 }                    // optional UI hint
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer. Gates migration (see below). |
| `metadata` | Provenance: title, timestamps, the app version that wrote the file, free notes. |
| `structures` | The phases. `structures[0]` is the **primary phase** — the one a magnetic model decorates (`MagneticModel.structureId`) and the one the single-crystal engine refines. Further entries are additional phases (powder / PDF multi-phase). |
| `workspace` | **Exactly one** technique block, selected by its `technique` tag (below). |
| `view` | Ignorable UI hints. `step`: 0 = nuclear refinement page, 1 = magnetic page. |

## The workspace: a tagged union on `technique`

This is the guard the format is built around. Each measurement technique has
its own block with its own dataset type, its own model settings, and its own
validator branch. A reader dispatches on `workspace.technique` and checks that
the data actually has that technique's shape — PDF points `{r, gObs}` inside a
block tagged `"powder"` are refused with a message naming the mismatch, never
loaded as a pattern with missing columns. Nothing outside the block changes
when a technique gains a setting, and adding a technique never touches the
others.

Every block carries a `refinement` section of the same shape:

```jsonc
"refinement": {
  "parameters": [ /* RefinementParameter[] — full rows: id, label, kind, value,
                     initialValue, min?, max?, fixed, esd?, expression?… */ ],
  "bindings":   [ /* ParameterBinding[] — parameterId → targetId/targetKey, axes */ ],
  "lastResult": { /* RefinementResult, when a fit has run */ }
}
```

The *full* rows are stored, not just values by id, so a file is readable on its
own. Bindings must reference parameters present in the file; ids must be unique.

### `"powder"` — Rietveld (Bragg profile)

| Field | Type | Notes |
| --- | --- | --- |
| `pattern` | `PowderPattern` | `xUnit` ∈ twoTheta · dSpacing · q · tof; points `{x, yObs, sigma?}`. |
| `instrument` | `InstrumentParameters` | Constant-wavelength (λ, Caglioti U/V/W, X/Y…) or TOF (difC/difA/difB, α/β/σ). |
| `instrumentLoaded` | boolean | Whether `instrument` came from a user file (vs. the built-in default). |
| `profile` | `PowderProfile` | `shape` ∈ gaussian · pseudoVoigt · tof; `eta?`, `lorentz?`, `backgroundType?`. |
| `backgroundTerms` | integer ≥ 1 | Number of background coefficients. |
| `siteTies` | `SiteTies` | Shared-site position / ADP / occupancy-to-unity ties. |
| `anisotropicAdp?` | boolean | U-tensor ADPs instead of B_iso. |
| `mustrain?` | isotropic · uniaxial · generalized | Microstrain model. Absent ⇒ isotropic. |
| `overlay?` | `{calc[], background[]}` | Reference curves of a view-only pattern (GSAS-II CSV); one value per point. |
| `source` | string | Provenance of the data (file name or demo marker). |
| `rawInstrument?`, `rawData?` | `{name, text}` | The user's original files, verbatim — shipped in FullProf/GSAS-II bundles. |
| `magnetic?` | `MagneticModel` | The applied magnetic model. Its moment rows/bindings are inside `refinement`. |
| `refinement` | see above | |
| `fitRange?` | `{min, max}` | Refinement window in the pattern's native unit. Absent ⇒ whole pattern. |
| `displayUnit?` | `PowderXUnit` | Display-only axis choice. |
| `manualPeaks?` | number[] | Hand-picked residual peaks (d, Å) from the magnetic page. |

### `"singleCrystal"` — integrated intensities (F²)

| Field | Type | Notes |
| --- | --- | --- |
| `dataset` | `SingleCrystalDataset` | Nuclear reflections `{h, k, l, iObs, sigma?}`, radiation as loaded. |
| `magneticDataset?` | `SingleCrystalDataset` | Companion magnetic set (`_mag` file) for joint co-refinement. |
| `probe` | xray · neutron · neutron-tof | The user's probe choice (a reflection file cannot carry it). The page presents it as **source** (X-ray / neutron) × **mode** (CW / TOF); X-ray is always constant-wavelength, so the three values are X-ray CW, neutron CW, neutron TOF. |
| `refinement` | see above | Nuclear rows **plus** applied moment rows; bindings likewise. |
| `magnetic?` | `MagneticModel` | Model applied from the symmetry analysis. |
| `outlierFilter?` | `{on, cutoffSigma}` | SHELX-style OMIT on \|Fo²−Fc²\|/σ. |
| `modulated?` | `ModulatedHypothesis` | The single-k supercell panel's inputs: `k` (three strings, so "1/4" survives), per-ion `{on, direction, phase}`, starting moment, seed, restarts. |

### `"pdf"` — pair distribution function (real space)

| Field | Type | Notes |
| --- | --- | --- |
| `pattern` | `PdfPattern` | `scatteringType` ∈ neutron · xray; points `{r, gObs, sigma?}`; Qmax/Qdamp/Qbroad/rpoly… from the header. |
| `refinement` | see above | Includes mode-amplitude rows (irreps) and moment rows (mPDF) when in use. |
| `fitRange` | `{min, max}` | The r window the model is computed and fitted in (Å). Required. |
| `positionMode` | atomic · irreps | Per-coordinate shifts vs. symmetry-adapted mode amplitudes. |
| `distortionModes?` | `{set: DistortionModeSet, parentName, fromActivation?}` | The parameterization built from a parent CIF or a subgroup activation — stored whole, since it cannot be regenerated from the child structure alone. |
| `spinModel?` | `{magnetic, parameters, bindings}` | The spin model handed over from the magnetic page (mPDF). Refined moment values are the ones in `refinement.parameters`. |
| `boxcar?` | `{plan, lastRun?}` | Sliding-window plan (width, step, direction, restarts) and, if run, the whole scan (`BoxcarRun`). |

## Design rules

- **Plain JSON, no methods, no typed arrays.** Every referenced type is a
  methods-free data object; `parse(serialize(x))` equals `x` — a test.
- **Self-describing.** Full parameter rows and bindings, the dataset, the
  instrument: a file can be read (and its numbers checked) without the app.
- **References by id.** `structures[0].id` ↔ `magnetic.structureId`;
  `bindings[].parameterId` ↔ `parameters[].id`; moment `siteLabel`s must be
  sites of the primary phase. The validator enforces all three.
- **Strict write, lenient read.** Optional fields are *omitted* when absent
  (never `null`); a reader still accepts `null` as "absent".
- **Timestamps as ISO-8601 strings.**
- **Readable layout.** The serializer indents like `JSON.stringify(_, null, 2)`
  but prints table-like arrays one element per line — a 30 000-point pattern
  is 30 000 lines, not 120 000 — so files diff and scan.

## Loading: the app never trusts a file over the running code

Opening a project does **not** paste saved parameter arrays into the engines.
Each engine rebuilds its parameter spec from structure + data exactly as on a
normal load, then overlays the saved rows **by id** (value, initial value,
fixed/free, esd):

- parameters a newer build added start at their defaults;
- parameters the file names but the build no longer has are dropped;
- the exception is the moment rows an applied magnetic model contributed —
  no spec builder can regenerate them, so they are appended as saved (the
  powder engine holds its rows as state and takes them as saved directly).

The single-crystal and PDF pages read their block **once, at mount** (the shell
remounts them with a fresh key when a project opens) and apply it only while
the structure and dataset are the very objects the file carried, so a later CIF
or data load can never re-stamp saved values onto a different model.

## What is *not* persisted (and why)

| State | Reason |
| --- | --- |
| Posterior (MCMC) samples and the resume token | Analysis output, large, and tied to a request closure; re-run from the saved parameters. |
| The magnetic page's exploration (k-search candidates, chosen group/irreps, amplitude drafts) | Working state of a tool; the **applied model** is the artifact and is saved. |
| The single-crystal modulated-supercell *result* | Deterministic from the saved inputs (seed included); re-run. |
| Live refinement curves, plot tabs, 3D-view choices | Transient. |

Each of these has a natural home if it is ever wanted: an optional field in
the owning technique block (see the checklist below).

## Versioning & migration

- `schemaVersion` is an integer, currently **2** (`PROJECT_SCHEMA_VERSION`).
- On load the reader compares the file's version with the build's:
  - equal → validate and load;
  - older → run the migration chain in `migrate.ts` up to the current version,
    **then** validate like any current file (a migration cannot smuggle in a
    malformed document);
  - newer → refuse with a clear message rather than misread.
- Any breaking change to a persisted type **must** bump `schemaVersion` and add
  a migration step. Adding an *optional* field does not.

**v1 → v2.** v1 was a flat, technique-blind aggregate
(`structures / magneticModels / datasets / parameters / bindings / lastResult`)
written only by the old powder "Project JSON" export and never read back. It
is lifted into a `workspace` by inspecting `datasets[0]`: powder points → a
powder block, reflections → a single-crystal block. v1 recorded no instrument,
profile, background basis or fit window, so those take defaults (the profile is
inferred from the parameter kinds where possible) and the migrated file's
`metadata.notes` says so.

## Extending the format

**Adding a field to a technique** (no version bump when optional):

1. Add it to that technique's workspace interface in `core/project/types.ts`.
2. Validate it in the technique's branch of `core/project/validate.ts`.
3. Capture it in the engine's `…WorkspaceFrom` and restore it in the engine's
   initializer (`src/app/projectIo.ts`, the workbench).
4. Add a line to the fixture and a round-trip assertion.

**Adding a technique:**

1. Add the tag to `Technique` / `TECHNIQUES` and a new member to `Workspace`
   (`core/project/types.ts`). The compile-time guard in `project.test.ts` fails
   until both agree.
2. Add its validator branch, including the foreign-data refusal for its dataset.
3. Add a fixture, a capture/restore pair in `projectIo.ts`, a `projectWorkspace`
   snapshot in the engine, and a `case` in the shell's `openProjectText`.

## Reproducibility

The file records the writing `appVersion`. Because the scientific core is pure
and deterministic, reopening a project and re-running the refinement from the
saved parameters yields the same numbers — a precondition for the validation
strategy in [VALIDATION.md](./VALIDATION.md).
