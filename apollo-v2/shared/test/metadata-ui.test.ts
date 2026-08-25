// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/ui/context";
import { initialState } from "../src/ui/context";
import { renderGuided } from "../src/ui/screens/guided";
import { BLANK_TEMPLATE } from "../src/templates";
import { MAX_SUBJECTS, REGION_CODES, REGION_GLOBAL, SUBJECTS } from "../src/taxonomy";

function guidedCtx(): { ctx: Ctx; state: ReturnType<typeof initialState> } {
  const state = initialState();
  state.identity = {
    kind: "internal",
    participantId: "",
    name: "A",
    email: "a@e.com",
    consent: { version: "1", accepted_at: "2026-08-12T00:00:00.000Z" },
  };
  state.mode = "guided";
  state.screen = "guided";
  state.activeTemplate = BLANK_TEMPLATE;
  state.guidedSteps = BLANK_TEMPLATE.steps.map((s, i) => ({ order: i, title: s.title, description: "" }));
  const ctx = {
    state,
    adapter: { platform: "web", storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
    autosave: vi.fn(),
    rerender: vi.fn(),
    update: vi.fn(),
    actions: { goto: vi.fn(), finishGuided: vi.fn() },
  } as unknown as Ctx;
  return { ctx, state };
}

// The distribution fields once lived only on the `form` screen, which
// reachableScreen rewrites to `guided` — so they rendered nowhere while
// validation still demanded them, leaving authors blocked with nothing on
// screen to fix. These assertions pin them to the screen authors actually use,
// and pin the block to exactly two questions.
describe("distribution fields on the authoring screen", () => {
  it("renders exactly the region and subject questions on the guided screen", () => {
    const { ctx } = guidedCtx();
    const root = renderGuided(ctx);
    const block = root.querySelector(".metadata-fields");

    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("Two quick picks help keep the collection balanced.");
    expect(block!.textContent).toContain("Where is it anchored?");
    expect(block!.textContent).toContain("What is it about?");
    expect(block!.textContent).toContain(`Pick 1-${MAX_SUBJECTS} subjects.`);
    expect(block!.querySelector(".metadata-grid")).not.toBeNull();
    // The sites a task uses are computed from the record, never asked for.
    expect(block!.textContent).not.toContain("Which sites");
    expect(block!.querySelectorAll("input")).toHaveLength(0);
  });

  it("offers every region and every subject leaf, grouped", () => {
    const { ctx } = guidedCtx();
    const selects = renderGuided(ctx).querySelectorAll<HTMLSelectElement>(".metadata-fields select");

    // Countries + the location-agnostic sentinel + the placeholder row.
    expect(selects[0].options).toHaveLength(REGION_CODES.length + 2);
    expect(selects[0].options[1].value).toBe(REGION_GLOBAL);

    expect(selects[1].querySelectorAll("optgroup").length).toBeGreaterThan(1);
    expect(selects[1].querySelectorAll("option")).toHaveLength(SUBJECTS.length + 1);
  });

  it("shows a validation error next to the field it belongs to", () => {
    const { ctx, state } = guidedCtx();
    state.formErrors = {
      region: "Pick the country this task is anchored in, or 'no specific country'.",
      subjects: "Pick at least one subject.",
    };
    const root = renderGuided(ctx);

    for (const field of ["region", "subjects"]) {
      const el = root.querySelector(`.metadata-fields .field-error[data-field="${field}"]`);
      expect(el, field).not.toBeNull();
      expect(el!.textContent, field).toBe(state.formErrors[field]);
    }
  });

  it("adds a chosen subject as a chip and stops offering it again", () => {
    const { ctx, state } = guidedCtx();
    const root = renderGuided(ctx);
    const subjectSelect = root.querySelectorAll<HTMLSelectElement>(".metadata-fields select")[1];

    subjectSelect.value = SUBJECTS[0];
    subjectSelect.dispatchEvent(new Event("change"));

    expect(state.draft.subjects).toEqual([SUBJECTS[0]]);
    expect(root.querySelectorAll(".subject-chips .chip")).toHaveLength(1);
    expect([...subjectSelect.options].map((o) => o.value)).not.toContain(SUBJECTS[0]);
  });

  it("stops accepting subjects at the cap", () => {
    const { ctx, state } = guidedCtx();
    state.draft.subjects = SUBJECTS.slice(0, MAX_SUBJECTS);
    const root = renderGuided(ctx);
    const subjectSelect = root.querySelectorAll<HTMLSelectElement>(".metadata-fields select")[1];

    expect(subjectSelect.disabled).toBe(true);
    expect(subjectSelect.textContent).toContain(`Maximum ${MAX_SUBJECTS}`);
  });
});
