// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  authorRejectionRates,
  cohortSteering,
  filterAdminSubmissions,
  rejectionReasonClusters,
  teamDistribution,
} from "../src/ui/screens/progress";
import type { AdminSubmission, AdminUserSummary } from "../src/review-client";

function submission(overrides: Partial<AdminSubmission>): AdminSubmission {
  return {
    task_id: "task-1",
    participant_id: "alice",
    participant_name: "Alice",
    participant_email: "alice@example.com",
    mode: "compose",
    submitted_at: "2026-08-01T00:00:00.000Z",
    status: "pending",
    reviewer: "",
    reviewed_at: "",
    rejection_reason: "",
    trajectory_count: 2,
    visit_count: 8,
    changed: false,
    original: { title: "Book dinner", request: "Find a table", difficulty: "high", criteria: [], steps: [] },
    final: null,
    ...overrides,
  };
}

function user(overrides: Partial<AdminUserSummary>): AdminUserSummary {
  return {
    participant_id: "alice",
    name: "Alice",
    email: "alice@example.com",
    submitted: 0,
    pending: 0,
    in_review: 0,
    approved: 0,
    rejected: 0,
    ...overrides,
  };
}

describe("admin submission filters", () => {
  const items = [
    submission({}),
    submission({
      task_id: "task-2",
      participant_id: "bob",
      participant_name: "Bob",
      participant_email: "bob@example.com",
      status: "approved",
      reviewer: "Reviewer One",
      original: { title: "Compare flights", request: "Find Seoul fares", difficulty: "high", criteria: [], steps: [] },
    }),
  ];

  it("filters by participant and status", () => {
    expect(filterAdminSubmissions(items, { query: "", participantId: "bob", status: "approved" })).toEqual([items[1]]);
    expect(filterAdminSubmissions(items, { query: "", participantId: "alice", status: "approved" })).toEqual([]);
  });

  it("searches user, authored content, task id, and reviewer case-insensitively", () => {
    expect(filterAdminSubmissions(items, { query: "SEOUL", participantId: "", status: "" })).toEqual([items[1]]);
    expect(filterAdminSubmissions(items, { query: "reviewer one", participantId: "", status: "" })).toEqual([items[1]]);
    expect(filterAdminSubmissions(items, { query: "alice@example", participantId: "", status: "" })).toEqual([items[0]]);
  });
});

describe("team spread panel", () => {
  it("charts places and subjects from the row's distribution metadata", () => {
    const items = [
      submission({ task_metadata: { region: "IN", subjects: ["Travel and Tourism > Air Travel"] } }),
      submission({ task_metadata: { region: "GLOBAL", subjects: ["Health > Medicine"] } }),
    ];

    const text = teamDistribution(items).textContent ?? "";
    expect(text).toContain("India");
    expect(text).toContain("No specific country");
    expect(text).toContain("Travel and Tourism");
    expect(text).toContain("50%");
  });

  // Which of original/final wins is resolved server-side by
  // taskMetadataForReporting, which has its own test in the backend suite.
  it("counts a task once, from the single resolved value", () => {
    const text = teamDistribution([submission({ task_metadata: { region: "BR", subjects: [] } })]).textContent ?? "";
    expect(text).toContain("Brazil");
    expect(text).not.toContain("India");
  });

  it("says so plainly instead of drawing an empty chart", () => {
    // Tasks authored before the metadata fields shipped carry none.
    const text = teamDistribution([submission({})]).textContent ?? "";
    expect(text).toContain("No task carries region or subject yet");
  });
});

