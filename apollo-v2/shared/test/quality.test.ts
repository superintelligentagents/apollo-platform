import { describe, expect, it } from "vitest";
import { computeQualitySignals, netAuthoredChars } from "../src/quality";
import { buildLongTask, deriveTimeSpan } from "../src/schema";
import type { LongTask, ParticipantIdentity } from "../src/types";

const identity: ParticipantIdentity = {
  kind: "internal",
  participantId: "",
  name: "L",
  email: "l@e.com",
  consent: { version: "2026-07-24", accepted_at: "2026-07-24T00:00:00.000Z" },
};

function task(request: string, extra: Partial<LongTask["task"]> = {}, journeys = 0): LongTask {
  return buildLongTask({
    identity,
    mode: "freeform",
    platform: "web",
    task: {
      task_title: "A task",
      agent_request: request,
      task_summary: null,
      difficulty: "medium",
      site_scope: extra.site_scope ?? [],
      success_criteria: [],
      must_visit_or_reach: [],
      required_outputs: extra.required_outputs ?? [],
      notes: null,
      time_span: deriveTimeSpan([]),
      ...extra,
    },
    sourceJourneys: Array.from({ length: journeys }, (_, i) => ({
      order: i,
      cluster_id: i,
      fingerprint: `fp${i}`,
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-01T01:00:00.000Z",
      label: null,
      visits: [
        { id: 1, url: "https://x.com/a", title: "a", visited_at: "2026-06-01T00:00:00.000Z" },
        { id: 2, url: "https://x.com/b", title: "b", visited_at: "2026-06-01T00:30:00.000Z" },
      ],
      key_urls: [],
    })),
    themeSuggestion: null,
    attachedUrls: [],
  });
}

describe("netAuthoredChars", () => {
  it("is ~zero when the draft is accepted with only bracket-fills of tiny length", () => {
    const draft = "Between Jun 1 and Jun 5 I kept coming back to mlb.com. Finish it: [what should happen?].";
    const accepted = draft.replace("[what should happen?]", "do it");
    expect(netAuthoredChars(accepted, draft)).toBeLessThan(25);
  });

  it("is large when the author rewrites the request", () => {
    const draft = "Between Jun 1 and Jun 5 I kept coming back to mlb.com. Finish it: [what should happen?].";
    const rewritten =
      "Plan a three-stadium MLB road trip in July under $2,500: find games on consecutive weekends, buy tickets, and book hotels near each park.";
    expect(netAuthoredChars(rewritten, draft)).toBeGreaterThan(40);
  });

  it("counts the whole thing when no draft was offered", () => {
    expect(netAuthoredChars("hand written from scratch", null)).toBeGreaterThan(10);
  });
});

describe("computeQualitySignals", () => {
  it("flags a barely-edited draft as low strength", () => {
    const draft = "Between Jun 1 and Jun 5 I kept coming back to mlb.com. Finish it: [what should happen?].";
    const accepted = draft.replace("[what should happen?]", "do it");
    const s = computeQualitySignals(task(accepted), draft);
    expect(s.barely_edited_draft).toBe(true);
    expect(s.strength).toBe("low");
  });

  it("rates a rich, constrained, comparative request as high", () => {
    const req =
      "Plan a week-long trip comparing flights on two platforms, book a hotel under $200/night before July 3, and produce an itinerary.";
    const s = computeQualitySignals(task(req, { site_scope: ["expedia.com", "booking.com"], required_outputs: ["itinerary"] }, 3), null);
    expect(s.has_constraints).toBe(true);
    expect(s.has_comparison).toBe(true);
    expect(s.has_deliverable).toBe(true);
    expect(s.strength).toBe("high");
    expect(s.journey_count).toBe(3);
    expect(s.visit_count).toBe(6);
  });

  it("does not count month-prefix words or bare numbers as constraints", () => {
    const s = computeQualitySignals(
      task("Help me decide which market stall may separate the top options into a novel list."),
      null
    );
    expect(s.has_constraints).toBe(false);
    const s2 = computeQualitySignals(task("Find the top options for an iPhone accessory to compare later on."), null);
    expect(s2.has_constraints).toBe(false);
  });

  it("counts money, number+unit, and real dates as constraints", () => {
    expect(computeQualitySignals(task("Keep the hotel around $180 a night if possible."), null).has_constraints).toBe(true);
    expect(computeQualitySignals(task("We're staying 3 nights somewhere warm."), null).has_constraints).toBe(true);
    expect(computeQualitySignals(task("Departure should be July 17 from London City airport."), null).has_constraints).toBe(true);
    expect(computeQualitySignals(task("Everything needs to wrap up before the wedding."), null).has_constraints).toBe(true);
  });

  it("detects comparison via multiple site families even without keywords", () => {
    const s = computeQualitySignals(task("Look at some stuff on these sites.", { site_scope: ["a.com", "b.com"] }), null);
    expect(s.has_comparison).toBe(true);
  });

  it("a middling one-line request lands medium, not low or high", () => {
    const s = computeQualitySignals(task("Find me a good espresso machine on amazon and tell me which to buy."), null);
    expect(["low", "medium", "high"]).toContain(s.strength);
    expect(s.request_words).toBeGreaterThan(5);
  });
});
