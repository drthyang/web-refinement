# Powder Structural Refinement Knowledge Base

Purpose: provide implementation guidance for a coding agent building powder structural refinement for synchrotron X-ray diffraction and neutron diffraction. This document focuses on physically defensible Rietveld-style refinement, profile matching, multiphase fitting, and joint X-ray/neutron refinement.

## 1. Scope

Support powder structural refinement for:

```text
- laboratory X-ray powder diffraction
- synchrotron X-ray powder diffraction
- constant-wavelength neutron powder diffraction
- time-of-flight neutron powder diffraction
- multiphase patterns
- multi-histogram / joint X-ray + neutron refinement
- sequential refinements across temperature, field, pressure, composition, or time
```

Do not build the refinement engine as a black-box curve fitter. Powder refinement must combine a diffraction model, instrument model, structural model, and constrained nonlinear least-squares optimizer.

## 2. Core calculated pattern

For each observed point `i`, compute:

```text
y_calc(i) = y_background(i) + Σ_phase Σ_hkl y_peak(i, hkl, phase)
```

Each peak contribution should include:

```text
y_peak = scale_phase_histogram
       × multiplicity_hkl
       × intensity_factor_hkl
       × correction_terms_hkl
       × profile_function(x_i - x_hkl)
```

Typical intensity factor:

```text
intensity_factor_hkl ∝ |F_hkl|²
```

where `F_hkl` is the nuclear structure factor for structural refinement. Magnetic scattering should be a separate module for neutron data.

## 3. Structural model

Represent each phase with:

```text
- space group
- unit cell
- atom sites
- Wyckoff/site symmetry information
- fractional coordinates
- occupancy
- isotropic or anisotropic displacement parameters
- element/isotope identity
- optional constraints/restraints
```

For each atom site, the nuclear structure factor contribution is:

```text
F_hkl += occ_j × scatterer_j(Q or isotope) × DW_j(hkl) × phase_j(hkl)
```

where:

```text
phase_j(hkl) = exp[2πi(hx_j + ky_j + lz_j)]
DW_j = Debye-Waller factor
```

Use symmetry to generate equivalent positions. Do not expand all atoms independently unless needed internally; refinement parameters should remain symmetry-reduced.

## 4. X-ray vs neutron scattering

### X-ray diffraction

X-rays scatter mainly from electron density. Atomic form factors depend on scattering vector and generally decrease with increasing `sinθ/λ` or `Q`.

Use:

```text
f_X(Q, E) = f0(Q) + f'(E) + i f''(E)
```

Minimum implementation:

```text
- f0(Q) table or analytical coefficients
- optional anomalous terms f' and f'' for synchrotron/anomalous work
- element-based scattering, not isotope-based scattering
```

Practical consequences:

```text
- heavy atoms dominate X-ray intensities
- light atoms near heavy atoms are difficult to refine from X-rays alone
- neighboring elements with similar Z can be hard to distinguish
- high-Q data help constrain ADPs and subtle displacements
- synchrotron data often have high angular resolution and strong counting statistics
```

### Neutron diffraction

Neutrons scatter from nuclei. Use coherent bound scattering lengths.

Use:

```text
scatterer_neutron = b_coherent isotope/element
```

Practical consequences:

```text
- scattering length is isotope-dependent
- scattering length does not monotonically scale with atomic number
- scattering length may be positive or negative
- light atoms can be visible, including O, H/D, Li, B, etc., depending on isotope and absorption/incoherent background
- neighboring transition metals may be distinguishable when X-rays cannot distinguish them well
- magnetic diffraction is available only for neutron diffraction in this context
```

Implementation requirement:

```text
- support natural-element neutron scattering lengths
- support isotope-specific scattering lengths
- support absorption and incoherent-scattering metadata
```

## 5. Independent histogram model

In a multi-pattern refinement, separate the shared phase model from histogram-specific parameters.

Shared phase parameters:

```text
- fractional coordinates
- occupancies
- ADPs, if physically justified
- composition constraints
- symmetry constraints
```

Histogram-specific parameters:

```text
- scale factor
- background
- zero shift / sample displacement
- wavelength or TOF calibration terms
- peak profile parameters
- preferred orientation
- absorption correction
- excluded regions
- data weights
```

Joint X-ray/neutron refinement should share the structural model but keep instrument/profile/background parameters independent for each dataset.

## 6. Data types and x-axis handling

Support these coordinate systems internally:

```text
- 2θ
- d-spacing
- Q
- TOF
```

Use explicit conversion functions:

```text
Q = 4π sinθ / λ
Bragg: nλ = 2d sinθ
```

For time-of-flight neutron data, support an instrument calibration mapping such as:

```text
TOF = DIFC × d + DIFA × d² + ZERO
```

