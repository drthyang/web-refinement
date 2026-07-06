# Knowledge Base: Background and Sample Texture in Powder Refinement

Purpose: guide implementation of background modeling and sample texture / preferred-orientation correction in a powder structural refinement engine for laboratory X-ray, synchrotron X-ray, and neutron diffraction.

This document is intended for a coding agent. Keep the implementation physically conservative, numerically stable, and transparent to the user.

---

## 1. Scope

Powder refinement separates the calculated intensity into three major parts:

```text
observed pattern = Bragg/profile contribution + background + noise/systematic errors
```

Texture/preferred orientation modifies Bragg intensities, while background modifies the non-Bragg baseline. These two effects must not be confused.

```text
y_calc(x_i) = y_background(x_i) + Σ_phase Σ_hkl I_hkl,phase * PO_hkl,phase * P(x_i - x_hkl)
```

where:

```text
y_background = smooth or semi-smooth non-Bragg intensity
PO_hkl       = preferred-orientation / texture correction factor
P            = peak profile function
```

---

## 2. Background modeling: physical sources

Common background sources:

```text
air scattering
sample-holder scattering
capillary scattering
amorphous sample contribution
fluorescence, especially in X-ray data
Compton scattering, especially in X-ray data
container/environment peaks or humps
cryostat/furnace/window scattering
incoherent scattering, especially in neutron data
instrumental electronic offsets
unmodeled broad diffuse scattering
```

Do not treat all background as arbitrary noise. Some background features carry physical information, but Rietveld refinement often models them empirically unless the diffuse/scattering source is itself the target.

---

## 3. Background model types

Implement multiple background models. No single model is universally correct.

### 3.1 Constant background

Use only for testing or very clean local windows.

```text
b(x) = c0
```

Do not use as a default for real full-pattern refinement.

### 3.2 Polynomial background

Basic model:

```text
b(x) = Σ_k c_k x^k
```

Better: use numerically stable basis functions rather than raw powers.

Recommended:

```text
Chebyshev polynomial background
shifted Chebyshev polynomial background
orthogonal polynomial basis over normalized x range
```

Implementation:

```text
x_norm = map x from [x_min, x_max] to [-1, 1]
b(x) = Σ_k c_k T_k(x_norm)
```

Advantages:

```text
stable coefficients
simple derivatives
works well for smooth background
```

Risks:

```text
too many coefficients can fit broad peaks or diffuse scattering
high-order terms can create oscillations
background can become correlated with scale, thermal parameters, and weak peaks
```

### 3.3 Interpolated background points

Represent background using user-defined or automatically generated anchor points.

```text
background_points = [(x_1, b_1), (x_2, b_2), ...]
b(x) = interpolation(background_points)
```

Recommended interpolation options:

```text
linear interpolation
cubic spline with monotonicity control
penalized spline / smoothing spline
```

Implementation rule:

```text
Allow background points to be fixed or refined.
```

Use cases:

```text
complex slowly varying background
synchrotron capillary data with non-polynomial background
neutron data with sample-environment humps
manual expert control
```

Risks:

```text
too many points can absorb real Bragg intensity
points placed under peaks bias the refinement
spline ringing can create fake features
```

### 3.4 Background peaks / broad humps

Use explicit broad background peaks for amorphous/container features:

```text
b_peak(x) = A * profile_background(x; center, width, shape)
```

Useful forms:

```text
Gaussian hump
Lorentzian hump
pseudo-Voigt hump
asymmetric broad hump if needed
```

Refinable parameters:

```text
amplitude
center
width
shape/mixing parameter, optional
```

Use cases:

```text
amorphous capillary hump
glass holder scattering
broad incoherent/diffuse contribution
cryostat/furnace feature
```

Do not use background peaks to hide missing crystalline phases.

### 3.5 Fourier-filtered / smoothed background

A background may be estimated by filtering out sharp Bragg features.

General concept:

```text
1. mask or down-weight Bragg peak regions
2. estimate a smooth baseline
3. optionally fix baseline or use it as starting values
```

Use this mainly as an automatic background initialization tool, not as an uncontrolled final model.

---

## 4. Background parameterization in least squares

For linear background coefficients, add them directly to the least-squares parameter vector.

If:

```text
b(x_i) = Σ_k c_k B_k(x_i)
```

then:

```text
∂y_calc(x_i)/∂c_k = B_k(x_i)
```

This makes background derivatives simple and stable.

For background peaks:

```text
∂y/∂A      = profile(x)
∂y/∂center = A * ∂profile/∂center
∂y/∂width  = A * ∂profile/∂width
```

Analytic derivatives are preferred. Finite differences are acceptable for center/width/shape during early implementation.

