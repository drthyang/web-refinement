import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import "@/app/workbench.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only: expose the WebGPU validation harness on window.__gpuValidate for the
// structure-factor precision campaign. Tree-shaken out of production builds.
if (import.meta.env.DEV) {
  void import("@/workers/gpuValidationHarness").then((m) => m.installGpuValidationHarness());
}
