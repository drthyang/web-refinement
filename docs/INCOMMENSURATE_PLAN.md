# Incommensurate & multi-k magnetic Rietveld — design

Status: design, **revised after adversarial review** (branch `feat/incommensurate-multik`).
Closes ROADMAP M2 "incommensurate / multi-k handling; a commensurate/incommensurate flag" and
M4 "wire the Fourier model into the powder/single-crystal workflow".

> Revision note: the first draft of this document got three conventions wrong (arm multiplicity,
> the symmetry-expansion phase, the −k conjugation) and justified the FD-step change with an
> argument that measurement disproved. Those are corrected below and the superseded claims are
> named as such, so nobody re-derives them from an old copy.

## 0. Prerequisite: a pre-existing bug in the shipped satellite enumerator — **FIXED**

Found while validating this design; it was **not** caused by the new work, but every validation
gate below runs through this code, so it was settled first.

`magneticSatellites` (`satellites.ts:83-86`) emits both G+k and G−k for every parent. When **2k
is a reciprocal-lattice vector** (k = ½ along every nonzero component — the commonest
commensurate AFM case), those two sets are *identical*: G − k = (G − 2k) + k, and G − 2k is
itself a lattice node. Measured on a P1 test cell, k = (0,0,½): 405 emissions for 203 distinct
nodes. At k = ⅓, ¼ and 0.137 there is no duplication (ratio exactly 1.000).

Two separable symptoms, and they need different responses:

1. **Per-node weights are asymmetric.** The node (0,0,½) accumulates weight 3 (1 from the (000)
   seed + 2 from parent (0,0,1)−k) while its Friedel partner (0,0,−½) gets weight 1. Friedel
   partners must carry equal weight; this is unambiguously wrong, and it is visible to the
   per-reflection consumers (`reflectionTicks`, `obsCalc`).
2. **Per-d totals are uniformly 2×.** Summed over each d-group — which is all a powder pattern
   sees — every group is exactly twice the k = ⅓ analogue. So the powder *pattern shape* is not
   distorted; the error is a factor 2 on the magnetic component.

Consequence for powder: with `magneticScale` free it is absorbed entirely and refined moments are
unaffected. With `magneticScale` fixed at 1 (the default — fully shared with the nuclear scale)
the magnetic component is 2× too strong and least squares compensates by refining moments low by
≈1/√2. This is a strong candidate for the "convention-dependent factor" that `momentModel.ts:13-16`
already warns about for k ≠ 0, and it is invisible to the existing GSAS-II magnitude validation
because that golden (Mn₃Ga 350 K) is k = 0, which returns from the `isK0` branch before this code.

**The naive fix is wrong and was rejected.** Simply skipping the −k arm for self-conjugate k
under-counts: node (½,0,0) is reachable *both* as (000)+k and as (100)−k, so dropping one arm
removes weight the other parent legitimately contributes, and the per-d totals stop being uniform
— trading a pure scale error for a shape error, which is strictly worse.

**The fix as implemented (second iteration).** The first fix halved every arm weight for
self-conjugate k, which is exact in P1 and for single-axis ½ vectors — but a scale-chain audit
found it still miscounts **multi-axis** ½ vectors in richer Laue groups (k = (½,½,½) in Pmmm:
per-d errors of 1.25–1.75×, a *shape* distortion the scale cannot absorb; G-type perovskite AFMs
live exactly there). The mechanism: G + k = G′ − k whenever G′ − G = 2k ∈ ℤ³, and for a
multi-component ½ vector those coinciding arms belong to Laue families of *different*
multiplicities, so no constant arm weight can be right. Since self-conjugate satellites are true
Bragg reflections of a ≤ 2×2×2 supercell, they are now enumerated **exactly**: every parent
expanded to its full Laue star, both arms formed, nodes deduplicated globally, each distinct node
emitted once with weight 1 and |F_M|² evaluated per node. This also *removes* the
representative-only (no cone average) approximation for self-conjugate k — each node carries its
own perpendicular projection. Two-arm (generic and incommensurate) k keeps the representative ×
parent-multiplicity convention, where it was measured exact per-d in orthogonal cells.

