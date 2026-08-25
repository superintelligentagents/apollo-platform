import type { Ctx } from "../context";
import { el } from "../components/helpers";
import { loadUploadLog, STORAGE_KEYS, type UploadLogEntry } from "../../platform";
import {
  reviewAdmin,
  reviewAdminDetail,
  reviewAdminReopen,
  reviewAdminReopenByReviewer,
  reviewStatus,
  type AdminDashboard,
  type AdminReopenResult,
  type AdminReviewerFlag,
  type AdminReviewerSummary,
  type AdminSubmission,
  type AdminSubmissionStatus,
  type AdminTaskSnapshot,
} from "../../review-client";
import { participantKey } from "../identity";
import { isAdminEmail } from "../../admin-access";
import { pct, summarizeDistribution, type DistributionInput, type Share } from "../../distribution";
import { regionShortLabel } from "../../taxonomy";

const MODE_LABEL: Record<string, string> = {
  guided: "Write your own",
  freeform: "Write your own",
  compose: "Pick your journeys",
  theme: "Start from a theme",
  review: "Tasks reviewed",
};

function tally(entries: UploadLogEntry[], key: (e: UploadLogEntry) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    const k = key(e);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function barGroup(title: string, counts: Map<string, number>, order?: string[]): HTMLElement {
  const entries = order
    ? order.filter((k) => counts.has(k)).map((k) => [k, counts.get(k)!] as const)
    : [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const wrap = el("div", { class: "stat-group" }, el("h3", null, title));
  if (!entries.length) {
    wrap.append(el("p", { class: "muted" }, "Nothing yet."));
    return wrap;
  }
  for (const [k, v] of entries) {
    const fill = el("span", { class: "stat-fill" });
    fill.style.width = `${(v / max) * 100}%`;
    wrap.append(
      el(
        "div",
        { class: "stat-row" },
        el("span", { class: "stat-key" }, k),
        el("span", { class: "stat-track" }, fill),
        el("span", { class: "stat-val mono" }, String(v))
      )
    );
  }
  return wrap;
}

function shareGroup(title: string, rows: Share[], hint: string, empty: string): HTMLElement {
  const wrap = el("div", { class: "stat-group" }, el("h3", null, title), el("p", { class: "field-hint" }, hint));
  if (!rows.length) {
    wrap.append(el("p", { class: "muted" }, empty));
    return wrap;
  }
  const max = Math.max(...rows.map((row) => row.share));
  for (const row of rows) {
    const fill = el("span", { class: "stat-fill" });
    fill.style.width = `${(row.share / max) * 100}%`;
    wrap.append(
      el(
        "div",
        { class: "stat-row share-row" },
        el("span", { class: "stat-key", title: row.label }, row.label),
        el("span", { class: "stat-track" }, fill),
        el("span", { class: "stat-val mono" }, `${pct(row.share)} · ${row.count}`)
      )
    );
  }
  return wrap;
}

const STATUS_LABEL: Record<AdminSubmissionStatus, string> = {
  pending: "Pending",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
};

export function filterAdminSubmissions(
  items: AdminSubmission[],
  filters: { query: string; participantId: string; status: string }
): AdminSubmission[] {
  const q = filters.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.participantId && item.participant_id !== filters.participantId) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (!q) return true;
    return [
      item.task_id,
      item.participant_name,
      item.participant_email,
      item.participant_id,
      item.original.title,
      item.original.request,
      item.reviewer,
    ].some((value) => value.toLowerCase().includes(q));
  });
}

// `meta` is passed in rather than read off the snapshot: the server keeps
// distribution metadata beside the snapshots so the reporting content hash
// stays stable, and both snapshots of a row share the one resolved value.
function taskSnapshot(
  label: string,
  snapshot: AdminTaskSnapshot,
  meta: { region?: string; subjects?: string[] } | null | undefined,
  extraClass = ""
): HTMLElement {
  const criteria = snapshot.criteria.length
    ? el("ol", { class: "admin-rubric-list" }, ...snapshot.criteria.map((criterion) => el("li", null, criterion)))
    : el("p", { class: "muted" }, "No success criteria.");
  const steps = snapshot.steps.length
    ? el(
        "ol",
        { class: "admin-step-list" },
        ...snapshot.steps.map((step) =>
          el("li", null, el("strong", null, step.title || `Step ${step.order}`), el("p", null, step.description))
        )
      )
    : el("p", { class: "muted" }, "No authored steps.");
  return el(
    "section",
    { class: `admin-snapshot ${extraClass}`.trim() },
    el(
      "div",
      { class: "admin-snapshot-head" },
      el("h5", null, label),
      meta?.region ? el("span", { class: "chip tag region-tag" }, regionShortLabel(meta.region)) : null,
      ...(meta?.subjects ?? []).map((subject) => el("span", { class: "chip" }, subject)),
      el("span", { class: "chip tag" }, snapshot.difficulty)
    ),
    el("h6", null, snapshot.title || "Untitled task"),
    el("p", { class: "admin-request" }, snapshot.request || "No request text."),
    ...(snapshot.criteria.length ? [el("h6", null, "Success criteria"), criteria] : []),
    el("h6", null, "Steps"),
    steps
  );
}

type ReopenTask = (taskId: string) => Promise<AdminReopenResult>;

