import type { Ctx } from "../context";
import { el } from "../components/helpers";
import {
  reviewLlmFeedback,
  reviewReject,
  reviewRelease,
  reviewSubmit,
  type LlmReviewForHuman,
  type RubricRow,
  seedRubrics,
  upgradeRubrics,
} from "../../review-client";
import { appendUploadLog, STORAGE_KEYS } from "../../platform";
import { participantKey } from "../identity";
import { saveClaimSnapshot } from "../../review-client";

/** Keep the reporting API exact while translating older pipeline prose for reviewers. */
export function plainReviewText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/\bthe feasibility manager marked this rubric IMPOSSIBLE because\b/gi, "This step needs attention because")
    .replace(/\brequires NOT_FEASIBLE\b/g, "means the task cannot be completed as written")
    .replace(/\bis not presently feasible\b/gi, "cannot currently be completed")
    .replace(/\bnot presently feasible\b/gi, "cannot currently be completed")
    .replace(/\bunresolved verification shortfalls\b/gi, "items the automated check could not fully verify")
    .replace(/\bessential step[\s‐‑‒–—-]?(\d+) impossibility\b/gi, "problem in step $1")
    .replace(/\bstep[‐‑‒–—-](\d+)\b/gi, "step $1")
    .replace(/\bcompatibility failed\b/gi, "the step does not fit the task")
    .replace(/\brubric compatibility\b/gi, "how the step fits the task")
    .replace(/\bfeasibility manager\b/gi, "overall check")
    .replace(/\bcoherence manager\b/gi, "task check")
    .replace(/\bPlaywright navigation to (?:all three )?(?:the )?supplied targets\b/gi, "opening the referenced websites")
    .replace(/\bbrowser escalation\b/gi, "website check")
    .replace(/\bPlaywright navigation\b/gi, "automated website check")
    .replace(/\bverifier[- ]access limitation\b/gi, "limitation of the automated check")
    .replace(/\bsupplied targets\b/gi, "websites")
    .replace(/\btarget pages\b/gi, "websites")
    .replace(/\bpage rendered\b/gi, "website loaded")
    .replace(/\bpre[- ]purchase path\b/gi, "booking path")
    .replace(/\blive[- ]web\b/gi, "website")
    .replace(/\brubrics\b/gi, "steps")
    .replace(/\brubric\b/gi, "step")
    .replace(/\bcompatibility\b/gi, "fit with the task")
    .replace(/\bcompatible with\b/gi, "consistent with")
    .replace(/\bcompatible\b/gi, "consistent")
    .replace(/\bdeterministically bounded\b/gi, "clearly limited")
    .replace(/\benumerable\b/gi, "possible to list completely")
    .replace(/\bNEEDS_HUMAN_REVIEW\b/g, "needs a person to check")
    .replace(/\bNOT_FEASIBLE\b/g, "cannot be completed as written")
    .replace(/\bFEASIBLE\b/g, "can be completed")
    .replace(/\bWORKER_ERROR\b/g, "could not be checked")
    .replace(/\bSHORTFALL\b/g, "could not be fully checked")
    .replace(/\bIMPOSSIBLE\b/g, "cannot be completed as written")
    .replace(/\bPOSSIBLE\b/g, "can be completed")
    .replace(/\bworker\b/gi, "check")
    .replace(/\bmanager\b/gi, "overall check")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function conciseReviewText(value: string | null | undefined, maxChars = 240): string | null {
  const plain = plainReviewText(value);
  if (!plain) return null;
  const sentences = plain.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [plain];
  let concise = sentences.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
  if (concise.length <= maxChars) return concise;
  concise = concise.slice(0, maxChars - 1).replace(/\s+\S*$/, "").trimEnd();
  return `${concise}…`;
}