**Validation.** `satellites.test.ts` gains a brute-force reference that enumerates every distinct
node G ± k over a full hkl sphere and requires the emitted weight per d-group to match the
distinct-node count, across five k regimes (two self-conjugate, two rational two-arm, one
incommensurate). It is deliberately independent of the enumerator's parent-window and seeding
logic so it cannot inherit the same mistake. Note the existing k = ½ round-trip
(`magneticSimpleAfm.test.ts`) *cannot* catch this class of error and passed both before and after:
it synthesizes and fits with the same forward model, so a uniform factor cancels.

**Measured user impact.** A 2× magnetic-intensity error biases a refined moment by 1/√2, verified
end-to-end on the simple-AFM refinement: 2.1213 vs 3.0000, ratio 1.4142. So refined moments at
self-conjugate k were **low by ≈√2 whenever `magneticScale` was fixed**, and are now correct. With
`magneticScale` free, the error was absorbed and moments were already right.

## 1. Scope

**In scope.** Powder Rietveld against a modulated magnetic structure in the Fourier-coefficient
(Bertaut / FullProf) formalism: one or more propagation vectors **k**, each carrying a complex
coefficient **S** per magnetic sublattice, refined through symmetry-adapted mode amplitudes;
refinable **k**; multi-k as a coherent structure or a population-weighted domain average; a
commensurate/incommensurate flag gating every path that needs a finite supercell.

**Out of scope.** Superspace (3+d) groups and superspace CIF (ROADMAP puts them beyond this arc;
FullProf refines incommensurate magnetism without them). Incommensurate *nuclear* modulation.
Incommensurate mPDF (PDF_MPDF_ROADMAP defers it) — but see §7 for the guard that stops it
silently producing zero. Polarized-neutron chirality separation.

**Single crystal** is not implemented in this arc, and `buildMagneticSingleCrystalProblem` must
**refuse** a Fourier model with a typed error rather than silently returning real-moment
intensities.

## 2. Physics and conventions

Real-space moment of sublattice *j* in the cell at lattice translation **n**:

```
m_j(n) = Σ_{arms in the star} S_j^(k) · exp(−2πi k·n)
```

For a two-arm star (±k distinct) this is 2·(S^Re cos φ + S^Im sin φ), φ = 2π k·n. **The factor 2
is not unconditional**: when −k ≡ k modulo a reciprocal-lattice vector (2k ∈ ℤ³) the star has a
*single* arm, reality forces S real, and m(n) = S·e^{−2πik·n} with **no** factor 2.

**Fixed.** `momentInCell` multiplied by 2 unconditionally — confirmed empirically as reporting a
2 µ_B coefficient as a 4 µ_B moment at k = ½, and doing the same for k = 0 (a ferromagnet).
It now scales by an exported `armMultiplicity(k)`. Risk was nil: the function had no production
consumers. Verified in `fourierCollapse.test.ts` against the ±m alternation, and in
`fourierMoment.test.ts` for k = 0, ½, ¼, ⅓ and incommensurate k.

This is exactly the moment-magnitude convention `momentModel.ts:13-16` flags as unverified for
k ≠ 0. State it in the UI: for a two-arm SDW the quoted amplitude is 2|S^Re|; for k = ½ it is |S|.

Mode content determines the structure type: **S^Re only** → collinear sinusoid (SDW);
**S^Re ⊥ S^Im with equal norm** → circular helix; general → ellipse (cycloid); plus a k = 0 arm →
conical.

Satellite structure factor at **h** = **H** ± **k**:

```
M(h) = p · Σ_j f_j(s) · DW_j(s) · S_j · exp[2πi h·r_j],   I ∝ |M_⊥|²
```

with M_⊥ the Halpern–Johnson projection applied to Re and Im independently. **The −k arm uses
S\***, and this is load-bearing (§5).

**Form factor.** Both existing paths call `table.j0` (spin-only). Incommensurate helices are
overwhelmingly rare-earth systems where the orbital ⟨j2⟩ term is large — for Ho³⁺/Er³⁺ (g ≈ 1.25)
the dipole coefficient (2/g − 1) ≈ +0.6 across the whole d range, absorbed into the refined
amplitude as a bias. `magneticFormFactorDipole` is already implemented in
`scattering/magnetic.ts` and unused. Add `formFactorModel: "spin-only" | "dipole"` (+ Landé g) to
the coefficient, defaulting to dipole for lanthanides, and apply the same fix to the real-moment
path so the two cannot diverge.

