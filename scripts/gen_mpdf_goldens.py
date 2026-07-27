"""Regenerate the diffpy.mpdf reference fixtures for the mPDF cross-check gates.

Two outputs:
  1. synthetic_cases.json      -- COMMITTABLE toy cases (tri / cant / cant_dr);
                                  embed into src/core/magnetic/mpdfGolden.ts with
                                  scripts/gen-mpdf-golden-fixture.mjs.
  2. data/PDF/Mn3Sn_PG3/diffpy_pointwise.json -- LOCAL-ONLY pointwise reference
                                  for the real spin configuration (UNPUBLISHED;
                                  data/ is git-ignored). Every unpublished value
                                  (xi, mcif name) is READ from the local manifest
                                  data/PDF/Mn3Sn_PG3/golden.json at runtime --
                                  this script contains toy numbers only.

The generator runs diffpy.mpdf's calculatemPDF/calculateDr DIRECTLY from
magutils.py (the C++ diffpy.srreal import is stubbed -- those code paths are
never hit). Setup:

    python3 -m pip download --no-deps --python-version 3.11 \
        --only-binary :all: diffpy.mpdf -d /tmp/mpdfsrc
    cd /tmp/mpdfsrc && unzip -oq diffpy_mpdf-*.whl
    pip install numpy scipy matplotlib periodictable   # magutils imports
    python3 scripts/gen_mpdf_goldens.py /tmp/mpdfsrc/diffpy/mpdf/magutils.py

Conventions everywhere: OUR kernel's -- spins are full moment vectors (muB),
g = 1, K1 = (2/3)(gamma*r0/2)^2, K2 = K1*<m^2> -- so fixtures compare 1:1 to
computeNormalizedMpdf/computeUnnormalizedMpdf with no scale factors.

SELF-CHECK: before writing anything, the committed MPDF_GOLDEN_AFM case is
regenerated and must match at maxdiff/peak < 1e-6 (observed 2e-10) -- proof the
generator's conventions equal the fixtures'. Grid rule this encodes: committed
fixture grids END at the last sample (extendedrmax = 0; the tests hand the
kernel the bare grid, whose baseline runs over pairs <= rlast + step/2), while
the pointwise fixture mirrors mpdfExtendedGrid (window + 4 A).
"""
import importlib.util
import json
import os
import re
import sys
import types

import numpy as np

if len(sys.argv) < 2:
    sys.exit("usage: gen_mpdf_goldens.py /path/to/diffpy/mpdf/magutils.py [outdir]")
MAGUTILS = sys.argv[1]
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()

for name in ("diffpy.srreal", "diffpy.srreal.bondcalculator", "diffpy.srreal.pdfcalculator"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["diffpy.srreal.bondcalculator"].BondCalculator = object
sys.modules["diffpy.srreal.pdfcalculator"].PDFCalculator = object

spec = importlib.util.spec_from_file_location("magutils", MAGUTILS)
mu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mu)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREF = (1.913 * 0.281794 / 2.0) ** 2      # (gamma r0 / 2)^2, barn -- MPDF_PREFACTOR
K1_OURS = (2.0 / 3.0) * PREF              # fr /= N * K1/(gr0/2)^2 = N*2/3 -> 3/2N


def box_atoms(cell, frac, reach):
    """All periodic images (Cartesian, orthorhombic cell) with translations
    within reach -- origin-cell atoms FIRST (they are the calcIdxs)."""
    a, b, c = cell
    n1, n2, n3 = [int(np.ceil(reach / x)) + 1 for x in (a, b, c)]
    L = np.diag([a, b, c])
    orig = np.array(frac) @ L
    pts = [orig]
    for i in range(-n1, n1 + 1):
        for j in range(-n2, n2 + 1):
            for k in range(-n3, n3 + 1):
                if i == j == k == 0:
                    continue
                pts.append(orig + np.array([i * a, j * b, k * c]))
    return np.vstack(pts)