Keep the calibration model modular because TOF instruments use instrument-specific parameterizations.

## 7. Peak positions

For each reflection:

```text
1/d_hkl² = reciprocal_metric(h, k, l, cell)
```

Then map `d_hkl` to the histogram x-axis:

```text
- constant-wavelength X-ray/neutron: d -> 2θ
- TOF neutron: d -> TOF
- Q-space data: d -> Q = 2π/d
```

Refinable position-related parameters may include:

```text
- lattice parameters
- zero shift
- sample displacement
- specimen transparency correction
- wavelength or effective wavelength
- TOF calibration coefficients
```

Do not refine too many position correction terms simultaneously unless the data justify them.

## 8. Peak-profile model

Profile model must be histogram-specific and optionally phase-specific.

Support at least:

```text
- Gaussian
- Lorentzian
- pseudo-Voigt
- Thompson-Cox-Hastings pseudo-Voigt or equivalent
- split pseudo-Voigt / asymmetric peak shape
- TOF back-to-back exponential convoluted profile or equivalent TOF-specific model
```

Typical profile broadening sources:

```text
- instrument resolution
- crystallite size
- microstrain
- stacking faults / anisotropic strain
- sample transparency
- axial divergence / asymmetry
```

Implementation principle:

```text
separate instrument broadening from sample broadening where possible
```

Do not interpret profile width as crystallite size or strain unless instrument broadening is known or refined from standards.

## 9. Reflection-window acceleration

Never compute every reflection against every data point.

For each reflection:

```text
1. compute peak center
2. compute FWHM or equivalent width
3. select data window around the peak
4. accumulate only within that window
```

Recommended default:

```text
window = ±6 to ±10 FWHM
```

Make the window configurable. Lorentzian-heavy or TOF asymmetric profiles require longer tails.

## 10. Background model

Support multiple background representations:

```text
- polynomial background
- Chebyshev polynomial
- interpolated/fixed background points
- manually selected background anchor points
- broad diffuse humps / amorphous components
- Fourier/filter-based background only as optional advanced feature
```

Background should be histogram-specific.

Rules:

```text
- fit background before refining delicate structural parameters
- avoid using too many background terms to absorb weak Bragg peaks
- report when background is strongly correlated with scale, broad peaks, or magnetic/diffuse signal
```

## 11. Corrections to support

Implement corrections as modular factors.

Common corrections:

```text
- Lorentz factor
- polarization factor for X-ray data
- absorption correction
- microabsorption correction for multiphase samples
- preferred orientation correction
- extinction correction when justified
- detector efficiency / normalization correction if provided by reduction pipeline
```

Geometry-specific absorption support:

```text
- flat plate reflection geometry
- transmission/capillary geometry
- Debye-Scherrer geometry
```

Preferred orientation:

```text
- March-Dollase model as a baseline
- spherical harmonics as advanced option
```

Do not refine preferred orientation unless there is physical reason or clear systematic intensity mismatch.

## 12. Synchrotron X-ray refinement knowledge

Synchrotron powder diffraction often provides:

```text
- high angular resolution
- high counting statistics
- high-energy transmission/capillary geometries
- tunable wavelength/energy
- anomalous contrast near absorption edges
- strong sensitivity to heavy atoms and electron-density contrast
```

Implementation requirements:

```text
- accurate wavelength handling
- optional anomalous f' and f'' terms
- capillary/transmission absorption correction
- high-resolution peak-profile functions
- detector/excluded-region masks
- multi-bank or multi-detector support if the reduction provides multiple histograms
```

Common pitfalls:

```text
- over-refining tiny peak shifts as structural distortion
- ignoring sample displacement or wavelength calibration
- fitting impurity peaks with background
- treating high Rwp from extremely high-statistics data as automatically bad
- refining chemically unreasonable light-atom positions from X-rays alone
```

## 13. Neutron powder refinement knowledge

Neutron powder diffraction often provides:

```text
- isotope-sensitive nuclear contrast
- visibility of light atoms
- magnetic scattering
- constant-wavelength reactor data or TOF spallation data
- lower flux than synchrotron X-rays in many cases
- possible strong absorption or incoherent background for some isotopes/elements
```

Implementation requirements:

```text
- coherent scattering-length table
- isotope-specific scattering lengths
- absorption cross-section metadata
- incoherent background awareness
- TOF profile functions for spallation data
- support multiple detector banks for TOF data
- optional magnetic scattering module
```

Common pitfalls:

```text
- using natural scattering length when isotope enrichment matters
- ignoring high absorption elements such as Gd, Cd, B, Li isotope effects, etc.
- refining occupancies without composition constraints
- comparing neutron and X-ray scale factors directly without normalization/model context
- mixing nuclear and magnetic intensity without separate magnetic model terms
```