### 2.1 Position convention (superseded claim — read this)

**The first draft was wrong.** It called the symmetry-expansion phase "the one hard correctness
question" and claimed the shipped real-moment path lacks the inter-orbit phase. It does not.
`applyOperation` is documented "not wrapped" (`symmetry.ts:134`), and `structureFactor.ts:238`
forms the phase from that unwrapped image p. Since h = H + k and H·L ∈ ℤ,

```
exp(2πi h·p) = exp(2πi h·p_wrapped) · exp(2πi k·L)
```

identically — the `e^{+2πi k·L}` inter-orbit phase is **already there**, which is why the shipped
path produces nonzero |F_M|² at satellites at all, and it already matches the convention in
`allowedMoments.ts:95-103`. A Fourier expansion copied from that code *plus* an explicit phase
would double-apply it.

So this is a **position convention**, not an open question. Pick one and assert it:

- (a) `FourierSite.position` is the **unwrapped** image g(r_j) → apply **no** explicit phase; or
- (b) it is wrapped into [0,1) → apply `S_image = θ·det(R)·R·S·exp(+2πi k·L)`.

Never both. The sign is `+`, derived, not deferred to a gate. And the real reason the shipped
path is limited is that **S is real** — a collinear amplitude-modulated wave, which may perfectly
well be incommensurate — not that a phase is missing.

**Verified** in `fourierCollapse.test.ts`: with real S, both conventions reproduce
`magneticStructureFactor` to 10 decimal places at every satellite index tested, on a structure
with a nonzero returning translation (site at (0.3,0.1,0) under inversion, k·L = −½). Omitting
the phase under convention (b) is an ~89% intensity error (14.43 vs 7.61), so the phase is
genuinely load-bearing rather than accidentally cancelling — note a site at x = ¼ *does* make it
cancel, which is why the test deliberately avoids that special position.

### 2.2 Multi-k: what a powder can and cannot distinguish

Distinct arms **never interfere**: two arms share a reflection index only if k_a − k_b ∈ ℤ³,
which makes them the same arm. So the first draft's "coherent arms interfere at coincident
satellites" is vacuous.

The honest statement: **a powder cannot separate a coherent multi-k structure from a k-domain
average using satellite intensities alone.** Coherent {k₁,k₂} with coefficient S and a two-domain
model with p = ½, S′ = √2·S give an identical pattern. The only discriminator is the *real-space
moment-magnitude sum rule* — coherent arms superpose on the same site (up to 4|S|), domains do
not. The coherent branch therefore earns its place by carrying that sum rule as an **actual
constraint** (a |m| tie / saturation bound across arms), not by any interference logic.

**Domain populations are degenerate with amplitudes.** Only the product p_a·A_a² is observable,
so p and A form a one-parameter family unless the arms' amplitudes are **tied** — which is the
physical case, since arms of one star are symmetry-equivalent. Populations are therefore only
meaningful under that tie, and it must be implemented (via the existing `resolveTies`), with
N−1 free populations and the last as 1 − Σ. For arms that are not star-related, drop the
population entirely and let the per-arm amplitude carry the weight.

**Harmonics.** A squared-up SDW's 3k/5k arms are additional k entries, but they must be *tied* to
the fundamental (`harmonicOf: { armIndex, order }` resolved through `resolveTies`) or refining k
desynchronizes them.

## 3. Data model

Extend, do not replace: the Fourier representation is an optional field, and its presence
switches the engine onto the Fourier path.

```ts
interface FourierCoefficient {
  readonly siteLabel: string;
  readonly orbitIndex?: number;
  readonly sReal: Vec3; readonly sImag: Vec3;   // crystal-axis μ_B
  readonly formFactorId?: string;
  readonly formFactorModel?: "spin-only" | "dipole";
  readonly landeG?: number;
  readonly position?: Vec3;
}
interface FourierArm {
  readonly k: PropagationVector;
  readonly coefficients: readonly FourierCoefficient[];
  readonly population?: number;                  // only under the amplitude tie (§2.2)
  readonly harmonicOf?: { armIndex: number; order: number };
}
interface MagneticModel {
  readonly fourier?: { arms: readonly FourierArm[]; combination: "coherent" | "domains" };
}
```

