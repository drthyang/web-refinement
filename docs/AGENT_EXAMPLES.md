# Agent examples

Worked examples of a language model driving the MATERIA tools over MCP. Each
gives the prompt, the calls the model made, and what it concluded.

The runs are real: Claude (Opus 5.5) in Claude Code, on 2026-09-28, calling
the `materia` server. A test replays each tool sequence through an MCP client
and checks the outcomes stated here
([`examples.test.ts`](../src/mcp/examples.test.ts)), so this page cannot drift
from the tools.

## Setup

- **Claude Code.** Open the repository. Claude Code starts `materia` from
  [`.mcp.json`](../.mcp.json) and asks once before it does. The data paths below
  are relative to the repository.
- **Claude Desktop or another client.** Register the server as in
  [AGENT_TOOLS.md](./AGENT_TOOLS.md#run-the-mcp-server), with `MATERIA_ROOTS` set
  to the repository.
- **Data.** [`examples/mcp/`](../examples/mcp) holds the app's bundled demo data
  as plain files, so a model can load them by `path`.

How data travels between calls — refs such as `{"ref": "#7/structure"}`,
`path`, `free` — is in
[AGENT_TOOLS.md](./AGENT_TOOLS.md#how-data-travels).

## Example 1 — look at a structure before any data

**Prompt**

> Using the MATERIA tools, load `examples/mcp/mn3ga.cif`. What are its space
> group and Wyckoff sites? Which reflections would a Cu Kα pattern show first?
> Does any interatomic distance look unphysical?

**What the model did** — four calls, each passing the structure as a ref.

| # | Tool | Arguments | What came back |
|---|---|---|---|
| 1 | `parse_structure` | `path` | P 6₃/m m c, a = 5.422 Å, c = 4.376 Å; sites Mn1, Ga1 |
| 2 | `analyze_site_symmetry` | the structure | Mn1 on 6h (mm2, one free coordinate); Ga1 on 2d (−6m2, none) |
| 3 | `reflection_list` | d ≥ 1.5 Å, λ = 1.5406 Å | 100 at 18.9°, 101 at 27.8°, 2-10 at 33.0°, 200 at 38.3°, 002 at 41.2° |
| 4 | `bond_geometry` | cutoff 3.2 Å | shortest Mn1–Mn1 2.665 Å; Mn–Ga 2.705–2.712 Å |

**What it concluded.** Nothing is unphysical: 2.665 Å is a normal metallic
Mn–Mn contact. Ga's site fixes all its coordinates, so only one Mn coordinate
can refine. The first line a Cu Kα pattern shows is 100 at 18.9° 2θ.

**Checked by the test:** the Wyckoff labels, the first four reflections, and the
shortest contact.

## Example 4 — a PDF fit block by block, then local vs average

**Prompt**

> Fit the GaTa₄Se₈ X-ray PDF (`examples/mcp/gata4se8_299k.gr`, structure
> `examples/mcp/gata4se8.cif`) over 1.5–28 Å. Free the parameters in blocks and
> tell me what each block buys. Then tell me whether the local structure differs
> from the average.

**What the model did.** It built the model (`build_pdf_model` reported no
missing ADPs) and refined in blocks with `refine_pdf`, passing the previous
call's `parameters` ref each time and choosing what refines with `free`.

| Block | Freed | Rw |
|---|---|---|
| 1 | scale, cell | 35.3 % |
| 2 | + anisotropic ADPs (`U_*`) | 19.3 % |
| 3 | + Qdamp, Qbroad | 12.2 % |
| 4 | + δ1 (Qbroad fixed again) | 8.61 % |
| 5 | + positions | 8.33 % |

Three judgement calls, each stated in the run:

- **Qdamp freed.** It is an instrument constant, best calibrated on a standard,
  but none ships with these data. It moved from 0.030 to 0.044.
- **Qbroad dropped.** It stayed at its bound (0) and the solver removed a
  near-null direction, so the data do not support it.
- **δ1, not δ2.** One correlated-motion law at a time: δ1 = 1.78 took Rw from
  12.2 % to 8.6 %.

The final 8.33 % sits beside the bundled demo's 8.12 %. Freeing all the blocks
at once lands on the same minimum here; the blocks show what each part of the
model buys.

For local versus average, it ran `refine_pdf_boxcar`: 6 Å boxes stepped by
3 Å, tracking the scale, the cell and the Ta and Se ADPs, with Qdamp held.

| Box center (Å) | 4.5 | 7.5 | 10.5 | 13.5 | 16.5 | 19.5 | 22.5 |
|---|---|---|---|---|---|---|---|
| Box Rw (%) | 11.0 | 5.1 | 5.6 | 3.7 | 3.6 | 4.2 | 3.4 |
| U(Se2) (Å²) | 0.0088 | 0.0118 | 0.0117 | 0.0118 | 0.0129 | 0.0135 | 0.0154 |
| a (Å) | 10.3676 | 10.3675 | 10.3673 | 10.3690 | 10.3698 | 10.3684 | 10.3678 |

As the tool advises, it scanned again from high r to low r. The two tracks
agree well inside their esds, so the drift is in the data, not in where the
fit started.

**What it concluded.** The average cubic model fits well, but the short-range
structure is not that average. The lowest box fits worst, and U(Se2) nearly
doubles from low r to high r while the cell stays flat to 0.02 %. The
whole-range fit absorbs a local distortion into larger ADPs. Naming the
distortion needs a lower-symmetry local model, such as the symmetry-mode tools
(`build_symmetry_modes`, `build_distortion_modes`).

**Checked by the test:** the final Rw below 8.5 %, the refined Qdamp and δ1,
the lowest box fitting worst, U(Se2) growing with r, and the flat cell. With
`MCP_EXAMPLES_FULL=1` it also checks each block's Rw and the reverse scan.

## Running the checks

```bash
npx vitest run src/mcp/examples.test.ts
```

The slow parts (each block, the reverse scan):

```bash
MCP_EXAMPLES_FULL=1 npx vitest run src/mcp/examples.test.ts
```

The files in `examples/mcp/` are written from the app's bundled sources; the
same test fails if they drift. Rewrite them with:

```bash
UPDATE_MCP_EXAMPLES=1 npx vitest run src/mcp/examples.test.ts
```
