import { describe, it, expect } from "vitest";
import { tableRows } from "@/agent/ui/markdownTable";

describe("tableRows", () => {
  it("reads a pipe table: header, separator, rows", () => {
    const lines = ["| site | x | B (Å²) |", "|---|---|:---:|", "| Ca1 4f | ⅓ | 0.41(2) |", "| F 2a | 0 | 1.14(9) |"];
    expect(tableRows(lines)).toEqual([["site", "x", "B (Å²)"], ["Ca1 4f", "⅓", "0.41(2)"], ["F 2a", "0", "1.14(9)"]]);
  });

  it("leaves anything else to the paragraph and list readers", () => {
    expect(tableRows(["| a | b |"])).toBeNull();
    expect(tableRows(["| a | b |", "| c | d |"])).toBeNull();
    expect(tableRows(["a | b", "---|---"])).toBeNull();
  });
});
