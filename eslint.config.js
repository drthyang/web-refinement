// @ts-check
/**
 * ESLint (flat config). The rule set is deliberately small: it enforces the
 * architectural claims the docs make, and nothing about formatting. A rule earns
 * its place only if the code already respects it — so every remaining
 * `eslint-disable` comment in the tree marks a real, deliberate exception
 * instead of describing a linter that was never there.
 *
 *   - `@typescript-eslint/no-explicit-any` — "`any` avoided" is an architecture
 *     rule; the few genuine escapes (MCP SDK shapes) are annotated in place.
 *   - `no-console` in non-test `src/**` — `console.info`/`warn`/`error` are the
 *     app's deliberate status and failure channels, so they are allowed; what
 *     the rule catches is leftover debugging (`console.log`, `dir`, `table`).
 *     Tests are exempt: printing measured numbers IS their validation record.
 *   - `react-hooks/rules-of-hooks` + `exhaustive-deps` — the dependency-array
 *     rule the workbenches suppress deliberately, per component, with a stated
 *     reason. Advisory (warn), as the React docs intend.
 *
 *   - `react-hooks/immutability` + `react-hooks/preserve-manual-memoization` —
 *     two of the React-Compiler rules from eslint-plugin-react-hooks v7, now on
 *     as errors. They paid for themselves on the way in: `immutability` found
 *     two real temporal-dead-zone reads in `KSearchPanel` (a `useState` setter
 *     and a `const` callback used by effects declared above them), and
 *     `preserve-manual-memoization` found a `WorkbenchPlot` memo the compiler
 *     could not keep, because it built three filtered copies of an intermediate
 *     object array. Both were fixed rather than suppressed. The single standing
 *     exception is the three.js material update in `StructureView`, disabled in
 *     place with its reason: that scene graph is mutated live by design.
 *
 * Deliberately NOT enabled yet: the two remaining React-Compiler rules,
 * `react-hooks/refs` (67 findings, almost all in the three workbenches) and
 * `react-hooks/set-state-in-effect` (20, spread over seven files). Both report
 * against components that were never written to them, and unlike the two above
 * they need real restructuring rather than local fixes — a separate piece of
 * work, not a lint gate.
 *
 * Type-aware linting is off: CI already runs `tsc -b`, so a second full type
 * build per lint would buy nothing.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      // Reference material, not source: the vendored design handoff, the design
      // notes, and the knowledge base.
      "design/**",
      "design_handoff_refinement_workbench/**",
      "knowledge/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/preserve-manual-memoization": "error",
      "react-hooks/immutability": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-console": ["error", { allow: ["info", "warn", "error"] }],
      "@typescript-eslint/no-explicit-any": "error",
      // The codebase leans on `!` where a bounds or map invariant has just been
      // established; that is a deliberate style, not an oversight.
      "@typescript-eslint/no-non-null-assertion": "off",
      // A leading underscore marks an argument kept to document a callback's
      // signature (`(problem, options, _dataset, index)`).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Tests and the GPU validation scripts print measured numbers on purpose —
    // agreement factors, timings, golden comparisons. That output is the record.
    files: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
