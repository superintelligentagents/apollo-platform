import { totalOccurrences } from "../../alias";
import type { Entity } from "../../types";
import { chip, el } from "../components/helpers";
import type { Ctx } from "../context";

const ENTITY_PAGE_SIZE = 100;
const ENTITY_SEARCH_DELAY_MS = 180;
const pendingEntitySearch = new WeakMap<object, ReturnType<typeof setTimeout>>();

export function renderEntities(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const root = el("section", { class: "screen" });
  root.append(
    el("h2", { class: "display" }, "People & PII"),
    el(
      "p",
      { class: "screen-sub" },
      "Review personal identities detected in your imports. People are pseudonymized by default — the same person gets the same alias in email, calendar, and chats. Automated senders stay recognizable in a separate organizations/services view. The real-name → alias mapping never uploads."
    ),
    replacementPanel(ctx)
  );

  if (s.entityIndexing) {
    root.append(el("section", { class: "entity-indexing card", role: "status" }, el("strong", null, "Updating privacy classifications…"), el("p", null, "Checking people, senders, and services against the current imports. Stale classifications are hidden until this finishes.")));
    return root;
  }

  if (!s.entities.length) {
    root.append(el("p", { class: "empty-note" }, "No people or organizations detected yet. You can still use replace everywhere above."));
    return root;
  }

  const query = s.entityQuery.trim().toLowerCase();
  const active = s.entities.filter((entity) => totalOccurrences(entity) > 0);
  const peopleCount = active.filter(isPerson).length;
  const servicesCount = active.length - peopleCount;
  const scoped = active.filter((entity) => s.entityScope === "all" || (s.entityScope === "people" ? isPerson(entity) : !isPerson(entity)));
  const self: Entity[] = [];
  const rest: Entity[] = [];
  for (const entity of scoped) {
    if (query && !entitySearchText(entity).includes(query)) continue;
    (entity.category === "self" ? self : rest).push(entity);
  }
  const matching = [...self, ...rest];
  const pages = Math.max(1, Math.ceil(matching.length / ENTITY_PAGE_SIZE));
  const page = Math.min(s.entityPage, pages - 1);
  const shown = matching.slice(page * ENTITY_PAGE_SIZE, page * ENTITY_PAGE_SIZE + ENTITY_PAGE_SIZE);
  const first = matching.length ? page * ENTITY_PAGE_SIZE + 1 : 0;
  const last = Math.min((page + 1) * ENTITY_PAGE_SIZE, matching.length);

  root.append(
    el(
      "div",
      { class: "seg-control entity-scope", "aria-label": "Choose identity review type" },
      ...([
        ["people", `People & PII ${peopleCount.toLocaleString()}`],
        ["services", `Organizations/services ${servicesCount.toLocaleString()}`],
        ["all", `All active ${active.length.toLocaleString()}`],
      ] as const).map(([scope, label]) => el("button", {
        class: `seg ${s.entityScope === scope ? "active" : ""}`,
        type: "button",
        "data-testid": `entity-scope-${scope}`,
        onclick: () => {
          s.entityScope = scope;
          s.entityPage = 0;
          ctx.rerender();
        },
      }, label))
    ),
    el(
      "section",
      { class: "entity-browser card" },
      el("label", { class: "field primary-search" }, el("span", { class: "field-label" }, "Search people, aliases, email addresses, or organizations"), el("input", {
        type: "search",
        class: "field-input",
        "data-testid": "entity-search",
        placeholder: "Name, email, alias, phone, or organization…",
        value: s.entityQuery,
        oninput: (event: Event) => {
          s.entityQuery = (event.target as HTMLInputElement).value;
          s.entityPage = 0;
          const pending = pendingEntitySearch.get(s);
          if (pending !== undefined) clearTimeout(pending);
          pendingEntitySearch.set(s, setTimeout(() => {
            pendingEntitySearch.delete(s);
            ctx.rerender();
          }, ENTITY_SEARCH_DELAY_MS));
        },
      })),
      el("p", { class: "entity-browser-count mono", "aria-live": "polite" }, query
        ? `${matching.length.toLocaleString()} matching · showing ${first.toLocaleString()}–${last.toLocaleString()}`
        : `${matching.length.toLocaleString()} ${s.entityScope === "people" ? "people" : s.entityScope === "services" ? "services" : "active entities"} · showing ${first.toLocaleString()}–${last.toLocaleString()}`)
    )
  );

  const table = el("div", { class: "entity-rows" });
  for (const e of shown) table.append(entityRow(ctx, e));
  if (!shown.length) table.append(el("p", { class: "empty-note" }, "No people or organizations match this search."));
  root.append(table);
  if (pages > 1) {
    root.append(el("div", { class: "pager" },
      el("button", { class: "btn small", type: "button", disabled: page === 0, onclick: () => { s.entityPage = page - 1; ctx.rerender(); } }, "← Prev"),
      el("span", { class: "mono" }, `Page ${page + 1} of ${pages}`),
      el("button", { class: "btn small", type: "button", disabled: page >= pages - 1, onclick: () => { s.entityPage = page + 1; ctx.rerender(); } }, "Next →")
    ));
  }
  return root;
}

function isPerson(entity: Entity): boolean {
  return entity.category === "self" || entity.category === "person";
}

