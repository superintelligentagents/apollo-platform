import { reviewLlmFeedback, reviewReject, reviewRelease, reviewSubmit, saveClaimSnapshot, seedRubrics, upgradeRubrics, type LlmReviewForHuman, type RubricRow } from "../../review-client";
import { el } from "../components/helpers";
import type { Ctx } from "../context";

export function plainReviewText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/\bfeasibility manager\b/gi, "overall check")
    .replace(/\blive[- ]web\b/gi, "website")
    .replace(/\brubrics\b/gi, "steps")
    .replace(/\brubric\b/gi, "step")
    .replace(/\bIMPOSSIBLE\b/g, "cannot be completed as written")
    .replace(/\brequires NOT_FEASIBLE\b/g, "means the task needs changes")
    .replace(/\bNOT_FEASIBLE\b/g, "the task needs changes")
    .replace(/\bFEASIBLE\b/g, "works online")
    .replace(/\bSHORTFALL\b/g, "could not be fully checked")
    .replace(/\bPOSSIBLE\b/g, "can be completed")
    .replace(/\bNEEDS_HUMAN_REVIEW\b/g, "needs a person to check")
    .replace(/\bcritical step[- ]?(\d+)\b/gi, "step $1")
    .replace(/\bverification shortfalls?\b/gi, "items Codex could not fully check")
    .replace(/\bessential step[- ]?(\d+) impossibility alone means the task needs changes\b/gi, "problem in step $1 means the task needs changes")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function conciseReviewText(value: string | null | undefined, maxChars = 220): string | null {
  const plain = plainReviewText(value);
  if (!plain) return null;
  const sentences = plain.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [plain];
  let concise = sentences.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
  if (concise.length <= maxChars) return concise;
  concise = concise.slice(0, maxChars - 1).replace(/\s+\S*$/, "").trimEnd();
  return `${concise}…`;
}

