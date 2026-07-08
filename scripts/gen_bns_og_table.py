#!/usr/bin/env python3
"""Generate `src/core/magnetic/bnsOgTable.ts` — the bundled standard BNS/OG
magnetic-space-group table — from the ISO-MAG-derived database shipped with
pymatgen-core (`pymatgen/symmetry/symm_data_magnetic.sqlite`).

Provenance (per the docs' "labels must come from an authority" rule):
the sqlite database is parsed from the raw ISO-MAG data file
(ISOTROPY Software Suite, https://stokes.byu.edu/iso/magnetic_data.txt,
used in pymatgen with permission from Prof. Branton Campbell, BYU), itself
compiled from D. B. Litvin, *Magnetic Group Tables* (IUCr, 2013) and
Bradley & Cracknell (1972). Nothing here is hand-transcribed.

Usage:
    pip download --no-deps pymatgen-core -d /tmp/pmg
    unzip -o /tmp/pmg/pymatgen_core-*.whl -d /tmp/pmg/x
    python3 scripts/gen_bns_og_table.py \
        /tmp/pmg/x/pymatgen/symmetry/symm_data_magnetic.sqlite \
        src/core/magnetic/bnsOgTable.ts

Scope: magnetic group types I (230 "colourless" groups, M = G) and
III (674 groups, M = D + θ(G − D)) — the types produced by the k = 0 /
little-group candidate generator. Types II (grey) and IV (anti-translation)
can be added later by widening MAGTYPES; the encoding already supports them.

The script *verifies* every emitted entry before writing:
  - the identity is present and unprimed;
  - type I has no primed operations; type III is primed on exactly half;
  - the full coset set (representatives x centring translations) is closed
    under composition, with time reversal composing homomorphically;
  - for types I-III the OG symbol equals the BNS symbol (asserted, so only
    the BNS symbol is stored);
  - every entry has a distinct operation-set signature (mod lattice), i.e.
    the runtime lookup keyed on the op set is unambiguous.
"""

from __future__ import annotations

import sqlite3
import sys
from fractions import Fraction

MAGTYPES = (1, 3)

# ---------------------------------------------------------------------------
# Reading the database
# ---------------------------------------------------------------------------


def load_point_operators(cur: sqlite3.Cursor) -> dict[tuple[int, int], tuple[tuple[int, ...], str]]:
    """(hex, idx) -> (flattened 3x3 integer rotation, Jones-Faithful rotation string)."""
    out: dict[tuple[int, int], tuple[tuple[int, ...], str]] = {}
    for idx, hx, matrix, string in cur.execute("SELECT idx, hex, matrix, string FROM point_operators"):
        mat = tuple(int(float(v)) for v in matrix.split(","))
        assert len(mat) == 9
        out[(hx, idx)] = (mat, string)
    return out


def parse_symops(blob: bytes, hx: int, points):
    """6-byte records: [pointIdx+1, tx, ty, tz, denominator, timeReversal(1|255)].

    Returns (rotation, translation, timeReversal, rotationString) tuples.
    """
    ops = []
    for i in range(0, len(blob), 6):
        r = blob[i : i + 6]
        mat, string = points[(hx, r[0] - 1)]
        t = tuple(Fraction(r[j], r[4]) % 1 for j in range(1, 4))
        tr = 1 if r[5] == 1 else -1
        ops.append((mat, t, tr, string))
    return ops


def parse_lattice(blob: bytes) -> list[tuple[Fraction, Fraction, Fraction]]:
    """4-byte records: [x, y, z, denominator]. Fractional (centring) vectors only."""
    vecs = []
    for i in range(0, len(blob), 4):
        r = blob[i : i + 4]
        v = tuple(Fraction(r[j], r[3]) % 1 for j in range(3))
        if any(c != 0 for c in v):
            vecs.append(v)
    return vecs


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def expand(ops, centring):
    """Full coset list modulo integer lattice translations."""
    full = set()
    shifts = [(Fraction(0), Fraction(0), Fraction(0)), *centring]
    for mat, t, tr, _string in ops:
        for s in shifts:
            tt = tuple((t[i] + s[i]) % 1 for i in range(3))
            full.add((mat, tt, tr))
    return full


def compose(a, b):
    """(Ra,ta,tra) ∘ (Rb,tb,trb): rotation Ra·Rb, translation Ra·tb + ta (mod 1)."""
    ra, ta, tra = a
    rb, tb, trb = b
    rc = tuple(
        sum(ra[3 * i + k] * rb[3 * k + j] for k in range(3)) for i in range(3) for j in range(3)
    )
    tc = tuple((sum(ra[3 * i + k] * tb[k] for k in range(3)) + ta[i]) % 1 for i in range(3))
    return (rc, tc, tra * trb)


IDENTITY = (1, 0, 0, 0, 1, 0, 0, 0, 1)


def verify_group(label: str, magtype: int, ops, centring) -> frozenset:
    full = expand(ops, centring)
    ids = [o for o in full if o[0] == IDENTITY and all(c == 0 for c in o[1])]
    assert ids == [(IDENTITY, ids[0][1], 1)], f"{label}: identity missing or primed"
    primed = sum(1 for o in full if o[2] == -1)
    if magtype == 1:
        assert primed == 0, f"{label}: type I must have no primed ops"
    else:
        assert primed * 2 == len(full), f"{label}: type III must prime exactly half"
    for a in full:
        for b in full:
            assert compose(a, b) in full, f"{label}: not closed under composition"
    return frozenset(full)


