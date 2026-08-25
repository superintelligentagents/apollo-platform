import { buildLookup, createAliasPool, detectEntities, normalizeName, normalizePhoneKey } from "../alias";
import { assembleBundle } from "../bundle";
import { defaultReviewKey, MANIFEST_FILENAME, MAX_BODY_CHARS } from "../config";
import { appendUploadLog, loadUploadLog, STORAGE_KEYS, type PlatformAdapter } from "../platform";
import { buildReviewTaskSidecar, reviewTaskFilename } from "../review-task";
import { clearClaimSnapshot, clearTrajectoryClaimSnapshot, saveClaimSnapshot, saveTrajectoryClaimSnapshot, seedTrajectoryJudgment, type ReviewClaim, type TrajectoryClaim } from "../review-client";
import { buildBundleId, participantId as schemaParticipantId, participantUploadIdentity, validateBundle } from "../schema";
import { META_KEYS, openStore, type RecordStore } from "../store";
import { cardFor } from "../sources/registry";
import { isReceiptCandidate, mineReceipt } from "../sources/receipts";
import { seedCriteriaFromSteps, substantiveSteps, type PCTemplate } from "../templates";
import type {
  Entity,
  ItemDecision,
  ParticipantIdentity,
  PCTask,
  SourceKind,
  SourceRecord,
} from "../types";
import { applyDecisions, clearDecisions, loadDecisions, saveDecisions } from "./autosave";
import { el } from "./components/helpers";
import { initialState, type AppState, type Ctx, type Screen } from "./context";
import { participantKey } from "./identity";
import { renderEntities } from "./screens/entities";
import { renderHome } from "./screens/home";
import { renderEmailItems, renderItems, renderCalendarItems } from "./screens/items";
import { renderLogin } from "./screens/login";
import { renderProgress } from "./screens/progress";
import { renderReview } from "./screens/review";
import { renderCalendarImport, renderMailImport, renderSources } from "./screens/sources";
import { renderTaskEdit } from "./screens/task-edit";
import { renderTasks } from "./screens/tasks";
import { renderTaskReviewQueue } from "./screens/task-review-queue";
import { renderTaskReviewEdit } from "./screens/task-review-edit";
import { renderTrajectoryQueue } from "./screens/trajectory-queue";
import { renderTrajectoryEdit } from "./screens/trajectory-edit";

const SCREEN_PATH: Record<Screen, string> = {
  login: "/",
  home: "/home",
  sources: "/sources",
  "import-mail": "/import/mail",
  "import-calendar": "/import/calendar",
  items: "/items",
  "upload-email": "/upload/email",
  "upload-calendar": "/upload/calendar",
  entities: "/people",
  tasks: "/tasks",
  "task-edit": "/write-task",
  review: "/review",
  progress: "/progress",
  "task-review-queue": "/review-task",
  "task-review-edit": "/review-task/edit",
  "trajectory-queue": "/grade",
  "trajectory-edit": "/grade/run",
};
const ENTITY_CLASSIFICATION_VERSION = "sender-privacy-v3";

