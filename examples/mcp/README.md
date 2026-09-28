# Example data for the agent tools

The app's bundled demo data as plain files, so an MCP client can load them by
`path`, plus one simulated magnetic pattern. The worked examples that use them are in
[docs/AGENT_EXAMPLES.md](../../docs/AGENT_EXAMPLES.md).

| File | What it is |
|---|---|
| `mn3ga.cif` | Mn₃Ga, P6₃/mmc |
| `mno.cif` | MnO, Fm-3m (the impurity in the Mn₃Ga POWGEN sample) |
| `powgen_600k.irf` | TOF calibration (difC) of `src/examples/datasets/mn3ga_powgen_600k.dat` |
| `mn3ga_30k_nuclear.cif` | Mn₃Ga at 30 K, P2₁/m: the nuclear part of the bundled magnetic structure |
| `mn3ga_30k_sim.xye` | Neutron pattern **simulated** from that magnetic structure (λ 1.54 Å, seeded noise) |
| `mn3ga_30k.instprm` | The instrument it was simulated with (GSAS-II parameters) |
| `gata4se8.cif` | GaTa₄Se₈, F-43m |
| `gata4se8_299k.gr` | GaTa₄Se₈ X-ray PDF at 299 K (NSLS-II 28-ID) |

These files are written from the app's sources by
`src/mcp/examples.test.ts`; do not edit them by hand.
