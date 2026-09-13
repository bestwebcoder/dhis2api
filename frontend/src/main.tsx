import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme, readPreference } from "./theme.js";
import "./styles.css";

// before React mounts, so the first paint is already in the right theme and a
// dark-mode user never sees a white flash
applyTheme(readPreference());

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

