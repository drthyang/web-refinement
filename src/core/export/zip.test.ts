import { describe, it, expect } from "vitest";
import { zipStore } from "@/core/export/zip";

describe("zipStore", () => {
  const archive = zipStore([
    { name: "fullprof/MnO.pcr", data: "COMM MnO\n" },
    { name: "README.txt", data: "bundle" },
  ]);
  const view = new DataView(archive.buffer);

  it("starts with a local file header and ends with an EOCD record", () => {
    expect(view.getUint32(0, true)).toBe(0x04034b50); // PK\x03\x04
    const eocd = archive.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50); // PK\x05\x06
    expect(view.getUint16(eocd + 10, true)).toBe(2); // total entries
  });

  it("round-trips a STORE entry back to its bytes", () => {
    // First local header at offset 0: read the name + data and compare.
    const nameLen = view.getUint16(26, true);
    const size = view.getUint32(22, true);
    const name = new TextDecoder().decode(archive.subarray(30, 30 + nameLen));
    const data = new TextDecoder().decode(archive.subarray(30 + nameLen, 30 + nameLen + size));
    expect(name).toBe("fullprof/MnO.pcr");
    expect(data).toBe("COMM MnO\n");
    expect(view.getUint16(8, true)).toBe(0); // method 0 = store
  });

  it("accepts binary data and is deterministic", () => {
    const bin = new Uint8Array([0, 1, 2, 255, 128]);
    const a = zipStore([{ name: "d.bin", data: bin }]);
    const b = zipStore([{ name: "d.bin", data: bin }]);
    expect(a).toEqual(b); // fixed timestamps → byte-identical archives
  });
});