## 14. Joint X-ray + neutron refinement

Joint refinement is powerful because X-rays and neutrons have complementary contrast.

Use cases:

```text
- distinguish elements with similar X-ray form factors but different neutron scattering lengths
- locate light atoms in a heavy-atom framework
- separate occupancy and ADP correlations
- constrain oxygen positions/occupancies in oxides
- combine high-resolution synchrotron peak positions with neutron contrast
```

Architecture:

```text
one shared structural phase model
many histogram-specific calculated-pattern models
one global least-squares objective
```

Global objective:

```text
χ²_total = Σ_histogram α_h Σ_i w_hi [y_obs_hi - y_calc_hi]² + χ²_restraints
```

where `α_h` is an optional histogram weighting factor.

Rules:

```text
- keep histogram scales independent
- keep backgrounds independent
- keep profile parameters independent unless same instrument/setup justifies sharing
- share atomic coordinates only when the same average structure is assumed
- share occupancies only when the datasets measure the same sample state
- allow ADPs to be shared or separated depending on temperature, dataset quality, and model assumptions
```

Do not let one high-count dataset numerically dominate the refinement without checking the weighting scheme.

## 15. Multiphase refinement

Support multiple crystalline phases:

```text
- independent phase scale factors
- independent cells per phase
- independent profile terms per phase if needed
- shared histogram background
- phase-specific preferred orientation if justified
```

Phase fraction from scale factors requires correct normalization using phase mass, cell volume, formula weight, and instrument/model conventions.

Rules:

```text
- add impurity phases before overfitting background
- do not force a single-phase model when unmatched peaks remain
- report unmatched peaks after refinement
- quantify phase fraction only when scale factors and absorption/microabsorption are handled consistently
```

## 16. Refinement stages

Default refinement sequence:

```text
1. import pattern, instrument parameters, phase CIF/model
2. inspect and mask bad regions
3. refine scale and background
4. refine zero/sample displacement or TOF calibration terms
5. refine lattice parameters
6. refine profile width/shape/asymmetry
7. add impurity phases if unmatched peaks exist
8. refine preferred orientation/absorption only if justified
9. refine atomic coordinates
10. refine ADPs
11. refine occupancies under chemical constraints
12. for neutron data, add magnetic model only after nuclear model is stable
13. final combined refinement with conservative active parameters
14. inspect residuals, correlations, parameter shifts, and difference curve
```

Never start by refining coordinates, ADPs, occupancies, preferred orientation, and profile parameters simultaneously.

## 17. Parameter correlations to detect

Flag high correlations, especially:

```text
scale ↔ occupancy
occupancy ↔ ADP
background ↔ broad weak peaks
zero shift ↔ lattice parameters
sample displacement ↔ lattice parameters
size broadening ↔ strain broadening
preferred orientation ↔ occupancy
absorption ↔ phase scale
phase fraction ↔ microabsorption
magnetic scale ↔ ordered moment size
```

If correlation is high, recommend freezing one parameter group, adding constraints, or using complementary data.

## 18. Constraints and restraints

Hard constraints reduce the number of free parameters:

```text
- equal occupancies
- total occupancy = 1
- charge-balanced composition
- shared ADPs
- fixed special-position coordinates
- symmetry-generated coordinates
```

Soft restraints add penalty residuals:

```text
- bond lengths
- bond angles
- ADP similarity
- occupancy priors
- rigid-body geometry
```

Implementation:

```text
raw_parameters = transform(free_parameters)
χ²_total = χ²_pattern + χ²_restraints
```

Do not apply restraints silently. Report their contribution to the total objective.

## 19. Quality metrics

Report:

```text
- Rwp
- Rp
- Rexp
- χ² or goodness of fit
- reduced χ² when appropriate
- Bragg R-factor per phase
- weighted profile residual
- number of observations
- number of refined parameters
- parameter shifts / estimated standard deviations
- correlation matrix
- condition number or SVD diagnostics
```

Interpretation rule:

```text
low Rwp does not prove the structure is correct
```

Also inspect:

```text
- difference curve
- peak-position residuals
- systematic intensity residuals
- unmatched peaks
- high-angle residuals
- low-angle asymmetry
- physically unreasonable parameters
```

## 20. Automated refinement controller

Implement a staged controller with safety checks.

Pseudo-workflow:

```text
for stage in refinement_plan:
    enable stage parameters
    run damped least squares
    evaluate improvement
    inspect parameter shifts
    inspect correlations
    reject or freeze unstable parameters
    continue only if model remains physical
```

Automatic recommendations:

```text
- if peaks shifted together: refine zero/sample displacement
- if peak spacing wrong: refine lattice
- if peak widths wrong: refine profile parameters
- if intensities wrong systematically: inspect structure, preferred orientation, absorption, phase fractions
- if residual peaks remain: search for impurity phase or missing symmetry lowering
- if high-angle intensity mismatch: inspect ADPs/occupancy/form factors/background
```

