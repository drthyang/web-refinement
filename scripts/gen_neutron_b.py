#!/usr/bin/env python3
"""Generate `src/core/scattering/neutronData.ts` — bound coherent neutron
scattering lengths b (fm), complex, for the natural elements and the isotopes.

Evaluation: V. F. Sears, "Neutron scattering lengths and cross sections",
*Neutron News* 3(3), 26-37 (1992), as entered by NIST in the NCNR table
https://www.ncnr.nist.gov/resources/n-lengths/list.html (gemmi, Mantid and
cctbx carry transcriptions of the same page). It is NOT the later ITC Vol. C
§4.4.4 edition (Dans_Diffraction's `neutron_isotope_scattering_lengths_sears.dat`,
which this table used to be built from: it carries In = 2.08 fm — the In
σ_coh in barn — and stores the imaginary part with inconsistent signs), and NOT
Rauch & Waschkowski (2003) plus newer measurements (GSAS-II's `AtmBlens`,
periodictable), which differ for e.g. Au (7.90 vs 7.63 fm).

Input. The NIST page carries per-request tokens, so it cannot be pinned by URL.
The generator therefore pins the extracted data table: one line per `<tr>` of
the page's `<table border=4>`, cells separated by tabs, tags removed (so
`5.74-1.483<i>i</i>` reads `5.74-1.483i`). Pass either the saved HTML page (it
is normalized here exactly like that) or the normalized table itself, e.g.
ScatterPlan's `data-sources/snapshots/nist-sears1992.tsv`. The normalized table
must match NIST_TABLE_SHA256 below; a NIST revision fails loudly and must be
reviewed and re-pinned.

    python3 scripts/gen_neutron_b.py nist-sears1992.tsv src/core/scattering/neutronData.ts

Output, stored exactly as printed (b = b′ − i·b″, so `im` = −b″ ≤ 0 for an
absorbing nucleus; the crystallographic amplitude is the conjugate, applied in
neutron.ts):
  * NEUTRON_B           — every element row that prints a value, plus D (²H).
                          Pu and Cm print none (each isotope differs: ²³⁸Pu
                          14.1, ²³⁹Pu 7.7, ²⁴⁰Pu 3.5 fm), so they are absent and
                          a site needs an explicit isotope.
  * NEUTRON_B_ISOTOPES  — every isotope row that prints a value, keyed "238Pu".
Rows whose b_c is printed as "---" are skipped. Uncertainties in parentheses
("3.26(3)", "6.(1.)") are dropped.
"""

from __future__ import annotations

import hashlib
import math
import re
import sys

NIST_TABLE_SHA256 = "dcf8ea74603ceb3ed1ef56ef5017596a7d5bc581fc08f44c1d1c1b21025de914"

# Atomic number, for ordering the output.
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

ROW_NAME = re.compile(r"^(\d*)([A-Z][a-z]?)$")
# b′ with an optional "−b″i" (Sears prints every imaginary part with a minus).
B_VALUE = re.compile(r"^(-?\d+\.?\d*)(?:(-)(\d+\.?\d*)i)?$")


def normalize_html(html: str) -> str:
    """The page's data table as one tab-separated line per row (see docstring)."""
    start = html.find("<table border=4>")
    end = html.find("</table>", start)
    if start < 0 or end < 0:
        sys.exit("NIST page: data table not found")
    lines = []
    for row in re.split(r"<tr>", html[start:end], flags=re.I):
        if not re.search(r"<td", row, flags=re.I):
            continue
        cells = re.split(r"<td>", row, flags=re.I)[1:]
        cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", c).replace("&nbsp;", " ")).strip() for c in cells]
        lines.append("\t".join(cells))
    return "\n".join(lines) + "\n"


def parse_b(cell: str) -> tuple[float, float] | None:
    """'5.30-0.213i' → (5.30, −0.213); '3.26(3)' → (3.26, 0); '---' → None."""
    if cell == "---":
        return None
    m = B_VALUE.match(re.sub(r"\([^)]*\)", "", cell))
    if not m:
        sys.exit(f"cannot parse b_c '{cell}'")
    re_part = float(m.group(1))
    im_part = -float(m.group(3)) if m.group(2) else 0.0
    return re_part, im_part


def half_ulp(printed: str) -> float:
    """Half a unit in the last printed digit of a number like '4.871' or '6.'."""
    digits = re.sub(r"\([^)]*\)", "", printed)
    frac = digits.split(".")[1] if "." in digits else ""
    return 0.5 * 10.0 ** -len(frac)


def sigma_consistent(bc: str, sigma_coh: str, b: tuple[float, float]) -> bool:
    """σ_coh = 4π|b|²/100 (b in fm, σ in barn) within the printed precision of both."""
    sigma = float(re.sub(r"\([^)]*\)", "", sigma_coh))
    re_part = bc.split("-")[0] if not bc.startswith("-") else "-" + bc[1:].split("-")[0]
    db = half_ulp(re_part.lstrip("-"))
    mod = math.hypot(*b)
    lo = 4 * math.pi * max(mod - db, 0) ** 2 / 100
    hi = 4 * math.pi * (mod + db) ** 2 / 100
    ds = half_ulp(sigma_coh)
    return lo <= sigma + ds and sigma - ds <= hi


def num(x: float) -> str:
    s = repr(x)
    return s[:-2] if s.endswith(".0") else s


