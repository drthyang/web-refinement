# Magnetic Structure and Magnetic Symmetry Knowledge Base

Purpose: provide implementation guidance for a coding agent building magnetic structure refinement, and for judging whether a magnetic solution is **symmetry-allowed**, **reliably determined**, and **physically reasonable**. This document covers magnetic neutron scattering, propagation vectors, the two equivalent symmetry frameworks (representation analysis and magnetic space groups), the correct low-dimensional parameterization, and the limits — especially the direction ambiguities intrinsic to powder data. It complements §14–15 of `refinement_fitting_algorithms_knowledge.md` (do not refine free atom-by-atom moments) and the powder/single-crystal structural docs.

## 1. Scope

Support magnetic refinement for:

```text
- commensurate magnetic structures (k = 0 and rational k)
- incommensurate structures (sine-modulated, helical, cycloidal) — via superspace / Fourier modes
- collinear and non-collinear (canted, multi-k) arrangements
- constant-wavelength and time-of-flight neutron powder diffraction
- single-crystal neutron diffraction (unpolarized, and notes on polarized)
- temperature/field series (order parameter, spin reorientation, metamagnetism)
```

Neutrons are the primary probe. X-ray magnetic scattering is weak and used mainly as resonant/non-resonant magnetic scattering at synchrotrons for element- and edge-specific information; treat it as complementary, not the default engine.

## 2. Magnetic neutron scattering — the physics that constrains everything

Neutrons scatter from the magnetization via the magnetic interaction vector. Two facts dominate every downstream decision:

```text
1. Only the moment component PERPENDICULAR to Q scatters:
     M_perp(Q) = Q̂ × ( M(Q) × Q̂ )
   A moment parallel to the scattering vector is invisible. This is the root of powder
   direction ambiguities (§9).

2. The magnetic form factor f_m(Q) FALLS OFF with Q (unlike a point nucleus):
     dipole approximation:  f_m(Q) = <j0>(s) + (1 - 2/g) <j2>(s),   s = sinθ/λ
   so magnetic intensity is concentrated at low Q / high d-spacing.
```

Magnetic structure factor for a propagation vector `k`:

```text
F_M(Q) ∝ p · Σ_j  f_mj(Q) · o_j · exp[2πi Q·r_j] · S_j⊥
   p    = 0.2695 (×10⁻¹² cm per µ_B) magnetic scattering amplitude
   S_j⊥ = component of the Fourier moment of site j perpendicular to Q
```

Implemented in `src/core/scattering/magnetic.ts` (`magneticFormFactorJ0/J2/Dipole`, `magneticTable`) and `src/core/magnetic/structureFactor.ts`. Form-factor data live in `magneticFormFactorData.ts` / `magneticIons.ts`. Moments are always expressed in µ_B.

## 3. Propagation vector k

Magnetic order modulates the nuclear structure with wavevector `k`. Magnetic Bragg intensity appears at:

```text
Q = τ ± k     (τ = nuclear reciprocal-lattice vector)
```

Classify k, because it changes the whole parameterization and the peak-overlap situation:

```text
- k = 0            : magnetic cell = nuclear cell; magnetic intensity ADDS to nuclear reflections
- commensurate     : rational components (½, ⅓, ¼ …); enlarged but finite magnetic cell
- incommensurate   : irrational components; no finite cell — use Fourier-mode / superspace model
```

Determination workflow (below T_N/T_C, subtract the paramagnetic pattern to isolate magnetic peaks):

```text
1. index the extra magnetic peaks that appear on ordering
2. find k that places calculated satellites on all observed magnetic peaks
3. test special points / symmetry lines of the Brillouin zone first (star of k)
4. refine k for incommensurate cases; snap to rational for commensurate
```

See `src/core/magnetic/kSearch.ts` (`candidateKVectors`, `searchPropagationVector`, `kLabel`) and `extraPeaks.ts` / `magneticTicks.ts`. Report the **star of k** (symmetry-related arms) and remember that `+k` and `-k` domains generally coexist.

## 4. Two equivalent symmetry frameworks

There are two rigorous ways to constrain a magnetic structure. They are equivalent for a single active irrep and both are supported in the codebase. Use one as primary and cross-check with the other.

### 4.1 Representation analysis (Bertaut)

```text
- for the parent space group G, the propagation vector k, and each magnetic Wyckoff site,
  build the magnetic representation Γ_mag on that orbit
- decompose into irreducible representations of the little group G_k:
     Γ_mag = Σ_ν  n_ν Γ_ν
- each irrep contributes basis vectors (BVs); the allowed moment configuration is a linear
  combination of the BVs of ONE irrep (Landau: a single order parameter → one irrep, generically)
- refine the MODE AMPLITUDES (mixing coefficients), not free moments
```

