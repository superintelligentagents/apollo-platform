import type { Cluster, ParticipantIdentity, ProfileOption, TaskMode, ThemeSuggestion } from "../types";
import type { PlatformAdapter } from "../platform";
import {
  addProcessedFingerprints,
  appendUploadLog,
  loadProcessedFingerprints,
  loadReviewCount,
  loadUploadCount,
  loadUploadLog,
  STORAGE_KEYS,
} from "../platform";
import { participantKey, sessionKey } from "./identity";
import { prepareJourneys, clusterStart } from "../clustering";
import { suggestThemes } from "../themes";
import {
  deriveSiteScope,
  participantId as schemaParticipantId,
  sourceJourneyFromCluster,
  serializeLongTask,
  truncateForUpload,
  validateLongTask,
} from "../schema";
import { defaultReviewKey, LONG_TASK_FILENAME } from "../config";
import {
  BLANK_TEMPLATE,
  JOURNEYS_TEMPLATE,
  MIN_STEP_LENGTH,
  requiredOutputsForDeliverable,
  substantiveSteps,
  TASK_TEMPLATES,
  type TaskTemplate,
} from "../templates";
import { FREEFORM_SCAFFOLD } from "../drafts";
import { applyDraftState, isWorthSaving, serializeDraftState, type SavedDraft } from "./autosave";
import { emptyDraft, initialState, type AppState, type Ctx, type Screen } from "./context";
import { buildPendingTask } from "./pending";
import { el } from "./components/helpers";
import { renderLogin } from "./screens/login";
import { renderHome, renderSubmitHub } from "./screens/home";
import { renderHistory } from "./screens/history";
import { renderCompose } from "./screens/compose";
import { renderThemes } from "./screens/themes";
import { renderGuided } from "./screens/guided";
import { renderForm } from "./screens/form";
import { renderReview } from "./screens/review";
import { renderExamples } from "./screens/examples";
import { renderProgress } from "./screens/progress";
import { renderReviewQueue } from "./screens/review-queue";
import { renderReviewEdit } from "./screens/review-edit";
import { renderTrajectoryQueue } from "./screens/trajectory-queue";
import { renderTrajectoryEdit } from "./screens/trajectory-edit";
import {
  clearClaimSnapshot,
  clearTrajectoryClaimSnapshot,
  contributionStatus,
  saveClaimSnapshot,
  saveTrajectoryClaimSnapshot,
  seedTrajectoryJudgment,
  type ReviewClaim,
  type TrajectoryClaim,
} from "../review-client";

const SCREEN_PATH: Record<Screen, string> = {
  login: "/",
  home: "/home",
  submit: "/submit",
  progress: "/progress",
  "review-queue": "/review-queue",
  "review-edit": "/review-task",
  "trajectory-queue": "/trajectory-review",
  "trajectory-edit": "/trajectory-judge",
  history: "/load-history",
  compose: "/pick-journeys",
  themes: "/themes",
  guided: "/write",
  form: "/describe",
  review: "/review",
  examples: "/examples",
};