def entry(b: tuple[float, float]) -> str:
    return f"{{ re: {num(b[0])}, im: {num(b[1] or 0.0)} }}"


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    raw = open(sys.argv[1], encoding="utf-8").read()
    table = normalize_html(raw) if "<table" in raw.lower() else raw
    got = hashlib.sha256(table.encode("utf-8")).hexdigest()
    if got != NIST_TABLE_SHA256:
        sys.exit(f"NIST table SHA-256 {got} does not match the pinned {NIST_TABLE_SHA256}")

    elements: dict[str, tuple[float, float]] = {}
    radioactive: dict[str, str] = {}  # element row printing a half-life → half-life
    isotopes: dict[str, tuple[float, float]] = {}
    isotope_only: dict[str, list[int]] = {}
    sigma_mismatch: list[str] = []
    for line in table.splitlines():
        cells = line.split("\t")
        if len(cells) != 8:
            sys.exit(f"expected 8 cells, got {len(cells)}: {line!r}")
        name, conc, bc, _binc, sigma_coh = cells[:5]
        m = ROW_NAME.match(name)
        if not m or m.group(2) not in Z_OF:
            sys.exit(f"unexpected row name '{name}'")
        mass, sym = m.group(1), m.group(2)
        b = parse_b(bc)
        if b is not None and sigma_coh not in ("---", "") and not sigma_consistent(bc, sigma_coh, b):
            sigma_mismatch.append(f"{name} (b={bc}, σ_coh={sigma_coh})")
        if mass:
            if b is not None:
                isotopes[f"{mass}{sym}"] = b
                isotope_only.setdefault(sym, []).append(int(mass))
            continue
        if b is None:
            continue
        elements[sym] = b
        if conc.startswith("("):
            radioactive[sym] = conc.strip("()")

    if "2H" not in isotopes:
        sys.exit("²H row missing")
    isotope_only = {s: v for s, v in isotope_only.items() if s not in elements}
    if sorted(isotope_only) != ["Cm", "Pu"]:
        sys.exit(f"unexpected isotope-only elements {sorted(isotope_only)} — review the table")

    ordered = sorted(elements, key=lambda s: Z_OF[s])
    element_lines = []
    for sym in ordered:
        note = f"  // radioactive: one value, t½ {radioactive[sym]}" if sym in radioactive else ""
        element_lines.append(f"  {sym}: {entry(elements[sym])},{note}")
        if sym == "H":
            element_lines.append(f"  D: {entry(isotopes['2H'])},  // ²H")

    def iso_key(k: str) -> tuple[int, int]:
        m = re.match(r"(\d+)([A-Z][a-z]?)", k)
        assert m
        return Z_OF[m.group(2)], int(m.group(1))

    isotope_lines = [f'  "{k}": {entry(isotopes[k])},' for k in sorted(isotopes, key=iso_key)]
    only = ", ".join(f"{s} ({', '.join(str(a) for a in sorted(v))})" for s, v in sorted(isotope_only.items()))

    header = f"""/**
 * Bound coherent neutron scattering lengths b (fm) — GENERATED FILE, do not
 * edit by hand. Regenerate with scripts/gen_neutron_b.py.
 *
 * Evaluation: V. F. Sears, *Neutron News* 3(3), 26–37 (1992), as entered in the
 * NIST NCNR table "Neutron scattering lengths and cross sections" (extracted
 * table pinned by SHA-256 {NIST_TABLE_SHA256[:16]}… in the generator). Not the
 * later ITC Vol. C §4.4.4 edition, and not Rauch & Waschkowski (2003), which
 * GSAS-II's AtmBlens uses (e.g. Au 7.90 there vs 7.63 fm here).
 *
 * Values are stored exactly as Sears prints them, b = b′ − i·b″: `im` is −b″,
 * negative for an absorbing nucleus (B, Cd, In, Sm, Eu, Gd, Dy, …). The amplitude
 * in the crystallographic structure factor F = Σ a·exp(+2πi h·x) is the
 * conjugate b′ + i·b″ — see neutron.ts, which applies it.
 *
 * {len(ordered)} elements (+ D = ²H) in NEUTRON_B, {len(isotopes)} isotopes in NEUTRON_B_ISOTOPES.
 * Sears prints no element value for these, so a site needs an explicit isotope:
 *   {only}.
 * Elements marked "radioactive" have no natural isotopic composition: Sears
 * gives one value, for the isotope with the half-life shown.
 */

/** b = b′ − i·b″ in fm, as printed by Sears (1992): `im` = −b″ ≤ 0. */
export interface BoundCoherentLength {{
  readonly re: number;
  readonly im: number;
}}

/** Element symbol (natural isotopic composition; D = ²H) → b (fm). */
export const NEUTRON_B: Readonly<Record<string, BoundCoherentLength>> = {{
"""
    with open(sys.argv[2], "w") as fh:
        fh.write(header)
        fh.write("\n".join(element_lines))
        fh.write("\n};\n\n")
        fh.write('/** Isotope, keyed mass number + symbol ("238Pu") → b (fm). */\n')
        fh.write("export const NEUTRON_B_ISOTOPES: Readonly<Record<string, BoundCoherentLength>> = {\n")
        fh.write("\n".join(isotope_lines))
        fh.write("\n};\n")
    print(f"wrote {sys.argv[2]}: {len(ordered)} elements (+ D), {len(isotopes)} isotopes")
    print(f"isotope-only elements: {only}")
    if sigma_mismatch:
        print("σ_coh ≠ 4π|b|²/100 (as printed; informational):")
        for s in sigma_mismatch:
            print(f"  {s}")


if __name__ == "__main__":
    main()
