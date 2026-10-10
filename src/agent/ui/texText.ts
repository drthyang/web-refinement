/**
 * Inline TeX as models write it in chat ("$R_{\text{w}}$", "$c_0 \leftrightarrow
 * c_1$", "$\chi^2$"), read as plain text with sub- and superscripts for the
 * drawer's small Markdown renderer. The system prompt asks for no LaTeX, but
 * local models write it anyway; showing the dollar signs and backslashes is
 * worse than a plain reading. Not a TeX renderer: a simple fraction reads
 * a/b, and anything richer stays as its text.
 */

export interface TexPiece {
  readonly text: string;
  readonly script?: "sub" | "sup";
}

/**
 * A `$…$` (or `$$…$$`) span on one line that reads as math: no space just
 * inside the dollars, as TeX writes it, so "costs $5 and $10" is left alone.
 */
export const MATH_SPAN_SOURCE = String.raw`\$\$?[^\s$](?:[^$\n]*[^\s$])?\$\$?`;

const SYMBOL: Readonly<Record<string, string>> = {
  leftrightarrow: "↔", rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", Leftrightarrow: "⇔",
  approx: "≈", sim: "~", simeq: "≃", propto: "∝", times: "×", cdot: "·", pm: "±", mp: "∓",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", ll: "≪", gg: "≫", infty: "∞", partial: "∂",
  AA: "Å", angstrom: "Å", circ: "°", degree: "°", deg: "°", sum: "Σ", sqrt: "√", langle: "⟨", rangle: "⟩",
  alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ", delta: "δ", Delta: "Δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ", phi: "φ", varphi: "φ", Phi: "Φ",
  chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω", quad: " ", qquad: " ",
  left: "", right: "", big: "", Big: "", displaystyle: "",
};

/** Commands whose braced argument is just text: `\text{w}` → "w". */
const WRAPPER = /\\(?:text|textrm|textit|textbf|mathrm|mathbf|mathit|mathsf|mathcal|operatorname|mbox)\s*\{([^{}]*)\}/g;

/** The math inside a span (without its dollars), as plain pieces and scripts. */
export function texPieces(math: string): TexPiece[] {
  let s = math;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(WRAPPER, "$1");
    if (next === s) break;
    s = next;
  }
  s = s
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\([%{}#&_$])/g, "$1")
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => SYMBOL[name] ?? name);

  const out: TexPiece[] = [];
  let plain = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if ((c === "_" || c === "^") && i + 1 < s.length) {
      let arg: string;
      if (s[i + 1] === "{") {
        const close = closingBrace(s, i + 1);
        arg = s.slice(i + 2, close);
        i = close;
      } else {
        arg = s[i + 1]!;
        i += 1;
      }
      if (plain) out.push({ text: plain });
      plain = "";
      out.push({ text: arg.replace(/[{}^_]/g, ""), script: c === "_" ? "sub" : "sup" });
    } else if (c !== "{" && c !== "}") {
      plain += c;
    }
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** Strip a span's dollars: "$$x$$" or "$x$" → "x". */
export function mathInside(span: string): string {
  return span.replace(/^\$\$?/, "").replace(/\$\$?$/, "");
}

function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return s.length;
}
