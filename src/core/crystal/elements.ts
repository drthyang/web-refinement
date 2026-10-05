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

/** What the rest of a file says about how its atom-site labels spell elements. */
export interface LabelContext {
  /** Some label spells its element in proper case ("Fe1", "Ow1"), so letter
   *  case in this file's labels means something. */
  readonly caseAware: boolean;
  /** The elements of the file's `_chemical_formula_sum`, when it has one. */
  readonly formula?: ReadonlySet<string>;
}

/**
 * The element an atom-site label names, honouring letter case: one element, or
 * the two candidates when the label cannot decide, or none.
 *  - Proper case is read as written: "Fe1" → Fe, "Ca1" → Ca, "Ow1" → O.
 *  - A second capital ("CO1") can be a two-letter symbol in capitals (Co) or a
 *    one-letter symbol plus a capital suffix (C). When only one reading is an
 *    element it is taken ("OW1" → O, "MN1" → Mn); otherwise the formula
 *    decides if it names exactly one of them; otherwise, when no label in the
 *    file uses lower case, case carries no information and the two-letter
 *    reading is taken ("FE1" → Fe, "CA1" → Ca). In a file that does use lower
 *    case the label is ambiguous.
 */
export function elementsForLabel(label: string, context: LabelContext): string[] {
  const letters = /^[A-Za-z]+/.exec(label.trim())?.[0] ?? "";
  const one = canonical(letters.charAt(0));
  const oneOk = letters.length > 0 && KNOWN.has(one);
  if (letters.length < 2) return oneOk ? [one] : [];
  if (/^[A-Z][a-z]/.test(letters)) {
    const two = letters.slice(0, 2);
    return KNOWN.has(two) ? [two] : oneOk ? [one] : [];
  }
  const two = canonical(letters.slice(0, 2));
  const twoOk = KNOWN.has(two);
  if (!twoOk || !oneOk) return twoOk ? [two] : oneOk ? [one] : [];
  const named = [two, one].filter((e) => context.formula?.has(e));
  if (named.length === 1) return named;
  return context.caseAware ? [two, one] : [two];
}

/** True when a label spells its element in proper case, e.g. "Fe1", "Ow1". */
export function labelUsesCase(label: string): boolean {
  return /^[A-Z][a-z]/.test(label.trim());
}

/** The element symbols of a CIF `_chemical_formula_sum`, e.g. "Ca O3 Ti". */
export function formulaElements(formula: string): Set<string> {
  const out = new Set<string>();
  for (const m of formula.matchAll(/([A-Z][a-z]?)/g)) if (KNOWN.has(m[1]!)) out.add(m[1]!);
  return out;
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
