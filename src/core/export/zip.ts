/**
 * Minimal dependency-free ZIP writer (STORE method — no compression).
 *
 * Export bundles are a handful of small text files, so compression buys nothing;
 * this emits a spec-correct STORE-only archive (local file headers + central
 * directory + end-of-central-directory, CRC-32 per entry) that any unzip tool
 * reads. Pure producer: returns the archive bytes; downloading is a UI concern.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path within the archive (forward slashes for folders). */
  readonly name: string;
  /** File contents; strings are encoded as UTF-8. */
  readonly data: string | Uint8Array;
}

// Fixed DOS timestamp (1980-01-01 00:00) — deterministic archives.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const UTF8_FLAG = 0x0800; // filenames are UTF-8

/** Build a spec-correct STORE-only ZIP archive from the given entries. */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const files = entries.map((e) => ({
    name: encoder.encode(e.name),
    data: typeof e.data === "string" ? encoder.encode(e.data) : e.data,
  }));

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = new Uint8Array(30 + f.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, f.name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(f.name, 30);
    parts.push(local, f.data);

    const cd = new Uint8Array(46 + f.name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, f.name.length, true);
    cv.setUint32(42, offset, true); // local header offset
    cd.set(f.name, 46);
    central.push(cd);

    offset += local.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const cd of central) { parts.push(cd); centralSize += cd.length; }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, files.length, true); // entries on this disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  parts.push(eocd);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}