---

## 5. Automatic background initialization

Implement an automatic background estimator, but keep it separate from final refinement.

Suggested algorithm:

```text
input: x, y_obs, approximate peak positions if available

1. Estimate noise level.
2. Mask strong Bragg peak regions.
3. Use a rolling lower quantile or asymmetric least-squares smoother.
4. Place background anchor points at regular intervals or local minima.
5. Fit Chebyshev/spline coefficients to those anchor points.
6. Allow user inspection and manual editing.
```

A robust lower-envelope estimate is safer than fitting the whole observed pattern because Bragg peaks are positive outliers relative to the background.

Recommended methods:

```text
rolling minimum / rolling quantile
asymmetric least-squares baseline
SNIP-style peak clipping
iterative polynomial fit with peak rejection
masked smoothing spline
```

Do not automatically refine many background parameters during the first refinement cycle.

---

## 6. Background refinement strategy

Recommended refinement order:

```text
1. scale + low-order background
2. zero/sample displacement + lattice
3. profile parameters
4. increase background flexibility only if residual requires it
5. add broad background peaks only when physically justified
```

Default rules:

```text
start with 3-6 Chebyshev coefficients
increase gradually
prefer fewer coefficients for clean synchrotron data
allow more flexibility for neutron data with sample environment background
```

Do not refine:

```text
high-order background + weak phase scale + occupancy + ADP simultaneously
```

This is highly correlated and can produce false structural conclusions.

---

## 7. Background diagnostics

Implement automatic warnings.

Warn if:

```text
background is negative over a significant range
background has sharp oscillations comparable to peak widths
background coefficients are highly correlated with scale or ADPs
adding background terms lowers Rwp but changes structural parameters significantly
broad background peaks overlap important Bragg peaks
background accounts for a large fraction of integrated intensity near peaks
```

Report:

```text
background model type
number of background parameters
background intensity fraction
background smoothness metric
correlations with scale, occupancy, Uiso, phase fraction
fixed vs refined background points
```

---

## 8. Instrument-specific background considerations

### 8.1 Laboratory X-ray powder diffraction

Common issues:

```text
fluorescence
sample holder background
air scattering
Kα2 / wavelength effects if not modeled
amorphous binder or grease
```

Implementation notes:

```text
background often rises at low angle
fluorescence can produce high baseline
flat-plate geometry may introduce preferred orientation
```

### 8.2 Synchrotron X-ray powder diffraction

Common issues:

```text
capillary/glass background
air path/window scattering
detector offsets
high dynamic range near intense peaks
amorphous sample/container humps
```

Implementation notes:

```text
background can be very smooth but not always polynomial
capillary transmission often reduces preferred orientation but does not eliminate it
high-resolution data make poor background modeling obvious near weak peaks
```

### 8.3 Neutron powder diffraction

Common issues:

```text
incoherent scattering
hydrogen background
sample environment background
cryostat/furnace features
vanadium/container contributions
TOF-dependent baseline variations
```

Implementation notes:

```text
TOF neutron background may need bank-specific parameters
hydrogenous samples can require strong background handling
do not overfit broad magnetic diffuse scattering as background if magnetic correlations are scientifically relevant
```

---

## 9. Sample texture / preferred orientation

Ideal powder diffraction assumes random crystallite orientation. Real samples can violate this assumption.

Preferred orientation changes relative Bragg intensities without changing peak positions.

Symptoms:

```text
peak positions fit well but selected families of intensities are wrong
00l peaks enhanced in layered/plate-like materials
h00 or 0k0 families enhanced in needle-like/anisotropic crystallites
flat-plate/pressed samples worse than spinning capillaries
intensity mismatch depends systematically on hkl direction
```

Texture correction belongs in the Bragg intensity term, not in the background.

```text
I_corrected(hkl) = I_random(hkl) * PO(hkl)
```

---

## 10. March-Dollase preferred-orientation model

Use March-Dollase for simple axial preferred orientation.

Common form:

```text
PO(α) = (r^2 cos^2 α + r^-1 sin^2 α)^(-3/2)
```

where:

```text
r     = March-Dollase parameter
α     = angle between scattering vector for hkl and preferred-orientation axis
r = 1 = random orientation
```

Interpretation depends on convention and geometry, but broadly:

```text
r ≠ 1 indicates preferred orientation
```

Do not hard-code plate/needle interpretation without documenting the convention used.

Required inputs:

```text
preferred axis in crystal coordinates, e.g. [0 0 1]
March parameter r
geometry mode, if needed
```

Implementation:

