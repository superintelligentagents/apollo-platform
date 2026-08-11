import "@odyssey/shared/src/styles.css";
import "./site.css";
import { mountApp } from "@odyssey/shared";
import { createWebAdapter } from "./web-adapter";

// Exposed in the DOM so release smoke tests can confirm the browser loaded the
// current web bundle instead of a stale CDN or disk-cached asset.
document.documentElement.dataset.apolloRelease = "2026-07-25.2";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
mountApp(root, createWebAdapter());