**Authority and legacy degradation.** `moments.length > 0` is the app's universal "is there
magnetism" predicate at **19 non-test sites** — a pure-Fourier model with `moments: []` makes the
magnetic curve vanish from the plot, downgrades mCIF export to CIF, empties the F_obs
decomposition, and makes an MCP tool report the magnetic component as identically zero, all while
the engine happily fits it. Therefore:

- `moments` always carries the **derived n = (0,0,0) real moment**, so legacy consumers degrade to
  a documented approximation rather than to nothing.
- Add one exported `hasMagneticContent(model)` predicate and replace all 19 gates mechanically,
  with a grep-guard test.
- `propagation` is rebuilt from `arms` on every apply; add `magneticArms(model)` so `propagation[0]`
  (7 non-test readers today, each silently truncating multi-k to arm 1) disappears from the code.
- Derived models must not carry a stale `fourier`: `workflow/magnetic.ts:61`, `export/cif.ts:417`,
  `mpdf.ts:330` and `App.tsx:151` all build models by object spread. Add `withoutFourier(m)` and a
  test that no derived model carries a `fourier` whose k disagrees with its `propagation`.

**Commensurability is already shipped.** `core/magnetic/propagation.ts` holds
`classifyPropagation` (zero / commensurate / incommensurate, self-conjugacy, arm factor) plus
`componentDenominator` / `kDenominators` / `jointDenominators` (the last handles the multi-k
joint cell via componentwise LCM with a `maxCells` refusal — use it for §2.2's joint
supercell). `magneticSupercell.ts` and `cellExpansion.ts` already route through it. Note it
unified the *decision* only: the `cellExpansion` display policy still returns 1 along an
incommensurate axis, deliberately, until Phase F.

## 4. Parameters and bindings

New kinds: `fourierMode` (complex mode amplitude), `propagationX/Y/Z`, `domainPopulation`.
`ParameterBinding` gains `fourierBasis?: { sReal, sImag }` and `armIndex?`.