Implemented in `src/core/magnetic/`: `irreps.ts` (`decomposeMagneticRepresentation`, `projectIrrepModes`, `abelianIrreps`), `pointGroupIrreps.ts`, and `magneticRepresentation.ts` (little-group and orbit-splitting handling; see `littleGroup.test.ts`, `orbitSplitting.test.ts`).

### 4.2 Magnetic (Shubnikov) space groups — BNS/OG

```text
- for commensurate structures, the ordered state has a magnetic space group (MSG): a maximal
  subgroup of the parent grey group, combining crystallographic operations with time reversal (1')
- the MSG directly constrains: which sites carry a moment, allowed moment DIRECTIONS, and
  equal-moment relations between sites — no separate BV bookkeeping needed
- BNS and OG are two labelling settings of the same groups; support conversion between them
```

Implemented in `src/core/magnetic/bnsOg.ts` (`identifyMagneticGroup`, `magneticGroupsForParent`, `identifyMagneticGroupAnySetting`, `formatMagneticSymbol`), `magneticGroups.ts`, `bnsOgTable.ts`, `subgroupLattice.ts`, `isotropy.ts`, `shubnikovCandidateIndex`.

### 4.3 Relationship

```text
- a single active irrep of (G, k) corresponds to a specific magnetic space group (its kernel /
  isotropy subgroup). Enumerating irreps and enumerating maximal magnetic subgroups give the
  SAME candidate set for a single-k commensurate problem.
- use representation analysis to enumerate candidates and rank by symmetry; use the MSG to state
  the final answer in a standard, publishable, unambiguous form.
- multi-irrep (multiferroic, complex) structures are not describable by one MSG — stay in the
  representation / superspace description and justify the extra order parameters physically.
```

## 5. Allowed moments and symmetry constraints

Before refining anything, determine what symmetry permits:

```text
- does a given site carry a moment at all under (G, k) / the MSG?  (some sites are forced to zero)
- the moment DIRECTION at a site may be fixed to an axis or a plane by site symmetry
- moments on symmetry-related sites are related in magnitude and phase (equal-moment,
  antiparallel, or phase-shifted) — these are constraints, not free choices
```

See `src/core/magnetic/allowedMoments.ts` (`allowedMomentDirections`); symmetry-related-site relations are carried by the moment model (`momentModel.ts`), which expands each orbit's moment from its mode amplitudes over the magnetic operations. Refine only symmetry-allowed degrees of freedom; enforcing zero moments and the symmetry relations between equivalent sites is what makes the refinement stable and the answer physical.

## 6. Correct parameterization (the central rule)

```text
BAD default:   refine Mx, My, Mz freely for every magnetic atom
GOOD default:  moment_structure = Σ_ν A_ν · basis_vector_ν     (refine amplitudes A_ν)
               subject to the MSG / irrep constraints and equal-moment relations
```

Build the model with `src/core/magnetic/momentModel.ts` (`buildMagneticModel`, `describeMomentMode`) and `moment.ts` / `fourierMoment.ts` for the Fourier (incommensurate) representation. This reduces dimensionality, removes correlated/undetermined directions, and guarantees a symmetry-allowed result. Free-moment refinement is permissible only as a final, unconstrained sanity check against the constrained solution — never as the primary model.

## 7. Physically reasonable moments

The refined **magnitude** is well determined from powder data; hold it to physics:

```text
- ordered moment must not exceed the ionic maximum:
     spin-only   µ ≤ g·S µ_B   (g ≈ 2)
     rare earth  µ ≤ g_J·J µ_B  (with crystal-field / L–S coupling; often strongly reduced)
- compare against the Curie–Weiss effective moment µ_eff = g√(S(S+1)) from susceptibility
  (effective and ordered moments are different quantities — do not equate them, but they bound
  each other physically)
- reductions from the ionic maximum are expected and meaningful: covalency/hybridization,
  quantum fluctuations (low-D, frustrated), crystal-field quenching, itinerancy
- a refined moment ABOVE the ionic maximum is a red flag: wrong form factor, wrong scale,
  wrong site multiplicity, or unmodelled peak overlap — reject and diagnose
- check the form-factor falloff: magnetic intensity that persists to high Q like nuclear
  intensity is not magnetic (or the form factor / ion assignment is wrong)
```

Cross-checks worth surfacing: bulk saturation magnetization, µSR, XMCD/resonant scattering, and the ordering temperature all constrain the moment independently.

## 8. Order parameter and temperature/field dependence

```text
- the ordered moment vs temperature follows M(T) ∝ (1 - T/T_N)^β near T_N (critical exponent β)
- refine a sequence and report M(T); a sudden change in the best irrep/direction is a spin
  reorientation, not a fitting artifact
- applied field can drive spin-flop / metamagnetic transitions → a different k or MSG; refine
  each field point as its own model, do not force one parameterization across a transition
```