describe("rejection reason clusters", () => {
  it("groups rejected items by reason, lowercased for grouping but keeping first-seen casing", () => {
    const items = [
      submission({ task_id: "1", status: "rejected", rejection_reason: "Non-evergreen" }),
      submission({ task_id: "2", status: "rejected", rejection_reason: "non-evergreen" }),
      submission({ task_id: "3", status: "rejected", rejection_reason: "India-only site" }),
      submission({ task_id: "4", status: "approved", rejection_reason: "Non-evergreen" }),
    ];

    expect(rejectionReasonClusters(items)).toEqual([
      { reason: "Non-evergreen", count: 2 },
      { reason: "India-only site", count: 1 },
    ]);
  });

  it("treats empty and whitespace reasons as (no reason given)", () => {
    const items = [
      submission({ task_id: "1", status: "rejected", rejection_reason: "" }),
      submission({ task_id: "2", status: "rejected", rejection_reason: "   " }),
      submission({ task_id: "3", status: "rejected", rejection_reason: "Infeasible" }),
    ];

    const clusters = rejectionReasonClusters(items);
    expect(clusters).toContainEqual({ reason: "(no reason given)", count: 2 });
    expect(clusters).toContainEqual({ reason: "Infeasible", count: 1 });
  });

  it("breaks count ties by reason, alphabetically", () => {
    const items = [
      submission({ task_id: "1", status: "rejected", rejection_reason: "Zebra" }),
      submission({ task_id: "2", status: "rejected", rejection_reason: "Apple" }),
    ];

    expect(rejectionReasonClusters(items).map((c) => c.reason)).toEqual(["Apple", "Zebra"]);
  });

  it("returns nothing when there are no rejected tasks", () => {
    expect(rejectionReasonClusters([submission({ status: "approved" })])).toEqual([]);
  });
});

describe("author rejection rates", () => {
  it("computes rejected/(approved+rejected) for authors with finished reviews, sorted descending", () => {
    const users = [
      user({ participant_id: "alice", name: "Alice", approved: 8, rejected: 2 }),
      user({ participant_id: "bob", name: "Bob", approved: 2, rejected: 8 }),
      user({ participant_id: "cara", name: "Cara", pending: 5 }),
    ];

    const rates = authorRejectionRates(users);
    expect(rates.map((r) => r.participant_id)).toEqual(["bob", "alice"]);
    expect(rates.find((r) => r.participant_id === "bob")?.rate).toBeCloseTo(0.8);
    expect(rates.find((r) => r.participant_id === "alice")?.rate).toBeCloseTo(0.2);
  });

  it("skips authors with no finished reviews", () => {
    expect(authorRejectionRates([user({ approved: 0, rejected: 0, pending: 5 })])).toEqual([]);
  });

  it("breaks rate ties by name, alphabetically", () => {
    const users = [
      user({ participant_id: "zoe", name: "Zoe", approved: 5, rejected: 5 }),
      user({ participant_id: "amy", name: "Amy", approved: 5, rejected: 5 }),
    ];

    expect(authorRejectionRates(users).map((r) => r.name)).toEqual(["Amy", "Zoe"]);
  });
});

describe("cohort steering panel", () => {
  it("lists rejection clusters and flags authors over the coaching threshold", () => {
    const items = [
      submission({ task_id: "1", status: "rejected", rejection_reason: "Non-evergreen" }),
      submission({ task_id: "2", status: "rejected", rejection_reason: "non-evergreen" }),
      submission({ task_id: "3", status: "rejected", rejection_reason: "India-only site" }),
    ];
    const users = [
      user({ participant_id: "bob", name: "Bob", email: "bob@example.com", approved: 2, rejected: 8 }),
      user({ participant_id: "alice", name: "Alice", email: "alice@example.com", approved: 9, rejected: 1 }),
    ];

    const text = cohortSteering(items, users).textContent ?? "";
    expect(text).toContain("Cohort steering");
    expect(text).toContain("Non-evergreen");
    expect(text).toContain("India-only site");
    expect(text).toContain("Bob · bob@example.com");
    expect(text).toContain("80%");
    expect(text).not.toContain("Alice");
  });

  it("shows muted fallbacks when there is nothing to steer on", () => {
    const text = cohortSteering([submission({ status: "approved" })], [user({ approved: 1, rejected: 0 })]).textContent ?? "";
    expect(text).toContain("No rejected tasks");
    expect(text).toContain("No authors currently need coaching flagging");
  });
});