**There is an exact gauge freedom that must be fixed.** S_j → S_j e^{iψ} for every sublattice of
an arm leaves |M_⊥|² identical, so each arm contributes exactly one null direction in JᵀJ whenever
both Re and Im amplitudes are free. It does not fail loudly — every column has leverage, so only
the SVD pseudo-inverse truncates it, and the reported esds then come from a rank-deficient
Hessian while the staged guard starts re-fixing legitimate amplitudes at |ρ| ≥ 0.998. Fix it the
way FullProf does: **pin one sublattice's S^Im to 0 per independent arm**. Only a k = 0 arm or a
second arm makes any remaining phase physical. (The first draft's "a helix's single refinable
phase" was precisely the *unrefinable* quantity for a one-arm structure.)

**Amplitude+phase is a derived, read-only report**, computed from the refined (Re, Im) pair. The
engine has no periodic-parameter support: `clamp` hard-clamps (a phase optimum across the branch
cut would rail at ±π forever), the relative-shift metric explodes near 0, and the FD step |φ|·1e-5
is dimensionally wrong. Making it refinable is a separate engine change, not a UI toggle.

`fourierMode` is **non-linear**: S is linear in the pair amplitudes (which is why that
parameterization conditions better than |S|,φ), but the observable |M_⊥|² is quadratic. It must
not be added to `LINEAR_KINDS` or set `linear: true` — matching the shipped `momentMode`.

**Register the new kinds in one place.** They are needed in at least five, only one of which the
compiler enforces: `MAGNETIC_GEOMETRY_KINDS` (cache key), `MAGNETIC_BINDING_KINDS` (multi-phase
routing — magnetic bindings target `<id>-mag`, which `phaseBindingsFor` drops, and **the bundled
demo is multi-phase**, so missing this gives every new parameter a Jacobian column that cannot
move the model), `mcp/tools.ts` `HOLD` (untyped `Set<string>`), and `ParameterPanel`'s `CATEGORY`
(a total `Record<ParameterKind,…>` — a hard typecheck failure) and `ORDER`. Create a magnetic-kind
registry mirroring the existing correction-registry pattern, derive all consumers from it, and
test that every magnetic kind appears in each derived set.

**Apply has no model-level branch today.** `applyMagneticMoments` only writes `moments` and skips
bindings without `targetKey`, so a refined k would be inert. Phase A adds the model-level branch
plus a unit test asserting `applyMagneticMoments(model, bindings, {kz: 0.31}).propagation[0][2] === 0.31`
*before* any refinement gate runs.

## 5. Powder wiring

**The branch belongs one level down.** `unitMagneticIntensities` is one of five places that
recompute magnetic intensity from real moments; the others are `obsCalc.ts:189` (F_obs/F_calc),
`reflectionTicks.ts:84` (tick rows), `workflow/magnetic.ts:97` (single crystal) and
`expandMagneticAtoms` → the GPU kernel. Branching only in the powder path would put satellites in
the fit that the ticks and the F-plot do not have — breaking the single-enumerator invariant
`satellites.ts:1-8` exists to enforce.

Introduce `magneticSatelliteIntensities(structure, magnetic, radiation, dMin, dMax)` in
`core/magnetic/`, holding the `if (!magnetic.fourier)` switch, and route `magneticPowder`,
`obsCalc` and `reflectionTicks` through it **in Phase B, not Phase E**. The GPU path, single
crystal, mPDF and mCIF **refuse** a Fourier model with a typed error until their phase lands.

Per arm: enumerate satellites → expand coefficients over the magnetic subgroup ops (§2.1 convention,
orbit dedup, split-orbit anchoring) → evaluate → weight by LP and multiplicity.

- **Tag every satellite with its arm sign** and either conjugate (sImag → −sImag) for the −k arm
  or evaluate the +k formula at the negated index. `fourierMagneticStructureFactor` takes only
  (sites, index) and cannot know which arm it is on. This is invisible for real S and a **factor
  ~17** for a two-sublattice complex S — exactly the helix case being built.
- **Debye–Waller is s-dependent.** `FourierSite` must gain `adp: DisplacementParameters` (matching
  `ExpandedMagneticAtom`) and DW must be evaluated *inside* the structure factor from the index,
  which already derives s. A per-site scalar would freeze it at one d. Without DW at all, the
  Fourier and real-moment paths disagree at low d and bias moments low.
- Combination: `domains` sums intensities with normalized populations under the amplitude tie;
  `coherent` shares the |m| sum rule (§2.2).

## 6. Refinable k

Off by default. The **cache key is the real blocker**: `propagationX/Y/Z` and `fourierMode` must
join `MAGNETIC_GEOMETRY_KINDS`, or the FD perturbation of k reuses the cached satellite list and
returns an identically-zero column.

**Superseded claim.** The first draft argued the engine's FD step (`h = max(1e-6, |p|·1e-5)`,
so ~3e-6 for k = 0.3) is too small and would give a noise-dominated derivative. Measurement on the
shipped Mn₃Ga example disproves this: engine default h gives relative error **1.9e-6** against a
Richardson extrapolation, while the proposed h = 1e-4 gives **2.7e-5** — 14× *worse* — with no
noise floor down to 1e-7. The profile is analytic in peak position. **Drop the per-kind FD step as
a requirement.** The genuine k-specific hazard is different: the satellite *list* is a step
function of k (its count changed at h = 1e-2), so the FD probe must assert `magneticSatellites`
returns the same list at ±h. If any override survives it is a step *floor* for a k component
sitting at exactly 0, justified by a measured scan and promoted to a real test.

**Starting values and staging** (absent from the first draft, and the part most likely to make
this unusable in practice):

- `kSearch` is commensurate-only (denominators [2,3,4,6]); for an incommensurate k the nearest
  candidate can be several satellite widths away. Add a **continuous k-seeding scan**: freeze
  everything else, scan the symmetry-free k components on a fine grid, take the χ²(k) minima,
  hand the best to LM. Surface it through the existing `search_propagation_vector` MCP tool.
- Restrict which components are refinable using the shipped `littleGroup` — refining a component
  the k-label fixes is a guaranteed singular direction.
- Multi-start's kick is *relative*, hence exactly 0 for a k component seeded at 0; give the k
  kinds an absolute kick.
- **k correlates with the profile width when the ±k splitting is unresolved**: measured
  cos(∂I/∂k, ∂I/∂peakWidth) = 0.0089 at k = 0.3 but **0.828 at k = 0.01** — below the engine's 0.95
  reporting threshold, so it would pass silently. Free k **last**, after the nuclear structure and
  profile are converged and frozen, never in the same block as the Caglioti/TOF width terms, with
  Fourier amplitudes getting their own stage first. `DEFAULT_STAGE_KINDS` contains no magnetic
  kinds and stage-less kinds are never freed, so this needs an explicit magnetic stage plan.
  (This matches the user's own methodology skill, where the external cross-check terminates the
  loop.)

