import { APP_NAME, APP_VERSION } from "@/app/constants";

/**
 * Placeholder application shell.
 *
 * Phase 0 deliverable: this is intentionally minimal. It exists only so that
 * `npm run dev` / `npm run build` produce a working page. Feature UI arrives in
 * Phase 1+. Per the architecture rules, no scientific calculation lives here.
 */
export function App(): JSX.Element {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 720 }}>
      <h1>{APP_NAME}</h1>
      <p>Version {APP_VERSION} — architecture skeleton (Phase 0).</p>
      <p>
        Browser-native workbench for atomic and magnetic structure refinement. The scientific
        engine is being built in phases; see <code>docs/ROADMAP.md</code>.
      </p>
      <p style={{ color: "#a00" }}>
        Not a replacement for GSAS-II, FullProf, Jana2020, or ShelX. Results intended for
        publication must be validated against established tools.
      </p>
    </main>
  );
}