## 21. Le Bail / Pawley profile matching

Implement profile matching as a stabilization step.

Use when:

```text
- starting cell/profile is uncertain
- structure model is incomplete
- impurity peaks need identification
- pattern indexing/cell verification is needed
- magnetic peaks are present before magnetic model is known
```

Profile matching refines:

```text
- background
- zero/sample displacement or TOF calibration
- lattice parameters
- profile parameters
- reflection intensities without structural interpretation
```

After profile matching, transfer stable background, cell, zero, and profile parameters into structural Rietveld refinement.

## 22. Sequential refinement

For temperature/field/pressure/time series:

```text
1. refine a representative high-quality pattern carefully
2. use that result as the seed for neighboring patterns
3. refine only robust parameter groups first
4. propagate parameters sequentially
5. track trends and flag discontinuities
```

Use smoothness checks but do not enforce smooth trends unless scientifically justified.

Track:

```text
- lattice parameters vs control variable
- phase fraction
- ADPs
- order parameters
- selected bond lengths/angles
- Rwp and χ²
- parameter uncertainty
```

## 23. Implementation modules

Recommended package layout:

```text
refinement/
  data/
    histogram.ts
    instrument.ts
    masks.ts
  crystallography/
    cell.ts
    symmetry.ts
    hkl.ts
    structureFactorXray.ts
    structureFactorNeutron.ts
    formFactors.ts
    scatteringLengths.ts
  powder/
    peakPosition.ts
    profileFunctions.ts
    corrections.ts
    background.ts
    ycalc.ts
  optimizer/
    residual.ts
    jacobian.ts
    lmSolver.ts
    svd.ts
    constraints.ts
    restraints.ts
  workflows/
    rietveldStages.ts
    lebail.ts
    jointRefinement.ts
    sequential.ts
  diagnostics/
    metrics.ts
    correlations.ts
    residualAnalysis.ts
    reports.ts
```

## 24. Acceptance tests

Minimum tests:

```text
1. Single Gaussian peak recovers position, width, scale, and background.
2. Synthetic cubic pattern recovers lattice parameter and zero shift.
3. Synthetic structure recovers scale and background with fixed structure.
4. X-ray form-factor test: heavy atoms dominate low-Q intensity.
5. Neutron scattering-length test: isotope-specific b values change intensities correctly.
6. Occupancy/ADP correlation test triggers warning.
7. Two-phase synthetic pattern recovers approximate phase fractions.
8. Joint X-ray/neutron synthetic refinement recovers occupancy contrast better than X-ray alone.
9. TOF calibration test maps d-spacing to TOF correctly.
10. Reflection-window calculation matches full calculation within tolerance.
11. Constraint system preserves total occupancy.
12. Restraint residual contributes correctly to χ².
13. Sequential refinement propagates stable parameters without unexpected jumps.
```

## 25. Non-negotiable rules

```text
- Do not refine all parameters at once.
- Do not ignore instrument calibration.
- Do not use background to hide real peaks.
- Do not refine occupancy and ADP freely without constraints or complementary evidence.
- Do not compare X-ray and neutron intensities using the same scattering model.
- Do not treat synchrotron data as automatically more structurally complete than neutron data.
- Do not interpret profile broadening without separating instrument and sample effects.
- Do not claim a phase fraction without checking absorption/microabsorption assumptions.
- Do not add preferred orientation, absorption, extinction, and occupancy simultaneously.
- Do not use Rwp alone as proof of structural correctness.
```

## 26. Practical target

The engine should behave like a careful crystallographer:

```text
- stabilize geometry first
- refine profile before delicate structure
- use X-ray and neutron contrast correctly
- keep histogram-specific effects separate
- use constraints and restraints transparently
- report correlations and physically suspicious parameters
- support profile matching before full Rietveld refinement
- support joint and sequential refinements without hiding instability
```

## 27. Reference sources for implementation context

```text
- GSAS-II documentation and source repository: https://github.com/AdvancedPhotonSource/GSAS-II
- GSAS-II scripting/refinement documentation: https://gsas-ii.readthedocs.io/
- FullProf Suite feature documentation: https://www2017.ill.eu/sites/fullprof/
- FullProf manual: https://www.psi.ch/sites/default/files/import/sinq/dmc/ManualsEN/fullprof.pdf
- Jana2020 documentation: https://jana.fzu.cz/
- NIST neutron scattering lengths and cross sections: https://www.ncnr.nist.gov/resources/n-lengths/
- NIST X-ray form factor, attenuation, and scattering tables: https://www.nist.gov/pml/x-ray-form-factor-attenuation-and-scattering-tables
```
