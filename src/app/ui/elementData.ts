/**
 * Element display data for the 3D structure viewer — CPK-style colours and
 * covalent radii (Å, Cordero et al. 2008). Ported from the rmc-phonon viewer so
 * the two apps render structures consistently. Extend as needed; unknown
 * elements fall back to grey / 1.0 Å.
 */

export const ELEMENT_COLORS: Readonly<Record<string, string>> = {
  H: "#ffffff", D: "#e0e0ff", He: "#d9ffff", Li: "#cc80ff", Be: "#c2ff00", B: "#ffb5b5",
  C: "#444444", N: "#3050f8", O: "#ff3030", F: "#90e050", Ne: "#b3e3f5", Na: "#ab5cf2",
  Mg: "#8aff00", Al: "#bfa6a6", Si: "#f0c8a0", P: "#ff8000", S: "#ffff30", Cl: "#1ff01f",
  Ar: "#80d1e3", K: "#8f40d4", Ca: "#3dff00", Sc: "#e6e6e6", Ti: "#bfc2c7", V: "#a6a6ab",
  Cr: "#8a99c7", Mn: "#9c7ac7", Fe: "#e06633", Co: "#f090a0", Ni: "#50d050", Cu: "#c88033",
  Zn: "#7d80b0", Ga: "#a67e5b", Ge: "#668f8f", As: "#bd80e3", Se: "#ff9900", Br: "#a62929",
  Kr: "#5cb8d1", Rb: "#702eb0", Sr: "#00ff00", Y: "#94ffff", Zr: "#94e0e0", Nb: "#73c2c9",
  Mo: "#54b5b5", Tc: "#3b9e9e", Ru: "#248f8f", Rh: "#0a7d8c", Pd: "#006985", Ag: "#c0c0c0",
  Cd: "#ffd98f", In: "#a67573", Sn: "#668080", Sb: "#9e63b5", Te: "#d4aa00", I: "#940094",
  Xe: "#429eb0", Cs: "#57178f", Ba: "#00c900", La: "#70d4ff", Ce: "#ffffc7", Pr: "#d9ffc7",
  Nd: "#c7ffc7", Pm: "#a3ffc7", Sm: "#8fffc7", Eu: "#61ffc7", Gd: "#45ffc7", Tb: "#30ffc7",
  Dy: "#1fffc7", Ho: "#00ff9c", Er: "#00e675", Tm: "#00d452", Yb: "#00bf38", Lu: "#00ab24",
  Hf: "#4dc2ff", Ta: "#4da6ff", W: "#2194d6", Re: "#267dab", Os: "#266696", Ir: "#175487",
  Pt: "#d0d0e0", Au: "#ffd123", Hg: "#b8b8d0", Tl: "#a6544d", Pb: "#575961", Bi: "#9e4fb5",
  Po: "#ab5c00", At: "#754f45", Rn: "#428296", Fr: "#420066", Ra: "#007d00", Ac: "#70abfa",
  Th: "#00baff", Pa: "#00a1ff", U: "#008fff", Np: "#0080ff", Pu: "#006bff", Am: "#545cf2",
  Cm: "#785ce3", Bk: "#8a4fe3", Cf: "#a136d4", Es: "#b31fd4",
};

export const COVALENT_RADII: Readonly<Record<string, number>> = {
  H: 0.31, D: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57,
  Ne: 0.58, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06,
  K: 2.03, Ca: 1.76, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26,
  Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20, As: 1.19, Se: 1.20, Br: 1.20, Kr: 1.16,
  Rb: 2.20, Sr: 1.95, Y: 1.90, Zr: 1.75, Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42,
  Pd: 1.39, Ag: 1.45, Cd: 1.44, In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.40,
  Cs: 2.44, Ba: 2.15, La: 2.07, Ce: 2.04, Pr: 2.03, Nd: 2.01, Pm: 1.99, Sm: 1.98, Eu: 1.98,
  Gd: 1.96, Tb: 1.94, Dy: 1.92, Ho: 1.92, Er: 1.89, Tm: 1.90, Yb: 1.87, Lu: 1.87, Hf: 1.75,
  Ta: 1.70, W: 1.62, Re: 1.51, Os: 1.44, Ir: 1.41, Pt: 1.36, Au: 1.36, Hg: 1.32, Tl: 1.45,
  Pb: 1.46, Bi: 1.48, Po: 1.40, At: 1.50, Rn: 1.50, Fr: 2.60, Ra: 2.21, Ac: 2.15, Th: 2.06,
  Pa: 2.00, U: 1.96, Np: 1.90, Pu: 1.87, Am: 1.80, Cm: 1.69,
};

/** Normalize a site element string (e.g. "Mn2+", "O2-") to a plain symbol "Mn"/"O". */
export function baseElement(element: string): string {
  const m = element.match(/^[A-Za-z]+/);
  if (!m) return element;
  const s = m[0];
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function elementColor(element: string): string {
  return ELEMENT_COLORS[baseElement(element)] ?? "#cccccc";
}

export function covalentRadius(element: string): number {
  return COVALENT_RADII[baseElement(element)] ?? 1.0;
}
