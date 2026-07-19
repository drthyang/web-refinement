# Feature & Performance Comparison: GSAS-II · Jana2020 · FullProf

A factual capability comparison of the three mature refinement packages, and an
honest assessment of where this browser-native workbench currently stands
against them. Cells are **Yes / Partial / No** with a short qualifier; **unclear**
means it could not be confirmed from primary documentation.

> Sources: Toby & Von Dreele 2013 *J. Appl. Cryst.* 46, 544 (GSAS-II); GSAS-II
> docs (gsas-ii.readthedocs.io) & k-SUBGROUPSMAG paper (PMC11457102);
> Jana2020 (jana.fzu.cz), Petříček et al. 2023 *Z. Kristallogr.* & "Analysis of
> magnetic structures in JANA2020" (PMC11457105); Rodríguez-Carvajal 1993
> *Physica B* 192, 55 (FullProf), ILL FullProf pages & "Magnetic structure
> determination and refinement using FullProf" 2025 (PMC12147938).

## 1. Capability matrix

### Data types
| Feature | GSAS-II | Jana2020 | FullProf |
| --- | --- | --- | --- |
| X-ray powder | Yes | Yes | Yes |
| CW neutron | Yes | Yes | Yes (core) |
| TOF neutron | Yes (full profiles) | Yes (imports) | Yes (profiles) |
| Single crystal | Yes | Yes (strong) | Yes (neutron focus) |
| Electron diffraction | No/unclear | **Yes (dynamical, unique)** | No |
| Total scattering / PDF | Yes (built-in) | No | No |

### Profile & corrections
| Feature | GSAS-II | Jana2020 | FullProf |
| --- | --- | --- | --- |
| Gaussian / Lorentzian / pseudo-Voigt | Yes | Yes | Yes |
| Thompson-Cox-Hastings pV | Yes | Partial (equivalent) | Yes |
| TOF profiles (α/β + σ) | Yes | Yes | Yes |
| Background (Chebyshev / Fourier / manual) | Yes (all) | Yes (poly + manual) | Yes (poly + Fourier + interp) |
| Absorption / extinction | Yes / Yes | Yes / Yes | Yes / Yes |
| Preferred orientation (March-Dollase) | Yes | Yes | Yes (multi-axial) |
| Preferred orientation (spherical harmonics) | Yes | Yes | Yes |

### Symmetry
| Feature | GSAS-II | Jana2020 | FullProf |
| --- | --- | --- | --- |
| All 230 space groups | Yes | Yes | Yes |
| Magnetic (Shubnikov/BNS) | Yes (1421 BNS) | Yes (1651, BNS+OG) | Yes (BNS/OG/UNI) |
| Superspace (3+d) incommensurate | Partial (3+1 nuclear) | **Yes (reference impl.)** | Yes (via k-vectors) |
| Wyckoff / absences / symmetry constraints | Yes | Yes | Yes |

### Refinement engine
| Feature | GSAS-II | Jana2020 | FullProf |
| --- | --- | --- | --- |
| Least-squares | Full-Hessian LM (+SVD) | Gauss-Newton LS | Marquardt LS |
| Rigid bodies / restraints | Yes / Yes | Yes / Yes | Yes / Yes |
| Multi-phase | Yes | Yes | Yes |
| Multi-histogram / joint | Yes | Yes | Yes |
| Sequential / parametric | Yes (signature) | Partial (cyclic) | Partial |
| Simulated annealing (solution) | Yes | via Superflip | Yes |
| Error / covariance | Yes | Yes | Yes |

### Intensity extraction & magnetism
| Feature | GSAS-II | Jana2020 | FullProf |
| --- | --- | --- | --- |
| Le Bail | Yes | Yes | Yes (profile matching) |
| Pawley | Yes | unclear | unclear |
| Representation analysis | via Bilbao/ISODISTORT | Yes (built-in) | **Yes (BasIreps)** |
| Commensurate k | Yes | Yes | Yes |
| Incommensurate k (helical/conical/SDW) | No | Yes | **Yes** |
| Magnetic form factors / mCIF | Yes / Yes | Yes / Yes | Yes / Yes |