export function resolveAdminTaskMetadata(
  item: Pick<AdminSubmission, "task_metadata" | "original" | "final">
): { region?: string; subjects?: string[] } | null | undefined {
  return item.task_metadata ?? item.final?.metadata ?? item.original.metadata;
}

function reopenTaskButton(item: AdminSubmission, reopen: ReopenTask): HTMLElement {
  const note = el("span", { class: "muted small admin-reopen-note" });
  const button = el("button", { class: "btn ghost small danger-ghost admin-reopen-task", type: "button" }, "Re-queue for another reviewer") as HTMLButtonElement;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    const verdict = item.status === "approved" ? "approval" : "rejection";
    if (!window.confirm(`Throw this task back into the review pool?\n\nThe ${verdict} by ${item.reviewer || "the previous reviewer"} is revoked (archived, not deleted) and the task is handed to a different reviewer.`)) return;
    button.disabled = true;
    note.textContent = "Re-queuing…";
    try {
      const result = await reopen(item.task_id);
      note.textContent = `Back in the queue · previous ${result.previous_outcome} by ${result.previous_reviewers.join(", ") || "unknown"} revoked.`;
      button.remove();
    } catch (error) {
      button.disabled = false;
      note.textContent = error instanceof Error ? error.message : "Couldn't re-queue this task.";
    }
  });
  return el("div", { class: "admin-reopen-row" }, button, note);
}

function submissionDetail(item: AdminSubmission, reopen?: ReopenTask): HTMLElement {
  const reviewMeta = item.status === "pending"
    ? "Awaiting review"
    : `${item.reviewer || "Unknown reviewer"}${item.reviewed_at ? ` · ${new Date(item.reviewed_at).toLocaleString()}` : ""}`;
  // Current dashboard rows carry metadata inside the snapshots. Keep the
  // top-level field as a forward-compatible fast path for indexed responses.
  const taskMetadata = resolveAdminTaskMetadata(item);
  return el(
    "div",
    { class: "admin-submission-detail" },
    ...(reopen && ["approved", "rejected"].includes(item.status) ? [reopenTaskButton(item, reopen)] : []),
    el(
      "div",
      { class: "admin-meta-grid" },
      el("span", null, el("small", null, "Task ID"), el("strong", { class: "mono" }, item.task_id)),
      el("span", null, el("small", null, "Source"), el("strong", null, item.mode === "pc" ? "Apollo PC" : item.mode)),
      el("span", null, el("small", null, "Review"), el("strong", null, reviewMeta)),
      el("span", null, el("small", null, "Trajectories"), el("strong", null, `${item.trajectory_count} journeys · ${item.visit_count} visits`))
    ),
    ...(item.rejection_reason
      ? [el("div", { class: "admin-rejection" }, el("strong", null, "Rejection reason"), el("p", null, item.rejection_reason))]
      : []),
    el(
      "div",
      { class: `admin-snapshots ${item.final ? "has-final" : ""}` },
      taskSnapshot(item.final ? "Original submission" : "Submitted task", item.original, taskMetadata),
      ...(item.final ? [taskSnapshot(item.changed ? "Final gold · changed" : "Final gold · unchanged", item.final, taskMetadata, "final")] : [])
    )
  );
}

function submissionRow(
  item: AdminSubmission,
  loadDetail: (taskId: string) => Promise<AdminSubmission>,
  reopen?: ReopenTask
): HTMLElement {
  const when = item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : "—";
  const identity = item.participant_email
    ? `${item.participant_name} · ${item.participant_email}`
    : item.participant_name;
  const details = el(
    "details",
    { class: "admin-submission" },
    el(
      "summary",
      { class: "admin-submission-summary" },
      el("span", { class: "admin-summary-main" }, el("strong", null, item.original.title || "Untitled task"), el("small", null, identity)),
      el("span", { class: `chip admin-status status-${item.status}` }, STATUS_LABEL[item.status]),
      el("span", { class: "muted mono admin-date" }, when),
      el("span", { class: "admin-chevron", "aria-hidden": "true" }, "▾")
    )
  );
  if (item.detail_loaded !== false) {
    details.append(submissionDetail(item, reopen));
    return details;
  }
  const loading = el("div", { class: "admin-submission-detail" }, el("p", { class: "muted" }, "Open to load the complete task…"));
  details.append(loading);
  let requested = false;
  details.addEventListener("toggle", () => {
    if (!details.open || requested) return;
    requested = true;
    loading.replaceChildren(el("p", { class: "muted" }, "Loading complete task…"));
    void loadDetail(item.task_id)
      .then((fullItem) => loading.replaceWith(submissionDetail(fullItem, reopen)))
      .catch(() => {
        requested = false;
        const retry = el("button", { class: "btn ghost small", type: "button" }, "Try again");
        retry.addEventListener("click", (event) => {
          event.preventDefault();
          details.open = false;
          queueMicrotask(() => { details.open = true; });
        });
        loading.replaceChildren(el("p", { class: "muted" }, "The complete task couldn't load."), retry);
      });
  });
  return details;
}

const REVIEWER_FLAG_LABEL: Record<AdminReviewerFlag, { label: string; title: string }> = {
  no_rejections: { label: "never rejects", title: "10+ decisions and not a single rejection" },
  rarely_edits: { label: "rarely edits", title: "Fewer than 25% of approvals changed the title, request, or any rubric" },
  fast: { label: "very fast", title: "Median under 3 minutes between consecutive decisions" },
};

function fmtPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function fmtMinutes(value: number | null): string {
  if (value === null) return "—";
  return value < 1 ? "<1 min" : `${value.toFixed(value < 10 ? 1 : 0)} min`;
}

export function reviewerQualityPanel(
  reviewers: readonly AdminReviewerSummary[] | undefined,
  actions: {
    onShow: (reviewer: string) => void;
    onReopenUnedited: (reviewer: AdminReviewerSummary, status: HTMLElement) => Promise<void>;
  }
): HTMLElement {
  const panel = el("section", { class: "admin-reviewers" });
  panel.append(
    el(
      "div",
      { class: "admin-reviewers-head" },
      el("div", null, el("p", { class: "eyebrow" }, "Reviewer quality"), el("h4", null, "Accept / reject / edit rates by reviewer")),
      el("p", { class: "muted" }, "Flags are heuristics, not verdicts: a reviewer who approves everything untouched, or decides every couple of minutes, deserves a second look. “Re-queue” revokes their unedited approvals (archived, never deleted) and hands those tasks to someone else.")
    )
  );
  if (!reviewers) {
    panel.append(el("p", { class: "muted" }, "Reviewer stats arrive with the next backend deploy."));
    return panel;
  }
  if (!reviewers.length) {
    panel.append(el("p", { class: "muted" }, "No decisions yet."));
    return panel;
  }
  const flagged = reviewers.filter((row) => row.suspicious).length;
  const table = el("table", { class: "admin-reviewer-table" });
  table.append(el("thead", null, el("tr", null,
    el("th", null, "Reviewer"),
    el("th", { class: "num" }, "Reviewed"),
    el("th", { class: "num" }, "Approved"),
    el("th", { class: "num" }, "Rejected"),
    el("th", { class: "num" }, "Approvals edited"),
    el("th", { class: "num" }, "Median gap"),
    el("th", null, "Last active"),
    el("th", null, "")
  )));
  const body = el("tbody");
  for (const row of reviewers) {
    const status = el("span", { class: "muted small admin-reviewer-status" });
    const flags = row.flags.map((flag) => el("span", { class: `chip flag-${flag}`, title: REVIEWER_FLAG_LABEL[flag].title }, REVIEWER_FLAG_LABEL[flag].label));
    const show = el("button", { class: "btn ghost small", type: "button", title: "Show this reviewer's decisions below" }, "Show");
    show.addEventListener("click", () => actions.onShow(row.reviewer));
    const reopen = el("button", {
      class: "btn ghost small danger-ghost",
      type: "button",
      disabled: row.unedited_approvals === 0,
      title: row.unedited_approvals
        ? `Revoke the ${row.unedited_approvals} approvals ${row.reviewer} made without any edit and put those tasks back in the queue for someone else`
        : "No unedited approvals to re-queue",
    }, `Re-queue ${row.unedited_approvals} unedited`) as HTMLButtonElement;
    reopen.addEventListener("click", async () => {
      if (!window.confirm(`Re-queue ${row.unedited_approvals} unedited approvals by ${row.reviewer}?\n\nEach approval is revoked (archived under v2-review/reopened/) and the task goes back to the pool for a different reviewer. ${row.reviewer} will not be offered these tasks again.`)) return;
      reopen.disabled = true;
      show.disabled = true;
      try {
        await actions.onReopenUnedited(row, status);
      } finally {
        show.disabled = false;
      }
    });
    body.append(el("tr", { class: row.suspicious ? "suspicious" : "" },
      el("td", null, el("div", { class: "admin-reviewer-name" }, el("strong", null, row.reviewer), ...flags)),
      el("td", { class: "num" }, String(row.reviewed)),
      el("td", { class: "num" }, String(row.approved)),
      el("td", { class: "num" }, `${row.rejected}`, el("small", null, ` (${fmtPct(row.reject_rate)})`)),
      el("td", { class: "num" }, `${row.edited_approvals}/${row.approved}`, el("small", null, ` (${fmtPct(row.edit_rate)})`)),
      el("td", { class: "num", title: row.fast_share === null ? "" : `${fmtPct(row.fast_share)} of decisions under 3 min apart` }, fmtMinutes(row.median_gap_minutes)),
      el("td", null, row.last_reviewed_at ? new Date(row.last_reviewed_at).toLocaleDateString() : "—"),
      el("td", { class: "admin-reviewer-actions" }, show, reopen, status)
    ));
  }
  table.append(body);
  panel.append(
    el("p", { class: "muted small admin-reviewers-summary" }, `${reviewers.length} reviewers · ${flagged} flagged · median gap = minutes between consecutive decisions in one sitting (claim time is not recorded).`),
    el("div", { class: "admin-reviewer-table-wrap" }, table)
  );
  return panel;
}

