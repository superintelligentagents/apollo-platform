import type { Ctx } from "../context";
import {
  MAX_SUBJECTS,
  REGION_GLOBAL,
  regionLabel,
  regionOptions,
  SUBJECT_GROUPS,
  SUBJECT_SEPARATOR,
  subjectSub,
  subjectTop,
} from "../../taxonomy";
import { el } from "./helpers";

// The distribution fields, rendered as one block at the foot of the authoring
// screen. Deliberately small: region is one pick and subjects are one to three.
// Anything heavier gets answered carelessly, and careless answers are worse
// than none — they look like data.
//
// The sites a task runs through are deliberately NOT asked for. Everything they
// would be computed from is already on the task (site_scope, key URLs, attached
// URLs), so `derivePrimaryDomains` can recover them offline without spending an
// author's attention on a question they have effectively already answered.

export function metadataFields(
  ctx: Ctx,
  fieldError: (key: string) => HTMLElement
): HTMLElement {
  const d = ctx.state.draft;

  const block = el(
    "fieldset",
    { class: "field metadata-fields" },
    el("legend", { class: "field-label" }, "About this task")
  );

  block.append(
    el("p", { class: "metadata-intro" }, "Two quick picks help keep the collection balanced."),
    el(
      "div",
      { class: "metadata-grid" },
      regionField(ctx, d, fieldError),
      subjectField(ctx, d, fieldError)
    )
  );
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
      "Pick the country whose websites or services the task depends on. If none, choose ",
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
      `Pick 1-${MAX_SUBJECTS} subjects.`
    ),
    chosen,
    select,
    fieldError("subjects")
  );
}