Use the sequential-refinement machinery already present for structural series.

## 9. Powder limitations — direction ambiguity (must be stated)

This is the single most important reliability caveat for powder magnetic work, and follows directly from §2 (only M_perp scatters) plus powder averaging over all crystallite orientations:

```text
- cubic symmetry: the moment DIRECTION relative to the crystal axes is NOT determinable from
  powder data — only the magnitude. Report magnitude and irrep, not a direction.
- uniaxial systems (tetragonal, hexagonal, trigonal): only the ANGLE of the moment to the
  unique axis is determinable; the azimuth within the perpendicular plane is not.
- lower symmetry (orthorhombic and below): more direction components become determinable, but
  correlations remain — report which components the data actually constrain.
- +k / -k and orientation domains are averaged in a powder; distinct domain populations are
  generally not separable.
```

Corollary: several symmetry-distinct models can produce the **same** powder magnetic pattern. Do not report a direction the data cannot fix, and do not choose among degenerate models on R factor alone — use symmetry (single-irrep preference), physical constraints, and complementary probes.

## 10. Nuclear–magnetic overlap and contrast

```text
- for k = 0 (and commensurate k giving overlap), magnetic intensity sits ON nuclear reflections;
  the nuclear model, scale, and ADPs must be solid first, or magnetic moment absorbs their error
- best practice: refine the nuclear structure on a paramagnetic (T > T_N) dataset, fix it, then
  refine only magnetic parameters on the ordered dataset (or refine the difference pattern)
- pure magnetic satellites (k ≠ τ) are cleaner but weaker and fall off with the form factor
```

## 11. Single-crystal magnetic diffraction

```text
- resolves individual magnetic reflections → can determine moment DIRECTION and domain
  populations that powder cannot (§9)
- unpolarized single crystal: intensities give |M_perp|²; direction from the set of reflections
- polarized neutrons / spherical neutron polarimetry: separate nuclear–magnetic interference,
  resolve chirality (helical handedness) and complex domain structures
- extinction and absorption apply as in nuclear single-crystal work (see the single-crystal doc)
```

## 12. Incommensurate and modulated structures

```text
- no finite magnetic cell; describe moments as Fourier series with wavevector k (and harmonics)
- amplitude-modulated (sine): moment magnitude varies site to site; at low T often "squares up"
  (odd harmonics 3k, 5k appear) because moments cannot exceed the ionic maximum
- helical / cycloidal: constant magnitude, rotating direction; two BVs in quadrature (phase 90°)
- use the (3+d)-dimensional superspace description for a rigorous, minimal parameterization
- refine k, the Fourier amplitudes, and inter-site phases; constrain by irrep/superspace symmetry
```

`src/core/magnetic/fourierMoment.ts` holds the Fourier-moment representation; extend for harmonics and superspace bookkeeping.

## 13. Limits of magnetic refinement — what neutrons cannot tell you

```text
- powder direction ambiguities (§9): magnitude yes, full direction often no
- model degeneracy: symmetry-distinct structures with identical powder patterns are not
  distinguishable without single-crystal data or extra physics
- moment vs occupancy/scale correlation: the overall magnetic scale correlates with the nuclear
  scale and with site moments — fix the nuclear scale from paramagnetic data
- form-factor uncertainty: covalency/delocalization make the free-ion form factor approximate;
  absolute moments carry this systematic error (cross-check vs magnetization / GSAS-II)
- spin vs orbital contribution: the dipole approximation lumps them; separating requires the
  full <j_l> treatment and high-Q data, rarely available from powder
- domains and chirality: inaccessible from unpolarized powder; need polarized single crystal
```

## 14. Instrument and methodology dependence

```text
- neutron only for routine magnetic structure; ensure the source has enough low-Q (high-d)
  coverage where magnetic intensity and form-factor signal live
- CW (e.g. HB-2A, D20, D1B): fixed λ, direct 2θ; good for order-parameter scans
- TOF (e.g. WISH, POWGEN, DMC-TOF): wide d-range in one setting; watch the wavelength-dependent
  Lorentz factor and resolution profile
- temperature control is essential (map T_N, order parameter, reorientation); field for
  metamagnetic/spin-flop mapping
- resolution and d-max limit which k and which weak satellites are recoverable
```

## 15. Implementation modules (existing)

