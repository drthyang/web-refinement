import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_VERSION } from "@/app/constants";

describe("release version", () => {
  it("package.json and APP_VERSION agree (the header badge and the MCP server read APP_VERSION)", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(APP_VERSION);
  });
});
