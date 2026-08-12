import type { Ctx } from "../context";
import {
  MAX_SUBJECTS,
  normalizeDomain,
  REGION_GLOBAL,
  regionLabel,
  regionOptions,
  SUBJECT_GROUPS,
  SUBJECT_SEPARATOR,
  subjectSub,
  subjectTop,
} from "../../taxonomy";
import { el } from "./helpers";

// The three distribution fields, rendered as one block at the foot of the
// authoring form. Deliberately small: region is one pick, subjects are one to
// three, and the domains arrive pre-filled from the task's own sites. Anything
// heavier gets answered carelessly, and careless answers are worse than none —
// they look like data.

export function metadataFields(
  ctx: Ctx,
  fieldError: (key: string) => HTMLElement
): HTMLElement {
  const d = ctx.state.draft;

  const block = el(
    "fieldset",
    { class: "field metadata-fields" },
    el(
      "legend",
      { class: "field-label" },
      "About this task",
      el(
        "span",
        { class: "field-hint" },
        " — so we can keep the collection spread across places, sites, and topics"
      )
    )
  );

  block.append(regionField(ctx, d, fieldError), subjectField(ctx, d, fieldError), domainField(ctx, d, fieldError));
  return block;
}

function regionField(
  ctx: Ctx,
  d: Ctx["state"]["draft"],
  fieldError: (key: string) => HTMLElement
): HTMLElement {
  const select = el("select", {
    class: "field-input",
    "aria-label": "Country this task is anchored in",
    onchange: (e: Event) => {
      d.region = (e.target as HTMLSelectElement).value;
      ctx.autosave();
    },
  }) as HTMLSelectElement;

  select.append(el("option", { value: "" }, "Choose one…"));
  for (const { code, label } of regionOptions()) {
    select.append(el("option", { value: code, selected: d.region === code }, label));
  }
  select.value = d.region;

  return el(
    "div",
    { class: "subfield" },
    el("span", { class: "subfield-label" }, "Where is it anchored?"),
    el(
      "p",
      { class: "subfield-hint" },
      "The country whose sites, services, or institutions the task depends on. If the work would read the same anywhere — comparing product specs, researching a standard, planning a curriculum — choose ",
      el("em", null, regionLabel(REGION_GLOBAL).toLowerCase()),
      "."
    ),
    select,
    fieldError("region")
  );
}

function subjectField(
  ctx: Ctx,
  d: Ctx["state"]["draft"],
  fieldError: (key: string) => HTMLElement
): HTMLElement {
  const chosen = el("div", { class: "preview-chips subject-chips" });
  const select = el("select", {
    class: "field-input",
    "aria-label": "Add a subject for this task",
  }) as HTMLSelectElement;

  const drawChosen = () => {
    chosen.replaceChildren();
    if (!d.subjects.length) {
      chosen.append(el("span", { class: "muted small" }, "Nothing picked yet."));
    }
    for (const subject of d.subjects) {
      chosen.append(
        el(
          "span",
          { class: "chip" },
          el("span", { class: "chip-top" }, subjectTop(subject)),
          el("span", { class: "chip-sub" }, subjectSub(subject)),
          el(
            "button",
            {
              type: "button",
              class: "chip-x",
              "aria-label": `Remove ${subject}`,
              onclick: () => {
                d.subjects = d.subjects.filter((s) => s !== subject);
                drawChosen();
                drawOptions();
                ctx.autosave();
              },
            },
            "×"
          )
        )
      );
    }
  };

  // Rebuilt after every change so already-chosen leaves drop out of the list
  // and the whole control disables once the cap is reached.
  const drawOptions = () => {
    const full = d.subjects.length >= MAX_SUBJECTS;
    select.replaceChildren();
    select.append(
      el(
        "option",
        { value: "" },
        full ? `Maximum ${MAX_SUBJECTS} subjects` : d.subjects.length ? "Add another…" : "Choose a subject…"
      )
    );
    for (const group of SUBJECT_GROUPS) {
      const optgroup = el("optgroup", { label: group.top });
      let any = false;
      for (const sub of group.subs) {
        const value = `${group.top}${SUBJECT_SEPARATOR}${sub}`;
        if (d.subjects.includes(value)) continue;
        any = true;
        optgroup.append(el("option", { value }, sub));
      }
      if (any) select.append(optgroup);
    }
    select.disabled = full;
    select.value = "";
  };

  select.addEventListener("change", () => {
    const value = select.value;
    if (!value || d.subjects.includes(value) || d.subjects.length >= MAX_SUBJECTS) {
      select.value = "";
      return;
    }
    d.subjects = [...d.subjects, value];
    drawChosen();
    drawOptions();
    ctx.autosave();
  });

  drawChosen();
  drawOptions();

  return el(
    "div",
    { class: "subfield" },
    el("span", { class: "subfield-label" }, "What is it about?"),
    el(
      "p",
      { class: "subfield-hint" },
      `Pick the one to ${MAX_SUBJECTS} categories the task is genuinely about. One is usually the honest answer — these are used to count coverage, so a wide guess is worse than a narrow truth.`
    ),
    chosen,
    select,
    fieldError("subjects")
  );
}

function domainField(
  ctx: Ctx,
  d: Ctx["state"]["draft"],
  fieldError: (key: string) => HTMLElement
): HTMLElement {
  const chips = el("div", { class: "preview-chips domain-chips" });

  const draw = () => {
    chips.replaceChildren();
    if (!d.primary_domains.length) {
      chips.append(el("span", { class: "muted small" }, "None yet — add the main sites below."));
    }
    for (const domain of d.primary_domains) {
      chips.append(
        el(
          "span",
          { class: "chip tag" },
          domain,
          el(
            "button",
            {
              type: "button",
              class: "chip-x",
              "aria-label": `Remove ${domain}`,
              onclick: () => {
                d.primary_domains = d.primary_domains.filter((x) => x !== domain);
                ctx.state.domainsDirty = true;
                draw();
                ctx.autosave();
              },
            },
            "×"
          )
        )
      );
    }
  };

  const input = el("input", {
    class: "field-input",
    placeholder: "Add a site, e.g. wikipedia.org",
    "aria-label": "Add a site this task runs through",
    // Enter must not submit the form — it belongs to this chip input.
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commit();
    },
    onblur: () => commit(),
  }) as HTMLInputElement;

  function commit() {
    const domain = normalizeDomain(input.value);
    if (!domain) {
      input.value = "";
      return;
    }
    if (!d.primary_domains.includes(domain)) {
      d.primary_domains = [...d.primary_domains, domain];
      ctx.state.domainsDirty = true;
      draw();
      ctx.autosave();
    }
    input.value = "";
  }

  draw();

  return el(
    "div",
    { class: "subfield" },
    el("span", { class: "subfield-label" }, "Which sites does it run through?"),
    el(
      "p",
      { class: "subfield-hint" },
      "Filled in from the sites and links you already gave. Correct it if it is missing the site that matters most."
    ),
    chips,
    input,
    fieldError("primary_domains")
  );
}
