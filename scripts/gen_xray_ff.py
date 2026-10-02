#!/usr/bin/env python3
"""Generate `src/core/scattering/cromerMannData.ts` — the X-ray atomic
form-factor coefficients — from the International Tables Cromer-Mann table.

Form (s = sinθ/λ, Å⁻¹):  f0(s) = Σ_{i=1..4} a_i·exp(−b_i·s²) + c,  f0(0) = Z.

Source of truth: *International Tables for Crystallography* Vol. C (1992),
Table 6.1.1.4, pp. 500-502 — the four-Gaussian parametrization of Cromer &
Mann, *Acta Cryst.* (1968) A24, 321. Two independent machine-readable
transcriptions are read, both pinned by SHA-256:

  * primary    — ESRF DABAX `f0_InterTables.dat`
                 https://raw.githubusercontent.com/oasys-kit/DabaxFiles/70ff9039085dafd4eb95d66d64c6880a6a10d9a8/f0_InterTables.dat
  * crosscheck — cctbx `it1992.cpp` (transcribed from the printed table)
                 https://raw.githubusercontent.com/cctbx/cctbx_project/d2d1c707ba15458d7dac4f1d2edff8560a51c418/cctbx/eltbx/xray_scattering/it1992.cpp

Every neutral-atom row emitted from DABAX must equal the cctbx row for the same
element (to DABAX's single-precision rounding) and give f0(0) = Z within 0.1 e;
anything else aborts the run. The one exception is a DABAX row that fails the
f0(0) = Z test while the cctbx row passes it: DABAX f0_InterTables has its Pu,
Np3+, Np4+ and Np6+ rows shuffled (its "Pu" row is the ITC Np4+ row, f0(0) =
89), so for such a row the cctbx transcription is used instead and the header
of the generated file names it. Today that is Pu only. The same Pu row is
carried by gemmi (it92.hpp) and GSAS-II (atmdata.py XrayFF).

Usage:
    curl -sLo /tmp/f0_InterTables.dat <primary URL above>
    curl -sLo /tmp/it1992.cpp <crosscheck URL above>
    python3 scripts/gen_xray_ff.py /tmp/f0_InterTables.dat /tmp/it1992.cpp \\
        src/core/scattering/cromerMannData.ts

Scope: the 98 **neutral atoms** (H–Cf), which is what the structure-factor code
looks up (by element symbol). The files also carry ionic species; they are
skipped here because nothing consumes an ionic X-ray key yet.
"""

from __future__ import annotations

import hashlib
import re
import sys

# Pinned inputs (same files as ScatterPlan's data-sources/sources.json).
DABAX_SHA256 = "d8c594a84ce628a613df59ab2a2f509c02a0328f2a784cc4081a28f39eac0e2d"
CCTBX_SHA256 = "7ca28976ff501268a9ce74ef95f35482847d875d19dec1aaa129195b2ff08169"

# Symbols in DABAX Z-order, indexed by atomic number (1-based).
ELEMENTS = [
    "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si",
    "P", "S", "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co",
    "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
    "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I",
    "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy",
    "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au",
    "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U",
    "Np", "Pu", "Am", "Cm", "Bk", "Cf",
]
Z_OF = {sym: i + 1 for i, sym in enumerate(ELEMENTS)}

DABAX_BLOCK = re.compile(r"#S\s+(\d+)\s+(\S+)\s*\n#N 9\n#L[^\n]*\n([^\n]+)")
# cctbx: { "Sym", { a1, a2, a3, a4 }, { b1, b2, b3, b4 }, c },  (comments stripped)
CCTBX_ROW = re.compile(
    r'\{\s*"([^"]+)",\s*\{([^}]*)\},\s*\{([^}]*)\},\s*([-+0-9.eE]+)\s*\}'
)

F0_TOLERANCE = 0.1  # e; |f0(0) − Z| allowed for a physical row
REL_TOLERANCE = 1e-6  # DABAX prints single-precision values (3.0380001E-03)


def sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def is_neutral(symbol: str) -> bool:
    """Pure element symbol — no charge (+/−) and no '.' variant suffix."""
    return re.fullmatch(r"[A-Za-z]+", symbol) is not None and symbol in Z_OF


def num(x: float) -> str:
    """Render without exponent notation, trimming trailing zeros."""
    return f"{x:.6f}".rstrip("0").rstrip(".") if x else "0"


def f0_at_zero(row: list[float]) -> float:
    """Row layout is [a1..a4, c, b1..b4]; f0(0) = Σa + c."""
    return sum(row[:4]) + row[4]


def same_row(x: list[float], y: list[float]) -> bool:
    return all(abs(p - q) <= REL_TOLERANCE * max(abs(p), abs(q), 1e-12) for p, q in zip(x, y))