# ---------------------------------------------------------------------------
# Emission
# ---------------------------------------------------------------------------


def frac_str(f: Fraction) -> str:
    return str(f.numerator) if f.denominator == 1 else f"{f.numerator}/{f.denominator}"


def op_string(mat_string: str, t, tr: int) -> str:
    """Magnetic Jones-Faithful string, e.g. 'x,-y+1/2,z,-1'."""
    comps = []
    for comp, f in zip(mat_string.split(","), t):
        comps.append(comp if f == 0 else f"{comp}+{frac_str(f)}")
    comps.append("-1" if tr == -1 else "1")
    return ",".join(comps)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    db_path, out_path = sys.argv[1], sys.argv[2]

    db = sqlite3.connect(db_path)
    cur = db.cursor()
    points = load_point_operators(cur)

    rows = []
    signatures: dict[frozenset, str] = {}
    counts = {t: 0 for t in MAGTYPES}

    query = (
        "SELECT magtype, BNS1, BNS2, BNS_label, OG1, OG2, OG3, OG_label, BNS_symops, BNS_lattice "
        f"FROM space_groups WHERE magtype IN ({','.join('?' * len(MAGTYPES))}) ORDER BY OG3"
    )
    for magtype, bns1, bns2, bns_label, og1, og2, og3, og_label, symops, lattice in cur.execute(
        query, MAGTYPES
    ):
        assert og_label == bns_label, f"{bns_label}: OG symbol differs from BNS for type {magtype}"
        hx = 1 if 143 <= bns1 <= 194 else 0
        ops = parse_symops(symops, hx, points)
        centring = parse_lattice(lattice)
        sig = verify_group(bns_label, magtype, ops, centring)
        assert sig not in signatures, f"{bns_label}: duplicate op-set signature with {signatures[sig]}"
        signatures[sig] = bns_label
        counts[magtype] += 1

        op_strings = ";".join(op_string(string, t, tr) for _mat, t, tr, string in ops)
        centring_str = ";".join(",".join(frac_str(c) for c in v) for v in centring)
        rows.append(
            f'  [{magtype}, "{bns1}.{bns2}", "{bns_label}", "{og1}.{og2}.{og3}", {bns1}, '
            f'"{op_strings}", "{centring_str}"],'
        )

    assert counts.get(1, 0) == 230, f"expected 230 type-I groups, got {counts.get(1)}"
    assert counts.get(3, 0) == 674, f"expected 674 type-III groups, got {counts.get(3)}"

    header = f"""/**
 * Standard magnetic space groups: BNS/OG numbers and symbols with their full
 * operation sets in the standard BNS setting.
 *
 * GENERATED FILE - DO NOT EDIT BY HAND. Regenerate with
 * `scripts/gen_bns_og_table.py` (see that file for the exact commands).
 *
 * Source of truth: the ISO-MAG magnetic-group data (ISOTROPY Software Suite,
 * https://stokes.byu.edu/iso/magnetic_data.txt, H. T. Stokes & B. J. Campbell),
 * compiled from D. B. Litvin, *Magnetic Group Tables* (IUCr, 2013) and
 * Bradley & Cracknell (1972), as redistributed in pymatgen-core's
 * `symm_data_magnetic.sqlite` (used there with permission from
 * Prof. Branton Campbell, BYU). No label here is hand-transcribed.
 *
 * Scope: types I ({counts.get(1)} groups, M = G) and III ({counts.get(3)} groups,
 * M = D + θ(G − D)) — the types the k = 0 / little-group candidate generator
 * produces. For types I-III the OG symbol equals the BNS symbol (verified at
 * generation time), so only the BNS symbol is stored; the OG *number* differs
 * and is kept. Settings follow ISO-MAG conventions: monoclinic unique axis b
 * cell choice 1, hexagonal axes for trigonal groups, origin choice 2 where
 * applicable.
 *
 * Row layout (kept as compact tuples - this file is bundled):
 *   [magtype, bnsNumber, bnsSymbol, ogNumber, parentNumber, ops, centring]
 * - bnsSymbol uses ASCII conventions: `_1` for subscripts ("P2_1/c"), `-3`
 *   for roto-inversion bars ("Fm-3m"); see `formatMagneticSymbol`.
 * - parentNumber: ITA number of the parent (Fedorov) space group F.
 * - ops: ';'-joined magnetic Jones-Faithful coset representatives
 *   ("x,-y+1/2,z,-1"), excluding centring translations.
 * - centring: ';'-joined fractional centring vectors ("1/2,1/2,0"), "" if none.
 * Generation verified per entry: identity unprimed, correct primed count for
 * the type, closure of the full coset set (with homomorphic time reversal),
 * and uniqueness of every entry's operation-set signature.
 */

export type MagneticGroupRow = readonly [
  magtype: 1 | 3,
  bnsNumber: string,
  bnsSymbol: string,
  ogNumber: string,
  parentNumber: number,
  ops: string,
  centring: string,
];

export const MAGNETIC_GROUP_TABLE: readonly MagneticGroupRow[] = [
"""
    with open(out_path, "w") as fh:
        fh.write(header)
        fh.write("\n".join(rows))
        fh.write("\n];\n")
    print(f"wrote {out_path}: {len(rows)} groups ({counts})")


if __name__ == "__main__":
    main()
