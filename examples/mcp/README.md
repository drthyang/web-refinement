# Example data for the agent tools

The app's bundled demo data as plain files, so an MCP client can load them by
`path`. The worked examples that use them are in
[docs/AGENT_EXAMPLES.md](../../docs/AGENT_EXAMPLES.md).

| File | What it is |
|---|---|
| `mn3ga.cif` | Mn₃Ga, P6₃/mmc |
| `mno.cif` | MnO, Fm-3m (the impurity in the Mn₃Ga POWGEN sample) |
| `powgen_600k.irf` | TOF calibration (difC) of `src/examples/datasets/mn3ga_powgen_600k.dat` |
| `gata4se8.cif` | GaTa₄Se₈, F-43m |
| `gata4se8_299k.gr` | GaTa₄Se₈ X-ray PDF at 299 K (NSLS-II 28-ID) |

These files are written from the app's sources by
`src/mcp/examples.test.ts`; do not edit them by hand.
