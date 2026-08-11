import type { Cluster } from "../../types";
import { GENERIC_SITE_FAMILIES, siteFamily } from "../../themes";
import { clusterEnd, clusterStart } from "../../clustering";

type Attrs = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value as EventListener);
      } else if (key === "class") {
        node.className = String(value);
      } else if (key === "dataset" && typeof value === "object") {
        Object.assign(node.dataset, value);
      } else if (key in node && (key === "value" || key === "checked" || key === "disabled" || key === "selected")) {
        (node as unknown as Record<string, unknown>)[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const DAY_YEAR_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function fmtDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : DAY_FMT.format(d);
}

export function fmtDayYear(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : DAY_YEAR_FMT.format(d);
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : TIME_FMT.format(d);
}

export function dayKey(iso: string | null): string {
  // Local calendar day, matching what the user sees in row times and enters
  // in the date filters (a UTC slice put near-midnight visits on the wrong day).
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function spanDays(startIso: string | null, endIso: string | null): number {
  if (!startIso || !endIso) return 0;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)) + 1);
}

export function journeyTitle(c: Cluster): string {
  for (const v of c.visits) {
    const t = (v.title || "").trim();
    if (t) return t;
  }
  return c.visits[0]?.url || "Untitled journey";
}

export function journeyFamilies(c: Cluster, limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const v of c.visits) {
    const family = siteFamily(v.domain || hostOf(v.url));
    if (family) counts.set(family, (counts.get(family) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => {
    const aGeneric = GENERIC_SITE_FAMILIES.has(a[0]) ? 1 : 0;
    const bGeneric = GENERIC_SITE_FAMILIES.has(b[0]) ? 1 : 0;
    return aGeneric - bGeneric || b[1] - a[1];
  });
  return ranked.slice(0, limit).map(([f]) => f);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function journeyRange(c: Cluster): string {
  const start = clusterStart(c);
  const end = clusterEnd(c);
  const day = fmtDay(start);
  const t1 = fmtTime(start);
  const t2 = fmtTime(end);
  return t1 === t2 ? `${day} · ${t1}` : `${day} · ${t1}–${t2}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function chip(text: string, extraClass = ""): HTMLElement {
  return el("span", { class: `chip ${extraClass}`.trim() }, text);
}

export function stepper(
  active: number,
  labels?: readonly string[],
  onStep?: (n: number) => void
): HTMLElement {
  const steps = labels ?? ["Select journeys", "Describe the task", "Review & submit"];
  const wrap = el("ol", { class: "stepper" });
  steps.forEach((label, i) => {
    const n = i + 1;
    const done = n < active;
    const clickable = done && !!onStep;
    const item = el(
      "li",
      {
        class: `step ${n === active ? "active" : done ? "done" : ""} ${clickable ? "clickable" : ""}`.trim(),
        ...(clickable
          ? {
              role: "button",
              tabindex: "0",
              title: "Go back to this step",
              onclick: () => onStep!(n),
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") onStep!(n);
              },
            }
          : {}),
      },
      el("span", { class: "step-dot" }, done ? "✓" : String(n)),
      el("span", { class: "step-label" }, label)
    );
    wrap.append(item);
  });
  return wrap;
}
