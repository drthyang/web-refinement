#!/usr/bin/env python3
"""Extract per-phase reflection lists directly from a GSAS-II .gpx project.

Some POWGEN refinements (e.g. data/TwoPhases/Fe1Co9Sn) were never exported to a
`fitted_results_hkl.dat`; the Fo²/Fc² reflection list lives only in the binary
.gpx (a Python pickle). This reads the pickle without a GSAS-II install by
stubbing the custom GSASII* classes (the RefList we want is a plain numpy array),
and writes `reflections_<phase>.csv` (columns h,k,l,m,d,Fo2,Fc2) next to the .gpx
— the same format `scripts/extract_reflections.py` produces from the text export,
so `neutronSfValidation.test.ts` consumes both identically.

Usage:
    python3 scripts/extract_gpx_reflections.py data/TwoPhases/Fe1Co9Sn_100K_TwoPhases.gpx

GSAS-II RefList columns (powder): 0..2 h,k,l · 3 mult · 4 d-space · 5 pos · 6 sig
· 7 gam · 8 |Fo|² · 9 |Fc|² · 10 phase · 11 Icorr · … We keep h,k,l,mult,d,Fo²,Fc².
"""
import os
import re
import sys
import pickle
import numpy as np


class _Stub:
    """Placeholder for any pickled GSASII* object we don't need to interpret."""
    def __init__(self, *a, **k):
        pass

    def __setstate__(self, state):
        self._state = state

    def __reduce__(self):
        return (_Stub, ())


_cache = {}


class _GSASUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module.startswith("GSASII") or module.startswith("G2"):
            key = (module, name)
            if key not in _cache:
                _cache[key] = type(name, (_Stub,), {})
            return _cache[key]
        return super().find_class(module, name)


def slug(name):
    return re.sub(r"[^A-Za-z0-9]+", "_", str(name).strip()).strip("_") or "phase"


def load_tree(path):
    """.gpx = repeated pickled `datum` lists; datum[0]=[name,data], rest=[sub,data]."""
    tree = {}
    with open(path, "rb") as f:
        up = _GSASUnpickler(f)
        while True:
            try:
                datum = up.load()
            except EOFError:
                break
            head = datum[0]
            subs = {item[0]: (item[1] if len(item) > 1 else None) for item in datum[1:]}
            tree[head[0]] = (head[1] if len(head) > 1 else None, subs)
    return tree


def reflection_lists(tree):
    """Yield (phase_name, RefList ndarray) for every powder histogram."""
    for name, (data, subs) in tree.items():
        if not (isinstance(name, str) and name.startswith("PWDR")):
            continue
        rl = subs.get("Reflection Lists")
        if rl is None and isinstance(data, dict):
            rl = data.get("Reflection Lists")
        if not isinstance(rl, dict):
            continue
        for phase, phd in rl.items():
            if isinstance(phd, dict) and "RefList" in phd:
                yield phase, np.asarray(phd["RefList"])


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: extract_gpx_reflections.py <file.gpx>")
    path = sys.argv[1]
    outdir = os.path.dirname(path)
    tree = load_tree(path)
    found = False
    for phase, arr in reflection_lists(tree):
        found = True
        tag = slug(phase)
        out = os.path.join(outdir, f"reflections_{tag}.csv")
        with open(out, "w") as f:
            f.write("h,k,l,m,d,Fo2,Fc2\n")
            for row in arr:
                h, k, l, m = int(row[0]), int(row[1]), int(row[2]), int(row[3])
                d, fo2, fc2 = float(row[4]), float(row[8]), float(row[9])
                f.write(f"{h},{k},{l},{m},{d:.5f},{fo2:.5f},{fc2:.5f}\n")
        print(f"  {tag}: {len(arr)} reflections -> {out}")
    if not found:
        sys.exit("no reflection lists found in .gpx")


if __name__ == "__main__":
    main()
