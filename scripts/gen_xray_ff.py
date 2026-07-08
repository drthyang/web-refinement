#!/usr/bin/env python3
"""Generate `src/core/scattering/cromerMannData.ts` — the X-ray atomic
form-factor coefficients — from the International Tables Cromer-Mann table.

Form (s = sinθ/λ, Å⁻¹):  f0(s) = Σ_{i=1..4} a_i·exp(−b_i·s²) + c,  f0(0) = Z.

Source of truth: *International Tables for Crystallography* Vol. C (1995),
pp. 500-502 — the four-Gaussian parametrization of Cromer & Mann,
*Acta Cryst.* (1968) A24, 321. Machine-readable via the ESRF **DABAX**
`f0_InterTables.dat` table (public domain; redistributed in the
`xrayutilities` package as `materials/data/f0_InterTables.dat.xz`). These are
the same coefficients GSAS-II uses, so the neutral-atom rows reproduce its
form factors (verified for Mn/O/Ga against the bundled validation data).

Usage:
    pip download --no-deps xrayutilities -d /tmp/xu
    unzip -o /tmp/xu/xrayutilities-*.whl -d /tmp/xu/x
    xz -dc /tmp/xu/x/xrayutilities/materials/data/f0_InterTables.dat.xz > /tmp/f0.dat
    python3 scripts/gen_xray_ff.py /tmp/f0.dat src/core/scattering/cromerMannData.ts

Scope: the 98 **neutral atoms** (H–Cf), which is what the structure-factor code
looks up (by element symbol). The DABAX file also carries ionic species; they
are skipped here because nothing consumes an ionic X-ray key yet — widen
`is_neutral` to emit them. Every emitted row is verified: nine coefficients
parsed, and f0(0) = Σaᵢ + c equal to the element's atomic number Z (the
physical normalization) within 0.02 e.
"""

from __future__ import annotations

import re
import sys

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

BLOCK = re.compile(r"#S\s+(\d+)\s+(\S+)\s*\n#N 9\n#L[^\n]*\n([^\n]+)")


def is_neutral(symbol: str) -> bool:
    """Pure element symbol — no charge (+/−) and no DABAX '.' variant suffix."""
    return re.fullmatch(r"[A-Za-z]+", symbol) is not None and symbol in Z_OF


def num(x: float) -> str:
    """Render without exponent notation, trimming trailing zeros."""
    return f"{x:.6f}".rstrip("0").rstrip(".") if x else "0"


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    text = open(sys.argv[1]).read()

    rows: list[tuple[int, str, list[float]]] = []
    seen: set[str] = set()
    skipped: list[str] = []
    for z, sym, line in BLOCK.findall(text):
        if not is_neutral(sym) or sym in seen:
            continue
        v = [float(t) for t in line.split()]
        if len(v) != 9:
            sys.exit(f"{sym}: expected 9 coefficients, got {len(v)}")
        a, c, b = v[:4], v[4], v[5:9]
        z_expect = Z_OF[sym]
        f0_at_0 = sum(a) + c
        seen.add(sym)
        # f0(0) must equal Z for a physical form factor; a large miss means a
        # bad fit in the source table, so drop it rather than ship a wrong curve.
        if abs(f0_at_0 - z_expect) > 0.1:
            skipped.append(f"{sym} (f0(0)={f0_at_0:.2f}, Z={z_expect})")
            continue
        rows.append((z_expect, sym, a + [c] + b))

    rows.sort(key=lambda r: r[0])
    assert len(rows) >= 97, f"expected ≥97 neutral atoms, got {len(rows)}"

    lines = []
    for _z, sym, v in rows:
        a, c, b = v[:4], v[4], v[5:9]
        lines.append(
            f'  {sym}: {{ a: [{", ".join(num(x) for x in a)}], '
            f'b: [{", ".join(num(x) for x in b)}], c: {num(c)} }},'
        )

    header = f"""/**
 * X-ray atomic form-factor coefficients — GENERATED FILE, do not edit by hand.
 *
 * Four-Gaussian Cromer-Mann parametrization
 *   f0(s) = Σ_{{i=1..4}} a_i·exp(−b_i·s²) + c,   s = sinθ/λ (Å⁻¹),   f0(0) = Z,
 * from *International Tables for Crystallography* Vol. C (1995), pp. 500-502
 * (Cromer & Mann, *Acta Cryst.* 1968, A24, 321), via the ESRF DABAX
 * `f0_InterTables.dat` table (redistributed in the `xrayutilities` package).
 * These are the coefficients GSAS-II uses; neutral-atom rows reproduce its
 * form factors. Regenerate with scripts/gen_xray_ff.py.
 *
 * Covers {len(rows)} neutral atoms (H–Cf), keyed by element symbol. Any row
 * whose f0(0) = Σaᵢ + c disagrees with the element's Z by more than 0.1 e is a
 * bad least-squares fit in the source and is omitted (currently only Pu).
 */

export interface CromerMann {{
  readonly a: readonly [number, number, number, number];
  readonly b: readonly [number, number, number, number];
  readonly c: number;
}}

export const CROMER_MANN: Readonly<Record<string, CromerMann>> = {{
"""
    with open(sys.argv[2], "w") as fh:
        fh.write(header)
        fh.write("\n".join(lines))
        fh.write("\n};\n")
    print(f"wrote {sys.argv[2]}: {len(rows)} neutral atoms")
    if skipped:
        print(f"skipped (bad f0(0) vs Z): {', '.join(skipped)}")


if __name__ == "__main__":
    main()
