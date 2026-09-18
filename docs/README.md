# Documentation index

Every document in this folder, grouped by what you are trying to do. New to the
workbench? Start with the [user guide](./USER_GUIDE.md), and read
[LIMITATIONS.md](./LIMITATIONS.md) before you rely on a result.

## Using the workbench

| Document | Read it to learn |
| --- | --- |
| [USER_GUIDE.md](./USER_GUIDE.md) | How to run a refinement in the app, task by task: powder, magnetic, single crystal, PDF |
| [LIMITATIONS.md](./LIMITATIONS.md) | What is supported, what is approximate, what is missing, and the known issues |
| [COMPARISON.md](./COMPARISON.md) | How the workbench compares with GSAS-II, Jana2020 and FullProf |
| [PROJECT_FORMAT.md](./PROJECT_FORMAT.md) | How a session is saved and reopened (`.materia.json`) |

## The science and methods

| Document | Read it to learn |
| --- | --- |
| [REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md) | The least-squares engine: Levenberg–Marquardt, esds, posterior sampling, sequential refinement |
| [MAGNETIC_SYMMETRY.md](./MAGNETIC_SYMMETRY.md) | Magnetic space groups and representation analysis — the two routes to allowed moments |
| [SINGLE_CRYSTAL.md](./SINGLE_CRYSTAL.md) | Single-crystal F² refinement, the magnetic-supercell merge, and absorption correction |
| [MICROSTRUCTURE.md](./MICROSTRUCTURE.md) | Crystallite size and microstrain from powder peak broadening |
| [SCATTERING_TABLES.md](./SCATTERING_TABLES.md) | Neutron, X-ray and magnetic form-factor tables: coverage and sources |
| [REFINEMENT_NOTES.md](./REFINEMENT_NOTES.md) | Methods notes on magnetic refinement stability, written as the basis for a methods section |
| [REFERENCES.md](./REFERENCES.md) | The bibliography, including the software this project validates against |
| [`../knowledge/`](../knowledge/) | Domain notes on refinement practice that the engine and the agent tools follow |

## Validation

| Document | Read it to learn |
| --- | --- |
| [VALIDATION.md](./VALIDATION.md) | What is tested, and which results are checked against external tools |

## Working on the code

| Document | Read it to learn |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The layers, the source tree, and the rules the code follows |
| [DATA_MODEL.md](./DATA_MODEL.md) | The core data types, their units and conventions |
| [AGENT_TOOLS.md](./AGENT_TOOLS.md) | The MCP agent tools, skills, and the LLM-guided refinement design |

## Plans

| Document | Status |
| --- | --- |
| [ROADMAP.md](./ROADMAP.md) | The authoritative roadmap for the whole project |
| [PDF_MPDF_ROADMAP.md](./PDF_MPDF_ROADMAP.md) | The real-space PDF and magnetic PDF track |
| [PLAN_SUBGROUPS_AND_INCOMMENSURATE.md](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md) | Planned next: PDF subgroups and supercells; incommensurate magnetic studies |

## Archive

Kept for their detail; each names the document that replaced it.

| Document | What it was |
| --- | --- |
| [archive/REPORT.md](./archive/REPORT.md) | The first build-and-validation report, from July 2026 |
| [archive/IMPROVEMENT_PLAN.md](./archive/IMPROVEMENT_PLAN.md) | The finished plan for magnetic refinement stability and single-crystal co-refinement |
| [archive/REFINEMENT_PROCEDURE.md](./archive/REFINEMENT_PROCEDURE.md) | The seven-step procedure with its code mapping, replaced by the user guide |
| [archive/POWDER_ROADMAP.md](./archive/POWDER_ROADMAP.md) | The powder roadmap, merged into ROADMAP.md |
| [archive/MATURITY_PLAN.md](./archive/MATURITY_PLAN.md) | The maturity plan, merged into ROADMAP.md |

## Keeping these docs readable

- Describe the current state. When something lands, edit the existing text: move
  the item from **Next** to **Done**, or from **Not yet** to **Supported**.
  Don't append dated status notes; git keeps the history.
- Give each fact one home: capabilities and limits in LIMITATIONS, evidence in
  VALIDATION, the order of future work in the roadmaps, UI steps in the user
  guide. Other documents link to it.
- Keep counts that change (tests, tools) out of the docs.
- Keep section numbers that code comments cite, such as `PDF_MPDF_ROADMAP §8`
  and `roadmap F1.1`.
- The tool tables in AGENT_TOOLS.md are generated: edit `src/mcp/registry.ts`,
  then run `npm run gen:tooldoc`.
