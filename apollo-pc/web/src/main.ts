import "@apollo-pc/shared/src/styles.css";
import "./site.css";
import { mountApp } from "@apollo-pc/shared";
import { createPcAdapter } from "./pc-adapter";

document.documentElement.dataset.apolloPcRelease = "2026-08-12.6";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
void mountApp(root, createPcAdapter());
