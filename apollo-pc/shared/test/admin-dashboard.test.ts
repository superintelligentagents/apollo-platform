// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { authorApprovedShowcasePanel, authorQcRoundPanel, authorQualityPanel, filterAdminSubmissions, resolveAdminTaskMetadata, reviewerQualityPanel, teamDistribution } from "../src/ui/screens/metrics";
import { vi } from "vitest";
import type { AdminShowcase, AdminSubmission } from "../src/review-client";

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

describe("team distribution", () => {
  it("keeps region and subject metadata from current snapshot-shaped dashboard rows", () => {
    const item = submission({
      original: {
        title: "Book dinner",
        request: "Find a table",
        difficulty: "high",
        criteria: [],
        steps: [],
        metadata: { region: "IN", subjects: ["Travel and Tourism > Restaurants"] },
      },
    });
    expect(resolveAdminTaskMetadata(item)).toEqual({
      region: "IN",
      subjects: ["Travel and Tourism > Restaurants"],
    });
  });

  it("renders the complete place and subject spread supplied by the backend", () => {
    const root = teamDistribution([
      { region: "IN", subjects: ["Travel and Tourism > Air Travel"] },
      { region: "IN", subjects: ["Travel and Tourism > Accommodation and Hotels"] },
      { region: "GLOBAL", subjects: ["Health > Medicine"] },
      { region: "US", subjects: ["Science and Education > Education"] },
    ]);
    expect(root.textContent).toContain("Spread across the team");
    expect(root.textContent).toContain("India");
    expect(root.textContent).toContain("No specific country");
    expect(root.textContent).toContain("Travel and Tourism");
    expect(root.textContent).toContain("50% · 2");
  });

  it("does not draw misleading bars when the aggregate has not loaded", () => {
    const root = teamDistribution(undefined);
    expect(root.querySelectorAll(".share-row")).toHaveLength(0);
    expect(root.textContent).toContain("next dashboard refresh");
  });

  it("keeps a large team spread compact", () => {
    const root = teamDistribution([
      { region: "US" },
      { region: "IN" },
      { region: "GB" },
      { region: "BR" },
      { region: "CA" },
      { region: "AU" },
    ]);
    expect(root.querySelectorAll(".share-row")).toHaveLength(5);
    expect(root.textContent).toContain("top 5 of 6");
    expect(root.textContent).not.toContain("United States");
  });
});