def read_dabax(path: str) -> dict[str, list[float]]:
    """{species: [a1..a4, c, b1..b4]} — first occurrence of each species."""
    rows: dict[str, list[float]] = {}
    for _z, sym, line in DABAX_BLOCK.findall(open(path).read()):
        if sym in rows:
            continue
        v = [float(t) for t in line.split()]
        if len(v) != 9:
            sys.exit(f"DABAX {sym}: expected 9 coefficients, got {len(v)}")
        rows[sym] = v
    return rows


def read_cctbx(path: str) -> dict[str, list[float]]:
    """{species: [a1..a4, c, b1..b4]} in the DABAX column order."""
    text = re.sub(r"/\*.*?\*/", "", re.sub(r"//[^\n]*", "", open(path).read()), flags=re.S)
    rows: dict[str, list[float]] = {}
    for sym, a, b, c in CCTBX_ROW.findall(text):
        av = [float(t) for t in a.split(",")]
        bv = [float(t) for t in b.split(",")]
        if len(av) != 4 or len(bv) != 4:
            sys.exit(f"cctbx {sym}: expected 4 a and 4 b coefficients")
        rows[sym] = av + [float(c)] + bv
    return rows


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    dabax_path, cctbx_path, out_path = sys.argv[1:]
    for path, expected in ((dabax_path, DABAX_SHA256), (cctbx_path, CCTBX_SHA256)):
        got = sha256(path)
        if got != expected:
            sys.exit(f"{path}: SHA-256 {got} does not match the pinned {expected}")

    dabax = read_dabax(dabax_path)
    cctbx = read_cctbx(cctbx_path)

    rows: list[tuple[int, str, list[float]]] = []
    substituted: list[str] = []
    for sym in ELEMENTS:
        z = Z_OF[sym]
        d = dabax.get(sym)
        c = cctbx.get(sym)
        if d is None or c is None:
            sys.exit(f"{sym}: missing from {'DABAX' if d is None else 'cctbx'}")
        d_ok = abs(f0_at_zero(d) - z) <= F0_TOLERANCE
        c_ok = abs(f0_at_zero(c) - z) <= F0_TOLERANCE
        if d_ok and same_row(d, c):
            rows.append((z, sym, d))
        elif not d_ok and c_ok:
            # Name the species whose cctbx row DABAX actually printed here.
            match = next((s for s, r in cctbx.items() if same_row(d, r)), "no ITC species")
            substituted.append(f"{sym}: the DABAX row is the {match} row (f0(0) = {f0_at_zero(d):.2f})")
            rows.append((z, sym, c))
        else:
            sys.exit(
                f"{sym}: transcriptions disagree — DABAX f0(0)={f0_at_zero(d):.4f}, "
                f"cctbx f0(0)={f0_at_zero(c):.4f}, Z={z}; check the printed table"
            )

    lines = []
    for _z, sym, v in rows:
        a, c, b = v[:4], v[4], v[5:9]
        lines.append(
            f'  {sym}: {{ a: [{", ".join(num(x) for x in a)}], '
            f'b: [{", ".join(num(x) for x in b)}], c: {num(c)} }},'
        )

    substitution_note = (
        " * Rows taken from cctbx because the DABAX row fails f0(0) = Z:\n"
        + "".join(f" *   {note}.\n" for note in substituted)
        if substituted
        else ""
    )
    header = f"""/**
 * X-ray atomic form-factor coefficients — GENERATED FILE, do not edit by hand.
 *
 * Four-Gaussian Cromer-Mann parametrization
 *   f0(s) = Σ_{{i=1..4}} a_i·exp(−b_i·s²) + c,   s = sinθ/λ (Å⁻¹),   f0(0) = Z,
 * from *International Tables for Crystallography* Vol. C (1992), Table 6.1.1.4,
 * pp. 500-502 (Cromer & Mann, *Acta Cryst.* 1968, A24, 321). Read from the ESRF
 * DABAX `f0_InterTables.dat` transcription and checked row by row against the
 * independent cctbx `it1992.cpp` transcription (both pinned by SHA-256 in
 * scripts/gen_xray_ff.py); every row equals both and gives f0(0) = Z within
 * 0.1 e. Neutral-atom rows equal GSAS-II's XrayFF and gemmi's it92 tables.
{substitution_note} *
 * Covers {len(rows)} neutral atoms (H–Cf), keyed by element symbol.
 */

export interface CromerMann {{
  readonly a: readonly [number, number, number, number];
  readonly b: readonly [number, number, number, number];
  readonly c: number;
}}

export const CROMER_MANN: Readonly<Record<string, CromerMann>> = {{
"""
    with open(out_path, "w") as fh:
        fh.write(header)
        fh.write("\n".join(lines))
        fh.write("\n};\n")
    print(f"wrote {out_path}: {len(rows)} neutral atoms")
    for note in substituted:
        print(f"from cctbx: {note}")


if __name__ == "__main__":
    main()