// How each trainer's SUBMITTED tasks fare in QC — the author-side complement
// to the reviewer table (which grades the reviewers). Rate is over decided
// tasks only; authors with everything still pending are shown but unrated.
export function authorQualityPanel(
  users: readonly AdminDashboard["users"][number][] | undefined,
  onShow: (participantId: string) => void
): HTMLElement {
  const panel = el("section", { class: "admin-authors" });
  panel.append(
    el(
      "div",
      { class: "admin-reviewers-head" },
      el("div", null, el("p", { class: "eyebrow" }, "Author quality"), el("h4", null, "Final outcomes and author follow-through")),
      el("p", { class: "muted" }, "Admin-only workflow view. Final approval rates use decided tasks only; QC edits, author sign-offs, appeals, terminal second rejections, and non-appeal author requeues are shown separately.")
    )
  );
  const rows = [...(users ?? [])]
    .map((user) => {
      const decided = user.decided ?? user.approved + user.rejected;
      const approvalRate = user.approval_rate ?? (decided ? user.approved / decided : null);
      const qcEdited = user.qc_edited_approvals ?? 0;
      const qcEditRate = user.qc_edit_rate ?? (user.approved ? qcEdited / user.approved : null);
      const authorAccepted = user.author_accepted_approvals ?? 0;
      const authorAmended = user.author_amended_approvals ?? 0;
      return {
        ...user,
        decided,
        approval_rate: approvalRate,
        reject_rate: approvalRate === null ? null : 1 - approvalRate,
        qc_edited_approvals: qcEdited,
        qc_edit_rate: qcEditRate,
        author_accepted_approvals: authorAccepted,
        author_amended_approvals: authorAmended,
        awaiting_signoff: user.awaiting_signoff ?? Math.max(0, user.approved - authorAccepted - authorAmended),
        appealed: user.appealed ?? 0,
        double_rejected: user.double_rejected ?? 0,
        author_requeues: user.author_requeues ?? 0,
      };
    })
    .sort((a, b) => (b.reject_rate ?? -1) - (a.reject_rate ?? -1) || b.submitted - a.submitted);
  if (!rows.length) {
    panel.append(el("p", { class: "muted" }, "No submissions yet."));
    return panel;
  }
  const flagged = rows.filter((row) => row.decided >= 10 && (row.reject_rate ?? 0) >= 0.3);
  const table = el("table", { class: "admin-reviewer-table" });
  table.append(el("thead", null, el("tr", null,
    el("th", null, "Author"),
    el("th", { class: "num" }, "Submitted"),
    el("th", { class: "num", title: "Approved divided by approved plus rejected; pending tasks are excluded" }, "Final approval"),
    el("th", { class: "num", title: "Approved tasks whose reviewer changed the authored task during QC" }, "Edited in QC"),
    el("th", { class: "num", title: "How approved tasks were finalized by their original author" }, "Author sign-off"),
    el("th", { class: "num", title: "Tasks revised and appealed once after their first rejection" }, "Appealed"),
    el("th", { class: "num", title: "Appealed tasks rejected by the fresh second reviewer; these are terminal" }, "Rejected twice"),
    el("th", { class: "num", title: "Non-appeal revisions that an author resubmitted to the reviewer queue" }, "Author requeues"),
    el("th", { class: "num" }, "Pending"),
    el("th", null, "")
  )));
  const body = el("tbody");
  for (const row of rows) {
    const suspicious = row.decided >= 10 && (row.reject_rate ?? 0) >= 0.3;
    const strong = row.decided >= 10 && (row.reject_rate ?? 1) <= 0.05;
    const show = el("button", { class: "btn ghost small", type: "button", title: "Show this author's submissions below" }, "Show");
    show.addEventListener("click", () => onShow(row.participant_id));
    body.append(el("tr", { class: suspicious ? "suspicious" : "" },
      el("td", null, el("div", { class: "admin-reviewer-name" },
        el("strong", null, row.name),
        ...(suspicious ? [el("span", { class: "chip flag-fast", title: "30%+ of decided tasks rejected (10+ decided)" }, "high rejection")] : []),
        ...(strong ? [el("span", { class: "chip flag-clean", title: "5% or less rejected (10+ decided)" }, "clean record")] : []))),
      el("td", { class: "num" }, String(row.submitted)),
      el("td", { class: "num" }, row.approval_rate === null ? "—" : `${Math.round(row.approval_rate * 100)}%`,
        el("small", null, row.decided ? ` ${row.approved}/${row.decided} · ${row.rejected} rejected` : " no decisions yet")),
      el("td", { class: "num" }, `${row.qc_edited_approvals}/${row.approved}`,
        el("small", null, row.qc_edit_rate === null ? " no approvals" : ` ${Math.round(row.qc_edit_rate * 100)}%`)),
      el("td", { class: "num" }, `${row.author_accepted_approvals} accepted · ${row.author_amended_approvals} edited`,
        el("small", null, ` ${row.awaiting_signoff} awaiting`)),
      el("td", { class: "num" }, String(row.appealed)),
      el("td", { class: "num" }, String(row.double_rejected)),
      el("td", { class: "num" }, String(row.author_requeues)),
      el("td", { class: "num" }, String(row.pending + row.in_review)),
      el("td", { class: "admin-reviewer-actions" }, show)
    ));
  }
  table.append(body);
  const decidedTotal = rows.reduce((sum, row) => sum + row.decided, 0);
  const approvedTotal = rows.reduce((sum, row) => sum + row.approved, 0);
  const qcEditedTotal = rows.reduce((sum, row) => sum + row.qc_edited_approvals, 0);
  const authorAmendedTotal = rows.reduce((sum, row) => sum + row.author_amended_approvals, 0);
  const appealedTotal = rows.reduce((sum, row) => sum + row.appealed, 0);
  const doubleRejectedTotal = rows.reduce((sum, row) => sum + row.double_rejected, 0);
  const authorRequeueTotal = rows.reduce((sum, row) => sum + row.author_requeues, 0);
  panel.append(
    el("p", { class: "muted small admin-reviewers-summary" }, `${rows.length} authors · ${decidedTotal ? Math.round((approvedTotal / decidedTotal) * 100) : 0}% final approval · ${qcEditedTotal} edited in QC · ${authorAmendedTotal} edited by author at sign-off · ${appealedTotal} appealed · ${doubleRejectedTotal} rejected twice · ${authorRequeueTotal} author requeues · ${flagged.length} flagged`),
    el("div", { class: "admin-reviewer-table-wrap" }, table)
  );
  return panel;
}

