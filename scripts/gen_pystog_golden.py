"""Regenerate src/core/totalscattering/pystogGolden.ts — the external reference
for the S(Q) -> G(r) transform AND its propagated uncertainty.

pystog (ORNL, https://github.com/neutrons/pystog, https://pystog.readthedocs.io)
is the Python port of RMCProfile's StoG; its Transformer.S_to_G propagates a
dS(Q) column. This script runs it on a SYNTHETIC S(Q) whose formula the
TypeScript test re-evaluates (same IEEE operations: q = 0.4 + 0.02*k,
r = 0.1*j), so only pystog's OUTPUTS are stored — four cases:

    plain          no modification, no low-Q term
    lorch          Lorch (1969) modification, Qmax = last Q node
    lowq           OmittedXrangeCorrection (S(Q) linear to 0 below Qmin)
    lorch_lowq     both

Setup (any recent Python):

    uv venv --python 3.12 /tmp/sqenv
    uv pip install --python /tmp/sqenv/bin/python pystog numpy h5py pandas
    /tmp/sqenv/bin/python scripts/gen_pystog_golden.py

pystog 0.6.7 imports h5py/pandas at package import even though Transformer
needs neither.
"""
import json
import sys

import numpy as np
import pystog
from pystog import Transformer

SHELLS = [(2.5, 0.6, 0.006), (3.6, 0.45, 0.009), (4.4, 0.35, 0.011)]
NQ = 1181  # q = 0.4 ... 24.0
NR = 200  # r = 0.1 ... 20.0


def toy_sofq(q):
    """Must match toySofQ() in pystogGolden.test.ts operation for operation."""
    s = np.ones_like(q)
    for d, n, u in SHELLS:
        s = s + (n * np.sin(q * d)) / (q * d) * np.exp(-0.5 * u * q * q * d)
    return s


def main(out_path):
    q = 0.4 + 0.02 * np.arange(NQ)
    r = 0.1 * np.arange(1, NR + 1)
    sq = toy_sofq(q)
    dsq = 0.002 * (1 + 0.15 * q)

    cases = {}
    t = Transformer()
    for name, kw in [
        ("plain", {}),
        ("lorch", {"lorch": True}),
        ("lowq", {"OmittedXrangeCorrection": True}),
        ("lorch_lowq", {"lorch": True, "OmittedXrangeCorrection": True}),
    ]:
        _, g, dg = t.S_to_G(q.copy(), sq.copy(), r.copy(), dsq=dsq.copy(), **kw)
        cases[name] = {"g": [float(v) for v in g], "dg": [float(v) for v in dg]}

    def arr(xs):
        return "[" + ", ".join(repr(x) for x in xs) + "]"

    lines = [
        "/** pystog reference S(Q) -> G(r) transforms WITH propagated dG — GENERATED, do not edit.",
        f" * pystog {pystog.__version__} (numpy {np.__version__}); regenerate with scripts/gen_pystog_golden.py.",
        " * Input S(Q) is the formula toySofQ() in pystogGolden.test.ts on q = 0.4 + 0.02*k",
        f" * (k = 0..{NQ - 1}), dS = 0.002*(1 + 0.15*q); outputs on r = 0.1*j (j = 1..{NR}). */",
        "export interface PystogCase { readonly g: readonly number[]; readonly dg: readonly number[] }",
        "",
        f'export const PYSTOG_VERSION = "{pystog.__version__}";',
        "export const PYSTOG_GOLDEN: Readonly<Record<\"plain\" | \"lorch\" | \"lowq\" | \"lorch_lowq\", PystogCase>> = {",
    ]
    for name, c in cases.items():
        lines.append(f"  {name}: {{")
        lines.append(f"    g: {arr(c['g'])},")
        lines.append(f"    dg: {arr(c['dg'])},")
        lines.append("  },")
    lines.append("};")
    with open(out_path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"wrote {out_path}: {len(cases)} cases x {NR} r-points", file=sys.stderr)
    print(json.dumps({k: [v["g"][49], v["dg"][49]] for k, v in cases.items()}), file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "src/core/totalscattering/pystogGolden.ts")
