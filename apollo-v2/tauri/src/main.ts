import "@odyssey/shared/src/styles.css";
import { mountApp } from "@odyssey/shared";
import { createTauriAdapter } from "./tauri-adapter";

window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root");
  mountApp(root, createTauriAdapter());
});