## 7. UI, I/O, 3D

- Commensurate/incommensurate indicator from `classifyPropagation(k).kind`; modulation type expressed as *mode
  content* (a helix is two quadrature modes tied to equal amplitude), not a separate model.
- Complex mode rows per arm × sublattice, with the derived amplitude/phase shown read-only.
- k refine checkboxes; multi-k arms with populations; per-arm satellite ticks.
- `KSearchPanel` is **one shared component mounted by all three workbenches**, including the PDF
  one. Add an `allowModulated` capability prop that the PDF mount sets false, with a visible
  "incommensurate mPDF not supported" note — otherwise a Fourier model built there yields an
  identically-zero d_mag(r).
- The irrep route's `complex-phase` dead end becomes a route *into* the Fourier flow.
- **mCIF**: parse/write `_cell_wave_vector_*` and `_atom_site_moment_Fourier*`. `cif.ts:410`
  hardcodes `propagation: [[0,0,0]]`, so every parsed magnetic model claims k = 0 regardless of
  file content — a straight bug fixed here. Supercell export **refuses** incommensurate k with an
  explanation. Move these refusals to Phase A/B (they need only `classifyPropagation`): today an
  incommensurate k silently writes the *parent* cell with unmodulated moments and a comment.
- **3D**: `displayMoment`'s phase argument is `2πk·(latt + n)`, but with `S_image` carrying
  `e^{+2πik·L}` the correct argument is `2πk·(n − L)`. The two agree only when 2k·L ∈ ℤ — always
  true at k = ½, which is why it has never shown. Fix the sign *before* adding the quadrature
  term, or the helix winds backwards. Implement the aperiodic window as a **new** function rather
  than by changing `cellExpansion.magneticSupercell`, so the out-of-scope mPDF path keeps its
  numerics byte-for-byte.
- Multi-start canonicalization derives its global sign from `magnetic.moments`; extend it to
  Fourier coefficients and canonicalize the chirality twin (S^Im → −S^Im), or identical structures
  cluster as distinct solutions.

## 8. Validation gates

1. **(a) Inter-cell phase** vs `buildModulatedMomentModel` with an explicitly **non-zero**
   `ion.phase`, compared per-reflection on |F_M|² at matched (h,k,l) *before* multiplicity and LP,
   with the supercell's N² factor divided out. Note the first draft's version of this gate could
   not have worked: the reference uses `cos(2πk·L + phase)` with default phase 0, and cos is even
   in k, so flipping the sign convention leaves it bit-identical.
   **(b) A hand-enumerated two-sublattice helix** in a commensurate supercell that the parent-cell
   Fourier symmetry expansion must reproduce. Only 1(b) settles the §2.1 convention and the S*
   handling. **Phase B must not merge on 1(a) alone.**
2. **Real-S reduction**: with S^Im = 0 and a collinear structure, the Fourier path equals the
   existing real-moment path. Guarantees zero regression for shipped refinements.
3. **Friedel invariant** |M_⊥(H+k)|² = |M_⊥(−H−k)|², *plus* the discriminating half: the naive
   non-conjugated evaluation at H−k must **fail** it for a complex multi-sublattice S. (The first
   draft's "+k/−k centro-related pair" was ill-posed — H+k and H−k are different reflections at
   different d.) Circular helix has cell-independent |m|; an SDW does not.
4. **Round-trip refinement** with **Poisson counting noise** so reduced χ² ≈ 1 — the engine scales
   covariance by reduced χ², so on a noise-free pattern esd → 0 and any "within esd" test is
   unsatisfiable. Require a stated absolute tolerance on amplitudes and k (~1e-3 r.l.u.), then a
   ≤3 esd check, and require that k does **not** appear in `diagnostics.singularParameterIds`.
   Report k↔profile and k↔cell correlations unconditionally.
5. **Multi-k**: recover population *ratios* under the amplitude tie; assert `svdZeroCount` does
   not grow. Assert one singular direction per arm when the §4 gauge fix is *removed*.
