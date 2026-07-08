#!/usr/bin/env python3
"""Generate src/core/scattering/magneticFormFactorData.ts from the public-domain
CrysFML magnetic form-factor table redistributed in the `periodictable` package.

Source of truth: International Tables for Crystallography Vol. C, §4.4.5
(P. J. Brown). Numbers are copied verbatim (as source tokens) so no digits are
altered by float round-tripping.

Usage:
    python3 scripts/gen_magnetic_ff.py            # fetch source over the network
    python3 scripts/gen_magnetic_ff.py path.py    # parse a local copy instead
"""
import os
import re
import sys
import urllib.request

URL = "https://raw.githubusercontent.com/pkienzle/periodictable/master/periodictable/magnetic_ff.py"
OUT = os.path.join(
    os.path.dirname(__file__), "..", "src", "core", "scattering", "magneticFormFactorData.ts"
)

# add_form_factor("j0", "MN", 2, ( 0.42, 17.68, 0.59, 6.00, 0.004, -0.60, -0.02) )
ROW = re.compile(
    r'add_form_factor\(\s*"(j0|j2)"\s*,\s*"([A-Za-z]+)"\s*,\s*(-?\d+)\s*,\s*\(([^)]*)\)'
)


def load_source() -> str:
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as fh:
            return fh.read()
    with urllib.request.urlopen(URL) as resp:  # noqa: S310 (trusted public URL)
        return resp.read().decode("utf-8")


def parse(text: str):
    j0, j2, order = {}, {}, []  # order preserves file (Z-ordered) key sequence
    for line in text.splitlines():
        m = ROW.search(line)
        if not m:
            continue
        kind, el, charge, body = m.groups()
        nums = [t.strip() for t in body.split(",")]
        if len(nums) != 7:
            sys.exit(f"expected 7 numbers, got {len(nums)}: {line!r}")
        key = el.capitalize() + charge  # e.g. "Mn2", "Fe3", "Cr3", "Ce3"
        (j0 if kind == "j0" else j2)[key] = nums
        if key not in order:
            order.append(key)
    return j0, j2, order


def emit(name: str, table, order) -> str:
    lines = [f"export const {name}: Readonly<Record<string, MagFfCoeffs>> = {{"]
    for key in order:
        if key not in table:
            continue
        A, a, B, b, C, c, D = table[key]
        lines.append(
            f'  "{key}": {{ A: {A}, a: {a}, B: {B}, b: {b}, C: {C}, c: {c}, D: {D} }},'
        )
    lines.append("};")
    return "\n".join(lines)


HEADER = '''/**
 * Magnetic form-factor coefficients — GENERATED FILE, do not edit by hand.
 *
 * Analytical ⟨j0⟩ and ⟨j2⟩ approximations from International Tables for
 * Crystallography Vol. C, §4.4.5 (P. J. Brown), via the public-domain CrysFML
 * table redistributed in the `periodictable` package
 * (https://periodictable.readthedocs.io/en/latest/api/magnetic_ff.html).
 *
 * Form (s = sinθ/λ = 1/(2d), Å⁻¹):
 *   ⟨j0⟩(s) = A·e^{−a·s²} + B·e^{−b·s²} + C·e^{−c·s²} + D            → 1 at s=0
 *   ⟨j2⟩(s) = (A·e^{−a·s²} + B·e^{−b·s²} + C·e^{−c·s²} + D)·s²       → 0 at s=0
 * The dipole approximation is  f(s) = ⟨j0⟩ + (1 − 2/g)·⟨j2⟩.
 *
 * Keys are element-symbol + integer charge, e.g. "Mn2", "Fe3", "Cr3", "Ce3".
 * Regenerate with scripts/gen_magnetic_ff.py.
 */

export interface MagFfCoeffs {
  readonly A: number;
  readonly a: number;
  readonly B: number;
  readonly b: number;
  readonly C: number;
  readonly c: number;
  readonly D: number;
}
'''


def main() -> None:
    j0, j2, order = parse(load_source())
    with open(OUT, "w") as fh:
        fh.write(HEADER)
        fh.write("\n/** ⟨j0⟩ (spin-only) coefficients. */\n")
        fh.write(emit("J0_COEFFS", j0, order))
        fh.write("\n\n/** ⟨j2⟩ coefficients (dipole approximation, g ≠ 2). */\n")
        fh.write(emit("J2_COEFFS", j2, order))
        fh.write("\n")
    missing = sorted(set(j0) - set(j2))
    print(f"wrote {os.path.relpath(OUT)}: {len(j0)} ⟨j0⟩ ions, {len(j2)} ⟨j2⟩ ions")
    print(f"ions with ⟨j0⟩ but no ⟨j2⟩ (dipole falls back to spin-only): {missing}")


if __name__ == "__main__":
    main()
