import { describe, it, expect } from "vitest";
import { parseInstrumentParameters } from "@/parsers/instrument";

describe("parseInstrumentParameters", () => {
  it("reads a GSAS-II constant-wavelength .instprm incl. Caglioti U,V,W and polarization", () => {
    const text = [
      "#GSAS-II instrument parameter file; do not add/delete items!",
      "Type:PXC",
      "Lam:0.1665",
      "Zero:0.0",
      "Polariz.:0.8442443204963332",
      "U:-46.05407875520966",
      "V:0.0",
      "W:1.208754241879003",
      "X:0.0",
      "SH/L:0.002711817508568138",
      "Bank:1.0",
    ].join("\n");
    const p = parseInstrumentParameters(text);
    expect(p.kind).toBe("constantWavelength");
    if (p.kind !== "constantWavelength") throw new Error("wrong kind");
    expect(p.wavelength).toBeCloseTo(0.1665, 6);
    expect(p.zero).toBe(0);
    expect(p.u).toBeCloseTo(-46.054, 3);
    expect(p.v).toBe(0);
    expect(p.w).toBeCloseTo(1.2088, 4);
    expect(p.polarization).toBeCloseTo(0.8442, 4);
  });

  it("still parses a TOF file (difC) without profile terms", () => {
    const p = parseInstrumentParameters("difC: 5000\nZero: -1.2\n");
    expect(p.kind).toBe("tof");
    if (p.kind === "tof") expect(p.difC).toBe(5000);
  });
});
