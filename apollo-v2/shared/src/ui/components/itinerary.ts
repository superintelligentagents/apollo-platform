import type { Cluster } from "../../types";
import { clusterStart } from "../../clustering";
import { chip, el, fmtBytes, fmtDay, journeyFamilies, journeyTitle, spanDays } from "./helpers";

export type ItineraryOptions = {
  title: string;
  readOnly?: boolean;
  minJourneys?: number;
  estimatedBytes?: number;
  onMove?(index: number, delta: number): void;
  onRemove?(index: number): void;
  footer?: HTMLElement | null;
};

// The itinerary rail: selected journeys as waypoints on a route line, in task
// order. This is the object the participant is building — a voyage across days.
export function itinerary(basket: Cluster[], opts: ItineraryOptions): HTMLElement {
  const rail = el("aside", { class: "itinerary" });
  rail.append(el("div", { class: "itinerary-title" }, opts.title));

  if (!basket.length) {
    rail.append(
      el(
        "div",
        { class: "itinerary-empty" },
        el("div", { class: "itinerary-empty-mark" }, "◈"),
        el("p", null, "Check sessions on the left that belong to one bigger goal.")
      )
    );
  } else {
    const route = el("ol", { class: "route" });
    basket.forEach((c, i) => {
      const families = journeyFamilies(c);
      const controls = opts.readOnly
        ? null
        : el(
            "div",
            { class: "waypoint-controls" },
            el("button", {
              class: "icon-btn",
              type: "button",
              title: "Move earlier",
              disabled: i === 0,
              onclick: () => opts.onMove?.(i, -1),
            }, "↑"),
            el("button", {
              class: "icon-btn",
              type: "button",
              title: "Move later",
              disabled: i === basket.length - 1,
              onclick: () => opts.onMove?.(i, 1),
            }, "↓"),
            el("button", {
              class: "icon-btn danger",
              type: "button",
              title: "Remove from task",
              onclick: () => opts.onRemove?.(i),
            }, "✕")
          );
      route.append(
        el(
          "li",
          { class: "waypoint" },
          el("span", { class: "waypoint-dot" }),
          el(
            "div",
            { class: "waypoint-body" },
            el("div", { class: "waypoint-date mono" }, fmtDay(clusterStart(c))),
            el("div", { class: "waypoint-title" }, journeyTitle(c)),
            el("div", { class: "waypoint-chips" }, ...families.map((f) => chip(f, "tag"))),
            controls
          )
        )
      );
    });
    rail.append(route);

    const visitCount = basket.reduce((sum, c) => sum + c.visits.length, 0);
    const starts = basket.map((c) => clusterStart(c)).filter(Boolean) as string[];
    const sorted = [...starts].sort();
    const days = spanDays(sorted[0] ?? null, sorted[sorted.length - 1] ?? null);
    const stats = [
      `${basket.length} journey${basket.length === 1 ? "" : "s"}`,
      `${visitCount} visits`,
      `${days} day${days === 1 ? "" : "s"} spanned`,
    ];
    if (opts.estimatedBytes !== undefined) stats.push(`~${fmtBytes(opts.estimatedBytes)}`);
    rail.append(el("div", { class: "itinerary-stats mono" }, stats.join(" · ")));

    if (!opts.readOnly && opts.minJourneys && basket.length < opts.minJourneys) {
      rail.append(
        el("div", { class: "itinerary-hint" }, `Add at least ${opts.minJourneys} journeys.`)
      );
    }
  }

  if (opts.footer) rail.append(opts.footer);
  return rail;
}