export function authorQcRoundPanel(
  users: readonly AdminDashboard["users"][number][] | undefined
): HTMLElement {
  const rows = users ?? [];
  const approved = rows.reduce((sum, row) => sum + row.approved, 0);
  const accepted = rows.reduce((sum, row) => sum + (row.author_accepted_approvals ?? 0), 0);
  const amended = rows.reduce((sum, row) => sum + (row.author_amended_approvals ?? 0), 0);
  const awaiting = rows.reduce(
    (sum, row) => sum + (row.awaiting_signoff ?? Math.max(0, row.approved - (row.author_accepted_approvals ?? 0) - (row.author_amended_approvals ?? 0))),
    0
  );
  const completed = accepted + amended;
  const editedInQc = rows.reduce((sum, row) => sum + (row.qc_edited_approvals ?? 0), 0);
  const editedAccepted = rows.reduce((sum, row) => sum + (row.qc_edited_author_accepted ?? 0), 0);
  const editedAmended = rows.reduce((sum, row) => sum + (row.qc_edited_author_amended ?? 0), 0);
  const editedAwaiting = rows.reduce((sum, row) => sum + (row.qc_edited_awaiting_signoff ?? 0), 0);
  const hasEditedBreakdown = rows.some((row) => row.qc_edited_author_accepted !== undefined);
  const metric = (label: string, value: string, note: string) => el(
    "div",
    { class: "author-qc-metric" },
    el("span", { class: "eyebrow" }, label),
    el("strong", null, value),
    el("small", { class: "muted" }, note)
  );
  const panel = el(
    "section",
    { class: "author-qc-round", "aria-label": "Author QC round" },
    el(
      "div",
      { class: "admin-reviewers-head" },
      el("div", null, el("p", { class: "eyebrow" }, "Author QC round"), el("h4", null, "Original-author final pass")),
      el("p", { class: "muted" }, "After reviewer approval, the original author either accepts that version or edits it into final gold. Pending tasks remain visible until they act.")
    ),
    el(
      "div",
      { class: "author-qc-grid" },
      metric("Awaiting author", String(awaiting), "approved, not signed off"),
      metric("Accepted", String(accepted), "reviewer version finalized"),
      metric("Edited & finalized", String(amended), "author changed final gold"),
      metric("Round complete", approved ? `${Math.round((completed / approved) * 100)}%` : "—", `${completed} of ${approved} approvals`)
    )
  );
  panel.append(
    el(
      "p",
      { class: "muted small author-qc-edited-breakdown" },
      hasEditedBreakdown
        ? `Of ${editedInQc} reviewer-edited approvals: ${editedAccepted} accepted · ${editedAmended} edited again by the author · ${editedAwaiting} awaiting.`
        : "The reviewer-edit × author-action breakdown will appear after the backend refreshes."
    )
  );
  return panel;
}

function renderAdminPanel(reviewKey: string, adminEmail: string): HTMLElement {
  const panel = el(
    "section",
    { class: "stat-group admin-panel", "aria-labelledby": "admin-heading" },
    el("div", { class: "admin-section-head" },
      el("div", null, el("p", { class: "eyebrow" }, "Admin"), el("h3", { id: "admin-heading" }, "Team submissions")),
      el("p", { class: "muted" }, "Authored task content only. Raw browsing history is not exposed here.")
    ),
    el("p", { class: "muted admin-loading" }, "Loading team activity…")
  );
  void reviewAdmin(reviewKey, adminEmail)
    .then((data) => hydrateAdminPanel(panel, data, reviewKey, adminEmail))
    .catch(() => renderAdminLoadError(panel, reviewKey, adminEmail));
  return panel;
}

function renderAdminLoadError(panel: HTMLElement, reviewKey: string, adminEmail: string): void {
  const retry = el("button", { class: "btn ghost small", type: "button" }, "Retry");
  const error = el(
    "div",
    { class: "admin-load-error" },
    el("p", { class: "muted" }, "Team submissions couldn't load."),
    retry
  );
  panel.querySelector(".admin-loading")?.replaceWith(error);
  retry.addEventListener("click", () => {
    error.replaceWith(el("p", { class: "muted admin-loading" }, "Loading team activity…"));
    void reviewAdmin(reviewKey, adminEmail)
      .then((data) => hydrateAdminPanel(panel, data, reviewKey, adminEmail))
      .catch(() => renderAdminLoadError(panel, reviewKey, adminEmail));
  });
}