def run_case(cell, frac, moments, rstep, n, psigma, qdamp, xi, rmax_data, ext):
    """fr on r = k*rstep, k = 0..n-1 in OUR conventions (g=1, K1_OURS).
    ext: grid extension past rmax_data (0 for committed fixtures, 4 for the
    mpdfExtendedGrid-mirroring pointwise fixture) -- see module docstring."""
    nspin = len(frac)
    atoms = box_atoms(cell, frac, rmax_data + ext + 4 + np.linalg.norm(cell))
    spins = np.tile(np.array(moments), (len(atoms) // nspin, 1))
    g1 = np.ones(len(spins))
    vol = cell[0] * cell[1] * cell[2]
    netMag = np.linalg.norm(np.array(moments).sum(axis=0)) / nspin
    rho0 = nspin / vol
    rc, fr = mu.calculatemPDF(atoms, spins, g1, list(range(nspin)), rstep, 0.0,
                              rmax_data, psigma, 0.0, -1.0, qdamp, 0.0, ext, 1.0,
                              K1_OURS, rho0, netMag, xi, 'exact', True,
                              None, np.array([0]))
    assert abs(rc[0]) < 1e-9 and abs(rc[1] - rstep) < 1e-9, (rc[0], rc[1])
    return rc[:n], fr[:n]


def run_dr(rc, fr, rstep, mSqAvg, paraScale):
    q = np.arange(0, 25.0 + rstep * 1e-3, 0.01)
    ff = mu.jCalc(q, mu.getFFparams('Mn2'))
    return mu.calculateDr(rc, fr, q, ff, paraScale, -5.0, 5.0, rstep, 0, -1,
                          K1_OURS, K1_OURS * mSqAvg)


# ------------------------------------------------------------------ self-check
src = open(os.path.join(REPO, 'src/core/magnetic/mpdfGolden.ts')).read()
m = re.search(r'MPDF_GOLDEN_AFM[^{]*\{(.*?)\n\};', src, re.S)
committed = np.array([float(x) for x in
                      re.findall(r'[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?', m.group(1).split('y: [')[1])])
rc, fr = run_case((4.4, 4.4, 8.8), [(0, 0, 0), (0, 0, 0.5)],
                  [(5, 0, 0), (-5, 0, 0)], 0.02, 1201, 0.15, 0.02, 0.0, 24.0, 0.0)
rel = np.abs(fr - committed).max() / np.abs(committed).max()
print(f'SELF-CHECK AFM: maxdiff/peak = {rel:.2e} (must be < 1e-6)')
assert rel < 1e-6, 'generator conventions do NOT match the committed fixture'

# ------------------------------------------------------------- synthetic cases
CELL = (5.5, 5.5, 4.4)
FRAC = [(0, 0, 0), (0.5, 0.5, 0), (0.25, 0.25, 0.5)]
TRI = [(0, 2.5, 0), (0, -1.25, 2.1650635094610966), (0, -1.25, -2.1650635094610966)]
CANT = [(0.5, 2.4, 0.3), (0.3, -1.2, 2.1), (-0.2, -1.4, -2.0)]
RSTEP, N, PSIGMA, QDAMP, XI = 0.02, 1201, 0.15, 0.02, 8.0

out = {"cell": {"a": CELL[0], "b": CELL[1], "c": CELL[2]}, "positions": FRAC}
rc, fr_tri = run_case(CELL, FRAC, TRI, RSTEP, N, PSIGMA, QDAMP, 0.0, 24.0, 0.0)
out["tri"] = {"rstep": RSTEP, "n": N, "psigma": PSIGMA, "qdamp": QDAMP,
              "moments": TRI, "y": [float(f'{v:.9g}') for v in fr_tri]}
rc, fr_cant = run_case(CELL, FRAC, CANT, RSTEP, N, PSIGMA, QDAMP, XI, 24.0, 0.0)
out["cant"] = {"rstep": RSTEP, "n": N, "psigma": PSIGMA, "qdamp": QDAMP, "xi": XI,
               "moments": CANT, "y": [float(f'{v:.9g}') for v in fr_cant]}
mSq = float(np.mean([np.dot(v, v) for v in CANT]))
out["cant_dr"] = {"rstep": RSTEP, "n": N, "psigma": PSIGMA, "qdamp": QDAMP, "xi": XI,
                  "paraScale": 0.8, "mSqAvg": mSq,
                  "y": [float(f'{v:.9g}') for v in run_dr(rc, fr_cant, RSTEP, mSq, 0.8)[:N]]}
path = os.path.join(OUTDIR, 'synthetic_cases.json')
json.dump(out, open(path, 'w'))
print(f'{path} written (tri/cant/cant_dr) -- embed with scripts/gen-mpdf-golden-fixture.mjs')

# ------------------------------------------- real-data pointwise (local only)
DATA = os.path.join(REPO, 'data/PDF/Mn3Sn_PG3')
if not os.path.exists(os.path.join(DATA, 'golden.json')):
    print('no local data manifest -- skipping the pointwise fixture')
    sys.exit(0)
g = json.load(open(os.path.join(DATA, 'golden.json')))
mcif = open(os.path.join(DATA, g['mcif'])).read()
cellv = [float(re.search(rf'_cell_length_{x}\s+([\d.]+)', mcif).group(1)) for x in 'abc']
posmap = {p[0]: (float(p[1]), float(p[2]), float(p[3])) for p in
          re.findall(r'^(Mn\d+)\s+Mn\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)', mcif, re.M)}
momrows = [l.split() for l in mcif.splitlines()
           if re.match(r'^Mn\d+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s*$', l.strip())]
frac = [posmap[t[0]] for t in momrows]
moms = [(float(t[1]), float(t[2]), float(t[3])) for t in momrows]
assert len(moms) == 12
n_pw = int(round((g['fitMax'] + 4) / 0.01)) + 1
rc, fr = run_case(tuple(cellv), frac, moms, 0.01, n_pw, g['psigma'], g['qdampMag'],
                  g['xi'], g['fitMax'], 4.0)
mSq = float(np.mean([np.dot(v, v) for v in moms]))
fx = {"comment": "diffpy.mpdf magutils pointwise reference for the manifest's mcif in OUR "
                 "conventions (g=1, K1=(2/3)(gr0/2)^2, K2=K1*<m^2>), ordScale=paraScale=1, "
                 "psigma/qdamp/xi from golden.json, grid 0..fitMax+4 step 0.01. "
                 "UNPUBLISHED - local only, never commit.",
      "rstep": 0.01, "n": n_pw, "psigma": g['psigma'], "qdamp": g['qdampMag'],
      "xi": g['xi'], "mSqAvg": mSq,
      "f": [float(f'{v:.9g}') for v in fr],
      "d": [float(f'{v:.9g}') for v in run_dr(rc, fr, 0.01, mSq, 1.0)[:n_pw]]}
json.dump(fx, open(os.path.join(DATA, 'diffpy_pointwise.json'), 'w'))
print(f'{DATA}/diffpy_pointwise.json written (n={n_pw})')
