import { describe, it, expect } from "vitest";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { instrumentToInstprm, buildGpxScript } from "@/core/export/gsas2";

describe("instrumentToInstprm", () => {
  it("writes a TOF (PNT) file with the expected key set", () => {
    const tof: InstrumentParameters = { kind: "tof", difC: 22586.15, difA: -6.75, difB: -1.57, zero: 5.67 };
    const out = instrumentToInstprm(tof);
    expect(out.startsWith("#GSAS-II instrument parameter file; do not add/delete items!")).toBe(true);
    expect(out).toContain("Type:PNT");
    expect(out).toContain("difC:22586.15");
    expect(out).toContain("Zero:5.67");
    // Peak-shape keys must be present (GSAS-II forbids adding/deleting items).
    for (const k of ["alpha", "beta-0", "beta-1", "beta-q", "sig-0", "sig-1", "sig-2", "sig-q", "fltPath"]) {
      expect(out).toContain(`${k}:`);
    }
    expect(out).not.toContain("Lam:"); // TOF has no monochromatic wavelength
  });

  it("writes a CW X-ray (PXC) file with Polariz. and Source", () => {
    const cw: InstrumentParameters = { kind: "constantWavelength", radiationKind: "xray", wavelength: 0.1665, u: -46, v: 0, w: 1.2, polarization: 0.84 };
    const out = instrumentToInstprm(cw);
    expect(out).toContain("Type:PXC");
    expect(out).toContain("Lam:0.1665");
    expect(out).toContain("Polariz.:0.84");
    expect(out).toContain("Source:");
    expect(out).toContain("W:1.2");
  });

  it("writes a CW neutron (PNC) file without X-ray-only keys", () => {
    const cw: InstrumentParameters = { kind: "constantWavelength", radiationKind: "neutron", wavelength: 1.5 };
    const out = instrumentToInstprm(cw);
    expect(out).toContain("Type:PNC");
    expect(out).toContain("Lam:1.5");
    expect(out).not.toContain("Polariz.");
    expect(out).not.toContain("Source:");
  });
});

describe("buildGpxScript", () => {
  it("emits a powder script with the verified scriptable API", () => {
    const py = buildGpxScript({
      gpxName: "MnO.gpx", cifFile: "MnO.cif", phaseName: "MnO",
      dataFile: "MnO.xye", instprmFile: "MnO.instprm", histogramKind: "powder",
    });
    expect(py).toContain("import GSASIIscriptable as G2sc");
    expect(py).toContain("G2sc.G2Project(newgpx='MnO.gpx')");
    expect(py).toContain("gpx.add_phase('MnO.cif', phasename='MnO', fmthint='CIF')");
    expect(py).toContain("gpx.add_powder_histogram('MnO.xye', 'MnO.instprm', phases=[phase])");
    expect(py).toContain("gpx.save()");
  });

  it("probes legacy flat-directory installs before giving up on the import", () => {
    const py = buildGpxScript({
      gpxName: "MnO.gpx", cifFile: "MnO.cif", phaseName: "MnO",
      dataFile: "MnO.xye", instprmFile: "MnO.instprm", histogramKind: "powder",
    });
    expect(py).toContain("from GSASII import GSASIIscriptable as G2sc");
    expect(py).toContain("os.environ.get('GSASII_HOME')");
    for (const probe of [
      "os.path.join(_home, 'gsas2full', 'GSASII')",
      "os.path.join(_home, 'g2full', 'GSAS-II')",
      "os.path.join(_home, 'gsas2main', 'GSAS-II')",
    ]) {
      expect(py).toContain(probe);
    }
    expect(py).toContain("sys.path.insert(0, _dir)");
    // The retry import comes after the probe, so the script still ends up
    // with G2sc bound when a legacy install is found.
    expect(py.indexOf("sys.path.insert(0, _dir)")).toBeLessThan(py.lastIndexOf("import GSASIIscriptable as G2sc"));
  });

  it("emits a single-crystal script using add_single_histogram", () => {
    const py = buildGpxScript({
      gpxName: "Eu324.gpx", cifFile: "Eu324.cif", phaseName: "Eu3In2Te4",
      dataFile: "Eu324.hkl", histogramKind: "single", dataFmthint: "HKLF",
    });
    expect(py).toContain("gpx.add_single_histogram('Eu324.hkl', phase=phase, fmthint='HKLF')");
    expect(py).not.toContain("add_powder_histogram");
  });
});
