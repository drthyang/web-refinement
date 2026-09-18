# User guide

This guide shows you how to run a refinement in MATERIA Workbench, one task at
a time. It names each control as the app labels it; some labels appear in
capitals on screen. The science docs are linked where you need them. What the
app does not do is in [LIMITATIONS.md](./LIMITATIONS.md).

## 1. Before you start

- **Nothing to install.** The workbench is a static web page. It runs in a
  modern browser on any operating system.
- **Your data stay on your machine.** The browser reads your files locally and
  uploads nothing.
- **Public beta.** Read the [scope statement](./LIMITATIONS.md#scope-statement)
  and [cross-check](#cross-check-before-you-publish) what you publish.

## 2. Open the app and try a demo

Open [drthyang.github.io/web-refinement](https://drthyang.github.io/web-refinement/).
The start page shows the **Structure**, **Data** and **Instrument** cards above
**Start with a demo**.

1. Click a demo card, or pick a demo from **Demos ▾** in the header.
2. The demo opens on a converged refinement. Change anything you like.
3. To leave, open **Demo ✓ ▾** and click **Exit demo**.

- **Rietveld · Mn₃Ga neutron TOF**: a two-phase fit of POWGEN time-of-flight
  data, Mn₃Ga with a MnO impurity. At 600 K the sample is paramagnetic.
- **PDF · GaTa₄Se₈ X-ray G(r)**: a real-space fit of synchrotron
  total-scattering data at 299 K, with the cubic average structure.
- A third, magnetic demo (AWO₄) appears only in a local development build that
  has the git-ignored data folder. Its data are unpublished.

| Header control | What it does |
| --- | --- |
| **Powder** · **Crystal**, **Rietveld** · **PDF** | Indicators: the sample form and the technique of the loaded data |
| **Nuclear** · **Magnetic** | Switch between the refinement page and the magnetic page |
| **Project ▾** | **Save project** and **Open project…** |
| **Export ▾** | The report and the files for the active technique |

The data you load pick the page. A reflection list opens the single-crystal
page, a G(r) file the PDF page, and any other pattern the powder page.

## 3. Files you can load

| Kind | Formats | Load with |
| --- | --- | --- |
| Structure | CIF, or mCIF for a magnetic structure | **Load CIF…** on the **Structure** card |
| Powder pattern | Columns x, y and optional σ (`.xye`, `.xy`, `.dat`, `.txt`, `.csv`); GSAS histograms (`.gsa`, `.gss`, `.fxye`); ILL D1B/D20 numor files; FullProf `INSTRM=6` files | **Load data…** on the **Data** card |
| Powder, view only | A GSAS-II CSV export, drawn with GSAS-II's own fit | **Load data…** |
| Instrument | GSAS-II `.instprm`, GSAS `.prm`, FullProf `.irf` | **Load instrument…** on the **Instrument** card |
| Single-crystal reflections | SHELX `.hkl` (h k l F² σ); FullProf `.int`; a GSAS-II reflection list, filtered to the loaded cell | **Load data…** |
| Magnetic satellites | A second `.int` or `.hkl`, indexed as the fundamental hkl of hkl ± k | **Load magnetic .int…** |
| Pair distribution function | `.gr`; `.sq` and `.fq`, transformed to G(r) on load; PDFgui `.fgr` fit files | **Load data…** |
| Project | `.materia.json` | **Project ▾** → **Open project…** |

**Check `.hkl` reflections after loading.** The page reads them as
whitespace-separated columns, so in a SHELX HKLF 4 file an intensity of
10000.00 or more runs into the l index. FullProf `.int` files load correctly
([known issues](./LIMITATIONS.md#single-crystal)).

For a powder pattern, the app reads the x unit from the format, the column
header, the loaded instrument or, last, the data range. The **Data** card shows
the unit and range it read, and beside **unit** says which of those decided it —
**from the file header**, **from the instrument file**, **from the file name**,
**guessed from the value range** or **set by you**. A guess is shown in the
warning colour, because nothing in the file stated the unit. Pick another unit
from that menu to read the same file as that abscissa: the unit sets the
radiation, the peak shape and the whole parameter set, so the file is re-read and
parameter edits are lost. A G(r) file is read as neutron or X-ray from its
header, and as X-ray when it says neither.

### Load in this order

1. **Load CIF…** first. On the powder page it replaces the pattern with a
   synthetic one, so data loaded earlier are lost.
2. **Load instrument…**, for powder data. The x unit then comes from the
   instrument rather than the data range.
3. **Load data…**.
4. **Add CIF…** for each extra phase. Loading a pattern removes extra phases.

After you load your own CIF, **Clear** on the **Structure** card empties the
workbench and returns to the start page.

## 4. Powder (Rietveld) refinement

A refinement follows seven steps. This section covers steps 1–4, and
[Magnetic structures](#5-magnetic-structures) covers steps 5–7.

| Step | Task | Where |
| --- | --- | --- |
| 1 | Load the structure | **Structure** card |
| 2 | Load the instrument and the data | **Instrument** and **Data** cards |
| 3 | Refine the atomic structure, one parameter group at a time | Parameter panel |
| 4 | Judge the fit and check the structure | **Validation** and **3D Model** views |
| 5 | Find the allowed magnetic space groups | **Magnetic** page, steps 1–4 |
| 6 | Refine the moments with the structure | **Magnetic** page step 5, then **Refine** |
| 7 | Compare the candidate groups against the data | **Rank … candidates against the data** |

### Refine the atomic structure

Check the **Instrument** card first: it shows the beamline when known, and the
wavelength or difC. Time-of-flight data need a TOF instrument file with difC;
without one, the pattern is view-only. On load, only the scale, the background
and the cell are free, so the first **Refine** is safe.

1. Click **Refine**. The curve updates as the fit runs, and **Cancel** stops it.
2. Free the next parameter group and click **Refine** again. Use this order:
   **Instrument / profile**, **ADPs (thermal)**, **Positions**, **Occupancy**,
   **Microstructure**, **Corrections**.
3. [Judge the fit](#8-judge-a-fit) before you free more. Free occupancies only
   for a reason: they correlate with the scale and the ADPs.

In the parameter panel, click a row to switch it between **● free** and
**○ fixed**. Type a value and press Enter to set it. Tick **all** to free a
whole group. A **= tied** row follows another parameter, and a **calib** row
holds the instrument calibration. **Reset** restores every starting value.

Open a group for its model controls:

- **Background**: the **function** (such as **Chebyshev**) and its **terms**.
- **ADPs (thermal)**: **anisotropic (U tensor)**, once an isotropic fit
  converges.
- **Microstructure**: set **model** to **isotropic**, **uniaxial** (2θ data
  only) or **generalized** ([MICROSTRUCTURE.md](./MICROSTRUCTURE.md)).
- **Shared site**, under the plot when atoms share a site: **tie position**,
  **tie ADP** and **Σ occ = 1**.

### When the fit is stuck

The engine is local and needs a reasonable start
([REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md)). The button on the left of
**Refine** keeps the best of several starts. It reads **Prefit ↻** before a
refinement result exists: a Le Bail cell pre-fit, then broad restarts. Once a fit
exists it reads **Escape min ↻**: a few restarts around the fit, for when
**Refine** has stalled.

### Fit window, axis and phases

- Drag the blue handles on the plot to set the fit window. **Reset range**
  returns to the whole pattern, and **optimize view** zooms onto the window.
- Drag across the plot to zoom, and double-click to zoom out. Click a Bragg
  tick for its (hkl). The unit buttons (**2θ**, **d**, **Q**, **TOF**) change
  the axis only.
- To add a phase, load the data, then click **Add CIF…**. Each phase gets its
  own scale, cell, atoms and tick row; the profile and background are shared.
  Click **×** on a phase badge to remove it.

## 5. Magnetic structures

The magnetic page lists the magnetic space groups a propagation vector k allows,
and refines the symmetry-allowed moments
([MAGNETIC_SYMMETRY.md](./MAGNETIC_SYMMETRY.md)). The steps below are for
powder; [Single crystal and PDF](#single-crystal-and-pdf) lists what differs.

Refine the nuclear structure first, so the residual isolates the magnetic
intensity. Then click **Magnetic analysis →** or the **Magnetic** chip.

### Steps 1 and 2: magnetic ions and k

In **Magnetic ions**, click a site to include or exclude it. In
**Propagation vector k**:

1. Read **Detected residual peaks**. Each peak is numbered #n in the table and
   on the pattern.
2. Choose the peaks for the search with **I/σ ≥**,
   **include peaks at nuclear positions** and each peak's **use** box. To add a
   missed peak, click **+ Add peak from plot**, then the pattern.
3. Click **Search k from … peaks**, then a result row to use its k. A ✓ under
   **Δd→k (mÅ)** marks a peak that the current k explains.
4. Or type k, as fractions such as 1/2 or as decimals, and click **Set k**. The
   search proposes commensurate k only.

A k = 0 order adds intensity on top of the nuclear peaks. Every residual peak
then sits on a nuclear reflection, and a k ≠ 0 search has nothing to use. A
note says so. Keep k = (0 0 0) and go on to **Magnetic space group**;
**Use k = 0** sets it if needed. To search anyway, click
**Include them in the k-search**.

### Steps 3 and 4: framework and group

In **Symmetry framework**, pick **Magnetic space groups**, or
**Representation analysis** to tick irreps and get their isotropy subgroup.

In **Magnetic space group**, the candidates are grouped by index. Work top-down:
only **index 2 — maximal** starts open, because the ordered phase is usually a
maximal subgroup. Each row shows **type I** or **type III**, the BNS/OG symbol
and a **… moment dof** badge. A greyed **moment forbidden** row allows no moment
on your sites. Click a row to preview it. When a candidate's symbol needed a
change of setting, the 3D view's **Cell** control can also show its standard
cell.

#### Rank the candidates against the data

1. Click **Rank … candidates against the data**. It refines the moments of each
   moment-allowing candidate in the open sections, with the nuclear model
   fixed. **all …** ranks the collapsed sections too.
2. The rows sort by fit, with wR, the change from the **nuclear only** fit and
   the moment sizes. Click a ranked row to preview its refined moments.

Ties are expected, because a powder pattern often cannot tell symmetry-distinct
models apart. Candidates within 0.01 % in wR of the best are marked ≈. Among
them, the ★ goes to the maximal subgroup with the fewest moment parameters.

If no candidate beats the nuclear-only fit, a note says so. The pattern may be
paramagnetic, the moments may be too small, or k may be wrong. Check the
residual before you trust any moments.

#### The candidate on the pattern

The **Powder pattern** card draws the nuclear fit plus the selected candidate's
magnetic intensity, which also appears alone as the **magnetic** curve. Tick
rows mark where k allows satellites (**G ± k**), where the group keeps them
(**allowed**) and the unexplained peaks (**residual**). A plausible k puts a
**G ± k** tick under every residual peak. A plausible group keeps those peaks in
the **allowed** row.

### Step 5: Moments — refine & continue

1. Edit the amplitudes (µ_B), or click **Refine moments** to fit them with the
   nuclear model fixed.
2. Tie moments if the physics calls for it. **Same moment on shared site**
   gives co-located ions one moment. **Equal |M|** gives sublattices one size,
   **per element** or across **all sites**; **flip …** makes one antiparallel.
3. Click **Continue in refinement page →**. The moments join the **Magnetic**
   group on the refinement page.
4. Click **Refine** to fit the nuclear and magnetic models together, with one
   shared scale. **Prefit ↻** and **Escape min ↻** then also search the moments.

**Show on refinement pattern** puts the candidate on the refinement page with
its moments held at the amplitudes shown here. It joins the calculated pattern,
so **Refine** fits the nuclear parameters against nuclear plus magnetic and the
wR it reports is the wR you see plotted. It adds no parameter rows, so the
moments themselves do not move: use **Continue in refinement page →** to refine
them. **Prefit ↻** and **Escape min ↻** have no moment subspace to search in that
state, so they go straight to the joint solve. When +k and −k are distinct, each
mode has a cosine and a sine amplitude
([LIMITATIONS.md](./LIMITATIONS.md#magnetic-structures)).

### When the session already holds a model

The powder magnetic page opens on a model that is already applied. That model
comes from an mCIF load, a reopened project, **Show on refinement pattern** or
**Continue in refinement page →**. The page sets k, ticks the ions, opens and
selects the matching candidate, and recovers the amplitudes. If no candidate
matches, no group is selected.

Once moments are in the model, the **Magnetic** chip stays lit on the
refinement page, with a tint and a dot. It marks the fit as nuclear plus
magnetic. On the PDF page the chip is disabled for X-ray data or several phases.

### Single crystal and PDF

The single-crystal and PDF magnetic pages run the same steps, except:

- There is no pattern card and no peak search. Type k.
- **Refine moments** and ranking fit F² (wR2) or G(r) (Rw), without a
  nuclear-only comparison.
- The page does not open on a model the session already holds.
- The single-crystal page has no **Show on refinement pattern**.

The list labels candidates type I or type III. It does not enumerate type-IV
(anti-translation) groups or the star of k, so
[cross-check](#cross-check-before-you-publish) before you publish.

## 6. Single-crystal refinement

The method is in [SINGLE_CRYSTAL.md](./SINGLE_CRYSTAL.md).

1. Click **Load CIF…**, then **Load data…** with the reflection file.
2. On the **Data · single crystal** card, set **source** (**X-ray** or
   **Neutron**) and, for neutrons, **mode** (**CW** or **TOF**). The file
   cannot say, and the choice changes every F_calc.
3. Read R_int, R_sigma and redundancy under
   **Refinement quality — single crystal (F²)**.
4. Click **Refine**. Only the scale and the extinction start free, and the cell
   is fixed input.
5. Click **Refine structure**. It frees every symmetry-allowed position and ADP,
   then refines. Occupancies stay fixed.
6. Use **Prefit ↻** and **Escape min ↻** as on the powder page, without a Le Bail
   stage.

To reject outliers, tick **Reject reflections with |Δ|/σ >** and set a
threshold. The test follows the current model, and the card counts exclusions.

### Magnetic supercell refinement

For a commensurate k, the **Magnetic single-k · supercell refinement** card
merges the nuclear and magnetic files into the magnetic supercell. It then
refines the modulated moments with one shared scale.

1. Click **Load magnetic .int…** and pick the satellite file. A `…_mag.…` file
   loaded with **Load data…** pairs the same way.
2. Enter k, for example 1/4, 0, 1/4.
3. Tick each magnetic ion. Set its direction **m ∥** along a, b and c, and its
   phase **φ/π**.
4. Set **amp₀**, **restarts** and **seed**, then click
   **Refine magnetic supercell ↻**.
5. Read the supercell size, wR, amplitude per site and any
   **Data-limited directions**.

The refined value is the modulation amplitude; a site's moment is
amp·cos(2πk·L + φ). **Download combined .int** writes the merged file for
FullProf. The card leaves the structure and the parameter panel in the parent
cell. For the magnetic space-group route, click the **Magnetic** chip instead.

## 7. PDF and magnetic PDF

Models and caveats are in [PDF_MPDF_ROADMAP.md](./PDF_MPDF_ROADMAP.md). The
workbench fits reduced data; it does not reduce raw intensities.

1. Click **Load CIF…**, then **Load data…** with a `.gr`, `.sq`, `.fq` or `.fgr`
   file. Check the probe and Qmax on the **Data · PDF G(r)** card.
2. Set the fit window with the blue handles. The default window skips the
   lowest r and stops at 30 Å at most. **Reset range** restores it.
3. Click **Refine**. Only **PDF scale** and the cell start free.
4. Free more groups as needed: **ADPs (thermal)**, **Correlated motion**,
   **Positions**, **Particle shape**.

- Keep **Instrument** (Qdamp, Qbroad) fixed at values calibrated on a standard.
- In **Correlated motion**, refine δ1/δ2 or sratio/rcut, never both.
- A CIF without ADPs loads every site with B_iso = 0, which ruins a PDF fit.
  The page warns you; set B_iso before you refine.
- **partials** overlays the element-pair partial PDFs. With extra phases from
  **Add CIF…**, **phases** overlays each phase instead.

### Symmetry modes and subgroups

- Under **Parameterization**, switch **Constrained atomic** to
  **Irreps (modes)**. The mode amplitudes come from the structure's own space
  group and start at 0.
- In the **3D Model** view, **Load parent CIF…** decomposes the structure
  against a high-symmetry parent. Click a **Distortion modes** row to draw the
  mode as green arrows; **✕ clear** returns to coordinates.
- **Potential Γ modes · subgroup tree**, in the same view, lists the
  symmetry-breaking irreps. **Activate → …** lowers to that isotropy subgroup
  and frees the mode with a small starting amplitude.
- The **Subgroups** view lists the translationengleiche subgroups.
  **Activate ↓** lowers to one and loads its modes, fixed at 0, into
  **Positions**. A polar mode needs **Prefit ↻** to leave zero.

These tools need a single phase, and offer cell-preserving (Γ) modes only
([LIMITATIONS.md](./LIMITATIONS.md#real-space-pdf-and-magnetic-pdf)).

### Boxcar scan

A boxcar scan refines the model inside a fixed-width r-window slid across G(r).
A parameter that drifts with the box centre shows a local structure that
differs from the average one.

1. Refine the whole window, and free the parameters you want to track.
2. In the **Boxcar** view, set **box** and **step** in Å. Pick
   **low → high r**, **high → low r** or **both**, and optionally
   **random restarts**.
3. Click **Run boxcar scan**. **Cancel** keeps the boxes already fitted.
4. Click a parameter chip to plot it against the box centre, above an Rw strip.
5. **Adopt** loads one box's values into the panel. **Export CSV** saves the
   scan.

The scan itself changes neither the fit window nor the parameters. With
**both**, **The two directions agree** means the drift is in the data.

### Magnetic PDF

1. Refine the nuclear PDF; a magnetic PDF needs neutron data and one phase.
   Click **Magnetic PDF →** or the **Magnetic** chip.
2. Follow [Magnetic structures](#5-magnetic-structures), typing k by hand. Use
   a commensurate k: an incommensurate one is accepted but gives a wrong
   magnetic G(r) ([known issues](./LIMITATIONS.md#real-space-pdf-and-magnetic-pdf)).
3. Click **Continue in refinement page →**, then **Refine**. The nuclear and
   magnetic G(r) refine together, and the plot overlays both parts.

In the **mPDF** group, **mPDF ordered scale** is degenerate with the moment
size: free one, never both. **SRO length ξ (Å)** models short-range order, and
0 means long-range order.

## 8. Judge a fit

Never judge a fit by its R value alone. The definitions are in
[REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md).

| Page | Readout | How to read it |
| --- | --- | --- |
| Powder | wR and GoF | GoF = wR / R_exp, after a refinement. Near 1 matches the uncertainties; below 1 is also a warning. |
| Single crystal | R1, wR2, GooF | SHELX-style agreement factors on F² |
| PDF | Rw | A relative measure: a PDF Rw runs higher than a Bragg wR for an equally good fit |

- **F_obs vs F_calc**, in the powder **Validation** view: points should lie on
  the dashed line. Click a point for its (hkl). On powder, click its chip to
  jump to the peak.
- **Normal probability**: a straight line with slope 1 and intercept 0 means
  both the model and the uncertainties are right.
- **Result:**, in the panel footer, gives the status and cycles. A note may
  follow: **SVD dropped** (undetermined combinations, whose esds mean nothing),
  **High correlation:** (consider fixing one) or **At bound:**.
  **Refinement history** lists χ² and wR per cycle.
- **Largest outliers · (Fo²−Fc²)/σ**, on the single-crystal page, lists the
  worst reflections.
- **Bond lengths**, in any 3D model, labels the bonds. **View** with a, b or c
  looks down that axis.

The **Posterior** view samples the free parameters around a converged fit. It
is a prototype ([LIMITATIONS.md](./LIMITATIONS.md#uncertainty-and-posterior-sampling)).
Refine, then click **Sample posterior**. If the banner reads
**Not converged — continue the chain**, click **Continue ↻**. An **esd ratio**
near 1 supports the least-squares esds.

### Cross-check before you publish

| Result | Reproduce it in |
| --- | --- |
| Powder | GSAS-II or FullProf; **Export ▾** writes a bundle for each |
| Single crystal | SHELXL, JANA2020 or FullProf |
| PDF | PDFgui or diffpy-CMI (PDFfit2); diffpy.mpdf for a magnetic PDF |
| Magnetic candidates | Bilbao (MAXMAGN, k-SUBGROUPSMAG), ISODISTORT or SARAh |

## 9. Save and export

**Project ▾** → **Save project** downloads the session as a `.materia.json`
file. **Open project…**, or **… or open a saved project (.materia.json)** on the
start page, reopens it on the page you saved from.

A project keeps the phases, data, parameters, model settings, last result and
applied magnetic model. It does not keep the magnetic page's search state,
posterior samples, the single-crystal supercell result or view choices. See
[PROJECT_FORMAT.md](./PROJECT_FORMAT.md).

| **Export ▾** entry | Powder | Single crystal | PDF | Contents |
| --- | --- | --- | --- | --- |
| **Report** | yes | yes | yes | One self-contained HTML page |
| **CIF** | yes | yes | yes | The refined structure with esds and agreement factors |
| **mCIF** | with moments | — | — | The magnetic structure in its magnetic space group |
| **CSV** | yes | — | yes | The observed, calculated and difference curves |
| **.int** | — | yes | — | The reflections in FullProf format, as a `_nuc` and `_mag` pair when both are loaded |
| **GSAS-II bundle (.zip)** | yes | — | — | CIF, `.instprm`, data, a script that builds the GSAS-II project, and a README |
| **FullProf bundle (.zip)** | yes | — | — | `.pcr`, data and a README |

Both bundles hold your original data and instrument files, unchanged. They
carry the primary phase only.

### CIF or mCIF

- **CIF**: the nuclear structure in its space group, with esds.
- **mCIF** for k = 0: the parent cell in the magnetic subgroup.
- **mCIF** for a commensurate k ≠ 0: the magnetic supercell in its own magnetic
  space group, not a P1 atom list. Its atoms carry no esds. A comment marks a
  type-IV group, whose symbol the app does not tabulate.
- **mCIF** for an incommensurate k: the parent cell with the Fourier amplitudes.
- The single-crystal page has no mCIF export. On the PDF page, **CIF** writes
  an mCIF for a phase with a spin model.
- The powder **CIF** holds the primary phase only. For another phase, show it
  in the **3D Model** view and click that view's **CIF** button.

### The report

**Report** writes one HTML page: the data and model, the fit figure, the atomic
and magnetic structures, every parameter and the refinement details. Its
magnetic section gives k and the magnetic space group, named as on the magnetic
page. It adds a projected figure, the moments with esds and a sublattice table.
It states where the model came from:

- **Refined jointly**: refined with the atomic structure in this session.
- **Included in the model**: applied, but loaded or set on the magnetic page.
- **Candidate under exploration**: nothing is applied, so it shows the
  candidate selected on the magnetic page, until you continue with it. The
  powder, single-crystal and PDF reports all carry it.

## 10. Where to go next

| Document | Read it to learn |
| --- | --- |
| [LIMITATIONS.md](./LIMITATIONS.md) | What is supported, what is approximate, and what is missing |
| [REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md) | The least-squares engine, esds and posterior sampling |
| [MAGNETIC_SYMMETRY.md](./MAGNETIC_SYMMETRY.md) | Magnetic space groups and representation analysis |
| [SINGLE_CRYSTAL.md](./SINGLE_CRYSTAL.md) | F² refinement and the magnetic supercell merge |
| [MICROSTRUCTURE.md](./MICROSTRUCTURE.md) | Crystallite size and microstrain |
| [PDF_MPDF_ROADMAP.md](./PDF_MPDF_ROADMAP.md) | The PDF and magnetic PDF models and their caveats |
| [VALIDATION.md](./VALIDATION.md) | What is tested, and against which programs |
| [COMPARISON.md](./COMPARISON.md) | How the workbench compares with GSAS-II, Jana2020 and FullProf |
| [AGENT_TOOLS.md](./AGENT_TOOLS.md) | How an AI agent drives the same engine |
