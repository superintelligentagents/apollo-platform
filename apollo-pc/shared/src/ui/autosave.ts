// Decisions-only persistence. Records are rehydrated from IndexedDB on login
// (a 2 GB mbox re-parse is not an acceptable resume path); this snapshot
// carries just the small hot state: inclusion/edit decisions, replacement
// rules, authored tasks, and the pending bundle id.

import { STORAGE_KEYS, type KeyValueStore } from "../platform";
import type { ItemDecision, PCTask, ReplacementRule, SourceKind } from "../types";
import type { AppState, SourceImportInfo, TaskDraft } from "./context";

export type SavedDecisions = {
  savedAt: string;
  decisions: [string, ItemDecision][];
  sourceInclusionDefaults?: Partial<Record<SourceKind, boolean>>;
  rules: ReplacementRule[];
  tasks: PCTask[];
  taskDraft: TaskDraft | null;
  bundleId: string | null;
  bundleCreatedAt: string | null;
  dateFloorMonths: number;
  // Per-source parse stats — records rehydrate from IndexedDB, but the
  // stats/issues that describe HOW they were imported live only here.
  imports: Partial<Record<SourceKind, SourceImportInfo>>;
};

export function serializeDecisions(state: AppState): SavedDecisions {
  return {
    savedAt: new Date().toISOString(),
    decisions: [...state.decisions.entries()],
    sourceInclusionDefaults: state.sourceInclusionDefaults,
    rules: state.rules,
    tasks: state.tasks,
    taskDraft: state.taskDraft,
    bundleId: state.bundleId,
    bundleCreatedAt: state.bundleCreatedAt,
    dateFloorMonths: state.dateFloorMonths,
    imports: state.imports,
  };
}

export function applyDecisions(state: AppState, saved: SavedDecisions): void {
  state.decisions = new Map(saved.decisions);
  state.sourceInclusionDefaults = saved.sourceInclusionDefaults ?? {};
  state.rules = saved.rules ?? [];
  state.tasks = saved.tasks ?? [];
  state.taskDraft = saved.taskDraft ?? null;
  state.bundleId = saved.bundleId ?? null;
  state.bundleCreatedAt = saved.bundleCreatedAt ?? null;
  state.dateFloorMonths = saved.dateFloorMonths ?? 12;
  state.imports = saved.imports ?? {};
}

export async function loadDecisions(storage: KeyValueStore, participantId: string): Promise<SavedDecisions | null> {
  try {
    const raw = await storage.get(STORAGE_KEYS.decisions(participantId));
    if (!raw) return null;
    return JSON.parse(raw) as SavedDecisions;
  } catch {
    return null;
  }
}

export async function saveDecisions(storage: KeyValueStore, participantId: string, state: AppState): Promise<void> {
  try {
    await storage.set(STORAGE_KEYS.decisions(participantId), JSON.stringify(serializeDecisions(state)));
  } catch {
    // localStorage quota — decisions are sparse so this is unlikely; a failed
    // autosave must never break the flow.
  }
}

export async function clearDecisions(storage: KeyValueStore, participantId: string): Promise<void> {
  await storage.set(STORAGE_KEYS.decisions(participantId), "").catch(() => {});
}
