import { describe, expect, it } from "vitest";
import { applyDraftState, isWorthSaving, serializeDraftState } from "../src/ui/autosave";
import { initialState } from "../src/ui/context";
import { BLANK_TEMPLATE } from "../src/templates";

describe("isWorthSaving", () => {
  it("is false with no mode / no writing", () => {
    const s = initialState();
    expect(isWorthSaving(s)).toBe(false);
    s.mode = "freeform";
    expect(isWorthSaving(s)).toBe(false);
  });
  it("is true once there's request text or a filled step", () => {
    const s = initialState();
    s.mode = "freeform";
    s.draft.agent_request = "Plan a trip to Tokyo with flights and hotels.";
    expect(isWorthSaving(s)).toBe(true);
  });
});

describe("serialize → apply round-trip", () => {
  it("fully restores a guided task (no journeys needed), including intro and deliverable", () => {
    const s = initialState();
    s.identity = {
      kind: "internal",
      participantId: "",
      name: "L",
      email: "l@e.com",
      consent: { version: "2026-07-24", accepted_at: "2026-07-24T00:00:00.000Z" },
    };
    s.mode = "guided";
    s.screen = "form";
    s.activeTemplate = BLANK_TEMPLATE;
    s.guidedIntro = "I'm planning a trip to Tokyo in October.";
    s.guidedDeliverable = "sheet";
    s.guidedSteps = [{ order: 0, title: "Flights", description: "Compare two platforms for flights to Tokyo." }];
    s.draft.agent_request = "First, compare two platforms for flights to Tokyo.";
    s.generatedDraft = s.draft.agent_request;

    const saved = serializeDraftState(s, "2026-07-21T00:00:00.000Z");
    const fresh = initialState();
    const dest = applyDraftState(fresh, saved, BLANK_TEMPLATE);
    expect(dest).toBe("form");
    expect(fresh.mode).toBe("guided");
    expect(fresh.guidedSteps[0].description).toContain("Compare two platforms");
    expect(fresh.draft.agent_request).toContain("compare two platforms");
    // Re-assembling after resume must not drop the author's own framing.
    expect(fresh.guidedIntro).toBe("I'm planning a trip to Tokyo in October.");
    expect(fresh.guidedDeliverable).toBe("sheet");
    expect(fresh.activeTemplate).toBe(BLANK_TEMPLATE);
    expect(fresh.requestDirty).toBe(true); // restored text is the user's
  });

  it("restores compose text but drops to form with empty basket + kept fingerprints", () => {
    const s = initialState();
    s.mode = "compose";
    s.screen = "compose";
    s.draft.agent_request = "Finish my apartment hunt across zillow and apartments.com.";
    s.basket = [
      { cluster_id: 1, visits: [], fingerprint: "fp-a" },
      { cluster_id: 2, visits: [], fingerprint: "fp-b" },
    ];
    const saved = serializeDraftState(s, "2026-07-21T00:00:00.000Z");
    expect(saved.basketFingerprints).toEqual(["fp-a", "fp-b"]);

    const fresh = initialState();
    const dest = applyDraftState(fresh, saved, null);
    expect(dest).toBe("form"); // history not loaded → land on form
    expect(fresh.draft.agent_request).toContain("apartment hunt");
    expect(fresh.basket).toEqual([]); // journeys not restored here
  });

  it("round-trips metadata and defaults fields missing from an old autosave", () => {
    const s = initialState();
    s.mode = "freeform";
    s.draft.agent_request = "Compare current laptop warranty terms.";
    s.draft.region = "GLOBAL";
    s.draft.subjects = ["Computers Electronics and Technology > Consumer Electronics"];
    const saved = serializeDraftState(s, "2026-08-12T00:00:00.000Z");

    const fresh = initialState();
    applyDraftState(fresh, saved, null);
    expect(fresh.draft.region).toBe("GLOBAL");
    expect(fresh.draft.subjects).toHaveLength(1);

    delete (saved.draft as Partial<typeof saved.draft>).region;
    delete (saved.draft as Partial<typeof saved.draft>).subjects;
    const legacy = initialState();
    applyDraftState(legacy, saved, null);
    expect(legacy.draft.region).toBe("");
    expect(legacy.draft.subjects).toEqual([]);
  });

  it("stays on the saved screen when the basket is already present", () => {
    const s = initialState();
    s.mode = "compose";
    s.screen = "review";
    s.basket = [{ cluster_id: 1, visits: [], fingerprint: "fp-a" }];
    const saved = serializeDraftState(s, "2026-07-21T00:00:00.000Z");
    const fresh = initialState();
    fresh.basket = [{ cluster_id: 1, visits: [], fingerprint: "fp-a" }]; // rehydrated already
    const dest = applyDraftState(fresh, saved, null);
    expect(dest).toBe("review");
  });
});
