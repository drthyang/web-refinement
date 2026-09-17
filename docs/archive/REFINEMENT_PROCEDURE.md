# Refinement Procedure

> **Archived.** Replaced by the task-based [`../USER_GUIDE.md`](../USER_GUIDE.md),
> which covers these steps in the app. The magnetic-group theory is in
> [`../MAGNETIC_SYMMETRY.md`](../MAGNETIC_SYMMETRY.md), and the tests in
> [`../VALIDATION.md`](../VALIDATION.md).

The app is organized as a guided 7-step workflow mirroring the practical
procedure for atomic-then-magnetic structure refinement. Each step maps to
tested engine code.

| Step | Procedure | App implementation |
| --- | --- | --- |
| 1 | Load structural CIF | `parseCif` / `parseMagneticCif` → `StructureModel`; structure summary. |
| 2 | Load experimental data + instrument parameter file | Instrument-file parsers for GSAS-II `.instprm`, classic GSAS `.prm` and FullProf `.irf` (TOF difC/difA/difB/Zero or λ); `instrument.ts` does the TOF↔d and 2θ↔d conversions. |
| 3 | Structural refinement with constraints | Powder + single-crystal least-squares (`refine`), fixed/free per parameter, bounds, tied parameters. |
| 4 | Assess quality; investigate structure | Agreement factors (R, wR, GoF) + bond lengths (`bondLengths`). |
| 5 | Get allowed magnetic space groups | `generateMagneticCandidates` (k = 0): parent group + every index-2 subgroup, via a GF(2) time-reversal homomorphism solver. `allowedMomentDirections` gives the symmetry-allowed moment per site. |
| 6 | Refine magnetic structure with constraints | `magneticStructureFactor` + moment-component refinement; moment-size restraint (mirrors GSAS-II's "moments restraint weight factor"). |
| 7 | Compare magnetic space groups | `compareMagneticCandidates`: refine every candidate against the data, rank by weighted R — "which fits better". |

## Notes on the magnetic candidate generation (steps 5 & 7)

For a **commensurate k = 0** structure (which covers all the Mn₃Ga data), the
candidate magnetic space groups are exactly the parent group plus one type-III
group per index-2 subgroup, obtained from the time-reversal homomorphisms
θ: G → {±1}. The app enumerates these directly.

This is the well-defined core of "get allowed magnetic space groups". The app
goes further: for k ≠ 0 it works in the little group of k, it enumerates the
full magnetic subgroup lattice rather than only the index-2 candidates, and it
labels each candidate with its standard BNS/OG symbol (see
[MAGNETIC_SYMMETRY.md](../MAGNETIC_SYMMETRY.md)). Type-IV (anti-translation)
groups and the star of k are not enumerated yet, so for a publication still
cross-check the candidates against Bilbao (MAXMAGN / k-SUBGROUPSMAG),
ISODISTORT or SARAh. The comparison harness then tells you which candidate fits
the data best.

## Validation

The candidate generation is validated against the real 30 K Mn₃Ga data: from the
parent P2₁/m it produces four candidates, one of which is the known P2₁'/m'
solution (identity + inversion unprimed), and the comparison ranks that group
best against the observed intensities. See
`src/core/magnetic/magneticGroups.test.ts` and
`src/core/workflow/magneticCompare.test.ts`, and [VALIDATION.md](../VALIDATION.md).