export function teamDistribution(items?: readonly DistributionInput[]): HTMLElement {
  const panel = el("section", { class: "stat-group team-distribution" }, el("h3", null, "Spread across the team"));
  if (!items) {
    panel.append(el("p", { class: "muted" }, "Team distribution is loading with the next dashboard refresh."));
    return panel;
  }
  const summary = summarizeDistribution(items);
  if (!summary.labelled) {
    panel.append(el("p", { class: "muted" }, "No region or subject data has been recorded yet."));
    return panel;
  }
  const maxRows = 5;
  const regionRows = summary.regions.slice(0, maxRows);
  const subjectRows = summary.subjects.slice(0, maxRows);
  const regionHint = `${pct(summary.globalShare)} with no specific country${summary.regions.length > maxRows ? ` · top ${maxRows} of ${summary.regions.length}` : ""}`;
  const subjectHint = `${summary.subjects.length} of 21 groups covered${summary.subjects.length > maxRows ? ` · top ${maxRows} shown` : ""}`;
  panel.append(
    el(
      "div",
      { class: "stat-cols" },
      shareGroup("By place", regionRows, regionHint, "None recorded."),
      shareGroup("By subject", subjectRows, subjectHint, "None recorded.")
    ),
    ...(summary.unlabelled
      ? [el("p", { class: "muted small" }, `Based on ${summary.labelled} of ${items.length} submissions; the rest predate these fields.`)]
      : [])
  );
  return panel;
}

function distributionPanel(log: readonly UploadLogEntry[]): HTMLElement {
  const summary = summarizeDistribution(log.filter((entry) => entry.mode !== "review"));
  const panel = el(
    "section",
    { class: "stat-group distribution-panel" },
    el(
      "div",
      { class: "admin-section-head" },
      el("div", null, el("p", { class: "eyebrow" }, "Your spread"), el("h3", null, "Places and subjects")),
      el("p", { class: "muted" }, "Keep your tasks spread across places and subjects.")
    )
  );
  if (!summary.labelled) {
    panel.append(
      el(
        "p",
        { class: "muted" },
        summary.unlabelled
          ? "Earlier tasks predate these fields. New tasks will appear here."
          : "Submit a task and your spread will appear here."
      )
    );
    return panel;
  }
  if (summary.advice) panel.append(el("p", { class: "notice info distribution-advice" }, summary.advice));
  panel.append(
    el(
      "div",
      { class: "stat-cols" },
      shareGroup("By place", summary.regions, `${pct(summary.globalShare)} with no specific country`, "No places recorded."),
      shareGroup("By subject", summary.subjects, `${summary.subjects.length} of 21 groups covered`, "No subjects recorded.")
    )
  );
  if (summary.unlabelled) {
    panel.append(el("p", { class: "muted small" }, `${summary.unlabelled} earlier task${summary.unlabelled === 1 ? "" : "s"} not counted.`));
  }
  return panel;
}

