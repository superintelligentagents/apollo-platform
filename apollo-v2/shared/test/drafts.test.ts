import { describe, expect, it } from "vitest";
import { draftFromJourneys, FREEFORM_SCAFFOLD, hasUnfilledSlots } from "../src/drafts";
import { prepareJourneys } from "../src/clustering";
import { validateLongTask, buildLongTask, deriveTimeSpan } from "../src/schema";
import type { ParticipantIdentity } from "../src/types";
import { themedClusters } from "./fixtures";

describe("draftFromJourneys", () => {
  it("writes a draft from the basket's own sites, vocabulary, and dates", () => {
    const journeys = prepareJourneys(themedClusters(), new Set());
    const basket = journeys.filter((j) => j.visits.some((v) => v.url.includes("mlb.com")));
    const { title, request } = draftFromJourneys(basket);
    expect(request).toContain("mlb.com");
    expect(request.toLowerCase()).toContain("stadium");
    expect(request).toMatch(/Between .+ and .+/);
    expect(hasUnfilledSlots(request)).toBe(true);
    expect(title.length).toBeGreaterThan(0);
  });

  it("freeform scaffold has slots and clears once filled", () => {
    expect(hasUnfilledSlots(FREEFORM_SCAFFOLD)).toBe(true);
    expect(hasUnfilledSlots("Plan a week-long trip with tickets, hotels, and travel under $2,500.")).toBe(false);
  });
});

describe("bracket validation", () => {
  const identity: ParticipantIdentity = {
    kind: "internal",
    participantId: "",
    name: "L",
    email: "l@e.com",
    consent: { version: "2026-07-24", accepted_at: "2026-07-24T00:00:00.000Z" },
  };
  it("blocks upload while [slots] remain, passes once replaced", () => {
    const base = {
      identity,
      mode: "freeform" as const,
      platform: "web" as const,
      task: {
        task_title: "A real task title",
        agent_request: FREEFORM_SCAFFOLD,
        task_summary: null,
        difficulty: "medium" as const,
        site_scope: [],
        success_criteria: [],
        must_visit_or_reach: [],
        required_outputs: [],
        notes: null,
        time_span: deriveTimeSpan([]),
      },
      sourceJourneys: [],
      themeSuggestion: null,
      attachedUrls: [],
    };
    const withSlots = buildLongTask(base);
    expect(validateLongTask(withSlots).errors.agent_request).toContain("bracketed");

    const filled = buildLongTask({
      ...base,
      task: {
        ...base.task,
        agent_request: "Plan a week-long trip hitting three stadiums with tickets, hotels, and travel under $2,500.",
      },
    });
    expect(validateLongTask(filled).valid).toBe(true);
  });
});