```text
for each hkl:
    q_crystal = reciprocal_vector(hkl)
    α = angle(q_crystal, preferred_axis_reciprocal)
    PO_hkl = MarchDollase(r, α)
    I_hkl *= PO_hkl
```

Refinable parameters:

```text
r
optional texture fraction / mixing factor
optional multiple axes for multi-axial March-Dollase
```

Safer mixed model:

```text
PO_mixed = f * PO_MarchDollase + (1 - f) * 1
```

with:

```text
0 ≤ f ≤ 1
r near 1 at initialization
```

Use cases:

```text
layered materials
plate-like crystallites
needle-like crystallites
one dominant texture axis
pressed pellets
flat-plate XRD samples
```

Risks:

```text
wrong preferred axis gives misleading corrections
strong texture cannot always be represented by one axis
texture can be correlated with site occupancy, phase fraction, extinction, and magnetic moment size
```

---

## 11. Multi-axial March-Dollase

Use when more than one preferred direction is physically plausible.

```text
PO_total(hkl) = weighted combination or product of PO_axis_j(hkl)
```

Recommended conservative implementation:

```text
PO_total = normalize(Σ_j f_j * PO_j + (1 - Σ_j f_j) * 1)
```

Constraints:

```text
0 ≤ f_j ≤ 1
Σ_j f_j ≤ 1
r_j bounded near physical range
```

Do not allow unlimited independent axes by default. This can become an arbitrary intensity correction.

---

## 12. Spherical-harmonic texture model

Use spherical harmonics for more general texture.

Concept:

```text
PO(hkl) = 1 + Σ_l Σ_m C_lm * Y_lm(direction_hkl)
```

In real refinement codes, the allowed harmonic terms depend on crystal Laue symmetry and sample symmetry.

Use cases:

```text
complex texture
non-single-axis preferred orientation
2D detector / sample orientation information
high-quality datasets where texture matters quantitatively
```

Implementation requirements:

```text
generate allowed terms from crystal symmetry and sample symmetry
evaluate PO for each hkl direction
refine harmonic coefficients gradually
constrain or penalize coefficients to avoid negative pole densities
normalize so average PO is approximately 1
```

Default sample symmetry options:

```text
cylindrical/fiber symmetry
orthorhombic sample symmetry
triclinic/general sample symmetry, advanced only
```

Safety rule:

```text
Do not turn on high-order spherical harmonics automatically.
```

Recommended staged approach:

```text
start with low order, e.g. l = 2
increase to l = 4 only if justified
higher orders require strong evidence and good data coverage
```

Diagnostics:

```text
plot PO(hkl) vs hkl direction
plot pole-density map if possible
report min/max PO
warn if PO becomes negative or extreme
report texture coefficient correlations
```

---

## 13. Geometry dependence of texture

Texture correction depends on sample and measurement geometry.

Important cases:

```text
Bragg-Brentano flat plate
Debye-Scherrer capillary transmission
synchrotron capillary transmission
2D detector integration
neutron vanadium can / cylindrical sample
thin film or surface diffraction, advanced case
```

Capillary spinning often improves randomization but does not guarantee zero texture. Flat plates and pressed pellets are more prone to preferred orientation.

Implementation should store geometry metadata:

```text
geometry_type
sample_spinning: true/false
incident-beam direction
detector/scattering vector convention
sample normal or cylinder axis
integration azimuth range for 2D data
```

Do not use one universal March-Dollase geometry assumption silently.

---

## 14. Texture refinement strategy

Recommended order:

```text
1. refine scale/background/cell/profile first
2. inspect systematic hkl intensity residuals
3. choose physically plausible preferred axis/axes
4. refine one simple March-Dollase parameter
5. compare with no-texture model
6. only then consider multi-axis or spherical harmonics
```

Do not refine texture at the beginning of refinement.

Texture should be introduced when:

```text
peak positions and peak shapes are already reasonable
misfit is mostly intensity-family dependent
chemical/structural model is credible
preferred orientation is expected from sample morphology or geometry
```

---

## 15. Texture diagnostics and warnings

Warn if:

```text
texture correction becomes very large for a few reflections
texture strongly changes phase fractions
texture strongly changes occupancy or ADP
texture improves Rwp but worsens chemically meaningful parameters
texture model compensates for missing impurity phase
texture model compensates for wrong space group or wrong site assignment
```

Report:

```text
texture model type
preferred axis/axes
refined March-Dollase parameter(s)
spherical harmonic order and coefficients
min/max/mean PO factor
largest corrected reflections
correlation with scale, occupancy, ADP, magnetic moment, phase fraction
```

---

## 16. Combined background + texture pitfalls

Background and texture can interact through weak peaks.

