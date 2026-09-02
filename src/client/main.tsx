import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { buildId } from "../shared/build";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

document.documentElement.dataset.buildId = buildId;

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