export function screenFromHash(hash: string): Screen | null {
  const path = hash.replace(/^#/, "") || "/";
  const match = (Object.entries(SCREEN_PATH) as [Screen, string][]).find(([, screenPath]) => screenPath === path);
  return match?.[0] ?? null;
}

export function mountApp(root: HTMLElement, adapter: PlatformAdapter): void {
  const state: AppState = initialState();
  let requestedScreenOnLogin = typeof window === "undefined" ? null : screenFromHash(window.location.hash);
  // Reviewing is automatic for team builds: the key ships in the bundle and
  // the lambda still verifies it on every call. No manual entry, ever.
  state.reviewKey = defaultReviewKey();

  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  function flushAutosave() {
    if (!state.identity) return;
    const key = STORAGE_KEYS.draftAutosave(participantKey(state.identity));
    if (isWorthSaving(state)) {
      adapter.storage.set(key, JSON.stringify(serializeDraftState(state, new Date().toISOString()))).catch(() => {});
    } else if (state.mode) {
      // The user emptied their work: don't let a stale richer snapshot
      // resurrect text they deliberately deleted.
      adapter.storage.set(key, "").catch(() => {});
    }
  }
  // Clears the saved draft. Must work from the LOGIN screen too ("Start
  // fresh"), where identity is not set yet — the draft belongs to the
  // last-used identity there.
  function clearAutosave() {
    const owner = state.identity ?? state.lastIdentity;
    if (!owner) return;
    adapter.storage.set(STORAGE_KEYS.draftAutosave(participantKey(owner)), "").catch(() => {});
  }

  const ctx: Ctx = {
    state,
    adapter,
    update(patch) {
      Object.assign(state, patch);
    },
    rerender() {
      render();
    },
    autosave() {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(flushAutosave, 400);
    },
    actions: {
      async login(identity: ParticipantIdentity) {
        state.identity = identity;
        state.busy = null;
        adapter.storage.set(STORAGE_KEYS.lastIdentity, JSON.stringify(identity)).catch(() => {});
        const owner = participantKey(identity);
        const cloudCounts = state.reviewKey
          ? contributionStatus(state.reviewKey, schemaParticipantId(identity), identity.name).catch(() => null)
          : Promise.resolve(null);
        const [processed, storedUploads, storedReviews, log] = await Promise.all([
          loadProcessedFingerprints(adapter.storage, owner),
          loadUploadCount(adapter.storage, owner, sessionKey(identity)),
          loadReviewCount(adapter.storage, owner),
          loadUploadLog(adapter.storage, owner),
        ]);
        state.processed = processed;
        const loggedUploads = log.filter((entry) => entry.mode !== "review").length;
        const loggedReviews = log.filter((entry) => entry.mode === "review").length;
        state.uploadedCount = Math.max(storedUploads, loggedUploads);
        state.reviewedCount = Math.max(storedReviews, loggedReviews);
        // Offer Resume AFTER login, on home — never on the login screen.
        const savedDraft = await adapter.storage.get(STORAGE_KEYS.draftAutosave(participantKey(identity))).catch(() => null);
        state.hasResumableDraft = !!(savedDraft && savedDraft.length > 2);
        const destination = requestedScreenOnLogin ?? "home";
        requestedScreenOnLogin = null;
        goto(destination);
        // Reconcile across web and desktop after the local-first login has
        // rendered. A network failure leaves the durable local totals intact.
        void cloudCounts.then((counts) => {
          if (!counts || !state.identity || participantKey(state.identity) !== owner) return;
          state.uploadedCount = Math.max(state.uploadedCount, counts.submitted);
          state.reviewedCount = Math.max(state.reviewedCount, counts.reviewed);
          void Promise.allSettled([
            adapter.storage.set(STORAGE_KEYS.uploadCount(owner, sessionKey(identity)), String(state.uploadedCount)),
            adapter.storage.set(STORAGE_KEYS.reviewCount(owner), String(state.reviewedCount)),
          ]);
          render();
        });
      },
      async resumeDraft() {
        // Runs AFTER login: restore the current identity's saved draft.
        const identity = state.identity;
        if (!identity) return;
        const raw = await adapter.storage.get(STORAGE_KEYS.draftAutosave(participantKey(identity))).catch(() => null);
        if (!raw) return;
        let saved: SavedDraft;
        try {
          saved = JSON.parse(raw) as SavedDraft;
        } catch {
          return;
        }
        state.hasResumableDraft = false;
        const template = saved.activeTemplateId
          ? TASK_TEMPLATES.find((t) => t.id === saved.activeTemplateId) ??
            (saved.activeTemplateId === BLANK_TEMPLATE.id
              ? BLANK_TEMPLATE
              : saved.activeTemplateId === JOURNEYS_TEMPLATE.id
                ? JOURNEYS_TEMPLATE
                : null)
          : null;
        const destRaw = applyDraftState(state, saved, template);
        const dest = (destRaw in SCREEN_PATH ? destRaw : "home") as Screen;
        if ((saved.mode === "compose" || saved.mode === "theme") && !state.basket.length) {
          state.pendingBasketFingerprints = saved.basketFingerprints;
          notify("Your task text is back. Reload your history to re-attach the journeys.", "info");
        }
        goto(reachableScreen(dest));
      },
      async discardDraft() {
        clearAutosave();
        state.hasResumableDraft = false;
        render();
      },
      goto,
      startMode(mode: TaskMode) {
        state.mode = mode;
        state.afterHistory = null;
        state.basket = [];
        state.keyUrls = [];
        state.attachedUrls = [];
        state.activeTheme = null;
        state.removedFromTheme = [];
        state.activeTemplate = null;
        state.guidedIntro = "";
        state.guidedDeliverable = "doc";
        state.guidedSteps = [];
        state.guidedCustomDeliverable = "";
        state.generatedDraft = null;
        state.draft = emptyDraft();
        state.draftBasketKey = "";
        state.lastDraftTitle = "";
        state.scopeDirty = false;
        state.domainsDirty = false;
        state.requestDirty = false;
        state.pendingTaskId = null;
        state.pendingCreatedAt = null;
        state.formErrors = {};
        if (mode === "guided") {
          state.activeTemplate = BLANK_TEMPLATE;
          state.guidedSteps = BLANK_TEMPLATE.steps.map((s, i) => ({ order: i, title: s.title, description: "" }));
          goto("guided");
          return;
        }
        if (mode === "freeform") {
          // Fill-in-the-blanks beats a blank page.
          state.draft.agent_request = FREEFORM_SCAFFOLD;
          state.generatedDraft = FREEFORM_SCAFFOLD;
          goto("form");
          return;
        }
        if (!state.historyLoaded) {
          state.afterHistory = mode === "theme" ? "themes" : "compose";
          goto("history");
          return;
        }
        if (mode === "theme") {
          ensureSuggestions();
          goto("themes");
          return;
        }
        goto("compose");
      },
      async detectProfiles() {
        state.busy = "Looking for profiles…";
        render();
        try {
          state.profiles = await adapter.detectProfiles();
        } catch (err) {
          state.profiles = [];
          notify(`Could not read profiles: ${message(err)}`, "err");
        } finally {
          state.busy = null;
          render();
        }
      },
      async loadHistory(source: ProfileOption | File | "chrome-extension") {
        state.busy = "Reading history on this device…";
        render();
        try {
          if (source !== "chrome-extension" && !(source instanceof File)) state.selectedProfilePath = source.path;
          const raw = await adapter.loadClusters(source);
          state.journeys = prepareJourneys(raw, state.processed);
          state.historyLoaded = true;
          state.suggestions = null;
          // Rehydrate a resumed task's basket from its saved fingerprints.
          if (state.pendingBasketFingerprints.length) {
            const want = new Set(state.pendingBasketFingerprints);
            const byFp = new Map(state.journeys.map((c) => [c.fingerprint || "", c]));
            state.basket = [...want].map((fp) => byFp.get(fp)).filter((c): c is NonNullable<typeof c> => !!c);
            state.pendingBasketFingerprints = [];
            if (state.basket.length) {
              notify(`Re-attached ${state.basket.length} journey${state.basket.length === 1 ? "" : "s"} to your task.`, "ok");
            }
          }
          if (!state.journeys.length) {
            notify("History loaded, but no new journeys were found (already-used sessions are hidden).", "info");
          } else if (state.afterHistory) {
            // The user came here on the way to a mode — take them straight there.
            const dest = state.afterHistory;
            state.afterHistory = null;
            state.busy = null;
            goto(dest);
            return;
          }
        } catch (err) {
          state.historyLoaded = false;
          notify(
            adapter.platform === "web"
              ? `Couldn't parse that file — quit Chrome (or copy the History file) and try again. (${message(err)})`
              : `Couldn't read history: ${message(err)}`,
            "err"
          );
        } finally {
          state.busy = null;
          render();
        }
      },
      pickTemplate(template: TaskTemplate) {
        state.activeTemplate = template;
        state.guidedSteps = template.steps.map((s, i) => ({ order: i, title: s.title, description: "" }));
        state.formErrors = {};
        render();
      },
      finishGuided() {
        // Touched-but-short steps must not vanish silently: either finish the
        // sentence or clear the step.
        const tooShort = state.guidedSteps.filter((s) => {
          const len = s.description.trim().length;
          return len > 0 && len < MIN_STEP_LENGTH;
        });
        if (tooShort.length) {
          state.formErrors = {
            steps: `Almost — give ${tooShort.map((s) => `“${s.title.trim() || "Untitled"}”`).join(", ")} a full sentence, or clear ${tooShort.length === 1 ? "it" : "them"}.`,
          };
          notify("A step needs a few more words (or clear it).", "err");
          render();
          return;
        }
        const steps = substantiveSteps(state.guidedSteps);
        if (steps.length < 1) {
          state.formErrors = { steps: "Fill in at least one substep — a sentence is enough." };
          notify("Add a sentence to one of the steps first.", "err");
          render();
          return;
        }
        state.formErrors = {};
        state.guidedSteps = steps;
        state.draft.required_outputs = requiredOutputsForDeliverable(
          state.guidedDeliverable,
          state.guidedCustomDeliverable
        );
        // The request and steps now share one page. Preserve exactly what the
        // author wrote instead of rebuilding it from the step descriptions.
        state.generatedDraft = null;
        if (!ctx.actions.continueToReview()) {
          render();
          document.querySelector(".field-error:not(:empty)")?.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      },
      pickTheme(theme: ThemeSuggestion) {
        // A different theme is a different project — stale steps from the
        // previous theme must not ship with this one's provenance.
        if (state.activeTheme && state.activeTheme.theme_id !== theme.theme_id) {
          state.guidedSteps = [];
          state.guidedIntro = "";
        }
        const wanted = new Set(theme.cluster_fingerprints);
        state.basket = state.journeys
          .filter((c) => wanted.has(c.fingerprint || ""))
          .sort((a, b) => (clusterStart(a) || "").localeCompare(clusterStart(b) || ""));
        state.activeTheme = theme;
        state.removedFromTheme = [];
        state.mode = "theme";
        goto("compose");
      },
      toggleJourney(c: Cluster) {
        const fp = c.fingerprint || "";
        const idx = state.basket.findIndex((b) => b.fingerprint === fp);
        if (idx >= 0) {
          state.basket.splice(idx, 1);
          if (state.activeTheme?.cluster_fingerprints.includes(fp) && !state.removedFromTheme.includes(fp)) {
            state.removedFromTheme.push(fp);
          }
          // Selected key URLs from a removed journey must not linger in the
          // payload (unless another selected journey still contains them).
          state.keyUrls = state.keyUrls.filter(
            (u) =>
              !c.visits.some((v) => v.url === u) ||
              state.basket.some((b) => b.visits.some((v) => v.url === u))
          );
        } else {
          state.basket.push(c);
          state.removedFromTheme = state.removedFromTheme.filter((f) => f !== fp);
        }
      },
      clearBasket() {
        for (const c of state.basket) {
          const fp = c.fingerprint || "";
          if (fp && state.activeTheme?.cluster_fingerprints.includes(fp) && !state.removedFromTheme.includes(fp)) {
            state.removedFromTheme.push(fp);
          }
        }
        state.basket = [];
        state.keyUrls = [];
      },
      moveJourney(index: number, delta: number) {
        const target = index + delta;
        if (target < 0 || target >= state.basket.length) return;
        const [item] = state.basket.splice(index, 1);
        state.basket.splice(target, 0, item);
      },
      removeJourney(index: number) {
        const [removed] = state.basket.splice(index, 1);
        const fp = removed?.fingerprint || "";
        if (fp && state.activeTheme?.cluster_fingerprints.includes(fp) && !state.removedFromTheme.includes(fp)) {
          state.removedFromTheme.push(fp);
        }
        // Drop a selected key URL only if no remaining journey still contains it.
        state.keyUrls = state.keyUrls.filter(
          (u) =>
            !removed?.visits.some((v) => v.url === u) ||
            state.basket.some((c) => c.visits.some((v) => v.url === u))
        );
      },
      continueToForm() {
        // Keep site chips in sync with the basket (including clearing them
        // when everything was removed) until the user edits chips by hand.
        if (!state.scopeDirty) {
          const pseudo = state.basket.map((c, i) => sourceJourneyFromCluster(c, i, []));
          state.draft.site_scope = state.basket.length ? deriveSiteScope(pseudo).slice(0, 6) : [];
        }
        // Journey-backed tasks go through the same free-form step builder as
        // writing your own; the selected journeys ride along as a reference
        // rail. Seed the generic steps once — never clobber written ones.
        if ((state.mode === "compose" || state.mode === "theme") && state.basket.length) {
          if (state.guidedSteps.every((st) => !st.description.trim())) {
            state.guidedSteps = JOURNEYS_TEMPLATE.steps.map((s, i) => ({ order: i, title: s.title, description: "" }));
          }
          state.activeTemplate = JOURNEYS_TEMPLATE;
          goto("guided");
          return;
        }
        state.activeTemplate = state.activeTemplate ?? BLANK_TEMPLATE;
        if (!state.guidedSteps.length) {
          state.guidedSteps = BLANK_TEMPLATE.steps.map((s, i) => ({ order: i, title: s.title, description: "" }));
        }
        goto("guided");
      },
      continueToReview(): boolean {
        const task = buildPendingTask(ctx);
        if (!task) return false;
        const result = validateLongTask(task);
        if (!result.valid) {
          state.formErrors = result.errors;
          notify("A few fields need attention.", "err");
          return false;
        }
        state.formErrors = {};
        state.notice = null;
        goto("review");
        return true;
      },
      setReviewKey(key: string | null) {
        state.reviewKey = key;
        adapter.storage.set(STORAGE_KEYS.reviewKey, key ?? "").catch(() => {});
      },
      reviewerName() {
        const id = state.identity;
        if (!id) return "unknown";
        return id.name || id.email;
      },
      reviewerPid() {
        // Matches the participant id used for this person's own uploads, so
        // the server can refuse to hand them their own submissions to review.
        const id = state.identity;
        if (!id) return "";
        return schemaParticipantId(id);
      },
      startReview(claim: ReviewClaim) {
        state.reviewClaim = claim;
        state.reviewRubrics = null; // review-edit seeds from the task
        state.reviewEdits = null;
        void saveClaimSnapshot(adapter.storage, { claim, rubrics: null, edits: null });
        goto("review-edit");
      },
      endReview(msg: string) {
        state.reviewClaim = null;
        state.reviewRubrics = null;
        state.reviewEdits = null;
        void clearClaimSnapshot(adapter.storage);
        notify(msg, "ok");
        goto("review-queue");
      },
      startTrajectoryReview(claim: TrajectoryClaim) {
        const judgment = seedTrajectoryJudgment(claim.run);
        state.trajectoryClaim = claim;
        state.trajectoryJudgment = judgment;
        void saveTrajectoryClaimSnapshot(adapter.storage, { claim, judgment });
        goto("trajectory-edit");
      },
      endTrajectoryReview(msg: string) {
        state.trajectoryClaim = null;
        state.trajectoryJudgment = null;
        void clearTrajectoryClaimSnapshot(adapter.storage);
        notify(msg, "ok");
        goto("trajectory-queue");
      },
      notifyInfo(msg: string) {
        notify(msg, "info");
        render(); // notices only exist in the DOM after a render
      },
      notifyError(msg: string) {
        notify(msg, "err");
        render();
      },
      async uploadTask() {
        if (state.busy) return;
        const identity = state.identity;
        const built = buildPendingTask(ctx);
        if (!identity || !built) return;
        // Validate here as well as on the way in. Reaching this screen is not
        // proof of having passed validation: a draft autosaved on the review
        // screen resumes straight back to it, skipping the authoring screen and
        // its gate. Without this, a draft saved before a field existed uploads
        // with that field empty.
        const check = validateLongTask(built);
        if (!check.valid) {
          // Navigate first: transition() clears formErrors on the way into a
          // screen, so errors set before the goto would be wiped and the author
          // would land on the editor with nothing marked.
          goto("guided");
          state.formErrors = check.errors;
          notify("A few fields need attention before this can be submitted.", "err");
          render();
          document.querySelector(".field-error:not(:empty)")?.scrollIntoView({ block: "center" });
          return;
        }
        const { task } = truncateForUpload(built);
        state.busy = "Submitting…";
        render();
        try {
          await adapter.uploadJson({
            taskId: task.task_id,
            filename: LONG_TASK_FILENAME,
            body: serializeLongTask(task),
            participantId: task.participant.participant_id,
            studyId: task.participant.session_id ?? "internal",
          });
        } catch (err) {
          notify(`Couldn't submit: ${message(err)}`, "err");
          state.busy = null;
          render();
          return;
        }
        // S3 accepted the task, so count it immediately. Each local record is
        // persisted independently: a history-fingerprint failure can no longer
        // leave a successful submission showing as zero.
        const owner = participantKey(identity);
        state.uploadedCount += 1;
        const usedFps = state.basket.map((c) => c.fingerprint || "").filter(Boolean);
        if (usedFps.length) {
          for (const fp of usedFps) state.processed.add(fp);
          state.journeys = state.journeys.filter((c) => !state.processed.has(c.fingerprint || ""));
          state.suggestions = null;
        }
        const saved = await Promise.allSettled([
          adapter.storage.set(STORAGE_KEYS.uploadCount(owner, sessionKey(identity)), String(state.uploadedCount)),
          appendUploadLog(adapter.storage, owner, {
            task_id: task.task_id,
            title: task.task.task_title,
            mode: task.mode,
            level: task.task.difficulty,
            strength: task.quality_signals?.strength,
            score: task.quality_signals?.score,
            at: task.created_at,
            region: task.task.metadata?.region,
            subjects: task.task.metadata?.subjects,
          }),
          usedFps.length ? addProcessedFingerprints(adapter.storage, owner, usedFps) : Promise.resolve(),
        ]);
        if (saved.some((result) => result.status === "rejected")) {
          console.warn("Task uploaded but some local progress details could not be saved", saved);
        }
        resetFlow();
        notify("Task submitted. Thank you — that's exactly the data we need.", "ok");
        state.busy = null;
        goto("home");
      },
    },
  };

  function setUrl(screen: Screen, replace: boolean) {
    if (typeof history === "undefined") return;
    const url = `#${SCREEN_PATH[screen]}`;
    const data = { apolloScreen: screen };
    if (replace) history.replaceState(data, "", url);
    else history.pushState(data, "", url);
  }

  // Screens a browser Back should return to (transient/blocking ones are skipped).
  function transition(screen: Screen) {
    state.screen = screen;
    if (screen !== "form") state.formErrors = {};
    // Notices belong to the screen they were raised on: errors/info clear on
    // the first navigation away; success banners survive exactly one hop
    // (upload success is shown on the arrival at home).
    if (state.notice) {
      noticeAge += 1;
      const limit = state.notice.tone === "ok" ? 2 : 1;
      if (noticeAge >= limit) state.notice = null;
    }
    render();
    window.scrollTo({ top: 0 });
    // Persist in-progress work on every navigation so a refresh can resume.
    flushAutosave();
  }

  // Forward navigation: also push a browser history entry so the back/forward
  // arrows move between screens, and update the URL so each page is distinct.
  function goto(screen: Screen) {
    screen = reachableScreen(screen);
    transition(screen);
    setUrl(screen, false);
  }

  function ensureSuggestions() {
    if (state.suggestions === null) {
      state.suggestions = suggestThemes(state.journeys);
    }
  }

  function resetFlow() {
    state.mode = null;
    state.basket = [];
    state.keyUrls = [];
    state.attachedUrls = [];
    state.activeTheme = null;
    state.removedFromTheme = [];
    state.activeTemplate = null;
    state.guidedIntro = "";
    state.guidedDeliverable = "doc";
    state.guidedCustomDeliverable = "";
    state.guidedSteps = [];
    state.draft = emptyDraft();
    state.draftBasketKey = "";
    state.lastDraftTitle = "";
    state.scopeDirty = false;
    state.domainsDirty = false;
    state.requestDirty = false;
    state.pendingTaskId = null;
    state.pendingCreatedAt = null;
    state.generatedDraft = null;
    state.hasResumableDraft = false;
    state.formErrors = {};
    clearAutosave();
  }

  let noticeAge = 0;
  function notify(text: string, tone: "info" | "ok" | "err") {
    state.notice = { text, tone };
    noticeAge = 0;
  }

  function topBar(): HTMLElement {
    const bar = el("header", { class: "topbar" });
    // Back/forward live in the top bar so navigation is always one glance
    // away; they drive the same history the browser arrows do.
    const navGroup = el(
      "div",
      { class: "topbar-nav" },
      el(
        "button",
        {
          class: "icon-btn nav-arrow",
          type: "button",
          title: "Back (Esc)",
          "aria-label": "Go back",
          disabled: state.screen === "home",
          onclick: () => history.back(),
        },
        "←"
      ),
      el(
        "button",
        {
          class: "icon-btn nav-arrow",
          type: "button",
          title: "Forward",
          "aria-label": "Go forward",
          onclick: () => history.forward(),
        },
        "→"
      )
    );
    const brand = el(
      "button",
      {
        class: "topbar-brand as-button",
        type: "button",
        title: "Home",
        onclick: () => {
          if (state.identity) goto("home");
        },
      },
      el("span", { class: "brand-mark small" }, "◈"),
      el("span", { class: "brand-name" }, "Apollo v2"),
      el("span", { class: "brand-sub mono" }, "LONG-HORIZON TASKS")
    );
    const NAV: Array<{ label: string; target: Screen; owns: Screen[] }> = [
      { label: "Submit", target: "submit", owns: ["submit", "history", "compose", "themes", "guided", "form", "review"] },
      { label: "Review", target: "review-queue", owns: ["review-queue", "review-edit"] },
      { label: "Grade", target: "trajectory-queue", owns: ["trajectory-queue", "trajectory-edit"] },
      { label: "Examples", target: "examples", owns: ["examples"] },
      { label: "Dashboard", target: "progress", owns: ["progress"] },
    ];
    const navLinks =
      state.identity?.kind === "internal"
        ? el(
            "nav",
            { class: "topbar-nav-links" },
            ...NAV.map((n) =>
              el(
                "button",
                {
                  class: `topnav-link ${n.owns.includes(state.screen) ? "active" : ""}`,
                  type: "button",
                  onclick: () => goto(n.target),
                },
                n.label
              )
            )
          )
        : null;
    bar.append(el("div", { class: "topbar-left" }, navGroup, brand, navLinks));
    if (state.identity) {
      const right = el("div", { class: "topbar-right" });
      // The counter is the door to the participant's stats page.
      right.append(
        el(
          "button",
          {
            class: "progress-pill mono as-button",
            type: "button",
            title: "See your stats",
            onclick: () => goto("progress"),
          },
          `${state.uploadedCount} submitted`
        )
      );
      right.append(
        el(
          "span",
          { class: "participant-chip", title: "Annotator" },
          state.identity.name
        )
      );
      bar.append(right);
    }
    return bar;
  }

  function render() {
    const screens: Record<Screen, (c: Ctx) => HTMLElement> = {
      login: renderLogin,
      home: renderHome,
      submit: renderSubmitHub,
      history: renderHistory,
      compose: renderCompose,
      themes: renderThemes,
      guided: renderGuided,
      form: renderForm,
      review: renderReview,
      examples: renderExamples,
      progress: renderProgress,
      "review-queue": renderReviewQueue,
      "review-edit": renderReviewEdit,
      "trajectory-queue": renderTrajectoryQueue,
      "trajectory-edit": renderTrajectoryEdit,
    };
    if (state.screen === "themes") ensureSuggestions();

    const children: HTMLElement[] = [];
    if (state.screen !== "login") children.push(topBar());
    if (state.notice) {
      children.push(
        el(
          "div",
          { class: `notice ${state.notice.tone}` },
          el("span", null, state.notice.text),
          el("button", {
            class: "icon-btn",
            type: "button",
            title: "Dismiss",
            onclick: () => {
              state.notice = null;
              render();
            },
          }, "✕")
        )
      );
    }
    children.push(screens[state.screen](ctx));
    root.replaceChildren(...children);
  }

  render();

  // Wire browser back/forward to screen transitions. We seed one baseline
  // entry so the first Back stays inside the app rather than leaving it.
  if (typeof history !== "undefined" && typeof window !== "undefined") {
    setUrl(state.screen, true);
    window.addEventListener("popstate", (e) => {
      const target = (e.state as { apolloScreen?: Screen } | null)?.apolloScreen;
      if (!target) return;
      const reachable = reachableScreen(target);
      transition(reachable);
      if (reachable !== target) setUrl(reachable, true);
    });
  }

  // A back-target may need in-memory state that no longer exists (e.g. history
  // was never loaded, or the flow was reset after upload) — fall back sensibly.
  function reachableScreen(target: Screen): Screen {
    if (!state.identity) return "login";
    if (target === "login") return "home"; // logged in — login is behind you
    // The former request-only screen is retained only for old hashes and
    // autosaves. All authoring now happens on the combined request + steps page.
    if (target === "form") target = "guided";
    if ((target === "compose" || target === "themes") && !state.historyLoaded) return "home";
    if (target === "review" && !state.mode) return "home";
    if (target === "guided" && !state.mode) return "home";
    if (target === "review-edit" && !state.reviewClaim) return "review-queue";
    if (target === "trajectory-edit" && !state.trajectoryClaim) return "trajectory-queue";
    return target;
  }

  // Keyboard shortcuts: Esc = back, Cmd/Ctrl+Enter = the screen's primary
  // action, "/" = focus search. Never steal keys from an active text field
  // (except Cmd+Enter, which should submit from inside a textarea too).
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      const primaries = root.querySelectorAll<HTMLButtonElement>("main .btn.primary:not(:disabled), .screen .btn.primary:not(:disabled)");
      const btn = primaries[primaries.length - 1];
      if (btn) {
        e.preventDefault();
        btn.click();
      }
      return;
    }
    if (typing) return;
    if (e.key === "Escape" && state.screen !== "login" && state.screen !== "home") {
      history.back();
      return;
    }
    // Home (internal chooser): 1 = submit hub, 2 = review queue, 3 = reference.
    if (state.screen === "home" && state.identity?.kind === "internal" && ["1", "2", "3"].includes(e.key)) {
      e.preventDefault();
      goto(e.key === "1" ? "submit" : e.key === "2" ? "review-queue" : "examples");
      return;
    }
    // Submit hub: 1/2/3 jump into a mode.
    if ((state.screen === "submit" || state.screen === "home") && ["1", "2", "3"].includes(e.key)) {
      const cards = root.querySelectorAll<HTMLButtonElement>(".mode-rows .mode-row .btn.primary");
      const btn = cards[Number(e.key) - 1];
      if (btn) {
        e.preventDefault();
        btn.click();
      }
      return;
    }
    if (e.key === "/") {
      const search = root.querySelector<HTMLInputElement>('input[type="search"], .filter-bar input[type="text"]');
      if (search) {
        e.preventDefault();
        search.focus();
      }
    }
  });

  // A manually-stored key (legacy devices) overrides the baked-in default.
  adapter.storage
    .get(STORAGE_KEYS.reviewKey)
    .then((k) => {
      if (k) state.reviewKey = k;
    })
    .catch(() => {});

  // Prefill the login form with the last-used identity (never auto-login), and
  // detect an in-progress task to offer a Resume.
  adapter.storage
    .get(STORAGE_KEYS.lastIdentity)
    .then(async (raw) => {
      if (!raw) return;
      const identity = JSON.parse(raw) as ParticipantIdentity;
      // Ignore legacy participant records from the removed Prolific flow.
      if (identity?.kind !== "internal" || !identity.name || !identity.email) {
        await adapter.storage.set(STORAGE_KEYS.lastIdentity, "").catch(() => {});
        return;
      }
      state.lastIdentity = identity;
      const saved = await adapter.storage
        .get(STORAGE_KEYS.draftAutosave(participantKey(identity)))
        .catch(() => null);
      state.hasResumableDraft = !!(saved && saved.length > 2);
      if (state.screen === "login") render();
    })
    .catch(() => {});
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