Dangerous refinements:

```text
many background terms + texture + occupancy + ADP
texture + phase fraction in multiphase quantitative analysis
background humps + broad weak magnetic peaks
high-order spherical harmonics + weak superstructure peaks
```

Hard rule:

```text
Do not let background or texture corrections silently explain away important residuals.
```

Residual interpretation:

```text
peak position errors       -> cell/zero/displacement problem
peak width/shape errors    -> profile/microstructure problem
specific hkl intensity errors -> structure, occupancy, texture, absorption, extinction, or magnetic model
smooth baseline errors     -> background problem
broad structured residual  -> diffuse/amorphous/sample-environment contribution, not necessarily background
```

---

## 17. Implementation plan

Build in this order:

```text
1. Chebyshev polynomial background
2. fixed/manual interpolated background points
3. automatic lower-envelope background initialization
4. background peak/hump components
5. background diagnostics and correlation warnings
6. single-axis March-Dollase correction
7. multi-axis March-Dollase correction
8. spherical-harmonic texture correction
9. pole-density visualization and hkl correction plots
10. geometry-aware texture correction for capillary/flat-plate/2D data
```

---

## 18. Suggested data structures

### Background model

```ts
interface BackgroundModel {
  type: 'chebyshev' | 'points' | 'spline' | 'peaks' | 'composite';
  coefficients?: number[];
  points?: Array<{ x: number; y: number; refine: boolean }>;
  peaks?: Array<{
    center: number;
    amplitude: number;
    width: number;
    shape?: number;
    refineCenter: boolean;
    refineAmplitude: boolean;
    refineWidth: boolean;
    refineShape?: boolean;
  }>;
  refine: boolean;
  constraints?: unknown[];
}
```

### Texture model

```ts
interface TextureModel {
  type: 'none' | 'march_dollase' | 'multi_march_dollase' | 'spherical_harmonics';
  geometry: 'flat_plate' | 'capillary' | 'tof_neutron' | 'synchrotron_capillary' | 'custom';
  axes?: Array<{
    h: number;
    k: number;
    l: number;
    r: number;
    fraction?: number;
    refineR: boolean;
    refineFraction?: boolean;
  }>;
  sphericalHarmonics?: {
    sampleSymmetry: string;
    crystalLaue: string;
    maxOrder: number;
    coefficients: Record<string, number>;
    refine: Record<string, boolean>;
  };
}
```

---

## 19. Acceptance tests

### Background tests

```text
1. synthetic flat background: recover c0
2. synthetic sloped background: recover polynomial coefficients
3. synthetic Chebyshev background + peaks: recover background without changing Bragg scale
4. broad amorphous hump: recover hump amplitude/center/width
5. background overfitting test: excessive coefficients must trigger warning
6. negative background test: warning must trigger
7. background-scale correlation test: warning must trigger
```

### Texture tests

```text
1. no-texture synthetic pattern: refined r should stay near 1
2. single-axis March-Dollase pattern: recover r and axis-dependent intensities
3. wrong-axis test: fit should remain poor or warn
4. multi-axis synthetic texture: single-axis model should not falsely appear perfect
5. spherical-harmonic low-order texture: recover known low-order coefficients
6. negative pole-density test: warning or constraint must trigger
7. texture-occupancy correlation test: warning must trigger
```

---

## 20. Non-negotiable rules

```text
Background is not a garbage bin for unexplained physics.
Texture is not a substitute for a correct structure model.
Do not refine high-order background and high-order texture at the same time by default.
Do not let preferred orientation alter phase fractions without warning.
Do not interpret lower Rwp alone as proof that texture/background modeling is correct.
Always report what corrections were applied and how large they are.
```

---

## 21. Minimal viable implementation

The first useful version should include:

```text
Chebyshev background with analytic derivatives
manual/fixed background points
background peak humps
single-axis March-Dollase correction
texture/background diagnostics
correlation warnings
staged refinement defaults
```

This is enough to handle many practical X-ray, synchrotron, and neutron powder refinements without pretending to solve full quantitative texture analysis.

---

## 22. Source-backed implementation notes

Established refinement packages use the same broad categories:

```text
FullProf: fixed/refinable background points, polynomial coefficients, Fourier filtering, multi-axial March-Dollase preferred orientation, absorption and micro-absorption corrections.
GSAS-II: Chebyshev-style background refinement, automatic background estimation with fixed points and background peaks, and spherical-harmonic texture machinery.
Jana2020: powder profile refinement for X-ray/neutron/TOF data, combined multi-source refinements, symmetry-allowed parameters, constraints/restraints/user equations.
```

Use these as design precedents, not as exact API requirements.