export function screenFromHash(hash: string): Screen | null {
  const path = hash.replace(/^#/, "") || "/";
  const match = (Object.entries(SCREEN_PATH) as [Screen, string][]).find(([, screenPath]) => screenPath === path);
  return match?.[0] ?? null;
}

export async function mountApp(root: HTMLElement, adapter: PlatformAdapter): Promise<void> {
  const state: AppState = initialState();
  state.reviewKey = defaultReviewKey();
  const store: RecordStore = await openStore();
  const aliasPool = createAliasPool();
  let requestedScreenOnLogin = typeof window === "undefined" ? null : screenFromHash(window.location.hash);

  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  function flushAutosave() {
    if (!state.identity) return;
    void saveDecisions(adapter.storage, participantKey(state.identity), state);
  }

  function defaultIncluded(record: SourceRecord): boolean {
    return includedByDefault(record);
  }

  function decisionFor(id: string): ItemDecision {
    let d = state.decisions.get(id);
    if (!d) {
      const record = state.records.get(id);
      d = { included: record ? sourceDefaultIncluded(record) : true, edits: {}, bodyEdit: null, maskOverrides: {} };
      state.decisions.set(id, d);
    }
    return d;
  }

  function isIncluded(record: SourceRecord): boolean {
    const d = state.decisions.get(record.id);
    return d ? d.included : sourceDefaultIncluded(record);
  }

  function sourceDefaultIncluded(record: SourceRecord): boolean {
    return state.sourceInclusionDefaults[record.source] ?? defaultIncluded(record);
  }

  function decisionHasEdits(decision: ItemDecision): boolean {
    return Object.keys(decision.edits).length > 0 || decision.bodyEdit !== null || Object.keys(decision.maskOverrides).length > 0;
  }

  function setSourcesIncluded(sources: SourceKind[], included: boolean) {
    const sourceSet = new Set(sources);
    for (const source of sourceSet) state.sourceInclusionDefaults[source] = included;
    // Decisions are normally sparse. Preserve hand edits/mask choices, while
    // selection-only overrides can fall back to the compact source default.
    for (const [id, decision] of state.decisions) {
      const record = state.records.get(id);
      if (!record || !sourceSet.has(record.source)) continue;
      if (decisionHasEdits(decision)) decision.included = included;
      else state.decisions.delete(id);
    }
  }

  let entityRefreshPromise: Promise<void> | null = null;
  function refreshEntities(): Promise<void> {
    if (entityRefreshPromise) return entityRefreshPromise;
    state.entityIndexing = true;
    const records = [...state.records.values()];
    const existing = state.entities;
    const identity = state.identity ?? undefined;
    entityRefreshPromise = new Promise<Entity[]>((resolve) => {
      if (typeof Worker === "undefined") {
        resolve(detectEntities(records, existing, aliasPool, identity));
        return;
      }
      const worker = new Worker(new URL("../entity-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ entities: Entity[] }>) => {
        worker.terminate();
        resolve(event.data.entities);
      };
      worker.onerror = () => {
        worker.terminate();
        resolve(detectEntities(records, existing, aliasPool, identity));
      };
      worker.postMessage({ records, existing, identity });
    }).then((entities) => {
      state.entities = entities;
      return store.setMeta(META_KEYS.entities, { entities, recordCount: records.length, classificationVersion: ENTITY_CLASSIFICATION_VERSION });
    }).finally(() => {
      state.entityIndexing = false;
      entityRefreshPromise = null;
    });
    return entityRefreshPromise;
  }

  function invalidatePrivacyAudit() {
    state.privacyAudit = null;
  }

  async function mineReceipts(): Promise<number> {
    const candidates = [...state.records.values()].filter(
      (r): r is Extract<SourceRecord, { source: "email" }> => r.source === "email" && isReceiptCandidate(r)
    );
    if (!candidates.length) return 0;
    const bodies = await store.getBodies(candidates.map((c) => c.id));
    let added = 0;
    const orders: SourceRecord[] = [];
    for (const email of candidates) {
      const order = mineReceipt(email, bodies.get(email.id) || "");
      if (!order || state.records.has(order.id)) continue;
      state.records.set(order.id, order);
      state.receiptEmailIds.add(email.id);
      orders.push(order);
      added++;
    }
    if (orders.length) await store.putRecords(orders);
    if (added) {
      state.imports.orders = {
        stats: {
          recordsEmitted: [...state.records.values()].filter((r) => r.source === "orders").length,
          itemsSkipped: 0,
          bodiesTruncated: 0,
          attachmentsStripped: 0,
          dateRange: null,
        },
        issues: [],
        importedAt: new Date().toISOString(),
      };
    }
    return added;
  }

  function rebuildReceiptEmailIds() {
    for (const r of state.records.values()) {
      if (r.source === "orders" || r.source === "transactions") {
        for (const id of r.relatedRecordIds) state.receiptEmailIds.add(id);
      }
    }
  }

  const ctx: Ctx = {
    state,
    adapter,
    store,
    rerender() {
      render();
    },
    autosave() {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(flushAutosave, 400);
    },
    update(patch) {
      Object.assign(state, patch);
      render();
    },
    actions: {
      async login(identity: ParticipantIdentity) {
        state.identity = identity;
        invalidatePrivacyAudit();
        adapter.storage.set(STORAGE_KEYS.lastIdentity, JSON.stringify(identity)).catch(() => {});
        state.busy = "Loading your workspace…";
        render();
        try {
          const owner = participantKey(identity);
          const [records, savedEntities, saved, log] = await Promise.all([
            store.allRecords(),
            store.getMeta<{ entities: Entity[]; recordCount?: number; classificationVersion?: string }>(META_KEYS.entities),
            loadDecisions(adapter.storage, owner),
            loadUploadLog(adapter.storage, owner),
          ]);
          state.records = new Map(records.map((r) => [r.id, r]));
          state.entities = savedEntities?.entities ?? [];
          if (saved) applyDecisions(state, saved);
          state.uploadedCount = log.length;
          state.uploadedBySource = log.reduce((totals, entry) => {
            if (entry.source_counts) {
              totals.email += entry.source_counts.email ?? 0;
              totals.calendar += entry.source_counts.calendar ?? 0;
              totals.knownBundles += 1;
            } else {
              totals.legacyRecords += entry.record_count;
            }
            return totals;
          }, { email: 0, calendar: 0, knownBundles: 0, legacyRecords: 0 });
          rebuildReceiptEmailIds();
          // A saved entity index was produced after the most recent import;
          // trusting it avoids another full 100k-message sender analysis on
          // every login. Older stores without one are upgraded off the first
          // paint in a worker.
          if (state.records.size && (
            !state.entities.length ||
            savedEntities?.recordCount !== state.records.size ||
            savedEntities?.classificationVersion !== ENTITY_CLASSIFICATION_VERSION
          )) {
            void refreshEntities()
              .then(() => {
                invalidatePrivacyAudit();
              })
              .catch((error) => {
                notify(`Couldn't refresh privacy classifications: ${message(error)}`, "err");
              })
              .finally(render);
          }
        } finally {
          state.busy = null;
        }
        const destination = requestedScreenOnLogin ?? "home";
        requestedScreenOnLogin = null;
        goto(destination);
      },

      goto,

      async importFiles(kind: SourceKind, files: File[]) {
        const card = cardFor(kind);
        if (!card.parser || !files.length) return;
        const floor =
          state.dateFloorMonths > 0
            ? new Date(Date.now() - state.dateFloorMonths * 30 * 24 * 3600 * 1000).toISOString()
            : null;
        state.importing = { kind, progress: { phase: "reading", bytesRead: 0, bytesTotal: 0, recordsEmitted: 0 } };
        render();
        let lastPaint = 0;
        try {
          const result = await card.parser.parse(
            files,
            {
              maxBodyChars: MAX_BODY_CHARS,
              dateFloor: floor,
              locale: state.waDateOrder === "auto" ? {} : { dateOrder: state.waDateOrder },
            },
            (p) => {
              state.importing = { kind, progress: p };
              const now = Date.now();
              // Rebuilding the full screen several times per second creates
              // avoidable renderer pressure during multi-gigabyte imports.
              if (now - lastPaint > 500) {
                lastPaint = now;
                render();
              }
            },
            async (bodies) => {
              await store.putBodies(bodies);
            }
          );
          const fresh = result.records.filter((r) => !state.records.has(r.id));
          for (const r of result.records) state.records.set(r.id, r);
          await store.putRecords(result.records);
          state.imports[kind] = { stats: result.stats, issues: result.issues, importedAt: new Date().toISOString() };
          let mined = 0;
          if (kind === "email") mined = await mineReceipts();
          await refreshEntities();
          invalidatePrivacyAudit();
          notify(
            `Imported ${fresh.length.toLocaleString()} ${kind} record${fresh.length === 1 ? "" : "s"}` +
              (mined ? ` · mined ${mined} orders from receipts` : "") +
              (result.stats.itemsSkipped ? ` · ${result.stats.itemsSkipped.toLocaleString()} outside your date window` : ""),
            "ok"
          );
        } catch (err) {
          notify(`Couldn't parse that file: ${message(err)}`, "err");
        } finally {
          state.importing = null;
          ctx.autosave();
          render();
        }
      },

      defaultIncluded,
      isIncluded,
      decisionFor,

      invalidatePrivacyAudit,

      toggleInclude(id: string) {
        const d = decisionFor(id);
        d.included = !d.included;
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      bulkInclude(ids: string[], included: boolean) {
        for (const id of ids) {
          const record = state.records.get(id);
          if (!record) continue;
          const decision = state.decisions.get(id);
          if (decision) {
            decision.included = included;
            if (!decisionHasEdits(decision) && included === sourceDefaultIncluded(record)) state.decisions.delete(id);
          } else if (included !== sourceDefaultIncluded(record)) {
            state.decisions.set(id, { included, edits: {}, bodyEdit: null, maskOverrides: {} });
          }
        }
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      bulkIncludeSources(sources: SourceKind[], included: boolean) {
        setSourcesIncluded(sources, included);
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      setFieldEdit(id: string, field: string, value: string | null) {
        const d = decisionFor(id);
        if (value === null) delete d.edits[field];
        else d.edits[field] = value;
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      setBodyEdit(id: string, value: string | null) {
        const d = decisionFor(id);
        d.bodyEdit = value;
        if (state.openItemId === id && value !== null) state.openItemBody = value;
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      openItem(id: string | null) {
        state.openItemId = id;
        state.openItemBody = null;
        render();
        if (!id) return;
        const record = state.records.get(id);
        const d = state.decisions.get(id);
        if (d?.bodyEdit !== null && d?.bodyEdit !== undefined) {
          state.openItemBody = d.bodyEdit;
          render();
          return;
        }
        if (record?.source === "email") {
          void store.getBody(id).then((text) => {
            if (state.openItemId === id) {
              state.openItemBody = text ?? "";
              render();
            }
          });
        } else if (record?.source === "messages") {
          state.openItemBody = record.text;
          render();
        }
      },

      updateEntity(entityId: string, patch: Partial<Entity>) {
        const entity = state.entities.find((e) => e.entityId === entityId);
        if (!entity) return;
        Object.assign(entity, patch);
        invalidatePrivacyAudit();
        void store.setMeta(META_KEYS.entities, {
          entities: state.entities,
          recordCount: state.records.size,
          classificationVersion: ENTITY_CLASSIFICATION_VERSION,
        });
        render();
      },

      addRule(rule) {
        if (!rule.find.trim()) return;
        state.rules.push(rule);
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      removeRule(index) {
        state.rules.splice(index, 1);
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      startTask(template: PCTemplate) {
        state.activeTemplate = template;
        state.taskDraft = {
          taskId: `task-${crypto.randomUUID().slice(0, 8)}`,
          templateId: template.id,
          category: template.category,
          title: "",
          request: template.requestScaffold,
          steps: template.steps.map((s, i) => ({ order: i, title: s.title, description: "" })),
          successCriteria: [],
          referencedRecordIds: [],
          expectedAnswer: "",
          notes: "",
        };
        state.formErrors = {};
        goto("task-edit");
      },

      editTask(taskId: string) {
        const task = state.tasks.find((t) => t.task_id === taskId);
        if (!task) return;
        state.activeTemplate = null;
        state.taskDraft = {
          taskId: task.task_id,
          templateId: "",
          category: task.category,
          title: task.task_title,
          request: task.agent_request,
          steps: task.steps.length ? task.steps : [{ order: 0, title: "Step", description: "" }],
          successCriteria: task.success_criteria,
          referencedRecordIds: task.referenced_record_ids,
          expectedAnswer: task.expected_answer ?? "",
          notes: task.notes ?? "",
        };
        state.formErrors = {};
        goto("task-edit");
      },

      saveTaskDraft(): boolean {
        const draft = state.taskDraft;
        if (!draft) return false;
        const errors: Record<string, string> = {};
        const request = draft.request.trim();
        const steps = substantiveSteps(draft.steps);
        if (request.length < 15) errors.request = "Write the request out — a sentence or two.";
        if (/\[[^\]]+\]/.test(request)) errors.request = "Replace the [bracketed] placeholders with your own details.";
        if (!steps.length) errors.steps = "Fill in at least one task step — a sentence is enough.";
        const template = state.activeTemplate;
        if (template?.requiresExpectedAnswer && !draft.expectedAnswer.trim()) {
          errors.expected = "This task type needs the ground-truth answer (you know it — the agent has to find it).";
        }
        if (Object.keys(errors).length) {
          state.formErrors = errors;
          notify("A few fields need attention.", "err");
          render();
          return false;
        }
        const sources = new Set<SourceKind>();
        for (const id of draft.referencedRecordIds) {
          const r = state.records.get(id);
          if (r) sources.add(r.source);
        }
        const task: PCTask = {
          task_id: draft.taskId,
          category: draft.category,
          task_title: draft.title.trim() || deriveTitle(request),
          agent_request: request,
          steps,
          success_criteria: draft.successCriteria.filter((c) => c.trim()).length
            ? draft.successCriteria.filter((c) => c.trim())
            : seedCriteriaFromSteps(steps),
          required_sources: [...sources],
          referenced_record_ids: draft.referencedRecordIds,
          expected_answer: draft.expectedAnswer.trim() || null,
          notes: draft.notes.trim() || null,
        };
        const idx = state.tasks.findIndex((t) => t.task_id === task.task_id);
        if (idx >= 0) state.tasks[idx] = task;
        else state.tasks.push(task);
        invalidatePrivacyAudit();
        state.taskDraft = null;
        state.activeTemplate = null;
        state.formErrors = {};
        ctx.autosave();
        notify("Task saved.", "ok");
        goto("tasks");
        return true;
      },

      deleteTask(taskId: string) {
        state.tasks = state.tasks.filter((t) => t.task_id !== taskId);
        invalidatePrivacyAudit();
        ctx.autosave();
        render();
      },

      toggleTaskRecord(recordId: string) {
        const draft = state.taskDraft;
        if (!draft) return;
        const idx = draft.referencedRecordIds.indexOf(recordId);
        if (idx >= 0) draft.referencedRecordIds.splice(idx, 1);
        else draft.referencedRecordIds.push(recordId);
        ctx.autosave();
        render();
      },

      async submitBundle() {
        if (state.busy) return;
        const identity = state.identity;
        if (!identity) return;
        const included = [...state.records.values()].filter(isIncluded);
        const validation = validateBundle({
          identity,
          includedCounts: countBySource(included),
          tasks: state.tasks,
        });
        if (!validation.valid) {
          state.formErrors = validation.errors;
          notify(Object.values(validation.errors)[0], "err");
          render();
          return;
        }
        const uploadIdentity = participantUploadIdentity(identity, state.entities);
        const uploadParticipantId = schemaParticipantId(uploadIdentity);
        if (!state.bundleId || !state.bundleId.startsWith(`pc/${uploadParticipantId}/internal/`)) {
          state.bundleCreatedAt = new Date().toISOString();
          state.bundleId = buildBundleId(uploadIdentity, state.bundleCreatedAt);
          flushAutosave();
        }
        const bundleId = state.bundleId;
        state.busy = "Preparing your bundle…";
        render();
        try {
          // Parts first, manifest LAST. Review-safe task sidecars are uploaded
          // only after that complete bundle, so an interrupted upload never
          // produces a claimable task. Assembly is shared with the review
          // screen's download-preview, so what you previewed is exactly what
          // ships.
          const { uploads, manifestBody, privacyAudit, sanitizedTasks } = await assembleBundle(
            state,
            store,
            identity,
            bundleId,
            state.bundleCreatedAt!,
            isIncluded
          );
          state.privacyAudit = privacyAudit;
          if (privacyAudit.status === "blocked") {
            notify(`Upload blocked by the privacy gate: ${privacyAudit.blocking_findings} finding${privacyAudit.blocking_findings === 1 ? "" : "s"}. Export the privacy audit for details.`, "err");
            render();
            return;
          }

          const pid = uploadParticipantId;
          let n = 0;
          for (const u of uploads) {
            n++;
            state.busy = `Uploading part ${n} of ${uploads.length + 1}…`;
            render();
            await adapter.uploadJson({ taskId: bundleId, filename: u.filename, body: u.body, participantId: pid, studyId: "internal" });
          }
          state.busy = `Uploading manifest (${uploads.length + 1} of ${uploads.length + 1})…`;
          render();
          await adapter.uploadJson({
            taskId: bundleId,
            filename: MANIFEST_FILENAME,
            body: manifestBody,
            participantId: pid,
            studyId: "internal",
          });

          // The private bundle is complete. Publish one authored-text-only
          // sidecar per task so peer review never receives mail, calendar
          // records, participant identity, aliases, expected answers, or
          // record references.
          for (let i = 0; i < sanitizedTasks.length; i++) {
            const task = sanitizedTasks[i]!;
            state.busy = `Adding task ${i + 1} of ${sanitizedTasks.length} to peer review…`;
            render();
            await adapter.uploadJson({
              taskId: bundleId,
              filename: reviewTaskFilename(task),
              body: buildReviewTaskSidecar(task, state.bundleCreatedAt!),
              participantId: pid,
              studyId: "internal",
            });
          }

          state.uploadedCount += 1;
          await appendUploadLog(adapter.storage, participantKey(identity), {
            bundle_id: bundleId,
            sources: Object.keys(state.imports),
            record_count: included.length,
            source_counts: {
              email: included.filter((record) => record.source === "email" || record.source === "orders").length,
              calendar: included.filter((record) => record.source === "calendar").length,
            },
            task_count: state.tasks.length,
            at: new Date().toISOString(),
          });
          state.uploadedBySource.email += included.filter((record) => record.source === "email" || record.source === "orders").length;
          state.uploadedBySource.calendar += included.filter((record) => record.source === "calendar").length;
          state.uploadedBySource.knownBundles += 1;
          state.bundleId = null;
          state.bundleCreatedAt = null;
          state.tasks = [];
          state.privacyAudit = null;
          flushAutosave();
          notify("Bundle submitted. Thank you — this is exactly the data we need.", "ok");
          goto("home");
        } catch (err) {
          notify(`Couldn't submit: ${message(err)} — your work is saved; try again.`, "err");
        } finally {
          state.busy = null;
          render();
        }
      },

      async eraseAll() {
        await store.clearAll();
        if (state.identity) await clearDecisions(adapter.storage, participantKey(state.identity));
        const identity = state.identity;
        const last = state.lastIdentity;
        const uploaded = state.uploadedCount;
        const uploadedBySource = state.uploadedBySource;
        Object.assign(state, initialState());
        state.identity = identity;
        state.lastIdentity = last;
        state.uploadedCount = uploaded;
        state.uploadedBySource = uploadedBySource;
        state.screen = identity ? "home" : "login";
        notify("All local data erased from this browser.", "ok");
        render();
      },

      notifyInfo(msg) {
        notify(msg, "info");
        render();
      },
      notifyError(msg) {
        notify(msg, "err");
        render();
      },
      reviewerName() {
        return state.identity?.name || state.identity?.email || "unknown";
      },
      reviewerPid() {
        return state.identity ? schemaParticipantId(state.identity) : "";
      },
      startReview(claim: ReviewClaim) {
        state.reviewClaim = claim;
        state.reviewRubrics = null;
        state.reviewEdits = null;
        void saveClaimSnapshot(adapter.storage, { claim, rubrics: null, edits: null });
        goto("task-review-edit");
      },
      endReview(message: string) {
        state.reviewClaim = null;
        state.reviewRubrics = null;
        state.reviewEdits = null;
        void clearClaimSnapshot(adapter.storage);
        notify(message, "ok");
        goto("task-review-queue");
      },
      startTrajectoryReview(claim: TrajectoryClaim) {
        const judgment = seedTrajectoryJudgment(claim.run);
        state.trajectoryClaim = claim;
        state.trajectoryJudgment = judgment;
        void saveTrajectoryClaimSnapshot(adapter.storage, { claim, judgment });
        goto("trajectory-edit");
      },
      endTrajectoryReview(message: string) {
        state.trajectoryClaim = null;
        state.trajectoryJudgment = null;
        void clearTrajectoryClaimSnapshot(adapter.storage);
        notify(message, "ok");
        goto("trajectory-queue");
      },
    },
  };

  function countBySource(records: SourceRecord[]): Partial<Record<SourceKind, number>> {
    const out: Partial<Record<SourceKind, number>> = {};
    for (const r of records) out[r.source] = (out[r.source] || 0) + 1;
    return out;
  }

  function deriveTitle(request: string): string {
    const words = request.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
    return words.length < request.trim().length ? `${words}…` : words;
  }

  function setUrl(screen: Screen, replace: boolean) {
    if (typeof history === "undefined") return;
    const url = `#${SCREEN_PATH[screen]}`;
    const data = { pcScreen: screen };
    if (replace) history.replaceState(data, "", url);
    else history.pushState(data, "", url);
  }

  let noticeAge = 0;
  function notify(text: string, tone: "info" | "ok" | "err") {
    state.notice = { text, tone };
    noticeAge = 0;
  }

  function transition(screen: Screen) {
    if (screen === "upload-email" && state.filters.source !== "email") Object.assign(state.filters, { source: "email", category: "all", direction: "all", correspondent: "", service: "", domain: "", sender: "", recurrence: "all", linked: "all", page: 0 });
    if (screen === "upload-calendar" && state.filters.source !== "calendar") Object.assign(state.filters, { source: "calendar", category: "all", direction: "all", correspondent: "", service: "", domain: "", sender: "", recurrence: "all", linked: "all", page: 0 });
    state.screen = screen;
    state.openItemId = null;
    state.openItemBody = null;
    if (screen !== "task-edit") state.formErrors = {};
    if (state.notice) {
      noticeAge += 1;
      const limit = state.notice.tone === "ok" ? 2 : 1;
      if (noticeAge >= limit) state.notice = null;
    }
    render();
    window.scrollTo({ top: 0 });
    flushAutosave();
  }

  function goto(screen: Screen) {
    screen = reachableScreen(screen);
    transition(screen);
    setUrl(screen, false);
  }

  function reachableScreen(target: Screen): Screen {
    if (!state.identity) return "login";
    if (target === "login") return "home";
    if (target === "task-edit" && !state.taskDraft) return "tasks";
    if (target === "task-review-edit" && !state.reviewClaim) return "task-review-queue";
    if (target === "trajectory-edit" && !state.trajectoryClaim) return "trajectory-queue";
    return target;
  }

  function topBar(): HTMLElement {
    const bar = el("header", { class: "topbar" });
    const navGroup = el(
      "div",
      { class: "topbar-nav" },
      el(
        "button",
        { class: "icon-btn nav-arrow", type: "button", title: "Back (Esc)", "aria-label": "Go back", disabled: state.screen === "home", onclick: () => history.back() },
        "←"
      ),
      el("button", { class: "icon-btn nav-arrow", type: "button", title: "Forward", "aria-label": "Go forward", onclick: () => history.forward() }, "→")
    );
    const brand = el(
      "button",
      { class: "topbar-brand as-button", type: "button", title: "Home", onclick: () => state.identity && goto("home") },
      el("span", { class: "brand-mark small" }, "◈"),
      el("span", { class: "brand-name" }, "Apollo PC"),
      el("span", { class: "brand-sub mono" }, "PERSONAL CONTEXT")
    );
    const NAV: Array<{ label: string; target: Screen; owns: Screen[] }> = [
      { label: "Dashboard", target: "home", owns: ["home", "progress"] },
      { label: "1. Import data", target: "sources", owns: ["sources", "import-mail", "import-calendar"] },
      { label: "2. Upload data", target: "items", owns: ["items", "upload-email", "upload-calendar", "entities", "review"] },
      { label: "3. Write tasks", target: "tasks", owns: ["tasks", "task-edit"] },
      { label: "Review", target: "task-review-queue", owns: ["task-review-queue", "task-review-edit"] },
      { label: "Grade", target: "trajectory-queue", owns: ["trajectory-queue", "trajectory-edit"] },
    ];
    const navLinks = el(
      "nav",
      { class: "topbar-nav-links" },
      ...NAV.map((n) =>
        el(
          "button",
          { class: `topnav-link ${n.owns.includes(state.screen) ? "active" : ""}`, type: "button", onclick: () => goto(n.target) },
          n.label
        )
      )
    );
    bar.append(el("div", { class: "topbar-left" }, navGroup, brand, navLinks));
    if (state.identity) {
      bar.append(
        el(
          "div",
          { class: "topbar-right" },
          el(
            "button",
            { class: "progress-pill mono as-button", type: "button", title: "Your submissions", onclick: () => goto("progress") },
            `${state.uploadedCount} submitted`
          ),
          el("span", { class: "participant-chip", title: "Participant" }, state.identity.name)
        )
      );
    }
    return bar;
  }

  function render() {
    const screens: Record<Screen, (c: Ctx) => HTMLElement> = {
      login: renderLogin,
      home: renderHome,
      sources: renderSources,
      "import-mail": renderMailImport,
      "import-calendar": renderCalendarImport,
      items: renderItems,
      "upload-email": renderEmailItems,
      "upload-calendar": renderCalendarItems,
      entities: renderEntities,
      tasks: renderTasks,
      "task-edit": renderTaskEdit,
      review: renderReview,
      progress: renderProgress,
      "task-review-queue": renderTaskReviewQueue,
      "task-review-edit": renderTaskReviewEdit,
      "trajectory-queue": renderTrajectoryQueue,
      "trajectory-edit": renderTrajectoryEdit,
    };
    const children: HTMLElement[] = [];
    if (state.screen !== "login") children.push(topBar());
    if (state.notice) {
      children.push(
        el(
          "div",
          { class: `notice ${state.notice.tone}` },
          el("span", null, state.notice.text),
          el(
            "button",
            {
              class: "icon-btn",
              type: "button",
              title: "Dismiss",
              onclick: () => {
                state.notice = null;
                render();
              },
            },
            "✕"
          )
        )
      );
    }
    children.push(screens[state.screen](ctx));
    root.replaceChildren(...children);
  }

  render();

  if (typeof history !== "undefined" && typeof window !== "undefined") {
    setUrl(state.screen, true);
    window.addEventListener("popstate", (e) => {
      const target = (e.state as { pcScreen?: Screen } | null)?.pcScreen;
      if (!target) return;
      const reachable = reachableScreen(target);
      transition(reachable);
      if (reachable !== target) setUrl(reachable, true);
    });
  }

  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      const primaries = root.querySelectorAll<HTMLButtonElement>(".screen .btn.primary:not(:disabled)");
      const btn = primaries[primaries.length - 1];
      if (btn) {
        e.preventDefault();
        btn.click();
      }
      return;
    }
    if (typing) return;
    if (e.key === "Escape" && state.screen !== "login" && state.screen !== "home") {
      if (state.openItemId) {
        ctx.actions.openItem(null);
        return;
      }
      history.back();
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

  // Prefill the login form with the last-used identity (never auto-login).
  adapter.storage
    .get(STORAGE_KEYS.lastIdentity)
    .then((raw) => {
      if (!raw) return;
      const identity = JSON.parse(raw) as ParticipantIdentity;
      if (identity?.kind !== "internal" || !identity.name || !identity.email) return;
      state.lastIdentity = identity;
      if (state.screen === "login") render();
    })
    .catch(() => {});
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Alias/phone helpers imported for screens that need them re-exported.
export { buildLookup, normalizeName, normalizePhoneKey };

export function includedByDefault(record: SourceRecord): boolean {
  // Consent is explicit at login and exclusion remains available at message,
  // sender, subject/search-result, and source scope. Start email opt-out so a
  // participant cannot silently miss useful personal context.
  if (record.source === "email") return true;
  if (record.source === "messages") return !record.isSystem;
  return true;
}