describe("author-approved showcase", () => {
  const example = (taskId: string, topLevel: string, primary: string, title: string) => ({
    task_id: taskId,
    review_content_hash: "a".repeat(64),
    title,
    request: `Research ${title} and compare current options.`,
    difficulty: "high",
    steps: [{ order: 1, title: "Research", description: "Find current evidence." }],
    rubrics: ["Find current evidence."],
    primary_category: primary,
    top_level_category: topLevel,
    categories: [primary],
    confidence: "high" as const,
    rationale: "Representative subject matter.",
    websites: ["example.com"],
    approved_at: "2026-09-01T00:00:00Z",
  });
  const showcase: AdminShowcase = {
    schema_version: "apollo-admin-author-approved-showcase-v1",
    generated_at_utc: "2026-09-01T00:00:00Z",
    source_tasks: 1609,
    selected_tasks: 3,
    requested_limit: 48,
    selection_strategy: "Balanced sample.",
    taxonomy: { name: "Similarweb website categories", source_url: "https://www.similarweb.com/category/", sha256: "c".repeat(64) },
    summary: {
      total_category_assignments: 2505,
      average_categories_per_task: 1.56,
      primary_categories_used: 144,
      top_level_categories_used: 24,
      category_count_distribution: [
        { category_count: 1, count: 889, share: 0.5525 },
        { category_count: 2, count: 544, share: 0.3381 },
        { category_count: 3, count: 176, share: 0.1094 },
      ],
      confidence_distribution: [
        { confidence: "high", count: 1562, share: 0.9708 },
        { confidence: "medium", count: 46, share: 0.0286 },
        { confidence: "low", count: 1, share: 0.0006 },
      ],
      tasks_with_websites: 914,
      tasks_without_websites: 695,
      website_coverage_share: 0.5681,
      website_mentions: 4678,
      unique_websites: 3186,
      top_websites: [{ label: "example.com", count: 10 }],
    },
    primary_top_level_distribution: [
      { category: "Travel and Tourism", count: 173, share: 0.1075, showcase_examples: 2 },
      { category: "Science and Education", count: 175, share: 0.1088, showcase_examples: 1 },
    ],
    primary_category_distribution: [],
    examples: [
      example("task-1", "Travel and Tourism", "Travel and Tourism > Air Travel", "Compare flights"),
      example("task-2", "Travel and Tourism", "Travel and Tourism > Accommodation and Hotels", "Plan a hotel stay"),
      example("task-3", "Science and Education", "Science and Education > Education", "Compare courses"),
    ],
  };

  it("shows full distribution stats and filters the highlighted examples", () => {
    const panel = authorApprovedShowcasePanel(showcase);
    expect(panel.textContent).toContain("1609approved tasks");
    expect(panel.textContent).toContain("3highlighted");
    expect(panel.textContent).toContain("Overall summary");
    expect(panel.textContent).toContain("2,505category assignments");
    expect(panel.textContent).toContain("1.56average labels per task");
    expect(panel.textContent).toContain("56.8%tasks with websites");
    expect(panel.textContent).toContain("97.1%high-confidence labels");
    expect(panel.textContent).toContain("3,186unique websites");
    expect(panel.textContent).toContain("55.3% with 1 label");
    expect(panel.textContent).toContain("914 tasks, 4,678 mentions");
    expect(panel.querySelectorAll(".showcase-task")).toHaveLength(3);
    expect(panel.querySelectorAll(".showcase-category-button")).toHaveLength(3);

    const travel = [...panel.querySelectorAll<HTMLButtonElement>(".showcase-category-button")]
      .find((button) => button.dataset.category === "Travel and Tourism")!;
    travel.click();
    expect(panel.querySelectorAll(".showcase-task")).toHaveLength(2);
    expect(panel.textContent).toContain("2 highlighted tasks in Travel and Tourism");
    expect(travel.getAttribute("aria-pressed")).toBe("true");

    const search = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "hotel";
    search.dispatchEvent(new Event("input"));
    expect(panel.querySelectorAll(".showcase-task")).toHaveLength(1);
    expect(panel.textContent).toContain("Plan a hotel stay");
  });
});

describe("reviewer quality panel", () => {
  const stamper = {
    reviewer: "Stamper",
    reviewed: 28, approved: 28, rejected: 0, edited_approvals: 0, unedited_approvals: 28,
    first_reviewed_at: "2026-08-19T00:00:00Z", last_reviewed_at: "2026-08-19T05:00:00Z",
    reject_rate: 0, edit_rate: 0, median_gap_minutes: 1.2, fast_share: 0.9,
    flags: ["no_rejections", "rarely_edits", "fast"] as const,
    suspicious: true,
  };
  const careful = {
    reviewer: "Careful",
    reviewed: 33, approved: 23, rejected: 10, edited_approvals: 23, unedited_approvals: 0,
    first_reviewed_at: "2026-08-18T00:00:00Z", last_reviewed_at: "2026-08-19T05:00:00Z",
    reject_rate: 0.303, edit_rate: 1, median_gap_minutes: 13.6, fast_share: 0,
    flags: [] as const,
    suspicious: false,
  };

  it("flags suspicious reviewers and offers filter + bulk re-queue", async () => {
    const onShow = vi.fn();
    const onReopenUnedited = vi.fn(async (_row: unknown, status: HTMLElement) => { status.textContent = "28 tasks back in the queue."; });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const panel = reviewerQualityPanel([stamper, careful] as never, { onShow, onReopenUnedited });
    const rows = panel.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].classList.contains("suspicious")).toBe(true);
    expect(rows[0].textContent).toContain("never rejects");
    expect(rows[0].textContent).toContain("very fast");
    expect(rows[0].textContent).toContain("0/28");
    expect(rows[1].classList.contains("suspicious")).toBe(false);
    expect(rows[1].textContent).toContain("10 (30%)");
    expect(panel.textContent).toContain("2 reviewers · 1 flagged");

    const [show, reopen] = rows[0].querySelectorAll<HTMLButtonElement>("button");
    show.click();
    expect(onShow).toHaveBeenCalledWith("Stamper");
    expect(reopen.textContent).toBe("Re-queue 28 unedited");
    reopen.click();
    await Promise.resolve();
    expect(onReopenUnedited).toHaveBeenCalledTimes(1);
    // Nothing to re-queue for a reviewer who edited every approval.
    expect(rows[1].querySelectorAll<HTMLButtonElement>("button")[1].disabled).toBe(true);
  });

  it("explains when the backend predates reviewer stats", () => {
    expect(reviewerQualityPanel(undefined, { onShow: vi.fn(), onReopenUnedited: vi.fn() }).textContent).toContain("next backend deploy");
  });
});