function hydrateAdminPanel(panel: HTMLElement, initialData: AdminDashboard, reviewKey: string, adminEmail: string): void {
  panel.querySelector(".admin-loading")?.remove();
  const stats = el("div", { class: "admin-user-stats" });
  for (const user of initialData.users) {
    stats.append(
      el(
        "button",
        { class: "admin-user-card", type: "button", dataset: { participantId: user.participant_id } },
        el("span", { class: "admin-user-name" }, user.name),
        el("small", null, user.email || user.participant_id),
        el("strong", null, String(user.submitted)),
        el("span", null, `${user.approved} approved · ${user.in_review} reviewing · ${user.pending} pending · ${user.rejected} rejected`)
      )
    );
  }
  const query = el("input", { class: "input", type: "search", placeholder: "Search user, title, task ID…", "aria-label": "Search team submissions" });
  const userSelect = el("select", { class: "input", "aria-label": "Filter submissions by user" }, el("option", { value: "" }, "All users"));
  for (const user of initialData.users) userSelect.append(el("option", { value: user.participant_id }, user.email ? `${user.name} · ${user.email}` : user.name));
  const statusSelect = el(
    "select",
    { class: "input", "aria-label": "Filter submissions by status" },
    el("option", { value: "" }, "All statuses"),
    ...Object.entries(STATUS_LABEL).map(([value, label]) => el("option", { value }, label))
  );
  const resultCount = el("p", { class: "muted admin-result-count", role: "status" });
  const list = el("div", { class: "admin-submission-list" });
  const previous = el("button", { class: "btn ghost small", type: "button" }, "Previous");
  const next = el("button", { class: "btn ghost small", type: "button" }, "Next");
  const pageActions = el("div", { class: "admin-page-actions" }, previous, next);
  let data = initialData;
  let requestVersion = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  const draw = () => {
    // The server pages current builds. Keep the local filter fallback so an
    // older backend response remains useful during a rolling deployment.
    const serverPaged = data.filtered_total !== undefined;
    const shown = serverPaged
      ? data.items
      : filterAdminSubmissions(data.items, {
          query: query.value,
          participantId: userSelect.value,
          status: statusSelect.value,
        });
    const filteredTotal = data.filtered_total ?? shown.length;
    const offset = data.offset ?? 0;
    const start = shown.length ? offset + 1 : 0;
    const end = offset + shown.length;
    resultCount.textContent = filteredTotal === data.total
      ? `Showing ${start}–${end} of ${data.total} submissions${data.truncated ? " (latest 1,000 indexed)" : ""}`
      : `Showing ${start}–${end} of ${filteredTotal} matching submissions · ${data.total} total${data.truncated ? " (latest 1,000 indexed)" : ""}`;
    list.replaceChildren(...(shown.length
      ? shown.map((item) => submissionRow(item, (taskId) => reviewAdminDetail(reviewKey, adminEmail, taskId), reopenTask))
      : [el("p", { class: "muted admin-empty" }, "No submissions match these filters.")]));
    previous.disabled = !serverPaged || offset <= 0;
    next.disabled = !serverPaged || data.next_offset == null;
    for (const card of stats.querySelectorAll<HTMLButtonElement>(".admin-user-card")) {
      card.classList.toggle("active", card.dataset.participantId === userSelect.value);
    }
  };
  const loadPage = async (offset = 0) => {
    const version = ++requestVersion;
    list.classList.add("loading");
    resultCount.textContent = "Loading matching submissions…";
    previous.disabled = true;
    next.disabled = true;
    try {
      const nextData = await reviewAdmin(reviewKey, adminEmail, {
        query: query.value,
        participantId: userSelect.value,
        status: statusSelect.value,
        offset,
        limit: data.limit ?? 50,
      });
      if (version !== requestVersion) return;
      data = nextData;
      draw();
    } catch {
      if (version !== requestVersion) return;
      resultCount.textContent = "Couldn't load matching submissions. Try again.";
    } finally {
      if (version === requestVersion) list.classList.remove("loading");
    }
  };
  query.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadPage(0), 250);
  });
  userSelect.addEventListener("change", () => void loadPage(0));
  statusSelect.addEventListener("change", () => void loadPage(0));
  stats.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".admin-user-card");
    if (!card) return;
    userSelect.value = userSelect.value === card.dataset.participantId ? "" : card.dataset.participantId || "";
    void loadPage(0);
  });
  previous.addEventListener("click", () => void loadPage(Math.max(0, (data.offset ?? 0) - (data.limit ?? 50))));
  next.addEventListener("click", () => {
    if (data.next_offset != null) void loadPage(data.next_offset);
  });
  const reopenTask: ReopenTask = (taskId) => reviewAdminReopen(reviewKey, adminEmail, taskId, "Re-queued from the executive dashboard");
  const reviewerPanel = reviewerQualityPanel(initialData.reviewers, {
    onShow: (reviewer) => {
      query.value = reviewer;
      userSelect.value = "";
      statusSelect.value = "";
      void loadPage(0);
    },
    onReopenUnedited: async (row, status) => {
      let reopened = 0;
      let remaining = row.unedited_approvals;
      let failed = 0;
      // The server bounds each call; keep going until nothing matches.
      for (let round = 0; round < 25 && remaining > 0; round += 1) {
        status.textContent = `Re-queuing… ${reopened} done`;
        const result = await reviewAdminReopenByReviewer(reviewKey, adminEmail, row.reviewer, {
          onlyUnedited: true,
          reason: "Re-queued from the executive dashboard (reviewer quality check)",
        }).catch(() => null);
        if (!result) { failed += 1; break; }
        reopened += result.reopened;
        failed += result.failed.length;
        remaining = result.remaining;
        if (result.reopened === 0) break;
      }
      status.textContent = `${reopened} task${reopened === 1 ? "" : "s"} back in the queue${failed ? ` · ${failed} failed` : ""}${remaining > 0 ? ` · ${remaining} remaining — run again` : ""}.`;
      void loadPage(0);
    },
  });
  const authorPanel = authorQualityPanel(initialData.users, (participantId) => {
    userSelect.value = participantId;
    query.value = "";
    statusSelect.value = "";
    void loadPage(0);
  });
  // One tabbed card: Reviewer quality | Author quality. Both tables are
  // heavy, and stacking them pushed the author view below the fold — which
  // read as "missing".
  const qualityTabs = el("div", { class: "quality-tabs", role: "tablist", "aria-label": "Quality views" });
  const qualityViews: { label: string; view: HTMLElement; tab: HTMLButtonElement }[] = [];
  const selectQualityTab = (index: number) => {
    qualityViews.forEach((entry, i) => {
      entry.tab.classList.toggle("active", i === index);
      entry.tab.setAttribute("aria-selected", String(i === index));
      entry.view.hidden = i !== index;
    });
  };
  [{ label: "Reviewer quality", view: reviewerPanel }, { label: "Author quality", view: authorPanel }].forEach((entry, index) => {
    const tab = el("button", {
      class: "quality-tab",
      type: "button",
      role: "tab",
      onclick: () => selectQualityTab(index),
    }, entry.label) as HTMLButtonElement;
    qualityTabs.append(tab);
    qualityViews.push({ ...entry, tab });
  });
  selectQualityTab(0);
  panel.append(
    authorQcRoundPanel(initialData.users),
    el("section", { class: "quality-card" }, qualityTabs, reviewerPanel, authorPanel),
    stats,
    teamDistribution(
      initialData.distribution_items ??
      (initialData.filtered_total === undefined
        ? initialData.items.map((item) => item.final?.metadata ?? item.original.metadata ?? {})
        : undefined)
    ),
    el("div", { class: "admin-filters" }, query, userSelect, statusSelect),
    resultCount,
    list,
    pageActions
  );
  draw();
}

