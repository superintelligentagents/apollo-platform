import type { Ctx } from "../context";
import { el } from "../components/helpers";
import { loadUploadLog, STORAGE_KEYS, type UploadLogEntry } from "../../platform";
import {
  reviewAdmin,
  reviewStatus,
  type AdminDashboard,
  type AdminSubmission,
  type AdminSubmissionStatus,
  type AdminTaskSnapshot,
} from "../../review-client";
import { participantKey } from "../identity";
import { isAdminEmail } from "../../admin-access";
import { pct, summarizeDistribution, type Share } from "../../distribution";
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

// Same bars as barGroup, but keyed on a precomputed share so the percentage the
// guidance is written in terms of is the number on screen.
function shareGroup(title: string, rows: Share[], hint: string, empty: string): HTMLElement {
  const wrap = el("div", { class: "stat-group" }, el("h3", null, title), el("p", { class: "field-hint" }, hint));
  if (!rows.length) {
    wrap.append(el("p", { class: "muted" }, empty));
    return wrap;
  }
  const max = Math.max(...rows.map((r) => r.share));
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

function taskSnapshot(label: string, snapshot: AdminTaskSnapshot, extraClass = ""): HTMLElement {
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
  const meta = snapshot.metadata;
  return el(
    "section",
    { class: `admin-snapshot ${extraClass}`.trim() },
    el(
      "div",
      { class: "admin-snapshot-head" },
      el("h5", null, label),
      meta?.region ? el("span", { class: "chip tag region-tag" }, regionShortLabel(meta.region)) : null,
      ...(meta?.subjects ?? []).map((s) => el("span", { class: "chip" }, s)),
      el("span", { class: "chip tag" }, snapshot.difficulty)
    ),
    el("h6", null, snapshot.title || "Untitled task"),
    el("p", { class: "admin-request" }, snapshot.request || "No request text."),
    ...(snapshot.criteria.length ? [el("h6", null, "Success criteria"), criteria] : []),
    el("h6", null, "Steps"),
    steps
  );
}

function submissionRow(item: AdminSubmission): HTMLElement {
  const when = item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : "—";
  const identity = item.participant_email
    ? `${item.participant_name} · ${item.participant_email}`
    : item.participant_name;
  const reviewMeta = item.status === "pending"
    ? "Awaiting review"
    : `${item.reviewer || "Unknown reviewer"}${item.reviewed_at ? ` · ${new Date(item.reviewed_at).toLocaleString()}` : ""}`;
  return el(
    "details",
    { class: "admin-submission" },
    el(
      "summary",
      { class: "admin-submission-summary" },
      el("span", { class: "admin-summary-main" }, el("strong", null, item.original.title || "Untitled task"), el("small", null, identity)),
      el("span", { class: `chip admin-status status-${item.status}` }, STATUS_LABEL[item.status]),
      el("span", { class: "muted mono admin-date" }, when),
      el("span", { class: "admin-chevron", "aria-hidden": "true" }, "▾")
    ),
    el(
      "div",
      { class: "admin-submission-detail" },
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
        taskSnapshot(item.final ? "Original submission" : "Submitted task", item.original),
        ...(item.final ? [taskSnapshot(item.changed ? "Final gold · changed" : "Final gold · unchanged", item.final, "final")] : [])
      )
    )
  );
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
    .then((data) => hydrateAdminPanel(panel, data))
    .catch(() => panel.querySelector(".admin-loading")?.replaceWith(el("p", { class: "muted" }, "Couldn't load admin submissions.")));
  return panel;
}