describe("author quality panel", () => {
  const users = [
    {
      participant_id: "sloppy", name: "Sloppy", email: "s@t.com", submitted: 40,
      pending: 10, in_review: 2, approved: 18, rejected: 10, decided: 28,
      approval_rate: 0.643, qc_edited_approvals: 6, qc_edit_rate: 0.333,
      qc_edited_author_accepted: 3, qc_edited_author_amended: 2, qc_edited_awaiting_signoff: 1,
      author_accepted_approvals: 8, author_amended_approvals: 4, awaiting_signoff: 6,
      appealed: 3, double_rejected: 2, author_requeues: 5,
    },
    {
      participant_id: "solid", name: "Solid", email: "so@t.com", submitted: 30,
      pending: 5, in_review: 0, approved: 24, rejected: 1, decided: 25,
      approval_rate: 0.96, qc_edited_approvals: 2, qc_edit_rate: 0.083,
      qc_edited_author_accepted: 2, qc_edited_author_amended: 0, qc_edited_awaiting_signoff: 0,
      author_accepted_approvals: 20, author_amended_approvals: 1, awaiting_signoff: 3,
      appealed: 1, double_rejected: 0, author_requeues: 2,
    },
    { participant_id: "new", name: "Newcomer", email: "n@t.com", submitted: 3, pending: 3, in_review: 0, approved: 0, rejected: 0 },
  ];

  it("ranks authors by rejection rate over decided tasks and flags outliers", () => {
    const onShow = vi.fn();
    const panel = authorQualityPanel(users as never, onShow);
    const rows = panel.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    // Sorted worst-first; undecided authors sink to the bottom unrated.
    expect(rows[0].textContent).toContain("Sloppy");
    expect(rows[0].textContent).toContain("64%");
    expect(rows[0].textContent).toContain("18/28");
    expect(rows[0].textContent).toContain("10 rejected");
    expect(rows[0].textContent).toContain("6/18");
    expect(rows[0].textContent).toContain("8 accepted · 4 edited");
    expect(rows[0].classList.contains("suspicious")).toBe(true);
    expect(rows[0].textContent).toContain("high rejection");
    expect(rows[1].textContent).toContain("Solid");
    expect(rows[1].textContent).toContain("96%");
    expect(rows[1].textContent).toContain("clean record");
    expect(rows[2].textContent).toContain("—");
    expect(rows[2].textContent).toContain("no decisions yet");
    expect(panel.textContent).toContain("3 authors");
    expect(panel.textContent).toContain("· 1 flagged");
    expect(panel.textContent).toContain("4 appealed");
    expect(panel.textContent).toContain("2 rejected twice");
    expect(panel.textContent).toContain("7 author requeues");
    expect(rows[0].querySelectorAll("td")[5].textContent).toBe("3");
    expect(rows[0].querySelectorAll("td")[6].textContent).toBe("2");
    expect(rows[0].querySelectorAll("td")[7].textContent).toBe("5");
    // Pending column counts in_review too.
    expect(rows[0].querySelectorAll("td")[8].textContent).toBe("12");
    (rows[0].querySelector("button") as HTMLButtonElement).click();
    expect(onShow).toHaveBeenCalledWith("sloppy");
  });

  it("shows the explicit original-author QC round and reviewer-edit breakdown", () => {
    const panel = authorQcRoundPanel(users as never);
    expect(panel.textContent).toContain("Author QC round");
    expect(panel.textContent).toContain("Awaiting author9");
    expect(panel.textContent).toContain("Accepted28");
    expect(panel.textContent).toContain("Edited & finalized5");
    expect(panel.textContent).toContain("Round complete79%");
    expect(panel.textContent).toContain("Of 8 reviewer-edited approvals: 5 accepted · 2 edited again by the author · 1 awaiting.");
  });
});
