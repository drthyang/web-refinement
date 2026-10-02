/**
 * Chemical element symbols (IUPAC), indexed by atomic number − 1, and the
 * case-insensitive symbol resolution CIF labels need.
 */

export const ELEMENT_SYMBOLS: readonly string[] = [
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
  "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe",
  "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu",
  "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn",
  "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr",
  "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
];

/** Element symbols plus D (deuterium), which crystallographic files use as an
 *  atom type of its own. */
const KNOWN = new Set<string>([...ELEMENT_SYMBOLS, "D"]);

/** Canonical capitalization: first letter upper case, the rest lower case. */
function canonical(letters: string): string {
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

/**
 * The element named by the leading letters of a symbol or label, matched case
 * insensitively and preferring the two-letter symbol: "FE1" → Fe, "CA1" → Ca,
 * "Ca1" → Ca, "C1" → C, "OW3" → O (no element "Ow"). Undefined when neither
 * the first two nor the first letter is an element.
 */
export function elementFromLetters(text: string): string | undefined {
  const letters = /^[A-Za-z]+/.exec(text.trim())?.[0];
  if (!letters) return undefined;
  if (letters.length >= 2 && KNOWN.has(canonical(letters.slice(0, 2)))) return canonical(letters.slice(0, 2));
  return KNOWN.has(canonical(letters.charAt(0))) ? canonical(letters.charAt(0)) : undefined;
}
