# Agent examples

Worked examples of a language model driving the MATERIA tools over MCP. Each
gives the prompt, the calls the model made, and what it concluded.

The runs are real: Claude (Opus 5.5) in Claude Code, calling the `materia`
server. Examples 1 and 4 ran on 2026-09-28, Example 3 on 2026-10-05. A test replays each tool sequence through an MCP client
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

## Example 3 — a magnetic structure from the peaks the nuclear model leaves

**Prompt**

> Using the MATERIA tools, fit the 30 K neutron pattern
> `examples/mcp/mn3ga_30k_sim.xye` (instrument `examples/mcp/mn3ga_30k.instprm`)
> with the nuclear structure `examples/mcp/mn3ga_30k_nuclear.cif`. If the
> nuclear model leaves intensity unexplained, find the magnetic order: the
> propagation vector, the magnetic space group and the Mn moments.

The pattern is simulated from the app's bundled Mn₃Ga 30 K magnetic structure,
so the true moments are known. The model is not given them.

**What the model did** — 18 calls. Bulky results travel as refs; the group
fits pass the nuclear and moment parameter sets as a list of two refs.

| # | Tool | Arguments | What came back |
|---|---|---|---|
| 1–3 | `parse_structure`, `parse_powder_data`, `parse_instrument` | `path` | P2₁/m with sites Mn1_0, Mn2_1, Mn3_2, Ga1; 6,251 points; neutron, λ = 1.54 Å |
| 4 | `build_refinement` | structure, pattern, instrument | 31 symmetry-allowed parameters |
| 5 | `refine_powder` | free: scale, background, cell, U V W | wR 12.4 %, GoF 2.89 |
| 6 | `assess_refinement` | the step 5 result | "fair"; three unexplained peaks |
| 7 | `find_unexplained_peaks` | the residual | d = 3.167, 2.710, 4.632 Å |
| 8 | `search_propagation_vector` | those d values | k = (0 0 0) matches all three, rmsd 0.0016 Å |
| 9 | `list_magnetic_subgroups` | k = (0 0 0) | four maximal groups (index 2) and seven lower ones |
| 10–17 | `build_magnetic_model`, `refine_magnetic_powder` | each maximal group, all three Mn sites; free: scale, background, moments; 12 restarts | the table below |
| 18 | `refine_magnetic_powder` | the best group; free: scale, background, cell, U V W, positions, B, moments | wR 4.35 %, GoF 1.01 |

Each maximal group allows different moment directions, and the data separate
them:

| Magnetic group | Moments allowed | wR | GoF |
|---|---|---|---|
| P2₁/m | along b | 9.30 % | 2.16 |
| P2₁'/m | along b | 12.10 % | 2.81 |
| P2₁/m' | in the ac plane | 11.79 % | 2.74 |
| P2₁'/m' | in the ac plane | 4.61 % | 1.07 |

Four judgement calls, each stated in the run:

- **Atoms held in the nuclear fit.** At k = 0 the magnetic peaks sit on nuclear
  reflections. Free positions would absorb that intensity and hide it.
- **The simplest k.** Three other vectors, such as (½ 0 ⅓), also match all
  three peaks, but with larger misfits. k = 0 needs no supercell.
- **Every maximal group fitted.** The model fits all four instead of guessing
  one, and only P2₁'/m' reaches GoF ≈ 1.
- **Restarts.** Magnetic intensity is quadratic in the moments, so the fit has
  several minima. Without restarts, P2₁'/m' stops at wR 4.86 %, GoF 1.13. That
  looks acceptable, but Mn1 is nearly switched off (−0.57, −0.02 μB). Only
  one of the 13 starts found the lower minimum.

**What it concluded.** The order is k = 0 in P2₁'/m', with moments in the ac
plane on all three Mn sites. With the atoms freed in step 18, every position
shift stays below 0.0003, about one esd, so the magnetic order needs no
distortion. The recovered moments match the ones the pattern was simulated
from to within 0.06 μB. Diffraction cannot fix the global sign, so the found
moments are shown with it flipped:

| Site | Found (mₐ, m꜀) μB | Simulated from (mₐ, m꜀) μB |
|---|---|---|
| Mn1_0 | −1.63 ± 0.03, −1.33 ± 0.03 | −1.58, −1.35 |
| Mn2_1 | −2.78 ± 0.03, 2.79 ± 0.03 | −2.78, 2.82 |
| Mn3_2 | 2.72 ± 0.03, −2.21 ± 0.03 | 2.72, −2.22 |

**Checked by the test:** the nuclear wR, the first unexplained peak, k = 0,
the four maximal groups, P2₁'/m' alone below 4.7 % with the others above 9 %,
the single run stopping higher, and the final GoF, positions and moments.

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
