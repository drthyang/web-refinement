#!/usr/bin/env python3
"""Generate `src/core/scattering/neutronData.ts` — bound coherent neutron
scattering lengths b (fm) — for the full periodic table.

Source of truth: V. F. Sears, *International Tables for Crystallography* Vol. C,
§4.4.4 (bound coherent scattering lengths). Machine-readable via the Sears
table redistributed in the `Dans_Diffraction` package
(`data/neutron_isotope_scattering_lengths_sears.dat`); only the real part of the
bound coherent length for each *natural* element is used.

GSAS-II override. GSAS-II (which this workbench is validated against, see
neutronSfValidation.test.ts) uses the slightly earlier Sears (1992) *Neutron
News* 3, 26 compilation, which differs from the ITC edition for a few elements.
Those values are pinned in {@link GSAS2_OVERRIDES} so the emitted table
reproduces GSAS-II exactly for the validation elements while filling the rest of
the periodic table from the ITC/Sears source.

Usage:
    pip download --no-deps Dans_Diffraction -d /tmp/dd
    unzip -o /tmp/dd/dans_diffraction-*.whl -d /tmp/dd/x
    python3 scripts/gen_neutron_b.py \
        /tmp/dd/x/Dans_Diffraction/data/neutron_isotope_scattering_lengths_sears.dat \
        src/core/scattering/neutronData.ts

Every element with a real, tabulated b is emitted, in atomic-number order, plus
deuterium (D) from the ²H isotope row. Elements with no bound coherent value in
the source (e.g. Tc and the trans-uranics past the table) are simply absent.
"""

from __future__ import annotations

import re
import sys

# Sears (1992) Neutron News values used by GSAS-II where they differ from the
# ITC edition — preserved verbatim so the neutron structure factor keeps
# matching GSAS-II's .lst output.  {element: b (fm)}.
GSAS2_OVERRIDES: dict[str, float] = {
    "Ti": -3.438,
    "Mn": -3.73,
    "Zn": 5.68,
    "Au": 7.9,
}

# Atomic number for ordering the output (1-based index).
ELEMENTS = [
    "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si",
    "P", "S", "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co",
    "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
    "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I",
    "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy",
    "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au",
    "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U",
    "Np", "Pu", "Am", "Cm",
]
Z_OF = {sym: i + 1 for i, sym in enumerate(ELEMENTS)}


def parse(path: str) -> tuple[dict[str, float], float | None]:
    """Return ({element: real b (fm)} for natural elements, deuterium b)."""
    natural: dict[str, float] = {}
    deuterium: float | None = None
    for line in open(path):
        if line.startswith("#") or not line.strip():
            continue
        parts = [p.strip() for p in line.split(",")]
        name, real_b = parts[0], float(parts[1])
        if name == "2-H":
            deuterium = real_b
            continue
        if "-" in name:  # other isotope rows, e.g. "1-H", "235-U"
            continue
        natural[name] = real_b
    return natural, deuterium


def num(x: float) -> str:
    return f"{x:g}"


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    natural, deuterium = parse(sys.argv[1])

    table: dict[str, float] = {}
    for sym, b in natural.items():
        if sym in Z_OF:
            table[sym] = b
    # Apply the GSAS-II overrides (must all correspond to real elements).
    for sym, b in GSAS2_OVERRIDES.items():
        assert sym in table, f"override element {sym} not in source table"
        table[sym] = b

    ordered = sorted(table, key=lambda s: Z_OF[s])
    assert len(ordered) >= 85, f"expected ≥85 elements, got {len(ordered)}"

    lines = [f'  {sym}: {num(table[sym])},' for sym in ordered]
    if deuterium is not None:
        # Deuterium keyed as "D" right after hydrogen, matching CIF usage.
        lines.insert(1, f'  D: {num(deuterium)},')

    header = f"""/**
 * Bound coherent neutron scattering lengths b (fm) — GENERATED FILE, do not
 * edit by hand.
 *
 * Values from V. F. Sears, *International Tables for Crystallography* Vol. C,
 * §4.4.4, via the Sears table redistributed in the `Dans_Diffraction` package
 * (real part of the bound coherent length, natural-abundance elements). A few
 * elements (Ti, Mn, Zn, Au) are pinned to GSAS-II's Sears (1992) *Neutron News*
 * values so the neutron structure factor keeps matching GSAS-II output — see
 * neutronSfValidation.test.ts and scripts/gen_neutron_b.py. Deuterium (D) is
 * the ²H isotope value.
 *
 * Covers {len(ordered)} natural elements (+ D), keyed by element symbol.
 */

/** Element symbol → bound coherent scattering length (fm). */
export const NEUTRON_B: Readonly<Record<string, number>> = {{
"""
    with open(sys.argv[2], "w") as fh:
        fh.write(header)
        fh.write("\n".join(lines))
        fh.write("\n};\n")
    print(f"wrote {sys.argv[2]}: {len(ordered)} elements (+ D)")


if __name__ == "__main__":
    main()