6. **Analytic-vs-FD** for any kind claiming an analytic derivative (existing project gate).
7. **mCIF round-trip**; `npm run typecheck` + full suite; multi-phase routing regression test.
8. **External golden — blocking for Phase G.** A published helical structure with
   FullProf-calculated satellite intensities. With four independent convention traps in this area
   (arm multiplicity, the factor 2, S*, the phase), self-consistency gates cannot be sufficient
   evidence: gates 4 and 5 use the same forward model for data and fit.

## 9. Known limits to state in the docs

- Unpolarized powder cannot determine **vector chirality**; the model can carry it, the data
  cannot refine it.
- Powder cannot separate **coherent multi-k from a k-domain average** (§2.2).
- For **two-arm** k the magnetic intensity uses the perpendicular projection of the
  **representative** reflection of each family with no cone average over symmetry-equivalent Q
  (`magneticPowder.ts:10-13`) — far more damaging for a helix/cycloid than for a collinear
  structure, since the equivalents H_i+k have genuinely different M_⊥ orientations. Either
  implement the Laue-equivalent average or name it here; the self-consistency gates cannot detect
  it. (**Self-conjugate k is now exempt**: §0's exact node enumeration evaluates every node
  individually, so no representative approximation remains there.)
- For two-arm k, satellite multiplicity is the parent-Laue **star-of-k approximation** (§0).
- The powder intensity formula carries no 1/V² (scale absorbs it — audited); harmless for the
  magnetic:nuclear ratio since both live on one cell, but it means multi-phase scale ratios are
  NOT phase fractions without a Z·M·V conversion, which the app (correctly) never claims to
  provide.
- SDW vs helix can be hard to separate from powder at low amplitude without the harmonics.
- No superspace groups; constraints come from the little group / irrep route.

## 10. Phase plan

| Phase | Content | Gate |
|---|---|---|
| A | Data model, `hasMagneticContent` + 19 call sites, magnetic-kind registry, model-level apply, `allowedFourierCoefficients`, incommensurate export/3D refusals | typecheck, apply test, multi-phase routing test |
| B | Symmetry expansion + arm sign/S\* + DW, shared `magneticSatelliteIntensities` wired into powder/obsCalc/ticks, arm combination | gates 1(a)+1(b), 2, 3, 5 |
| C | Refinable k, continuous k seeding, staging plan, multi-start kick | gates 4, 6 |
| D | Complex irrep basis modes (see below — partly pulled into A) | mode-count tests |
| E | UI: indicator, modulation types, complex rows, multi-k, `allowModulated` | preview verification |
| F | mCIF Fourier loops, 3D quadrature + phase-sign fix + aperiodic window | gate 7 |
| G | MCP tools, docs, adversarial branch review | full suite + gate 8 |

**Pulled forward into Phase A:** `allowedFourierCoefficients(ops, position, k)`.
`allowedMomentDirections` adds imaginary rows `sin·θ·det(R)·R·m = 0`; R is invertible, so any
stabilizer op with sin(2πk·L) ≠ 0 forces **m = 0** — correct for a real moment, wrong for a complex
S, whose constraint is the single complex equation e^{2πik·L}θdet(R)R·S = S on the 6-real-dimensional
(S^Re, S^Im) space. `momentModel.ts:203` then drops the sublattice entirely. *This*, more than the
`isotropy.ts` refusal, is why the incommensurate route currently looks like a dead end, and
Phases A/B cannot use the real basis for a complex arm. Gate: dimension ≥ the real one for every k,
reducing to the real basis when every k·L is integer. Call sites to route through it:
`buildMagneticModel`, the KSearchPanel DOF ranking, the `allowed_moments` MCP tool, and
`magneticCompare`.

## 11. Resolved decisions

**§0's enumerator fix — done, standalone, before the feature work.** It raises refined moment
magnitudes at self-conjugate k by ≈√2 whenever `magneticScale` is fixed. Any moment previously
quoted from a k = ½-type refinement in this app with a fixed magnetic scale was low by that factor
and should be re-refined. Refinements at k = ⅓, ¼, incommensurate k, or k = 0 are unaffected, as
are any refinements that freed `magneticScale`.

Still open, and deliberately not bundled into that fix: the **star-of-k multiplicity
approximation** itself (§9), which is what would make per-node satellite weights individually
meaningful rather than a per-d-group bookkeeping weight.
