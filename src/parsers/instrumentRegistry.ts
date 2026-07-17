/**
 * A registry of known diffraction instruments across the major neutron and
 * synchrotron facilities (US · UK · EU · other), used to recognise and label an
 * instrument from the header text of a loaded calibration file (`.instprm`,
 * `.irf`, GSAS header, …). Instrument files almost always name the beamline in a
 * title or comment line — e.g. FullProf's "! Resolution Function of D1B-ILL",
 * or a Mantid/GSAS-II "Instrument: POWGEN" — so a case-insensitive alias scan is
 * both simple and reliable.
 *
 * This is a display/UX aid, not a physics input: it fills the Instrument card
 * with the beamline + facility. The table is intentionally easy to extend — add
 * a row and the recognizer picks it up. Aliases should be specific enough to
 * avoid false hits (word-boundary matched).
 */

export interface FacilityInstrument {
  /** Canonical display name, e.g. "POWGEN". */
  readonly name: string;
  /** Facility acronym, e.g. "SNS". */
  readonly facility: string;
  /** Hosting laboratory / site, e.g. "ORNL". */
  readonly lab: string;
  /** Country / region. */
  readonly country: string;
  /** Probe and typical mode (for display + future auto-config). */
  readonly probe: "neutron" | "xray";
  readonly mode: "tof" | "cw";
  /** Strings to match in a file header (case-insensitive, word-boundary). */
  readonly aliases: readonly string[];
}

/** Extend freely — one row per beamline. Ordered longest-alias-first isn't
 *  required; the recognizer prefers the most specific match. */