function entitySearchText(entity: Entity): string {
  return [entity.category, entity.alias, entity.aliasEmail, entity.aliasPhone, ...entity.realNames, ...entity.realEmails, ...entity.realPhones]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function replacementPanel(ctx: Ctx): HTMLElement {
  const findInput = el("input", {
    id: "replacement-find",
    class: "field-input",
    placeholder: "Text to find",
    autocomplete: "off",
  }) as HTMLInputElement;
  const replaceInput = el("input", {
    id: "replacement-with",
    class: "field-input",
    placeholder: "Replacement (blank removes it)",
    autocomplete: "off",
  }) as HTMLInputElement;
  const noteInput = el("input", {
    id: "replacement-note",
    class: "field-input",
    placeholder: "Optional reminder",
    autocomplete: "off",
  }) as HTMLInputElement;

  const form = el(
    "form",
    {
      class: "replacement-form",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const find = findInput.value.trim();
        if (!find) {
          findInput.focus();
          return;
        }
        ctx.actions.addRule({ find, replace: replaceInput.value, note: noteInput.value.trim() });
        findInput.value = "";
        replaceInput.value = "";
        noteInput.value = "";
      },
    },
    el("label", { for: "replacement-find" }, el("span", { class: "field-label" }, "Find"), findInput),
    el("label", { for: "replacement-with" }, el("span", { class: "field-label" }, "Replace with"), replaceInput),
    el("label", { for: "replacement-note" }, el("span", { class: "field-label" }, "Note"), noteInput),
    el("button", { class: "btn primary", type: "submit" }, "Add replacement")
  );

  const rules = el("div", { class: "replacement-rules", "aria-live": "polite" });
  if (!ctx.state.rules.length) {
    rules.append(el("p", { class: "empty-note compact" }, "No replacements yet."));
  } else {
    ctx.state.rules.forEach((rule, index) => {
      rules.append(
        el(
          "div",
          { class: "replacement-rule" },
          el(
            "div",
            null,
            el("p", { class: "replacement-rule-text" }, el("code", null, rule.find), el("span", null, "→"), el("code", null, rule.replace || "[removed]")),
            rule.note ? el("p", { class: "entity-detail" }, rule.note) : null
          ),
          el("button", { class: "btn small danger-ghost", type: "button", onclick: () => ctx.actions.removeRule(index) }, `Remove ${rule.find}`)
        )
      );
    });
  }

  return el(
    "section",
    { class: "replacement-panel card", "aria-labelledby": "replace-everywhere-title" },
    el("div", { class: "replacement-head" },
      el("div", null,
        el("h3", { id: "replace-everywhere-title" }, "Replace everywhere before upload"),
        el("p", null, "Find text across every selected record and replace or remove it in the upload copy. Matching ignores capitalization; imported originals stay unchanged.")
      ),
      chip(`${ctx.state.rules.length} active`, ctx.state.rules.length ? "warn" : undefined)
    ),
    form,
    rules
  );
}

function entityRow(ctx: Ctx, e: Entity): HTMLElement {
  const occ = Object.entries(e.occurrences)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");

  const aliasInput = el("input", { class: "field-input compact", value: e.alias, disabled: e.keepReal }) as HTMLInputElement;
  aliasInput.addEventListener("blur", () => {
    if (aliasInput.value.trim()) ctx.actions.updateEntity(e.entityId, { alias: aliasInput.value.trim() });
  });

  return el(
    "div",
    { class: `entity-row card ${e.category === "self" ? "self" : ""}` },
    el(
      "div",
      { class: "entity-real" },
      el(
        "p",
        { class: "entity-name" },
        e.realNames[0] || e.realEmails[0] || e.realPhones[0] || "(unnamed)",
        e.category === "self" ? chip("you", "ok") : null
      ),
      el(
        "p",
        { class: "entity-detail mono" },
        [e.realEmails[0], e.realPhones[0], e.realNames.length > 1 ? `+${e.realNames.length - 1} name variants` : ""]
          .filter(Boolean)
          .join(" · ")
      ),
      el("p", { class: "entity-occ mono" }, occ || "no occurrences")
    ),
    el(
      "div",
      { class: "entity-controls" },
      el(
        "select",
        {
          class: "field-input compact",
          onchange: (ev: Event) =>
            ctx.actions.updateEntity(e.entityId, { category: (ev.target as HTMLSelectElement).value as Entity["category"] }),
        },
        ...(["self", "person", "org", "merchant"] as const).map((c) =>
          el("option", { value: c, selected: e.category === c }, c)
        )
      ),
      el(
        "label",
        { class: "keep-real" },
        el("input", {
          type: "checkbox",
          checked: e.keepReal,
          onchange: (ev: Event) => ctx.actions.updateEntity(e.entityId, { keepReal: (ev.target as HTMLInputElement).checked }),
        }),
        el("span", null, "keep real")
      )
    ),
    el(
      "div",
      { class: "entity-alias" },
      el("p", { class: "field-label" }, e.keepReal ? "UPLOADS AS (REAL)" : "UPLOADS AS"),
      e.keepReal
        ? el("p", { class: "entity-name" }, e.realNames[0] || e.realEmails[0] || "(as-is)")
        : el(
            "div",
            null,
            aliasInput,
            el("p", { class: "entity-detail mono" }, [e.aliasEmail, e.aliasPhone].filter(Boolean).join(" · "))
          )
    )
  );
}