```text
scattering/magnetic.ts          form factors (j0, j2, dipole), magneticTable
scattering/magneticFormFactorData.ts, magneticIons.ts   ion form-factor coefficients
magnetic/kSearch.ts             propagation-vector search, candidate k, star of k
magnetic/irreps.ts              magnetic representation decomposition, irrep modes/projection
magnetic/pointGroupIrreps.ts, magneticRepresentation.ts   point-group irreps, little group, orbits
magnetic/bnsOg.ts, magneticGroups.ts, bnsOgTable.ts, subgroupLattice.ts, isotropy.ts   MSGs
magnetic/allowedMoments.ts      symmetry-allowed moment directions and equal-moment relations
magnetic/momentModel.ts, moment.ts, fourierMoment.ts   moment parameterization (amplitudes)
magnetic/structureFactor.ts     magnetic structure factor (AFM cases in afmStructureFactor.test.ts)
magnetic/extraPeaks.ts          magnetic reflection generation / tick marks
workflow/magnetic.ts, magneticPowder.ts, magneticCompare.ts, magneticWorkflow(*.test)  drivers
```

Additions worth building on top:

```text
- automatic candidate enumeration: irreps AND maximal magnetic subgroups, cross-checked
- a "determinability" reporter that states, per crystal system, which direction components the
  powder data actually constrain (§9) — so the agent never over-claims a direction
- moment-vs-theory guard (§7): flag refined |µ| above the ionic maximum
- paramagnetic-subtraction / fixed-nuclear workflow for k=0 overlap cases (§10)
- harmonic/superspace extension for squared-up and helical incommensurate structures (§12)
```

## 16. Acceptance tests

### Symmetry and k
```text
- searchPropagationVector recovers the correct k for a synthetic AFM satellite set
- representation decomposition and the corresponding maximal magnetic subgroup enumerate the
  same candidate models for a single-k commensurate case
- allowedMomentDirections zeroes moments on sites the symmetry forbids
```

### Physics and reliability
```text
- refined moment above the ionic maximum is flagged, not accepted
- for a cubic test structure the engine refines a magnitude and REFUSES to report a direction
- for a uniaxial structure only the angle-to-axis is reported as determined
- magnetic intensity that fails to fall off with Q (wrong ion/form factor) is caught
- k=0 case: refining magnetic moment on an unfixed nuclear model corrupts the nuclear scale;
  the fixed-nuclear/paramagnetic-subtraction path gives the correct moment
```

## 17. Non-negotiable rules

```text
- Refine symmetry-mode amplitudes (irrep / MSG-allowed), never free Mx,My,Mz as the primary model.
- Determine k (and its star) before parameterizing moments.
- Enforce symmetry-allowed moments and equal-moment relations; zero forbidden sites.
- Include the magnetic form factor and use only M_perp — magnetic ≠ nuclear scattering model.
- Never report a moment direction that powder data cannot determine (cubic: none; uniaxial: axis
  angle only).
- Reject moments exceeding the ionic maximum; cross-check magnitude vs magnetization / GSAS-II.
- Fix the nuclear structure (paramagnetic data) before refining moments when k gives overlap.
- Do not choose among powder-degenerate models by R factor alone; use symmetry and physics.
- Refine each temperature/field point as its own model across a transition; do not force one k.
- Global search (Monte Carlo / simulated annealing) proposes starting models only, never the
  final answer — follow with constrained least squares.
```

## 18. Practical target

The engine should behave like a careful magnetic crystallographer:

```text
- isolate magnetic peaks, find k and its star
- enumerate symmetry-allowed models by representation analysis, name the answer as a magnetic
  space group
- parameterize by mode amplitudes, enforce allowed/equal moments, zero forbidden sites
- fix the nuclear model where magnetic and nuclear intensity overlap
- report the moment magnitude with its physical bound, and state exactly which direction
  components the data determine
- track the order parameter across temperature/field and re-evaluate the model at transitions
- flag anything unphysical (over-max moment, non-falling intensity, degenerate models) instead
  of reporting false precision
```

## 19. Reference sources for implementation context

```text
- Rodríguez-Carvajal, FullProf and magnetic refinement notes: https://www.ill.eu/sites/fullprof/
- Bertaut, representation analysis of magnetic structures (Acta Cryst. A24 (1968) 217)
- Wills, SARAh / representational analysis (Physica B 276–278 (2000) 680)
- Bilbao Crystallographic Server — MAGNDATA, k-SUBGROUPSMAG, MAXMAGN, Get_mirreps:
  https://www.cryst.ehu.es/
- ISOTROPY / ISODISTORT (Stokes, Campbell) for irreps and magnetic modes: https://iso.byu.edu/
- Izyumov, Naish & Ozerov, Neutron Diffraction of Magnetic Materials
- Magnetic form factors (dipole approximation), International Tables Vol. C, §4.4.5
- Opechowski & Guccione (OG) and Belov–Neronova–Smirnova (BNS) magnetic space-group settings
- NIST neutron scattering lengths and cross sections: https://www.ncnr.nist.gov/resources/n-lengths/
```
