#!/usr/bin/env python3
"""Split GSAS-II `fitted_results_hkl.dat` into per-phase reflection CSVs.

A multi-phase GSAS refinement writes one "... Reflection List" block per phase
into a single `fitted_results_hkl.dat` (e.g. Mn3Ga, MnO, and a magnetic phase).
Comparing our structure factor against a *mixed* list is meaningless — an MnO
reflection judged against the Mn3Ga structure looks like a huge bug. This tool
writes one `reflections_<phase>.csv` per block (columns h,k,l,m,d,Fo2,Fc2) plus
a `phases.txt` index, which `neutronSfValidation.test.ts` consumes.

The `data/` folder is git-ignored (real POWGEN data), so the CSVs are not
committed; regenerate them with:

    python3 scripts/extract_reflections.py              # scans ./data/*/
    python3 scripts/extract_reflections.py path/to/data

Columns are fixed-width, not whitespace-delimited: a wide Icorr value glues onto
Fc**2 (e.g. "1.283431339.810" = Fc²=1.283, Icorr=41339.810), so we slice by
column position from the GSAS format ("%4d"×4 then "%10.Nf"×5).
"""
import os
import re
import sys

# Half-open [start, end) column slices from the GSAS reflection-list format.
COLS = {"h": (0, 4), "k": (4, 8), "l": (8, 12), "m": (12, 16),
        "d": (16, 26), "Fo2": (46, 56), "Fc2": (56, 66)}


def slug(name):
    return re.sub(r"[^A-Za-z0-9]+", "_", name.strip()).strip("_") or "phase"


def parse_block(lines):
    out = []
    for ln in lines:
        if not ln.strip():
            continue
        try:
            rec = tuple(int(ln[a:b]) for a, b in (COLS["h"], COLS["k"], COLS["l"], COLS["m"]))
            rec += tuple(float(ln[a:b]) for a, b in (COLS["d"], COLS["Fo2"], COLS["Fc2"]))
        except ValueError:
            continue  # header/blank/ragged line
        out.append(rec)
    return out


def split_phases(path):
    blocks, name, cur = [], None, []
    for ln in open(path):
        if "Reflection List" in ln:
            if name is not None:
                blocks.append((name, cur))
            m = re.search(r"Bank\s+\d+\s+(.*?)\s+Reflection List", ln)
            name, cur = (m.group(1).strip() if m else "phase"), []
        elif name is not None and "d-space" not in ln and "Fc**2" not in ln:
            cur.append(ln)
    if name is not None:
        blocks.append((name, cur))
    return blocks


def file_tag(fname):
    """A folder may hold several *_hkl.dat (competing space-group refinements),
    each with its own 'Manganese oxide' phase — namespace CSVs to avoid clobber.
    `fitted_results_hkl.dat` -> '' (backward compatible); `fitted_results_Cmcm_hkl.dat`
    -> 'Cmcm'; `fitted_results_P21m_hkl.dat` -> 'P21m'."""
    stem = re.sub(r"_?hkl\.dat$", "", fname)
    stem = re.sub(r"^fitted_results_?", "", stem)
    return re.sub(r"[^A-Za-z0-9]+", "_", stem).strip("_")  # '' for the default file


def process_dir(d):
    srcs = sorted(f for f in os.listdir(d) if f.endswith("hkl.dat"))
    if not srcs:
        return
    tags = []
    for src in srcs:
        ftag = file_tag(src)
        for name, lines in split_phases(os.path.join(d, src)):
            refl = parse_block(lines)
            ptag = slug(name)
            tag = f"{ftag}_{ptag}" if ftag else ptag
            tags.append(f"{tag}\t{src}\t{name}\t{len(refl)}")
            with open(os.path.join(d, f"reflections_{tag}.csv"), "w") as f:
                f.write("h,k,l,m,d,Fo2,Fc2\n")
                for r in refl:
                    f.write(f"{r[0]},{r[1]},{r[2]},{r[3]},{r[4]:.5f},{r[5]:.5f},{r[6]:.5f}\n")
            print(f"  {os.path.basename(d)}/{tag}: {len(refl)} reflections")
    with open(os.path.join(d, "phases.txt"), "w") as f:
        f.write("\n".join(tags) + "\n")


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "data")
    if not os.path.isdir(base):
        sys.exit(f"no such directory: {base}")
    for entry in sorted(os.listdir(base)):
        path = os.path.join(base, entry)
        if os.path.isdir(path):
            process_dir(path)


if __name__ == "__main__":
    main()