function distinctReviewText(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = conciseReviewText(value);
    if (!text) return [];
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

export function renderReviewEdit(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen review-edit-screen" });
  const claim = state.reviewClaim;
  if (!claim) {
    root.append(el("p", { class: "muted" }, "No task claimed."));
    return root;
  }
  const task = claim.task;
  const usesStepRubrics = (task.task.steps?.some((step) => step.description?.trim()) ?? false);

  // Working copy in STATE, not locals — edits survive re-renders (notices,
  // back/forward) and are snapshotted for refresh-resume.
  if (!state.reviewEdits) {
    state.reviewEdits = {
      title: task.task.task_title,
      request: task.task.agent_request,
      difficulty: task.task.difficulty,
      evergreenChecked: false,
    };
  }
  const edits = state.reviewEdits;
  const rubrics: RubricRow[] = state.reviewRubrics ? upgradeRubrics(task, state.reviewRubrics) : seedRubrics(task);
  state.reviewRubrics = rubrics;
  const persist = () => void saveClaimSnapshot(ctx.adapter.storage, { claim, rubrics, edits });

  // Live lock countdown: static text goes stale, and a reviewer who runs past
  // the TTL deserves a warning before submit starts failing.
  const lockLine = el("p", { class: "eyebrow mono" });
  const expiryWarning = el(
    "p",
    { class: "lock-warning" },
    "Your 30-minute lock has expired — another reviewer may claim this task. Approve now, or skip."
  );
  expiryWarning.style.display = "none";
  const tickLock = () => {
    const msLeft = claim.lockTtlMs - (Date.now() - claim.claimedAtMs);
    const mins = Math.max(0, Math.ceil(msLeft / 60000));
    lockLine.textContent = `REVIEWING · ${task.mode.toUpperCase()} · ${msLeft > 0 ? `locked to you ${mins} min` : "lock expired"}`;
    const expired = msLeft <= 0;
    expiryWarning.style.display = expired ? "" : "none";
    if (!expired && mins <= 5) lockLine.classList.add("urgent");
  };
  tickLock(); // the screen isn't in the document yet — set the text directly
  const lockTimer = setInterval(() => {
    // Stop ticking once the user navigates away and this DOM is dropped.
    if (!document.contains(root)) {
      clearInterval(lockTimer);
      return;
    }
    tickLock();
  }, 30_000);

  root.append(
    el(
      "header",
      { class: "screen-head" },
      lockLine,
      el("h2", { class: "display" }, "Review task"),
      el(
        "p",
        { class: "screen-sub" },
        "Review the task in two short passes. Preserve the author's intent; only edit what must change."
      ),
      el(
        "div",
        { class: "review-instructions", "aria-label": "Review instructions" },
        el(
          "div",
          null,
          el("span", { class: "mono" }, "01"),
          el("p", null, el("strong", null, "Task prompt"), " — Read the full request. It should be clear, realistic, and possible at any later date without asking the author a question.")
        ),
        el(
          "div",
          null,
          el("span", { class: "mono" }, "02"),
          el("p", null, el("strong", null, "Rubrics"), " — Open every item. Confirm it fits the request, can be completed on the live web, and gives a reviewer something concrete to verify.")
        )
      ),
      expiryWarning
    )
  );

  let llmReview: LlmReviewForHuman | null = null;
  let requestEditor: HTMLTextAreaElement | null = null;
  let llmStatus: "loading" | "not_reviewed" | "pre_qc_passed" | "pre_qc_attention" | "stale" | "error" = "loading";
  const llmPanel = el("div", { class: "llm-preqc-slot" });
  const drawLlmPanel = () => {
    if (llmStatus === "loading") {
      llmPanel.replaceChildren(el("div", { class: "llm-preqc-loading" }, el("span", { class: "spinner-dot" }), "Loading the Codex live check…"));
      return;
    }
    if (!llmReview) {
      const copy = llmStatus === "stale"
        ? "This task changed after its last Codex check. Review this version yourself."
        : llmStatus === "error"
          ? "The Codex check could not be loaded. You can still review the task."
          : "Codex has not checked this version yet. No automated result is being hidden.";
      llmPanel.replaceChildren(el("div", { class: "llm-preqc-empty" }, el("strong", null, "Codex live check"), el("span", null, copy)));
      return;
    }
    const flagged = llmReview.rubrics.filter((rubric) =>
      rubric.verdict !== "POSSIBLE" || (rubric.quality_verdict !== null && rubric.quality_verdict !== "PASS")
    ).length;
    const overallPass = llmReview.status === "LLM_PASS";
    const coherence = llmReview.quality?.task_coherence ?? llmReview.quality?.prompt_quality ?? null;
    const taskClear = coherence?.verdict === "PASS";
    const websitesWork = llmReview.manager_disposition === "FEASIBLE";
    const taskNote = conciseReviewText(coherence?.summary ?? llmReview.quality?.summary);
    const websiteNote = conciseReviewText(llmReview.manager_summary);
    const extraNotes = websiteNote ? [] : distinctReviewText([llmReview.task_feedback]).filter((note) =>
      taskNote?.toLocaleLowerCase() !== note.toLocaleLowerCase()
    );
    const details = el(
      "details",
      { class: `llm-preqc-panel ${overallPass ? "pass" : "attention"}`, open: true },
      el(
        "summary",
        null,
        el(
          "span",
          { class: "llm-preqc-title" },
          el("strong", null, "Codex live check"),
          el("small", null, "Task quality, alignment, and feasibility")
        ),
        el(
          "span",
          { class: `badge ${overallPass ? "ok" : "warn"}` },
          overallPass ? "Looks good" : flagged > 0 ? `${flagged} step${flagged === 1 ? "" : "s"} need a look` : "Task needs a look"
        )
      ),
      el(
        "div",
        { class: "llm-preqc-body" },
        el(
          "div",
          { class: "codex-check-list" },
          el(
            "div",
            { class: `codex-check-item ${taskClear ? "pass" : "attention"}` },
            el("span", { class: "codex-check-mark", "aria-hidden": "true" }, taskClear ? "✓" : "!"),
            el("span", { class: "codex-check-copy" }, el("strong", null, "Coherent and high quality"), taskNote ? el("small", null, taskNote) : null),
            el("span", { class: "codex-check-result" }, taskClear ? "Yes" : "Needs a look")
          ),
          el(
            "div",
            { class: `codex-check-item ${websitesWork ? "pass" : "attention"}` },
            el("span", { class: "codex-check-mark", "aria-hidden": "true" }, websitesWork ? "✓" : "!"),
            el("span", { class: "codex-check-copy" }, el("strong", null, "Feasible overall"), websiteNote ? el("small", null, websiteNote) : null),
            el("span", { class: "codex-check-result" }, websitesWork ? "Yes" : "Needs a look")
          )
        ),
        ...extraNotes.slice(0, 1).map((note) => el("p", { class: "llm-task-feedback" }, note)),
        llmReview.task_repair
          ? el(
              "details",
              { class: "llm-repair task-repair" },
              el("summary", null, "Suggested task edit"),
              el("p", { class: "suggested-copy" }, llmReview.task_repair.suggested_task_prompt),
              el(
                "button",
                {
                  class: "btn ghost small",
                  type: "button",
                  onclick: () => {
                    if (!requestEditor || !llmReview?.task_repair) return;
                    edits.request = llmReview.task_repair.suggested_task_prompt;
                    requestEditor.value = edits.request;
                    requestEditor.style.height = "auto";
                    requestEditor.style.height = `${Math.max(220, requestEditor.scrollHeight + 2)}px`;
                    persist();
                  },
                },
                "Use this suggestion"
              )
            )
          : null,
        el("p", { class: "muted small codex-check-foot" }, "Use this as evidence, not the final decision. Nothing changes unless you apply a suggestion.")
      )
    );
    llmPanel.replaceChildren(details);
  };
  drawLlmPanel();

  const form = el("div", { class: "review-form" });

  // Request
  const reqArea = el("textarea", {
    class: "textarea review-request-editor",
    rows: "10",
    "aria-label": "Full task request",
    oninput: (e: Event) => {
      edits.request = (e.target as HTMLTextAreaElement).value;
      resizeRequestEditor();
      persist();
    },
  }) as HTMLTextAreaElement;
  reqArea.value = edits.request;
  requestEditor = reqArea;
  const resizeRequestEditor = () => {
    reqArea.style.height = "auto";
    reqArea.style.height = `${Math.max(220, reqArea.scrollHeight + 2)}px`;
  };
  const requestField =
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Full task request"),
      el("p", { class: "field-hint" }, "Read the complete request. Edit only if it is unclear, unrealistic, or tied to a date that will expire."),
      reqArea
    );
  requestAnimationFrame(resizeRequestEditor);

  // Rubrics
  const rubricList = el("div", { class: "rubric-list" });
  const expandedRubrics = new Set<RubricRow>();
  const approveBtn = el(
    "button",
    { class: "btn primary", type: "button", disabled: true },
    "Approve task"
  ) as HTMLButtonElement;

  const evergreenCheck = el("input", {
    type: "checkbox",
    checked: Boolean(edits.evergreenChecked),
    "aria-label": "Task is evergreen and remains feasible when run later",
    onchange: (event: Event) => {
      edits.evergreenChecked = (event.target as HTMLInputElement).checked;
      persist();
      syncApprove();
    },
  }) as HTMLInputElement;

  const syncApprove = () => {
    const substantive = rubrics.filter((r) => r.text.trim());
    const stepsVerified = substantive.length >= 1 && substantive.every((r) => r.checked);
    approveBtn.disabled = !(stepsVerified && edits.evergreenChecked);
    approveBtn.title = approveBtn.disabled
      ? substantive.length === 0
        ? "Write at least one rubric line first"
        : !stepsVerified
          ? "Check off every step first (rewrite any that need it)"
          : "Confirm the task is evergreen before approving"
      : "";
  };

  const drawRubrics = () => {
    rubricList.replaceChildren();
    // A task can arrive with no checklist at all (free-written, no criteria).
    // Say what to do instead of showing a bare disabled button.
    if (!rubrics.some((r) => r.text.trim())) {
      rubricList.append(
        el(
          "p",
          { class: "muted rubric-empty" },
          "This task came with no checklist. Write at least one rubric line — what, concretely, would prove an agent finished this task?"
        )
      );
    }
    rubrics.forEach((r, i) => {
      // Snapshots created by earlier builds did not carry source metadata.
      // Treat those rows as criteria so an in-flight review remains usable.
      r.kind ??= "criterion";
      if (r.sourceIndex === undefined) r.sourceIndex = r.kind === "criterion" ? i : null;
      r.title ??= null;
      r.seedVersion ??= 3;
      const rowNumber = (r.sourceIndex ?? i) + 1;
      const rowKind = "Step";
      const isEdited = () => r.original !== null && r.text.trim() !== r.original.trim();
      const check = el("input", {
        type: "checkbox",
        class: "rubric-check",
        checked: r.checked,
        "aria-label": `${rowKind} ${rowNumber} verified`,
        onchange: (e: Event) => {
          r.checked = (e.target as HTMLInputElement).checked;
          persist();
          syncApprove();
        },
      });
      const text = el("textarea", {
        class: "rubric-text",
        rows: "1",
        "aria-label": `${rowKind} ${rowNumber} text`,
        oninput: (e: Event) => {
          r.text = (e.target as HTMLTextAreaElement).value;
          // Editing un-verifies the row: what was checked isn't what's written now.
          if (r.checked) {
            r.checked = false;
            (check as HTMLInputElement).checked = false;
          }
          resizeEditor();
          preview.textContent = r.text || "Empty step — add a completion requirement";
          row.classList.toggle("edited", isEdited());
          changeNote.textContent = isEdited() ? "Edited from the original" : r.original === null ? "Added during review" : "Matches the original";
          persist();
          syncApprove();
        },
      }) as HTMLTextAreaElement;
      text.value = r.text;
      const resizeEditor = () => {
        text.style.height = "auto";
        text.style.height = `${Math.max(96, text.scrollHeight + 2)}px`;
      };
      const label = `Step ${rowNumber}${r.title ? ` · ${r.title}` : ""}`;
      const llm = llmReview?.rubrics.find((candidate) => candidate.rubric_id === `rubric-${i + 1}`) ?? null;
      const llmNeedsAttention = Boolean(
        llm && (llm.verdict !== "POSSIBLE" || (llm.quality_verdict !== null && llm.quality_verdict !== "PASS"))
      );
      const websitePass = llm?.verdict === "POSSIBLE";
      const taskFitPass = llm?.quality_verdict === null || llm?.quality_verdict === "PASS";
      const llmNotes = distinctReviewText([llm?.summary, llm?.feedback]);
      const taskFitNote = llm?.quality_verdict && llm.quality_verdict !== "PASS"
        ? conciseReviewText(llm.quality_summary)
        : null;
      const llmConcerns = distinctReviewText([...(llm?.quality_issues ?? []), ...(llm?.blockers ?? [])]).slice(0, 2);
      const preview = el("span", { class: "rubric-preview" }, r.text || "Empty step — add a completion requirement");
      const summary = el(
        "button",
        {
          class: "rubric-summary",
          type: "button",
          "aria-expanded": "false",
        },
        el(
          "span",
          { class: "rubric-kind" },
          label,
          llm
            ? el(
                "span",
                { class: "llm-rubric-badges", "aria-label": "Codex check results" },
                el("span", { class: `llm-rubric-badge status-${taskFitPass ? "ready" : "check"}` }, taskFitPass ? "Aligned" : "Alignment: review"),
                el("span", { class: `llm-rubric-badge status-${websitePass ? "ready" : "check"}` }, websitePass ? "Feasible" : "Feasibility: review")
              )
            : el("span", { class: "llm-rubric-badge status-pending" }, "Codex not run")
        ),
        preview,
        el("span", { class: "rubric-open-hint" }, "Open & edit")
      ) as HTMLButtonElement;
      const changeNote = el(
        "span",
        { class: "rubric-change-note" },
        isEdited() ? "Edited from the original" : r.original === null ? "Added during review" : "Matches the original"
      );
      const repairDetails = llm?.repair
        ? llm.repair.suggested_rubric_text && llm.repair.verified_possible
          ? el(
              "details",
              { class: "llm-repair" },
              el("summary", null, "Suggested fix"),
              el("p", { class: "suggested-copy" }, llm.repair.suggested_rubric_text),
              el(
                "button",
                {
                  class: "btn ghost small",
                  type: "button",
                  onclick: () => {
                    if (!llm.repair?.suggested_rubric_text) return;
                    r.text = llm.repair.suggested_rubric_text;
                    r.checked = false;
                    text.value = r.text;
                    (check as HTMLInputElement).checked = false;
                    resizeEditor();
                    preview.textContent = r.text;
                    changeNote.textContent = "Edited from the original";
                    text.closest(".rubric-row")?.classList.add("edited");
                    persist();
                    syncApprove();
                  },
                },
                "Use this suggestion"
              )
            )
          : llmNeedsAttention
            ? el(
                "details",
                { class: "llm-repair unresolved" },
                el("summary", null, "Why there isn't a suggested fix"),
                el("p", null, plainReviewText(llm.repair.reason) || "Codex could not find a small, safe change. Review this step yourself.")
              )
            : null
        : null;
      const removeButton = el(
        "button",
        {
          class: "btn ghost tiny rubric-remove",
          type: "button",
          title: "Remove this step",
          "aria-label": `Remove step ${rowNumber}`,
          onclick: () => {
            expandedRubrics.delete(r);
            rubrics.splice(i, 1);
            persist();
            drawRubrics();
          },
        },
        "Remove"
      );
      const editor = el(
        "div",
        { class: "rubric-editor" },
        text,
        ...(llm
          ? [el(
              "details",
              { class: `llm-rubric-detail verdict-${llm.verdict.toLowerCase()}`, open: llmNeedsAttention },
              el(
                "summary",
                { class: "llm-rubric-detail-head" },
                el("strong", null, llmNeedsAttention ? "Codex found something to review" : "What Codex verified"),
                el("span", { class: `llm-rubric-badge status-${llmNeedsAttention ? "check" : "ready"}` }, llmNeedsAttention ? "Needs a look" : "Looks good")
              ),
              el(
                "div",
                { class: "llm-rubric-detail-body" },
                ...llmNotes.map((note) => el("p", null, note)),
                taskFitNote
                  ? el("div", { class: "llm-simple-note" }, el("strong", null, "Alignment"), el("p", null, taskFitNote))
                  : null,
                llmConcerns.length
                  ? el(
                      "div",
                      { class: "llm-simple-note attention" },
                      el("strong", null, "What may block the agent"),
                      el("ul", null, ...llmConcerns.map((concern) => el("li", null, concern)))
                    )
                  : null,
                repairDetails,
                llm.evidence.length
                  ? el(
                      "details",
                      { class: "llm-pages-checked" },
                      el("summary", null, `Pages checked (${llm.evidence.length})`),
                      el("div", { class: "llm-evidence-links" }, ...llm.evidence.map((source) => el("a", { href: source.url, target: "_blank", rel: "noreferrer" }, source.title || source.url)))
                    )
                  : null
              )
            )]
          : []),
        el(
          "div",
          { class: "rubric-editor-meta" },
          changeNote,
          el(
            "div",
            { class: "rubric-editor-actions" },
            ...(r.original !== null
              ? [el("details", { class: "rubric-original" }, el("summary", null, "Show original"), el("p", null, r.original))]
              : []),
            removeButton
          )
        )
      );
      const setExpanded = (expanded: boolean) => {
        row.classList.toggle("expanded", expanded);
        summary.setAttribute("aria-expanded", String(expanded));
        editor.hidden = !expanded;
        if (expanded) {
          expandedRubrics.add(r);
          requestAnimationFrame(() => {
            resizeEditor();
            text.focus();
            text.setSelectionRange(text.value.length, text.value.length);
          });
        } else {
          expandedRubrics.delete(r);
        }
      };
      summary.onclick = () => setExpanded(!expandedRubrics.has(r));
      const row = el(
        "div",
        { class: `rubric-row ${isEdited() ? "edited" : ""}` },
        el("span", { class: "rubric-num mono" }, `S${rowNumber}`),
        check,
        el("div", { class: "rubric-content" }, summary, editor)
      );
      setExpanded(expandedRubrics.has(r));
      rubricList.append(row);
    });
    rubricList.append(
      el(
        "button",
        {
          class: "btn ghost small",
          type: "button",
          onclick: () => {
            const added: RubricRow = {
              text: "",
              original: null,
              checked: false,
              kind: usesStepRubrics ? "step" : "criterion",
              sourceIndex: null,
              title: usesStepRubrics ? "Added step" : null,
              seedVersion: 3,
            };
            rubrics.push(added);
            expandedRubrics.add(added);
            persist();
            drawRubrics();
          },
        },
        "+ Add a step"
      )
    );
    syncApprove();
  };
  drawRubrics();

  const evergreenField = el(
    "label",
    { class: "review-evergreen-check" },
    evergreenCheck,
    el(
      "span",
      null,
      el("strong", null, "Still works later"),
      el("small", null, "The task can be completed at any later date; it does not depend on today's price, date, availability, or schedule.")
    )
  );
  const rubricField = el(
    "div",
    { class: "field" },
    el("span", { class: "field-label" }, "Rubrics"),
    el("p", { class: "field-hint" }, "Open each rubric. Check live-web feasibility and task fit, edit if needed, then check it off."),
    rubricList
  );
  form.append(
    el("section", { class: "review-request-column", "aria-label": "Task prompt review" }, requestField, evergreenField, llmPanel),
    el("section", { class: "review-rubrics-column", "aria-label": "Rubric review" }, rubricField)
  );

  // Reject: for tasks with no salvageable intent. Two-step (button reveals a
  // reason row) so one misclick can't discard someone's submission.
  const rejectReason = el("input", {
    class: "input reject-reason",
    type: "text",
    placeholder: "Explain why this task is unusable; this reason is kept on record.",
    oninput: () => {
      rejectConfirm.disabled = rejectReason.value.trim().length < 3;
    },
  }) as HTMLInputElement;
  const rejectConfirm = el(
    "button",
    {
      class: "btn danger",
      type: "button",
      onclick: async () => {
        rejectConfirm.disabled = true;
        rejectConfirm.textContent = "Rejecting…";
        try {
          await reviewReject(state.reviewKey!, ctx.actions.reviewerName(), claim, rejectReason.value.trim());
          if (state.identity) {
            const owner = participantKey(state.identity);
            state.reviewedCount += 1;
            await Promise.allSettled([
              ctx.adapter.storage.set(STORAGE_KEYS.reviewCount(owner), String(state.reviewedCount)),
              appendUploadLog(ctx.adapter.storage, owner, {
                task_id: claim.task.task_id,
                title: `Rejected: ${edits.title}`,
                mode: "review",
                level: edits.difficulty,
                at: new Date().toISOString(),
              }),
            ]);
          }
          ctx.actions.endReview("Rejected — removed from the queue, reason on record.");
        } catch (err) {
          ctx.actions.notifyError(err instanceof Error ? err.message : String(err));
          rejectConfirm.disabled = false;
          rejectConfirm.textContent = "Confirm reject";
        }
      },
    },
    "Confirm reject"
  ) as HTMLButtonElement;
  rejectConfirm.disabled = true;
  const rejectRow = el("div", { class: "reject-row" }, rejectReason, rejectConfirm);
  rejectRow.style.display = "none";
  const rejectBtn = el(
    "button",
    {
      class: "btn ghost danger-ghost",
      type: "button",
      onclick: () => {
        const showing = rejectRow.style.display !== "none";
        rejectRow.style.display = showing ? "none" : "";
        rejectBtn.textContent = showing ? "Reject task" : "Cancel";
        if (!showing) rejectReason.focus();
      },
    },
    "Reject task"
  ) as HTMLButtonElement;

  // Actions
  const skipBtn = el(
    "button",
    {
      class: "btn ghost",
      type: "button",
      onclick: async () => {
        skipBtn.disabled = true;
        try {
          await reviewRelease(state.reviewKey!, claim);
        } catch {
          // lock will expire on its own — still leave the screen
        }
        ctx.actions.endReview("Task released back to the queue.");
      },
    },
    "Skip"
  ) as HTMLButtonElement;

  approveBtn.onclick = async () => {
    approveBtn.disabled = true;
    approveBtn.textContent = "Submitting…";
    try {
      await reviewSubmit(state.reviewKey!, ctx.actions.reviewerName(), claim, {
        title: edits.title,
        request: edits.request,
        difficulty: edits.difficulty,
        rubrics: rubrics.filter((r) => r.text.trim()),
        evergreenVerified: Boolean(edits.evergreenChecked),
      });
      // Same identity system as submitting: reviews earn credit in the same
      // per-person log the progress screen reads. Stats failure must never
      // read as a review failure — the task is already in the finished set.
      if (state.identity) {
        const owner = participantKey(state.identity);
        state.reviewedCount += 1;
        await Promise.allSettled([
          ctx.adapter.storage.set(STORAGE_KEYS.reviewCount(owner), String(state.reviewedCount)),
          appendUploadLog(ctx.adapter.storage, owner, {
            task_id: claim.task.task_id,
            title: edits.title,
            mode: "review",
            level: edits.difficulty,
            at: new Date().toISOString(),
          }),
        ]);
      }
      ctx.actions.endReview("Approved — task added to the finished set. Claim another?");
    } catch (err) {
      ctx.actions.notifyError(err instanceof Error ? err.message : String(err));
      approveBtn.textContent = "Approve task";
      syncApprove();
    }
  };

  form.append(el("div", { class: "form-actions review-actions" }, rejectBtn, skipBtn, approveBtn), rejectRow);
  root.append(form);
  void reviewLlmFeedback(state.reviewKey!, claim)
    .then((result) => {
      llmStatus = result.status;
      llmReview = result.review;
      drawLlmPanel();
      drawRubrics();
    })
    .catch(() => {
      llmStatus = "error";
      drawLlmPanel();
    });
  return root;
}
