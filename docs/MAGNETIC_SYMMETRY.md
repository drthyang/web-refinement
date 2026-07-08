# Magnetic symmetry analysis — the two routes

To determine and refine a commensurate magnetic structure you need the allowed
**magnetic order parameters** for a given propagation vector **k**. There are two
standard, complementary routes, and the workbench is building **both** (the user
explicitly wants both — Jana2020 leans on irreps, FullProf on the magnetic space
group / basis vectors):

| Route | Also called | Tools that use it | Status here |
|---|---|---|---|
| **A. Magnetic space group** | Shubnikov / coordinate / basis-vector | FullProf, ISODISTORT, Bilbao k-SUBGROUPSMAG | **working** (see below) |
| **B. Representation analysis** | irreps / small representations | Jana2020, BasIreps, SARAh | **foundation working**, irrep tables next |

Both start from the **little group of k**, `G_k = { g ∈ G : R_gᵀ·k ≡ k (mod reciprocal lattice) }`
([`littleGroup`](../src/core/magnetic/magneticGroups.ts)).

---

## Route A — magnetic space group (coordinate / Shubnikov) ✅

Enumerate the **magnetic subgroups** of `G_k` by assigning a time-reversal sign
θ: G_k → {±1} to each coset (a GF(2) homomorphism), giving the parent (type I)
group plus one type-III group per index-2 subgroup
([`generateMagneticCandidatesForK`](../src/core/magnetic/magneticGroups.ts)). For
each candidate, the **symmetry-allowed moment directions** on a site are the
null space of `{ θ_g·det(R_g)·R_g − I }` over the site stabilizer
([`allowedMomentDirections`](../src/core/magnetic/allowedMoments.ts)) — these are
the refinable moment modes (the "coordinates"/basis vectors FullProf refines).
This route drives the moment model + refinement
([`buildMagneticModel`](../src/core/magnetic/momentModel.ts)).

**Tested:** k=0 candidate set (P2₁/m → P2₁'/m'), allowed-moment dimensions, the
simple-AFM recovery ([`magneticSimpleAfm.test.ts`](../src/core/workflow/magneticSimpleAfm.test.ts)).

**Not yet:** standard **BNS/OG labels** (see below).

---

## Route B — representation analysis (irreps) 🚧 foundation done

The magnetic representation `Γ_mag = Γ_perm(k) ⊗ Γ_axial` on the magnetic atoms
decomposes into the irreps of `G_k`; each irrep that appears carries a set of
**basis vectors** (magnetic modes), and refining a structure means refining the
amplitudes of one (or a few) irreps. This is the Jana2020 / BasIreps route.

**Implemented + tested** ([`magneticRepresentation.ts`](../src/core/magnetic/magneticRepresentation.ts)):
- `axialCharacter(R) = det(R)·tr(R)` — a moment is an *axial* vector (E→+3,
  2-fold→−1, mirror→−1, inversion→+3).
- `magneticRepresentationCharacter(structure, k, sites, G_k)` — the character
  `χ_mag(g) = χ_axial(R_g)·Σ_{atoms fixed mod lattice} e^{2πi k·L}` (Bertaut 1968).
- `irrepMultiplicity(reducible, irrep) = (1/|G|) Σ χ·χ*` — the standard
  decomposition. Verified against hand-computed cases: P1 → 3× trivial (3 DOF),
  C2 → A + 2B (Mz = A, Mx,My = B), inversion → 3 Ag (0 Au).

**Remaining (the "irrep tables"):**
1. **Irrep character tables of `G_k`.** For k = 0 and symmorphic little groups the
   irreps are the point-group irreps of the little co-group. General point-group
   tables (32 groups) plus, for non-symmorphic groups at BZ-boundary k, the
   **projective small representations** (phase factors `e^{-2πi k·τ}`) are needed
   — Bradley & Cracknell Ch. 3–4. Abelian little groups (triclinic/monoclinic/
   orthorhombic, and any general-k) have 1-D irreps generable directly; the
   non-abelian ones need tabulated characters.
2. **Basis-vector projection** per irrep (projection operators) to list the modes
   for refinement, and the **image** (magnetic space group) each irrep maps to —
   the bridge back to Route A.

---

## BNS / OG labels ❌ (needs standard tables)

Candidates are currently labelled by *which operations are primed* (e.g.
"type III · primed: 2₁, m"), not by the standard **Belov–Neronova–Smirnova (BNS)**
or **Opechowski–Guccione (OG)** symbols (e.g. `P2₁'/m'`). Producing those requires
matching the generated group to the tabulated 1651 Shubnikov groups — data that
must come from an authority, not be re-derived:
- **Bilbao MAGNEXT / k-SUBGROUPSMAG / MGENPOS** (cryst.ehu.es),
- **ISO-MAG / ISOTROPY** (stokes.byu.edu), or
- the printed BNS/OG tables.

Plan: bundle the (public) label table keyed by the generator set, and look up the
BNS symbol for each generated magnetic subgroup. **Do not hand-transcribe labels**
— a wrong symbol is worse than none.

---

## Continuation plan (ordered)

1. Abelian-`G_k` irrep generator (correct by construction) → irrep decomposition
   in the UI for triclinic/monoclinic/orthorhombic and general-k cases.
2. Non-abelian point-group character tables (verified, cited) for the remaining
   crystal classes; projective small reps for non-symmorphic BZ-boundary k.
3. Basis-vector projection per irrep + irrep→magnetic-space-group image (link the
   two routes).
4. BNS/OG label lookup from a bundled standard table.

## References

- Bertaut, E. F. (1968). *Acta Cryst.* **A24**, 217 (magnetic representation).
- Bradley, C. J. & Cracknell, A. P. (1972). *The Mathematical Theory of Symmetry
  in Solids* (little groups, small representations).
- Rodríguez-Carvajal, J. & Bourée, F. (2012). BasIreps, *EPJ Web Conf.* **22**, 00010.
- Perez-Mato, J. M. et al. (2015). *Annu. Rev. Mater. Res.* **45**, 217 (Bilbao magnetic tools).
- Bilbao Crystallographic Server, magnetic section: <https://www.cryst.ehu.es/>.