export const INSTRUMENTS: readonly FacilityInstrument[] = [
  // ── United States ──────────────────────────────────────────────────────────
  { name: "POWGEN", facility: "SNS", lab: "ORNL", country: "USA", probe: "neutron", mode: "tof", aliases: ["POWGEN", "PG3"] },
  { name: "NOMAD", facility: "SNS", lab: "ORNL", country: "USA", probe: "neutron", mode: "tof", aliases: ["NOMAD", "NOM"] },
  { name: "VULCAN", facility: "SNS", lab: "ORNL", country: "USA", probe: "neutron", mode: "tof", aliases: ["VULCAN"] },
  { name: "CORELLI", facility: "SNS", lab: "ORNL", country: "USA", probe: "neutron", mode: "tof", aliases: ["CORELLI"] },
  { name: "TOPAZ", facility: "SNS", lab: "ORNL", country: "USA", probe: "neutron", mode: "tof", aliases: ["TOPAZ"] },
  { name: "HB-2A (POWDER)", facility: "HFIR", lab: "ORNL", country: "USA", probe: "neutron", mode: "cw", aliases: ["HB-2A", "HB2A"] },
  { name: "WAND² (HB-2C)", facility: "HFIR", lab: "ORNL", country: "USA", probe: "neutron", mode: "cw", aliases: ["HB-2C", "HB2C", "WAND"] },
  { name: "DEMAND (HB-3A)", facility: "HFIR", lab: "ORNL", country: "USA", probe: "neutron", mode: "cw", aliases: ["HB-3A", "HB3A", "DEMAND"] },
  { name: "11-BM", facility: "APS", lab: "ANL", country: "USA", probe: "xray", mode: "cw", aliases: ["11-BM", "11BM", "APS11BM"] },
  { name: "28-ID", facility: "NSLS-II", lab: "BNL", country: "USA", probe: "xray", mode: "cw", aliases: ["28-ID", "28ID", "XPD"] },

  // ── United Kingdom (ISIS, RAL) ─────────────────────────────────────────────
  { name: "HRPD", facility: "ISIS", lab: "RAL", country: "UK", probe: "neutron", mode: "tof", aliases: ["HRPD"] },
  { name: "GEM", facility: "ISIS", lab: "RAL", country: "UK", probe: "neutron", mode: "tof", aliases: ["GEM"] },
  { name: "POLARIS", facility: "ISIS", lab: "RAL", country: "UK", probe: "neutron", mode: "tof", aliases: ["POLARIS"] },
  { name: "WISH", facility: "ISIS", lab: "RAL", country: "UK", probe: "neutron", mode: "tof", aliases: ["WISH"] },
  { name: "SXD", facility: "ISIS", lab: "RAL", country: "UK", probe: "neutron", mode: "tof", aliases: ["SXD"] },
  { name: "PEARL", facility: "ISIS", lab: "RAL", country: "UK", probe: "neutron", mode: "tof", aliases: ["PEARL"] },

  // ── Europe (ILL · PSI · MLZ · ESRF) ────────────────────────────────────────
  { name: "D1B", facility: "ILL", lab: "ILL", country: "France", probe: "neutron", mode: "cw", aliases: ["D1B"] },
  { name: "D20", facility: "ILL", lab: "ILL", country: "France", probe: "neutron", mode: "cw", aliases: ["D20"] },
  { name: "D2B", facility: "ILL", lab: "ILL", country: "France", probe: "neutron", mode: "cw", aliases: ["D2B"] },
  { name: "D1A", facility: "ILL", lab: "ILL", country: "France", probe: "neutron", mode: "cw", aliases: ["D1A"] },
  { name: "D9", facility: "ILL", lab: "ILL", country: "France", probe: "neutron", mode: "cw", aliases: ["D9"] },
  { name: "D10", facility: "ILL", lab: "ILL", country: "France", probe: "neutron", mode: "cw", aliases: ["D10"] },
  { name: "D19", facility: "ILL", lab: "ILL", country: "France", probe: "neutron", mode: "cw", aliases: ["D19"] },
  { name: "HRPT", facility: "SINQ", lab: "PSI", country: "Switzerland", probe: "neutron", mode: "cw", aliases: ["HRPT"] },
  { name: "DMC", facility: "SINQ", lab: "PSI", country: "Switzerland", probe: "neutron", mode: "cw", aliases: ["DMC"] },
  { name: "SPODI", facility: "MLZ", lab: "FRM II", country: "Germany", probe: "neutron", mode: "cw", aliases: ["SPODI"] },
  { name: "ID22", facility: "ESRF", lab: "ESRF", country: "France", probe: "xray", mode: "cw", aliases: ["ID22"] },
  { name: "P02.1", facility: "PETRA III", lab: "DESY", country: "Germany", probe: "xray", mode: "cw", aliases: ["P02.1", "P021"] },

  // ── Other facilities ───────────────────────────────────────────────────────
  { name: "SuperHRPD", facility: "J-PARC", lab: "J-PARC", country: "Japan", probe: "neutron", mode: "tof", aliases: ["SuperHRPD", "SHRPD"] },
  { name: "iMATERIA", facility: "J-PARC", lab: "J-PARC", country: "Japan", probe: "neutron", mode: "tof", aliases: ["iMATERIA", "IMATERIA"] },
  { name: "SENJU", facility: "J-PARC", lab: "J-PARC", country: "Japan", probe: "neutron", mode: "tof", aliases: ["SENJU"] },
  { name: "BL02B2", facility: "SPring-8", lab: "SPring-8", country: "Japan", probe: "xray", mode: "cw", aliases: ["BL02B2"] },
  { name: "ECHIDNA", facility: "ANSTO", lab: "ANSTO", country: "Australia", probe: "neutron", mode: "cw", aliases: ["ECHIDNA"] },
  { name: "WOMBAT", facility: "ANSTO", lab: "ANSTO", country: "Australia", probe: "neutron", mode: "cw", aliases: ["WOMBAT"] },
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Recognise the instrument named in a calibration-file header. Scans for each
 * registry alias with word boundaries; on a tie, prefers the longest alias (so
 * "HB-3A" wins over a stray "HB"). Returns the matched instrument or undefined.
 */
export function recognizeInstrument(text: string): FacilityInstrument | undefined {
  let best: { inst: FacilityInstrument; len: number } | undefined;
  for (const inst of INSTRUMENTS) {
    for (const alias of inst.aliases) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(alias)}([^A-Za-z0-9]|$)`, "i");
      if (re.test(text) && (!best || alias.length > best.len)) best = { inst, len: alias.length };
    }
  }
  return best?.inst;
}

/** Facility + lab + country, e.g. "SNS · ORNL, USA" (no beamline name). */
export function facilityLabel(inst: FacilityInstrument): string {
  const site = inst.facility === inst.lab ? inst.facility : `${inst.facility} · ${inst.lab}`;
  return `${site}, ${inst.country}`;
}