function hydrateAdminPanel(panel: HTMLElement, data: AdminDashboard): void {
  panel.querySelector(".admin-loading")?.remove();
  const stats = el("div", { class: "admin-user-stats" });
  for (const user of data.users) {
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
  const query = el("input", { class: "input", type: "search", placeholder: "Search user, title, request, task ID…", "aria-label": "Search team submissions" });
  const userSelect = el("select", { class: "input", "aria-label": "Filter submissions by user" }, el("option", { value: "" }, "All users"));
  for (const user of data.users) userSelect.append(el("option", { value: user.participant_id }, user.email ? `${user.name} · ${user.email}` : user.name));
  const statusSelect = el(
    "select",
    { class: "input", "aria-label": "Filter submissions by status" },
    el("option", { value: "" }, "All statuses"),
    ...Object.entries(STATUS_LABEL).map(([value, label]) => el("option", { value }, label))
  );
  const resultCount = el("p", { class: "muted admin-result-count", role: "status" });
  const list = el("div", { class: "admin-submission-list" });
  const draw = () => {
    const filtered = filterAdminSubmissions(data.items, {
      query: query.value,
      participantId: userSelect.value,
      status: statusSelect.value,
    });
    resultCount.textContent = `Showing ${filtered.length} of ${data.total} submissions${data.truncated ? " (latest 1,000 loaded)" : ""}`;
    list.replaceChildren(...(filtered.length ? filtered.map(submissionRow) : [el("p", { class: "muted admin-empty" }, "No submissions match these filters.")]));
    for (const card of stats.querySelectorAll<HTMLButtonElement>(".admin-user-card")) {
      card.classList.toggle("active", card.dataset.participantId === userSelect.value);
    }
  };
  query.addEventListener("input", draw);
  userSelect.addEventListener("change", draw);
  statusSelect.addEventListener("change", draw);
  stats.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".admin-user-card");
    if (!card) return;
    userSelect.value = userSelect.value === card.dataset.participantId ? "" : card.dataset.participantId || "";
    draw();
  });
  panel.append(
    stats,
    teamDistribution(data.items),
    el("div", { class: "admin-filters" }, query, userSelect, statusSelect),
    resultCount,
    list
  );
  draw();
}

// Team-wide spread across places and subjects. The backend sends metadata only,
// never browsing history or attachments, alongside the existing admin rows.
export function teamDistribution(items: readonly AdminSubmission[]): HTMLElement {
  const authored = items.map((item) => item.final?.metadata ?? item.original.metadata ?? {});
  const summary = summarizeDistribution(authored);
  const panel = el(
    "section",
    { class: "stat-group team-distribution" },
    el("h3", null, "Spread across the team")
  );

  if (!summary.labelled) {
    panel.append(
      el(
        "p",
        { class: "muted" },
        "No region or subject data has been recorded yet."
      )
    );
    return panel;
  }

  panel.append(
    el(
      "div",
      { class: "stat-cols" },
      shareGroup("By place", summary.regions, `${pct(summary.globalShare)} with no specific country`, "None recorded."),
      shareGroup("By subject", summary.subjects, `${summary.subjects.length} of 21 groups covered`, "None recorded.")
    ),
    ...(summary.unlabelled
      ? [el("p", { class: "muted small" }, `Based on ${summary.labelled} of ${items.length} submissions; the rest predate these fields.`)]
      : [])
  );
  return panel;
}

// The author's own spread of places and subjects. This is the only place a
// contributor can check the distribution guidance against their actual output —
// the reporting feed is team-wide and does not come back to them.
function distributionPanel(log: readonly UploadLogEntry[]): HTMLElement {
  const summary = summarizeDistribution(log.filter((e) => e.mode !== "review"));
  const panel = el(
    "section",
    { class: "stat-group distribution-panel" },
    el("div", { class: "admin-section-head" },
      el("div", null, el("p", { class: "eyebrow" }, "Your spread"), el("h3", null, "Places and subjects")),
      el("p", { class: "muted" }, "Aim for about a third or less from any one country, and about a third with no specific country.")
    )
  );

  if (!summary.labelled) {
    panel.append(
      el(
        "p",
        { class: "muted" },
        summary.unlabelled
          ? "Your recorded tasks were submitted before these fields existed, so there is nothing to chart yet. New tasks will appear here."
          : "Nothing yet — submit a task and your spread will appear here."
      )
    );
    return panel;
  }

  if (summary.advice) {
    panel.append(el("p", { class: "notice info distribution-advice" }, summary.advice));
  }

  panel.append(
    el(
      "div",
      { class: "stat-cols" },
      shareGroup(
        "By place",
        summary.regions,
        `${pct(summary.globalShare)} with no specific country`,
        "No regions recorded yet."
      ),
      shareGroup(
        "By subject",
        summary.subjects,
        `${summary.subjects.length} of 21 groups covered`,
        "No subjects recorded yet."
      )
    )
  );

  if (summary.unlabelled) {
    panel.append(
      el(
        "p",
        { class: "muted small" },
        `Based on ${summary.labelled} task${summary.labelled === 1 ? "" : "s"}. ${summary.unlabelled} earlier task${summary.unlabelled === 1 ? "" : "s"} predate these fields and are not counted.`
      )
    );
  }
  return panel;
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
              detailNote.textContent = "Detailed task history is only available for contributions recorded by this installation.";
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

    if (!log.length) {
      detailNote = el(
        "p",
        { class: "muted" },
        total > 0 || state.reviewedCount > 0
          ? "Detailed task history is only available for contributions recorded by this installation."
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

    body.append(distributionPanel(log));

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