### Practical
| Feature | GSAS-II | Jana2020 | FullProf |
| --- | --- | --- | --- |
| Scripting API | **Yes (Python: GSASIIscriptable)** | Partial (silent mode) | Partial (CrysFML/pyCrysFML) |
| Platforms | Win/Mac/Linux | Windows (Wine elsewhere) | Win/Mac/Linux |
| Web / browser | No | No | No |
| GUI | Full (wxPython) | Full (OpenGL) | WinPLOTR/EdPCR/Studio |

## 2. Strengths & niche

- **GSAS-II** — modern Python-native all-rounder; best at automated
  multi-dataset Rietveld (sequential/parametric via a scripting API), combined
  X-ray+neutron, and total scattering/PDF. Commensurate magnetism via Bilbao;
  no incommensurate magnetic.
- **Jana2020** — the reference for aperiodic/(3+d) superspace, incommensurate
  and composite structures, incommensurate magnetic superspace, and dynamical
  electron-diffraction refinement.
- **FullProf** — the community standard for magnetic structures from neutron
  powder data: BasIreps representation analysis + k-vector formalism for
  commensurate/incommensurate/helical/conical order, plus Shubnikov/mCIF.

None of the three has a browser build — that is the niche this project targets.

## 3. Where this workbench stands

This is an early **browser-native** workbench. It does not compete on breadth,
but it implements a correct, tested core of the shared fundamentals — and a few
workflows the mature tools split across several programs (magnetic candidate
generation + comparison; the symmetry-mode distortion workflow) as single
in-app flows.

| Area | This app | Mature packages still add |
| --- | --- | --- |
| Data types | CW + **TOF** X-ray/neutron powder; single-crystal F² (`.hkl`/`.fcf`/`.int`); **PDF** `G(r)` (`.gr`/`.sq`/`.fq`) | electron diffraction |
| Profile | Gaussian / pseudo-Voigt / **TCH** + FCJ asymmetry; TOF back-to-back exponential; Chebyshev / Fourier / power backgrounds; March-Dollase PO; displacement / transparency / absorption / roughness corrections; Stephens microstrain, uniaxial size | spherical-harmonic texture, Ikeda–Carpenter TOF shape |
| Symmetry | **all 230 built-in tables** + CIF/mCIF operations; Wyckoff/site constraints; absences; magnetic subgroup enumeration with **BNS/OG labels**; isotropy + t-subgroup (Bärnighausen) lattices | superspace (3+d), full 1651 magnetic tables incl. type IV |
| Engine | Levenberg-Marquardt (SVD, esds, correlations), bounds/ties/restraints, staged controller, **multi-start**, worker pool, opt-in WebGPU | full-Hessian options, rigid bodies, restraint libraries |
| Multi-phase / multi-dataset | Yes (powder 2-phase; PDF multi-phase + multi-dataset co-refinement; sequential Rietveld + PDF) | larger joint-histogram breadth |
| Intensity extraction | **Le Bail** | + Pawley |
| Magnetism | mCIF in/out, single-crystal + powder moment refinement, k = 0 **and** k ≠ 0 commensurate, k-search, subgroup candidates + comparison | representation analysis (built-in), incommensurate/helical |
| Validation | GSAS-II golden values + real-data benchmarks; PDFfit2/PDFgui and diffpy.mpdf goldens | decades of community validation |
| Platform / API | **Static web app, no install**; **32 MCP agent tools** | desktop; Python scripting ecosystems |

**Honest gaps** (the road to maturity): incommensurate / multi-k and
helical/conical magnetism; built-in representation analysis for the magnetic
workflow; spherical-harmonic texture; powder extinction and anomalous
dispersion; twinning and absolute structure (single crystal); rigid bodies and
a restraints library; Pawley extraction. These are laid out in
[ROADMAP.md](./ROADMAP.md) and [LIMITATIONS.md](./LIMITATIONS.md).

## 4. Performance notes

The mature tools are compiled (Fortran/C cores; GSAS-II wraps C/Fortran under
NumPy/SciPy) with full-matrix solvers; their scaling story is automation and
multi-dataset throughput rather than single-fit speed, and none publishes
formal benchmarks. This app runs Levenberg-Marquardt in Web Workers in pure
TypeScript, with reflection-windowed evaluation, dependency caching, a
parallel-Jacobian worker pool (bit-identical to the serial driver), analytic
columns for a validated subset of parameters, and opt-in WebGPU f32 kernels for
the structure-factor sums — adequate for the pattern sizes shown here;
WebAssembly is deliberately skipped (see
[ARCHITECTURE.md](./ARCHITECTURE.md)).