export function renderTaskReviewEdit(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const claim = state.reviewClaim;
  const root = el("section", { class: "screen pc-task-review-edit" });
  if (!claim) return el("section", { class: "screen" }, el("p", { class: "muted" }, "No task claimed."));
  const task = claim.task;
  if (!state.reviewEdits) state.reviewEdits = { title: task.task.task_title, request: task.task.agent_request, difficulty: task.task.difficulty, evergreenChecked: false };
  state.reviewRubrics = state.reviewRubrics ? upgradeRubrics(task, state.reviewRubrics) : seedRubrics(task);
  const edits = state.reviewEdits;
  const rubrics = state.reviewRubrics;
  const persist = () => void saveClaimSnapshot(ctx.adapter.storage, { claim, rubrics, edits });

  const lockLine = el("p", { class: "eyebrow mono pc-review-lock" });
  const lockWarning = el("p", { class: "lock-warning", hidden: true }, "Your 30-minute claim has expired. Another reviewer may now claim this task; submitting may fail.");
  const updateLock = () => {
    const msLeft = claim.lockTtlMs - (Date.now() - claim.claimedAtMs);
    const minutes = Math.max(0, Math.ceil(msLeft / 60_000));
    lockLine.textContent = msLeft > 0 ? `HUMAN TASK QC · ${minutes} min left on your claim` : "HUMAN TASK QC · claim expired";
    lockLine.classList.toggle("urgent", msLeft > 0 && minutes <= 5);
    lockWarning.hidden = msLeft > 0;
  };
  updateLock();
  const lockTimer = setInterval(() => {
    if (!document.contains(root)) { clearInterval(lockTimer); return; }
    updateLock();
  }, 30_000);

  root.append(el("header", { class: "screen-head" },
    lockLine,
    el("h2", { class: "display" }, "Review task"),
    el("p", { class: "screen-sub" }, "Review in two passes. Preserve the author's intent and only change what is needed."),
    el("div", { class: "pc-review-instructions", "aria-label": "Review instructions" },
      instruction("01", "Task prompt", "Read the full request. It should be clear, coherent, realistic, and possible at any later date."),
      instruction("02", "Rubrics", "Open every step. Confirm it fits the request, works on the live web, and gives a reviewer concrete evidence to check.")
    ),
    lockWarning
  ));

  let llm: LlmReviewForHuman | null = null;
  const llmSlot = el("div", { class: "pc-codex-slot" }, el("div", { class: "pc-codex-empty" }, el("strong", null, "Codex live check"), el("span", null, "Loading…")));
  const rubricList = el("div", { class: "pc-review-rubrics" });
  const approve = el("button", { class: "btn primary", type: "button", disabled: true }, "Approve task") as HTMLButtonElement;
  const evergreen = el("input", { type: "checkbox", checked: Boolean(edits.evergreenChecked), "aria-label": "Task is evergreen and remains feasible when run later" }) as HTMLInputElement;

  const syncApprove = () => {
    const complete = rubrics.some((row) => row.text.trim()) && rubrics.filter((row) => row.text.trim()).every((row) => row.checked);
    approve.disabled = !(complete && edits.evergreenChecked);
  };

  const drawRubrics = () => {
    rubricList.replaceChildren();
    rubrics.forEach((rubric, index) => {
      const number = (rubric.sourceIndex ?? index) + 1;
      const checked = el("input", { type: "checkbox", class: "pc-rubric-check", checked: rubric.checked, "aria-label": `Step ${number} verified`, onchange: (event: Event) => { rubric.checked = (event.target as HTMLInputElement).checked; persist(); syncApprove(); } });
      const editor = el("textarea", { class: "pc-rubric-text", rows: "4", "aria-label": `Step ${number} text` }) as HTMLTextAreaElement;
      editor.value = rubric.text;
      editor.oninput = () => { rubric.text = editor.value; rubric.checked = false; (checked as HTMLInputElement).checked = false; preview.textContent = rubric.text; persist(); syncApprove(); };
      const check = llm?.rubrics.find((item) => item.rubric_id === `rubric-${index + 1}`) ?? null;
      const attention = Boolean(check && (check.verdict !== "POSSIBLE" || (check.quality_verdict && check.quality_verdict !== "PASS")));
      const aligned = !check?.quality_verdict || check.quality_verdict === "PASS";
      const feasible = check?.verdict === "POSSIBLE";
      const preview = el("span", { class: "pc-rubric-preview" }, rubric.text);
      const summary = el("button", { class: "pc-rubric-summary", type: "button", "aria-expanded": "false" },
        el("span", { class: "pc-rubric-heading" }, `Step ${number}${rubric.title ? ` · ${rubric.title}` : ""}`,
          !check
            ? el("span", { class: "pc-codex-badge pending" }, "Codex not run")
            : el("span", { class: "pc-codex-badges" },
                el("span", { class: `pc-codex-badge ${aligned ? "pass" : "attention"}` }, aligned ? "Aligned" : "Alignment: review"),
                el("span", { class: `pc-codex-badge ${feasible ? "pass" : "attention"}` }, feasible ? "Feasible" : "Feasibility: review")
              )
        ),
        preview,
        el("span", { class: "pc-rubric-open" }, "Open & edit")
      ) as HTMLButtonElement;
      const details = el("div", { class: "pc-rubric-editor", hidden: true }, editor,
        check ? el("details", { class: `pc-codex-detail ${attention ? "attention" : "pass"}`, open: attention },
          el("summary", null, attention ? "What Codex found" : "What Codex verified"),
          ...(conciseReviewText(check.summary ?? check.feedback) ? [el("p", null, conciseReviewText(check.summary ?? check.feedback)!)] : []),
          ...(!aligned && conciseReviewText(check.quality_summary) ? [el("p", { class: "pc-codex-concern" }, conciseReviewText(check.quality_summary)!)] : []),
          ...(check.blockers ?? []).slice(0, 2).map((item) => el("p", { class: "pc-codex-concern" }, conciseReviewText(item) ?? item)),
          check.repair?.suggested_rubric_text && check.repair.verified_possible ? el("div", { class: "pc-codex-suggestion" }, el("p", null, check.repair.suggested_rubric_text), el("button", { class: "btn ghost small", type: "button", onclick: () => { rubric.text = check.repair!.suggested_rubric_text!; editor.value = rubric.text; preview.textContent = rubric.text; rubric.checked = false; persist(); syncApprove(); } }, "Use suggestion")) : null,
          (check.evidence ?? []).length ? el("details", { class: "pc-codex-evidence" }, el("summary", null, `Pages checked (${check.evidence.length})`), el("div", null, ...check.evidence.map((source) => el("a", { href: source.url, target: "_blank", rel: "noreferrer" }, source.title || source.url)))) : null
        ) : null,
        rubric.original ? el("details", { class: "pc-rubric-original" }, el("summary", null, "Show original"), el("p", null, rubric.original)) : null
      );
      summary.onclick = () => { const open = details.hidden; details.hidden = !open; summary.setAttribute("aria-expanded", String(open)); if (open) editor.focus(); };
      rubricList.append(el("article", { class: "pc-rubric-row" }, el("span", { class: "mono pc-rubric-num" }, `S${number}`), checked, el("div", { class: "pc-rubric-content" }, summary, details)));
    });
    rubricList.append(el("button", { class: "btn ghost small", type: "button", onclick: () => { const row: RubricRow = { text: "", original: null, checked: false, kind: task.task.steps?.length ? "step" : "criterion", sourceIndex: null, title: "Added step", seedVersion: 3 }; rubrics.push(row); persist(); drawRubrics(); } }, "+ Add a step"));
    syncApprove();
  };

  const request = el("textarea", { class: "field-input pc-full-request", rows: "10", "aria-label": "Full task request" }) as HTMLTextAreaElement;
  request.value = edits.request;
  request.oninput = () => { edits.request = request.value; request.style.height = "auto"; request.style.height = `${Math.max(220, request.scrollHeight + 2)}px`; persist(); };
  const evergreenField = el("label", { class: "pc-evergreen-check" }, evergreen, el("span", null, el("strong", null, "Still works later"), el("small", null, "The task can be completed at any later date; it does not depend on today's price, date, availability, or schedule.")));
  evergreen.onchange = () => { edits.evergreenChecked = evergreen.checked; persist(); syncApprove(); };
  drawRubrics();

  root.append(el("div", { class: "pc-task-review-grid" },
    el("section", { class: "pc-task-prompt-column", "aria-label": "Task prompt review" },
      el("div", { class: "field" }, el("span", { class: "field-label" }, "Full task request"), el("p", { class: "field-hint" }, "Read all of it. Edit only if a requirement is unclear or expires with time."), request),
      evergreenField,
      llmSlot
    ),
    el("section", { class: "pc-task-rubric-column", "aria-label": "Rubric review" }, el("span", { class: "field-label" }, "Rubrics"), el("p", { class: "field-hint" }, "Open each rubric, check feasibility and task fit, edit if needed, then check it off."), rubricList)
  ));

  const rejectReason = el("input", { class: "field-input", placeholder: "Why is this task unusable?" }) as HTMLInputElement;
  const reject = el("button", { class: "btn ghost danger-ghost", type: "button", onclick: async () => {
    if (rejectReason.hidden) { rejectReason.hidden = false; reject.textContent = "Confirm reject"; rejectReason.focus(); return; }
    if (rejectReason.value.trim().length < 3) return;
    (reject as HTMLButtonElement).disabled = true;
    try {
      await reviewReject(state.reviewKey!, ctx.actions.reviewerName(), claim, rejectReason.value.trim());
      ctx.actions.endReview("Task rejected with the reason saved.");
    } catch (error) {
      (reject as HTMLButtonElement).disabled = false;
      ctx.actions.notifyError(error instanceof Error ? error.message : String(error));
    }
  } }, "Reject task");
  rejectReason.hidden = true;
  approve.onclick = async () => {
    approve.disabled = true;
    approve.textContent = "Submitting…";
    try {
      await reviewSubmit(state.reviewKey!, ctx.actions.reviewerName(), claim, { title: edits.title, request: edits.request, difficulty: edits.difficulty, rubrics: rubrics.filter((row) => row.text.trim()), evergreenVerified: edits.evergreenChecked });
      ctx.actions.endReview("Task approved. Original and reviewed versions were saved.");
    } catch (error) {
      approve.textContent = "Approve task";
      syncApprove();
      ctx.actions.notifyError(error instanceof Error ? error.message : String(error));
    }
  };
  const release = el("button", { class: "btn ghost", type: "button", onclick: async () => {
    (release as HTMLButtonElement).disabled = true;
    await reviewRelease(state.reviewKey!, claim).catch(() => {});
    ctx.actions.endReview("Task released back to the queue.");
  } }, "Skip & release");
  root.append(el("div", { class: "pc-review-actions" }, rejectReason, reject, release, approve));

  if (state.reviewKey) void reviewLlmFeedback(state.reviewKey, claim).then((result) => {
    llm = result.review;
    if (!llm) llmSlot.replaceChildren(el("div", { class: "pc-codex-empty" }, el("strong", null, "Codex live check"), el("span", null, result.status === "stale" ? "The task changed after its last check. Review this version manually." : "Codex has not checked this task version yet.")));
    else {
      const coherence = llm.quality?.task_coherence ?? llm.quality?.prompt_quality ?? null;
      const qualityPass = coherence?.verdict === "PASS";
      const feasiblePass = llm.manager_disposition === "FEASIBLE";
      llmSlot.replaceChildren(el("details", { class: `pc-codex-overview ${qualityPass && feasiblePass ? "pass" : "attention"}`, open: true },
        el("summary", null, el("strong", null, "Codex live check"), el("span", null, qualityPass && feasiblePass ? "Looks good" : "Needs a look")),
        el("div", { class: "pc-codex-checks" },
          compactCheck("Coherent and high quality", qualityPass, conciseReviewText(coherence?.summary ?? llm.quality?.summary)),
          compactCheck("Feasible overall", feasiblePass, conciseReviewText(llm.manager_summary ?? llm.task_feedback))
        ),
        llm.task_repair?.suggested_task_prompt ? el("details", { class: "pc-codex-suggestion pc-task-suggestion" },
          el("summary", null, "Suggested task edit"),
          el("p", null, llm.task_repair.suggested_task_prompt),
          el("button", { class: "btn ghost small", type: "button", onclick: () => {
            edits.request = llm!.task_repair!.suggested_task_prompt;
            request.value = edits.request;
            request.style.height = "auto";
            request.style.height = `${Math.max(220, request.scrollHeight + 2)}px`;
            persist();
          } }, "Use suggestion")
        ) : null
      ));
    }
    drawRubrics();
  }).catch(() => llmSlot.replaceChildren(el("div", { class: "pc-codex-empty" }, el("strong", null, "Codex live check"), el("span", null, "Could not load. Continue with human review."))));
  requestAnimationFrame(() => { request.style.height = "auto"; request.style.height = `${Math.max(220, request.scrollHeight + 2)}px`; });
  return root;
}

function instruction(number: string, title: string, copy: string): HTMLElement {
  return el("div", null, el("span", { class: "mono" }, number), el("p", null, el("strong", null, title), ` — ${copy}`));
}

function compactCheck(label: string, passed: boolean, note: string | null): HTMLElement {
  return el("div", { class: `pc-codex-check ${passed ? "pass" : "attention"}` },
    el("span", { class: "pc-codex-check-mark", "aria-hidden": "true" }, passed ? "✓" : "!"),
    el("span", null, el("strong", null, label), ...(note ? [el("small", null, note)] : [])),
    el("b", null, passed ? "Yes" : "Review")
  );
}
