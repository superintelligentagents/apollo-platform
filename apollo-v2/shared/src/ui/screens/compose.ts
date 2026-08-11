import type { Ctx } from "../context";
import type { Cluster } from "../../types";
import { clusterStart } from "../../clustering";
import { chip, dayKey, el, fmtDayYear, fmtTime, journeyFamilies, journeyTitle, stepper } from "../components/helpers";
import { itinerary } from "../components/itinerary";

type Filters = { query: string; family: string | null; from: string; to: string; groupBy: "date" | "site" };

export function renderCompose(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const filters: Filters = { query: "", family: null, from: "", to: "", groupBy: "date" };
  const root = el("section", { class: "screen compose-screen" });
  // Freeform/guided visit this screen only to attach optional supporting history.
  const attachOnly = state.mode === "freeform" || state.mode === "guided";
  const minJourneys = attachOnly ? 0 : 1;

  const head = el("header", { class: "screen-head" });
  head.append(stepper(1));
  if (state.mode === "theme" && state.activeTheme) {
    const t = state.activeTheme;
    head.append(
      el(
        "div",
        { class: "theme-banner" },
        el("span", { class: "eyebrow mono" }, "THEME"),
        el("strong", null, t.site_families.length ? t.site_families.slice(0, 3).join(" · ") : t.shared_tokens.slice(0, 3).join(" · ")),
        el("span", { class: "muted" }, " — prune, then continue.")
      )
    );
  } else {
    head.append(
      el("h2", { class: "display" }, attachOnly ? "Attach supporting journeys" : "Which journeys were one project?"),
      el("p", { class: "screen-sub" },
        attachOnly
          ? "Attach Chrome journeys that show how this long-horizon web request arose."
          : "Select the journeys that belonged to one substantial web project and exclude unrelated browsing.")
    );
    if (!attachOnly) {
      head.append(
        el(
          "div",
          { class: "notice info" },
          el("span", null, "Prefer help finding the project? Apollo can group recurring journeys into likely hour-long or multi-day threads."),
          el(
            "button",
            { class: "btn ghost small", type: "button", onclick: () => ctx.actions.startMode("theme") },
            "Cluster journeys automatically"
          )
        )
      );
    }
  }
  root.append(head);

  const layout = el("div", { class: "compose-layout" });
  const browser = el("div", { class: "journey-browser" });
  const railSlot = el("div", { class: "rail-slot" });
  layout.append(browser, railSlot);
  root.append(layout);

  const inBasket = (c: Cluster) => state.basket.some((b) => b.fingerprint === c.fingerprint);

  const familyCounts = new Map<string, number>();
  for (const c of state.journeys) {
    for (const f of journeyFamilies(c, 2)) familyCounts.set(f, (familyCounts.get(f) || 0) + 1);
  }
  const topFamilies = [...familyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const WINDOW = 60;
  // Lives outside drawBrowser so rail edits don't silently collapse "Show more".
  let visibleCount = WINDOW;
  const drawBrowser = () => {
    browser.replaceChildren();

    const search = el("input", {
      class: "field-input search-input",
      placeholder: "Search titles, sites, URLs…",
      value: filters.query,
      oninput: (e: Event) => {
        filters.query = (e.target as HTMLInputElement).value.toLowerCase();
        visibleCount = WINDOW;
        drawList();
      },
    });
    const chipsRow = el("div", { class: "filter-chips" });
    for (const [family, count] of topFamilies) {
      chipsRow.append(
        el(
          "button",
          {
            class: `chip clickable ${filters.family === family ? "active" : ""}`,
            type: "button",
            onclick: () => {
              filters.family = filters.family === family ? null : family;
              visibleCount = WINDOW;
              drawBrowser();
            },
          },
          `${family} (${count})`
        )
      );
    }

    const dateInput = (value: string, label: string, onchange: (v: string) => void) =>
      el("label", { class: "date-filter" },
        el("span", { class: "mono" }, label),
        el("input", {
          type: "date",
          class: "field-input date-input",
          value,
          onchange: (e: Event) => {
            onchange((e.target as HTMLInputElement).value);
            visibleCount = WINDOW;
            drawList();
          },
        })
      );
    const groupToggle = el(
      "div",
      { class: "segmented mini", role: "radiogroup" },
      ...(["date", "site"] as const).map((mode) =>
        el(
          "button",
          {
            class: `segment ${filters.groupBy === mode ? "active" : ""}`,
            type: "button",
            role: "radio",
            "aria-checked": String(filters.groupBy === mode),
            onclick: () => {
              filters.groupBy = mode;
              visibleCount = WINDOW;
              drawBrowser();
            },
          },
          mode === "date" ? "By date" : "By site"
        )
      )
    );
    browser.append(
      el(
        "div",
        { class: "filter-bar" },
        el(
          "div",
          { class: "filter-row" },
          search,
          dateInput(filters.from, "from", (v) => (filters.from = v)),
          dateInput(filters.to, "to", (v) => (filters.to = v)),
          groupToggle
        ),
        chipsRow
      )
    );

    const countLine = el("p", { class: "list-count mono" });
    // Selection state lives at the top of the list, always in view: how many
    // are picked, one-click clear, and the continue action without scrolling.
    const selectionBar = el("div", { class: "selection-bar" });
    const drawSelectionBar = () => {
      const n = state.basket.length;
      selectionBar.classList.toggle("empty", n === 0);
      selectionBar.replaceChildren(
        el("span", { class: "selection-count" }, n === 0 ? "Nothing selected — click a journey, or ↑ ↓ + Space" : `${n} selected`),
        ...(n > 0
          ? [
              el(
                "button",
                {
                  class: "btn ghost small",
                  type: "button",
                  onclick: () => {
                    ctx.actions.clearBasket();
                    drawBrowser();
                    drawRail();
                  },
                },
                "Clear all"
              ),
              el(
                "button",
                {
                  class: "btn primary small",
                  type: "button",
                  disabled: n < minJourneys,
                  onclick: () => ctx.actions.continueToForm(),
                },
                attachOnly ? "Done attaching" : "Describe the task"
              ),
            ]
          : [])
      );
    };
    const listWrap = el("div", { class: "journey-list" });
    browser.append(selectionBar, countLine, listWrap);
    drawSelectionBar();

    const drawList = () => {
      listWrap.replaceChildren();
      let visible = state.journeys.filter((c) => {
        if (filters.family && !journeyFamilies(c, 6).includes(filters.family)) return false;
        const day = dayKey(clusterStart(c));
        if (filters.from && day < filters.from) return false;
        if (filters.to && day > filters.to) return false;
        if (filters.query) {
          const hay = c.visits.map((v) => `${v.title} ${v.url}`).join(" ").toLowerCase();
          if (!hay.includes(filters.query)) return false;
        }
        return true;
      });
      if (!visible.length) {
        countLine.textContent = "";
        listWrap.append(el("p", { class: "muted empty-list" }, "No journeys match. Clear the search or filters."));
        return;
      }
      if (filters.groupBy === "site") {
        const famOf = (c: (typeof visible)[number]) => journeyFamilies(c, 1)[0] ?? "other";
        const counts = new Map<string, number>();
        for (const c of visible) counts.set(famOf(c), (counts.get(famOf(c)) || 0) + 1);
        visible = [...visible].sort((a, b) => {
          const fa = famOf(a);
          const fb = famOf(b);
          const byCount = (counts.get(fb) || 0) - (counts.get(fa) || 0);
          if (byCount) return byCount;
          if (fa !== fb) return fa.localeCompare(fb);
          return (clusterStart(b) || "").localeCompare(clusterStart(a) || "");
        });
      }
      const shown = visible.slice(0, visibleCount);
      countLine.textContent =
        visible.length > shown.length
          ? `showing ${shown.length} of ${visible.length} journeys — search or filter to narrow`
          : `${visible.length} journey${visible.length === 1 ? "" : "s"}`;

      let lastHeader = "";
      for (const c of shown) {
        const header =
          filters.groupBy === "site"
            ? journeyFamilies(c, 1)[0] ?? "other"
            : dayKey(clusterStart(c));
        if (header !== lastHeader) {
          lastHeader = header;
          listWrap.append(
            el(
              "div",
              { class: "day-header mono" },
              filters.groupBy === "site" ? header : fmtDayYear(clusterStart(c))
            )
          );
        }
        listWrap.append(journeyRow(c));
      }
      if (visible.length > shown.length) {
        listWrap.append(
          el("button", {
            class: "btn ghost show-more",
            type: "button",
            onclick: () => {
              visibleCount += 120;
              drawList();
            },
          }, `Show more (${visible.length - shown.length} remaining)`)
        );
      }
    };

    const journeyRow = (c: Cluster): HTMLElement => {
      const checked = inBasket(c);
      let expanded = false;

      const row = el("div", { class: `journey-row ${checked ? "selected" : ""}`, tabindex: "0", role: "option" });
      const applyToggle = () => {
        ctx.actions.toggleJourney(c);
        row.classList.toggle("selected");
        drawRail();
        drawSelectionBar();
      };
      const checkbox = el("input", {
        type: "checkbox",
        class: "journey-check",
        checked,
        "aria-label": `Select ${journeyTitle(c)}`,
        onchange: applyToggle, // browser already flipped the box
      }) as HTMLInputElement;
      // The whole row is a click target — no checkbox hunting. Clicks on the
      // expand button, the checkbox itself, or inside the visits panel keep
      // their own behavior.
      row.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        if (t === checkbox || t.closest(".expand") || t.closest(".visits-panel")) return;
        checkbox.checked = !checkbox.checked;
        applyToggle();
      });
      // Keyboard: ↑/↓ walk the list, Space/Enter toggles, →/← show/hide visits.
      row.addEventListener("keydown", (e) => {
        if (e.target !== row) return; // not while inside the checkbox etc.
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          checkbox.checked = !checkbox.checked;
          applyToggle();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rowsAll = [...listWrap.querySelectorAll<HTMLElement>(".journey-row")];
          const i = rowsAll.indexOf(row);
          const next = rowsAll[i + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) {
            next.focus();
            next.scrollIntoView({ block: "nearest" });
          }
        } else if (e.key === "ArrowRight" && !expanded) {
          e.preventDefault();
          expandBtn.click();
        } else if (e.key === "ArrowLeft" && expanded) {
          e.preventDefault();
          expandBtn.click();
        }
      });

      const visitsPanel = el("div", { class: "visits-panel", hidden: true });
      const expandBtn = el(
        "button",
        {
          class: "icon-btn expand",
          type: "button",
          title: "Show visits",
          "aria-label": `Show visits for ${journeyTitle(c)}`,
          "aria-expanded": "false",
          onclick: () => {
            expanded = !expanded;
            visitsPanel.hidden = !expanded;
            expandBtn.textContent = expanded ? "▾" : "▸";
            expandBtn.setAttribute("aria-expanded", String(expanded));
            expandBtn.title = expanded ? "Hide visits" : "Show visits";
            if (expanded && !visitsPanel.childElementCount) {
              for (const v of c.visits) {
                visitsPanel.append(
                  el(
                    "div",
                    { class: "visit-line" },
                    el("span", { class: "visit-time mono" }, fmtTime(v.visited_at)),
                    el("span", { class: "visit-title" }, v.title || v.url),
                    el("span", { class: "visit-url mono" }, v.url)
                  )
                );
              }
            }
          },
        },
        "▸"
      );

      row.append(
        checkbox,
        el(
          "div",
          { class: "journey-main" },
          el(
            "div",
            { class: "journey-top" },
            el("span", { class: "journey-time mono" }, fmtTime(clusterStart(c))),
            el("span", { class: "journey-title" }, journeyTitle(c)),
            expandBtn
          ),
          el(
            "div",
            { class: "journey-meta" },
            ...journeyFamilies(c).slice(0, 3).map((f) => chip(f, "tag")),
            ...(journeyFamilies(c).length > 3 ? [el("span", { class: "muted mono" }, `+${journeyFamilies(c).length - 3}`)] : []),
            el("span", { class: "muted mono" }, `${c.visits.length} visits`)
          ),
          visitsPanel
        )
      );
      return row;
    };

    drawList();
  };

  const drawRail = () => {
    railSlot.replaceChildren(
      itinerary(state.basket, {
        title: state.mode === "freeform" ? "Attached journeys" : "Task itinerary",
        minJourneys,
        onMove: (i, d) => {
          ctx.actions.moveJourney(i, d);
          drawRail();
        },
        onRemove: (i) => {
          ctx.actions.removeJourney(i);
          drawBrowser();
          drawRail();
        },
        footer: el(
          "div",
          { class: "rail-actions" },
          el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto(state.mode === "theme" ? "themes" : attachOnly ? "form" : ctx.state.identity?.kind === "internal" ? "submit" : "home") }, "Back"),
          el(
            "button",
            {
              class: "btn primary",
              type: "button",
              disabled: state.basket.length < minJourneys,
              onclick: () => ctx.actions.continueToForm(),
            },
            attachOnly ? "Done attaching" : "Describe the task"
          )
        ),
      })
    );
  };

  drawBrowser();
  drawRail();
  return root;
}
