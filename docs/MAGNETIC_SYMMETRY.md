# Magnetic symmetry analysis

To refine a magnetic structure, the workbench needs the moment arrangements that
symmetry allows for a propagation vector **k**. It finds them by two standard
routes, which both start from the little group of k and feed one moment model.

| | Route A — magnetic space groups | Route B — representation analysis |
| --- | --- | --- |
| Used by | FullProf, ISODISTORT, Bilbao k-SUBGROUPSMAG | Jana2020, BasIreps, SARAh |
| Gives | candidate Shubnikov groups and their allowed moments | irreps, their basis modes, and the group they imply |

What works and what is missing is listed under Symmetry and Magnetic structures
in [LIMITATIONS.md](./LIMITATIONS.md#symmetry). The tests are in
[VALIDATION.md](./VALIDATION.md), and [USER_GUIDE.md](./USER_GUIDE.md) explains
the magnetic page.

## Terms

| Term | Meaning |
| --- | --- |
| Little group G_k | The operations of the parent group G with Rᵀ·k ≡ k modulo a reciprocal-lattice vector. Their distinct rotations form the co-group Ḡ_k. |
| Grey group G_k·1′ | G_k with and without time reversal 1′: the paramagnetic symmetry. |
| Types I–IV | I: no time reversal. II: grey. III: time reversal on half the operations. IV: has an anti-translation, a lattice translation with time reversal. |
| Isotropy subgroup | The operations, with or without time reversal, that leave an order parameter unchanged. |
| Kernel, epikernel | The isotropy subgroup of an irrep in a generic direction (kernel) or a special one (epikernel). Only multidimensional irreps have epikernels. |

## Route A — magnetic space groups

**How it works**

A candidate is a subgroup of the grey group that lacks 1′ itself. Because the
enumeration keeps the parent lattice, each candidate is a pair (H, θ):

- H is a subgroup of G_k with every lattice and centring translation.
- θ: H → {±1} is a homomorphism that marks time reversal. The trivial θ gives
  type I, and any other θ gives type III.

Its index in the grey group is 2·|Ḡ_k| / |H̄|, where H̄ is the co-group of H. The
largest candidates have index 2.

Like k-SUBGROUPSMAG (Perez-Mato et al. 2015), the workbench lists every pair, not
only those of index 2 ([`subgroupLattice.ts`](../src/core/magnetic/subgroupLattice.ts)).
Subgroups come from breadth-first closure of generator sets, which is exhaustive,
and each θ from a linear system over GF(2). Conjugate candidates are one ordering
in different domains, so each conjugacy class is listed once, with its domain
count.

**Supported**
- Verified counts: 2/m gives 5 subgroups and 11 candidates, and mmm gives 16 and
  51. In 4mm, each pair of conjugate mirror subgroups forms one class with 2
  domains ([`subgroupLattice.test.ts`](../src/core/magnetic/subgroupLattice.test.ts)).
- At k = 0, P2₁/m gives four index-2 candidates, including the Mn₃Ga ground
  state P2₁′/m′ ([`magneticGroups.test.ts`](../src/core/magnetic/magneticGroups.test.ts)).

**Not yet**
- Type-IV candidates, planned with the star of k. They turn some lattice
  translations into anti-translations, a kind of step the lattice omits
  (Hermann 1929).

### Allowed moment directions

An operation g sends an axial moment m to θ_g·det(R_g)·R_g·m. A site's allowed
moments solve e^{2πi k·L}·θ_g·det(R_g)·R_g·m = m for each g that maps the site
onto itself up to a lattice translation L. The null space gives the refinable
modes ([`allowedMoments.ts`](../src/core/magnetic/allowedMoments.ts)).

For distinct ±k arms, the condition applies to the Fourier coefficient
S = ½(M^cos + i·M^sin). A mode with a nonzero sine part is then a helical or
elliptical coupling that symmetry forces.

### Split orbits

A k ≠ 0 little group or a lower-symmetry candidate can split a site's orbit. No
magnetic operation links the split orbits, so each is an independent sublattice
with its own modes. A split orbit with no allowed direction carries no moment.

The model identifies each sublattice by its orbit number, not by a stored
position, so the sublattice follows the refined site
([`orbitSplitting.test.ts`](../src/core/magnetic/orbitSplitting.test.ts)).

### Moment sizes

The model scales each mode to unit Cartesian length, so one unit of amplitude is
1 µ_B along the mode in any cell ([`momentModel.ts`](../src/core/magnetic/momentModel.ts)).
Crystal components would not do: the raw mode (−1, 1, 0) is √3 µ_B long in a
hexagonal cell. By default only symmetry constrains the amplitudes. Equal sizes
on different sublattices are a physical prior, not a symmetry requirement.

**The equal-|M| tie** adds that prior as an option, per element or across all
selected sites, with optional antiparallel flips. The sublattice with the most
modes is the reference:

- **Same mode geometry.** A sublattice shares the reference's amplitudes through
  its own modes.
- **One allowed mode.** Its amplitude is ±hypot(reference amplitudes). The
  reference's modes are first made orthonormal in the Cartesian metric, so the
  hypot is exactly |M|.

In Mn₃Ga, Cm′cm′ splits the Mn 6h orbit in two. Orbit 1 keeps the modes Mx and
Mx+2My, and orbit 2 follows |M(orbit 1)|
([`momentMagnitudeTie.test.ts`](../src/core/magnetic/momentMagnitudeTie.test.ts)).

**Not yet**
- Tying multi-mode sublattices of different geometry, which needs direction
  angles. They are reported as skipped.
- The derived tie for distinct ±k arms: a complex amplitude has no single size.
  Same-geometry sublattices still share amplitudes.

### Choosing among candidates

An ordered phase usually keeps a maximal subgroup of the paramagnetic group
(Landau theory, k-SUBGROUPSMAG practice, ITA Vol. A1). Test the maximal
candidates first, and descend the lattice only when none fits.

Powder data often cannot separate symmetry-distinct models, because only the
moment component perpendicular to Q scatters and orientations are averaged
([direction ambiguity](../knowledge/magnetic_structure_symmetry_knowledge.md), §9).
Ties are therefore expected. Among tied fits, prefer the maximal subgroup (lowest
index) with the fewest moment parameters.

On unpublished AWO₄ 6 K data with k = (½, 0, 0), five candidates tie at wR 7.45 %
with the nuclear model fixed: P2/c′, P-1′, Pc′, P2 and P1. The rule picks P2/c′,
of index 2 with two moment parameters. The magnetic page ranks candidates by this
rule, as [USER_GUIDE.md](./USER_GUIDE.md) describes.

## BNS and OG labels

**How it works**

A magnetic group is its operation set, so naming one is exact matching of a
signature: rotation, translation modulo the lattice, and time reversal
([`bnsOg.ts`](../src/core/magnetic/bnsOg.ts)). A match gives the
Belov–Neronova–Smirnova (BNS) and Opechowski–Guccione (OG) numbers and symbol,
such as P2₁′/m′, BNS 11.54, OG 11.5.63. Otherwise the candidate keeps a label of
its primed operations, because a wrong symbol is worse than none.

[`gen_bns_og_table.py`](../scripts/gen_bns_og_table.py) generates the table:

- **Contents.** The 230 type-I and 674 type-III groups. For these types the OG and
  BNS symbols agree, and only the numbers differ.
- **Source.** ISO-MAG data (ISOTROPY Software Suite) via pymatgen-core, compiled
  from Litvin (2013) and Bradley & Cracknell (1972). No label is typed by hand.
- **Checks.** Every entry has an unprimed identity, the right primed count,
  closure, a unique signature, and matching OG and BNS symbols.
- **Setting.** Standard BNS: unique axis b with cell choice 1, hexagonal axes for
  trigonal groups, origin choice 2.

**Setting search.** Subgroups often come in non-standard settings, such as a
2-fold axis along a or an off-origin inversion centre. The search applies ITA
basis changes, R′ = P⁻¹RP and t′ = P⁻¹(Rp + t − p) (ITA Vol. A §1.5), and still
requires an exact match. It tries the 24 proper signed axis permutations, alone
and composed with three orthohexagonal C-centred cells (det P = 2), each with
¼-grid origin shifts. The label then reports the transformation used.

The C-centred cells name orthorhombic and monoclinic subgroups of hexagonal
parents, such as Cmcm and C2/m under P6₃/mmc. The lattice, the isotropy result
and the mCIF writer all use the search.

**Supported**
- All 904 groups re-identify from their own operations. The four P2₁/c
  candidates get their numbers, and parents 14, 216 and 225 yield exactly their
  tabulated groups ([`bnsOg.test.ts`](../src/core/magnetic/bnsOg.test.ts)).
- The search recovers an a-unique P2/m and an off-origin P-1, with primes kept.
  Under P6₃/mmc it names Cmcm and C2/m (Nos. 63 and 12) and type-III
  orthorhombic groups ([`bnsOgSetting.test.ts`](../src/core/magnetic/bnsOgSetting.test.ts)).

**Not yet**
- Type-II and type-IV groups. Widening the generator's `MAGTYPES` filter is not
  enough, because its checks and the table's row type assume types I and III.
- Rhombohedral↔hexagonal settings (det P = 3) and monoclinic cell choices 2 and 3.

## Route B — representation analysis

**How it works**

The magnetic representation Γ_mag = Γ_perm(k) ⊗ Γ_axial describes how G_k acts on
the atoms' moments. Its irreps carry the basis vectors, or magnetic modes, whose
amplitudes a refinement fits
([`magneticRepresentation.ts`](../src/core/magnetic/magneticRepresentation.ts)).

The character is χ_mag(g) = χ_axial(R_g)·Σ e^{2πi k·L}, over the atoms that g
returns to their own position up to a lattice translation L (Bertaut 1968). For
an axial vector, χ_axial(R) = det(R)·tr(R): +3 for E and inversion, −1 for a
2-fold axis or a mirror. An irrep Γ appears n = (1/|Ḡ_k|)·Σ χ_mag(g)·χ_Γ(g)*
times. Hand checks: P1 gives 3 × trivial, C2 gives A + 2B, and inversion gives
3 Ag and no Au.

### Irreps by construction

No irrep table is transcribed.

- **Abelian co-groups, any k.** A product of cyclic groups ⟨g₁⟩ × … × ⟨gₘ⟩ has
  the 1-D irreps ∏ exp(2πi·pₖ·aₖ/nₖ). This covers every abelian class, from
  triclinic to hexagonal, and the little group of a general k
  ([`irreps.ts`](../src/core/magnetic/irreps.ts)).
- **Any co-group, k = 0.** Crystallographic point groups have order 2^a·3^b and
  are solvable, so irreps are induced up a chain of prime-index normal subgroups
  (Clifford theory; Serre 1977, §8–9). A result that fails Σ dim² = |G| or
  character orthogonality throws
  ([`pointGroupIrreps.ts`](../src/core/magnetic/pointGroupIrreps.ts)).

At k = 0 the ordinary irreps are the small representations, even for
non-symmorphic groups, because every e^{2πi k·τ} is 1 (Bradley & Cracknell 1972,
Ch. 3). Route B therefore works at k = 0 for every parent. The dimensions match
the classical tables:

| Co-group | Irrep dimensions |
| --- | --- |
| 4mm | 1, 1, 1, 1, 2 |
| 432 | 1, 1, 2, 3, 3 |
| m-3 | six of 1, with complex pairs; two of 3 |
| m-3m | 1, 1, 1, 1, 2, 2, 3, 3, 3, 3 |
| 6/mmm (Mn₃Ga) | eight of 1, all real and matching the eight index-2 candidates; four of 2 |

Basis modes come from the projection Σ χ_Γ(g)*·e^{2πi k·L}·det(R_g)·R_g over the
operations that fix a reference site. For a real 1-D irrep, they span exactly the
allowed moments of the matching Route A candidate, as checked for C2 and Pnma 4b
([`irrepsValidation.test.ts`](../src/core/magnetic/irrepsValidation.test.ts)).

### Irrep combinations and the isotropy subgroup

SARAh (Wills 2000) refines a combination of irreps. The workbench names the
magnetic group that a combination implies, then refines that group's allowed
modes ([`isotropy.ts`](../src/core/magnetic/isotropy.ts)).

It builds m(j) = Σ_ν Σ_λ c_νλ·ψ_νλ(j) with generic amplitudes, and coset
representatives carry the modes over each orbit (Izyumov et al. 1991). The exact
stabilizer in G_k × {1, 1′} is the isotropy subgroup (Stokes & Hatch 1988;
Campbell et al. 2006). The workbench intersects two independent draws to rule out
accidental invariance, then names the group through the table and setting search.

A 1-D irrep acts by the scalar χ(g), so its group does not depend on the
amplitudes: it is the kernel. Verified cases
([`isotropy.test.ts`](../src/core/magnetic/isotropy.test.ts)):

- Each real irrep of P2/m gives the candidate whose time-reversal signs equal its
  characters.
- Ag ⊕ Bg gives P-1, Ag ⊕ Au gives P2, and all four irreps give P1 (BNS 2.4, 3.1
  and 1.1).
- On P2₁/m, the irrep with 2₁ and m primed names P2₁′/m′.

### Where Route B stops

| Case | Why there is no result |
| --- | --- |
| Non-abelian co-group, k ≠ 0 | The decomposition needs projective small representations. |
| Irreps with no modes on the sites | The order is magnetically silent there. |
| Multidimensional irrep | Its group depends on an order-parameter direction, which cannot be chosen yet. |
| Complex conjugate-pair irrep | Real combinations are generally type IV, outside the table. |
| e^{2πi k·L} ≠ ±1 | Naming needs the type-IV and star-of-k treatment. |
| Primed pure translation in the stabilizer | The group is type IV. |

Non-integral multiplicities flag a zone-boundary k of a non-symmorphic group, where
the ordinary irreps are only approximate. Integral ones do not prove them right.

## mCIF export in the right magnetic group

For k = 0 the mCIF is the parent cell in the chosen group. For a commensurate
k ≠ 0 it is the magnetic supercell in its own magnetic space group, not a P1 atom
list ([`supercellGroup.ts`](../src/core/magnetic/supercellGroup.ts)).

The writer re-expresses each parent operation in the supercell basis. It combines
each with every parent translation inside the cell, with and without time
reversal. It keeps an operation only if every atom lands on an atom of the same
kind carrying θ·det(R)·R·m.

A translation that flips every moment becomes an anti-translation in the
centring loop, so the group is type IV. One that changes the moments any other
way, as in a k = ⅓ sinusoid, is not a symmetry. The atom loop holds the
supercell's asymmetric unit.

The writer gives a BNS symbol only for a tabulated type-I or type-III match, and a
comment for a type-IV group. The candidate's own label would be wrong: for k ≠ 0
it names the parent-cell group.

For AWO₄ (P2/c, k = (½, 0, 0)), the group has 4 coset representatives, 2 centring
translations and a 9-site asymmetric unit. The file re-expands through the app's
parser to the arrangement on screen
([`supercellGroup.test.ts`](../src/core/magnetic/supercellGroup.test.ts)). Reading
it in VESTA, Bilbao or GSAS-II is not yet tested.

## Open work (in order)

1. **Multidimensional irreps.** An order-parameter direction picker, so these
   irreps can drive the isotropy construction and name epikernels.
2. **Projective small representations** for non-abelian little co-groups at a
   zone-boundary k ≠ 0 (Bradley & Cracknell 1972, Ch. 3–4).
3. **Type-IV groups.** Anti-translation candidates with the star of k and its
   domains (phase B3 of
   [PLAN_SUBGROUPS_AND_INCOMMENSURATE.md](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md)),
   and type-II and type-IV rows in the label table.
4. **Conjugate-pair irreps.** Their combinations and type-IV isotropy groups, and
   cosine and sine modes taken from them instead of the magnetic group.

[ROADMAP.md](./ROADMAP.md) (M3, M4) places this work among the other milestones.

## References

- Bertaut, E. F. (1968). *Acta Cryst.* **A24**, 217.
- Bilbao Crystallographic Server, magnetic section: <https://www.cryst.ehu.es/>.
- Bradley, C. J. & Cracknell, A. P. (1972). *The Mathematical Theory of Symmetry
  in Solids*.
- Campbell, B. J., Stokes, H. T., Tanner, D. E. & Hatch, D. M. (2006). *J. Appl.
  Cryst.* **39**, 607.
- Hermann, C. (1929). *Z. Kristallogr.* **69**, 533.
- *International Tables for Crystallography* Vol. A (§1.5) and Vol. A1,
  Wondratschek & Müller, eds.
- ISO-MAG magnetic group data, ISOTROPY Software Suite:
  <https://stokes.byu.edu/iso/magnetic_data.txt>.
- Izyumov, Yu. A., Naish, V. E. & Ozerov, R. P. (1991). *Neutron Diffraction of
  Magnetic Materials*.
- Litvin, D. B. (2013). *Magnetic Group Tables* (IUCr).
- Perez-Mato, J. M. et al. (2015). *Annu. Rev. Mater. Res.* **45**, 217.
- Rodríguez-Carvajal, J. & Bourée, F. (2012). BasIreps, *EPJ Web Conf.* **22**,
  00010.
- Serre, J.-P. (1977). *Linear Representations of Finite Groups* (Springer).
- Stokes, H. T. & Hatch, D. M. (1988). *Isotropy Subgroups of the 230
  Crystallographic Space Groups*.
- Wills, A. S. (2000). *Physica B* **276–278**, 680.
