import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { buildId } from "../shared/build";
import { App } from "./app";
import { getLoadingPerformanceSnapshot } from "./performance/loading-performance";
import { getDriveLibraryCacheDiagnostics } from "./score-library/drive-library-cache";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

document.documentElement.dataset.buildId = buildId;
Object.defineProperty(window, "__SAME_PAGE_DIAGNOSTICS__", {
  configurable: false,
  value: Object.freeze({
    buildId,
    driveLibraryCache: getDriveLibraryCacheDiagnostics,
    loadingPerformance: getLoadingPerformanceSnapshot,
  }),
  writable: false,
});

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
