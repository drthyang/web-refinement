import { describe, it, expect } from "vitest";
import { MATH_SPAN_SOURCE, mathInside, texPieces } from "@/agent/ui/texText";

/** The pieces as one readable string: _x for a subscript, ^x for a superscript. */
const flat = (math: string): string => texPieces(math).map((p) => (p.script === "sub" ? `_${p.text}` : p.script === "sup" ? `^${p.text}` : p.text)).join("");

describe("texPieces", () => {
  it("reads what models write in chat", () => {
    expect(texPieces(String.raw`R_{\text{w}}`)).toEqual([{ text: "R" }, { text: "w", script: "sub" }]);
    expect(flat(String.raw`c_0 \leftrightarrow c_1`)).toBe("c_0 ↔ c_1");
    expect(flat(String.raw`d \approx 3.198\,\AA`)).toBe("d ≈ 3.198 Å");
    expect(flat(String.raw`\chi^2`)).toBe("χ^2");
    expect(flat(String.raw`U_{iso} = 0.012 \pm 0.001`)).toBe("U_iso = 0.012 ± 0.001");
    expect(flat(String.raw`\times 10^{-3}`)).toBe("× 10^-3");
    expect(flat(String.raw`\delta_2`)).toBe("δ_2");
    expect(flat(String.raw`\mathrm{Rw} = 8.12\%`)).toBe("Rw = 8.12%");
  });

  it("reads a simple fraction, keeps an unknown command's name and survives an unclosed brace", () => {
    expect(flat(String.raw`\frac{a}{b}`)).toBe("a/b");
    expect(flat(String.raw`\foo x`)).toBe("foo x");
    expect(flat("x_{12")).toBe("x_12");
  });
});

describe("MATH_SPAN_SOURCE", () => {
  const spans = (text: string): string[] => [...text.matchAll(new RegExp(MATH_SPAN_SOURCE, "g"))].map((m) => mathInside(m[0]));

  it("finds TeX spans, not prices", () => {
    expect(spans(String.raw`the $R_{\text{w}}$ stayed at 8.12% and $$\chi^2$$ fell`)).toEqual([String.raw`R_{\text{w}}`, String.raw`\chi^2`]);
    expect(spans("it costs $5 and $10 to run")).toEqual([]);
  });
});
