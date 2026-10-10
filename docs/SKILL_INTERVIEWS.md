# Skill interviews

A skill is the user's method in their own words (`.claude/skills/<name>/SKILL.md`),
read by the in-app Agent and by Claude Code alike. The Rietveld skill came from
interviewing its user; this page is the guide for the next interviews. Each
answer lands in one of three places:

- **the skill's text** — the order, the judgement calls, what to report;
- **code** — a firm rule the app enforces (`src/agent/method.ts`: refused
  until the user lifts it), or a stage of the method's checklist;
- **an eval scenario** (`src/agent/evals/scenarios.ts`) — a request the user
  makes and what a right answer does, so a later change cannot quietly break
  it.

How to run one: ask a few questions at a time, starting from the draft where
there is one ("the draft says X — is that how you do it?"); ask for a recent
dataset the method was used on, and for one time it went wrong. Write the
answers into the skill in the user's terms, mark what is a firm rule, and add
a scenario for each failure they describe. Then show them the diff.

## 1. Powder magnetic structure (`magnetic-analysis`, draft)

The draft follows the app's workflow and the knowledge base. To confirm:

1. Before the magnetic step: must the nuclear structure come from data above
   the ordering temperature, or do you refine it on the ordered data? Which
   nuclear parameters stay fixed while the moments refine?
2. Finding k: do you trust the k-search, index by hand, or start from a known
   k (literature, a single-crystal result)? When several k fit a few
   satellites, how do you choose?
3. Groups or irreps: do you work with magnetic space groups (BNS) or with
   irreducible representations (SARAh / BasIreps style)? Always top-down from
   the maximal groups?
4. Choosing among groups the powder cannot tell apart: what decides — the
   fewest parameters, a single irrep, physics (anisotropy, a known moment
   direction in a related compound), another probe?
5. Moments: which ties do you use by default (equal moments on one element,
   one moment on a mixed site)? When do you allow a moment to differ between
   sublattices?
6. Checks you always make: the moment against the free-ion value, the form
   factor (which one: spin-only, ⟨j0⟩ + ⟨j2⟩ for rare earths), the ordering
   temperature trend?
7. Joint refinement: the order you free nuclear and magnetic parameters in,
   and what you hold fixed (scale against the moment?).
8. What you report, and what you refuse to report (a direction a cubic powder
   cannot fix; a domain population).
9. Firm rules: anything the Agent must never do on this step without asking you?

## 2. PDF (`pdf-workflow`, draft)

1. Instrument resolution: always Qdamp/Qbroad from a standard measured that
   day (Ni, Si), or refined on the sample when no standard exists?
2. The r range you fit by default, and when you fit a short range only.
3. One correlated-motion term: δ2 at low temperature, δ1 at high — your rule,
   or do you decide from the fit?
4. ADPs: isotropic first, anisotropic when? The same ADP for one element?
5. Boxcar scans: box width and step you use; what spread counts as the local
   structure differing from the average?
6. Nanoparticles: when do you free spdiameter, and with which shape?
7. What makes a PDF fit "done" for you (Rw alone is relative)?
8. Firm rules for the PDF page.

## 3. Single crystal (no skill yet)

1. Data: which integration and absorption correction you trust; when you
   reject reflections (I/σ, outliers in the normal-probability plot).
2. Twinning and pseudo-symmetry: how you look for them, and when.
3. The refinement order (scale and extinction, positions, ADPs, occupancies,
   H atoms) and when you go anisotropic.
4. Weighting scheme: the two-parameter SHELX weights, refined when?
5. The checks before calling it done: R1, wR2, GooF, residual density, the
   largest shift/esd, checkCIF alerts you accept.
6. Absolute structure: Flack / Hooft, and what you report.
7. Magnetic single-crystal data: the same skill, or its own?
8. Firm rules.

## 4. Symmetry review (`symmetry-review`, from the report of 2026-10-10)

The rule is already the user's: the space group is changed last, when
everything else is refined. To make it theirs in detail:

1. What counts as "everything refined" for you — the stages in the checklist,
   or also corrections (texture, absorption) and a second phase?
2. The evidence you want before lowering the symmetry: forbidden reflections
   at what significance; split peaks; the misfit pattern?
3. How you test a lower group: refine it from the start, or start from the
   high-symmetry result with the distortion modes? The statistical test you
   use (Hamilton, an F-test, none)?
4. When you would rather report an open question than a lower symmetry.