export function renderProgress(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen progress-screen" });
  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("h2", { class: "display" }, "Your contributions"),
      el(
        "p",
        { class: "screen-sub" },
        "Your task counts as soon as it uploads. Its later review result does not delay your contribution credit."
      )
    )
  );

  const body = el("div", { class: "progress-body" }, el("p", { class: "muted" }, "Loading…"));
  root.append(body);

  const identity = state.identity;
  if (!identity) return root;

  void loadUploadLog(ctx.adapter.storage, participantKey(identity)).then((log) => {
    body.replaceChildren();

    const authored = log.filter((e) => e.mode !== "review");
    const reviews = Math.max(state.reviewedCount, log.length - authored.length);
    const total = Math.max(state.uploadedCount, authored.length);
    const submittedValue = el("strong", null, String(total));
    const reviewedValue = el("strong", null, String(reviews));
    let detailNote: HTMLParagraphElement | null = null;
    body.append(
      el(
        "div",
        { class: "queue-tiles you-tiles" },
        el("div", { class: "queue-tile" }, submittedValue, el("span", null, "tasks submitted")),
        el("div", { class: "queue-tile" }, reviewedValue, el("span", null, "tasks reviewed by you"))
      )
    );

    if (state.reviewKey) {
      const team = el("section", { class: "stat-group team-panel" }, el("h3", null, "Total"), el("p", { class: "muted" }, "Loading…"));
      body.append(team);
      void reviewStatus(state.reviewKey)
        .then((counts) => {
          const approved = counts.approved ?? counts.finished - (counts.rejected ?? 0);
          // Older clients did not persist review receipts locally. The team
          // API already has authoritative per-reviewer totals, so use the row
          // matching the signed-in annotator to repair their personal count.
          const reviewerNames = new Set([identity.name, identity.email].map((value) => value.trim().toLowerCase()));
          const mine = counts.reviewers?.find((row) => reviewerNames.has(row.reviewer.trim().toLowerCase()));
          if (mine) {
            state.reviewedCount = Math.max(state.reviewedCount, mine.approved + mine.rejected);
            reviewedValue.textContent = String(state.reviewedCount);
            if (detailNote) {
              detailNote.textContent = isAdminEmail(identity.email)
                ? "This installation has no local Recent tasks. Select your name in Team submissions above to view your cloud submissions."
                : "This installation has no local Recent tasks. Your cloud contribution totals are shown above.";
            }
            void ctx.adapter.storage.set(
              STORAGE_KEYS.reviewCount(participantKey(identity)),
              String(state.reviewedCount)
            ).catch(() => {});
          }
          team.replaceChildren(
            el("h3", null, "Total"),
            el(
              "div",
              { class: "queue-tiles" },
              el("div", { class: "queue-tile" }, el("strong", null, String(counts.claimable)), el("span", null, "waiting")),
              el("div", { class: "queue-tile" }, el("strong", null, String(approved)), el("span", null, "approved")),
              el("div", { class: "queue-tile" }, el("strong", null, String(counts.rejected ?? 0)), el("span", null, "rejected"))
            ),
            ...(counts.reviewers?.length
              ? [
                  el(
                    "div",
                    { class: "reviewer-table" },
                    ...counts.reviewers.map((r) =>
                      el(
                        "div",
                        { class: "recent-row" },
                        el("span", { class: "recent-title" }, r.reviewer),
                        el("span", { class: "muted mono" }, `${r.approved} approved · ${r.rejected} rejected`)
                      )
                    )
                  ),
                ]
              : [el("p", { class: "muted" }, "No reviews yet.")])
          );
        })
        .catch(() => {
          team.replaceChildren(el("h3", null, "Total"), el("p", { class: "muted" }, "Couldn't load total counts."));
        });
      if (isAdminEmail(identity.email)) body.append(renderAdminPanel(state.reviewKey, identity.email));
    }

    body.append(distributionPanel(log));

    if (!log.length) {
      detailNote = el(
        "p",
        { class: "muted" },
        total > 0 || state.reviewedCount > 0
          ? isAdminEmail(identity.email)
            ? "This installation has no local Recent tasks. Select your name in Team submissions above to view your cloud submissions."
            : "This installation has no local Recent tasks. Your cloud contribution totals are shown above."
          : "No contributions recorded on this installation yet. Cloud totals will appear above when available."
      );
      body.append(detailNote);
      return;
    }

    body.append(
      el(
        "div",
        { class: "stat-cols" },
        barGroup("By mode", tally(log, (e) => MODE_LABEL[e.mode] ?? e.mode)),
        // Strength describes the tasks YOU authored; reviewed tasks would
        // muddle the spread. (No difficulty split — every task is long-horizon.)
        barGroup("By strength", tally(authored.filter((e) => e.strength), (e) => e.strength!), ["high", "medium", "low"])
      )
    );

    const recent = el("div", { class: "stat-group recent" }, el("h3", null, "Recent tasks"));
    for (const e of [...log].reverse().slice(0, 8)) {
      recent.append(
        el(
          "div",
          { class: "recent-row" },
          el("span", { class: "recent-title" }, e.title || "(untitled)"),
          e.region ? el("span", { class: "chip tag region-tag" }, regionShortLabel(e.region)) : null,
          el("span", { class: "chip tag" }, MODE_LABEL[e.mode] ?? e.mode),
          el("span", { class: "muted mono" }, new Date(e.at).toLocaleDateString())
        )
      );
    }
    body.append(recent);
  });

  root.append(
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto("home") }, "Back to home")
    )
  );
  return root;
}
