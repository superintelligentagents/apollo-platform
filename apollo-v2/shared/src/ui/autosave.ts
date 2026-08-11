import type { AppState, Screen } from "./context";
import type { TaskMode } from "../types";

// A serialized in-progress task — enough to restore the author's WRITING after
// a refresh. Journeys themselves are not persisted (large + privacy); the
// basket is kept by fingerprint and rehydrated best-effort after history reload.
export type SavedDraft = {
  v: 1;
  screen: Screen;
  mode: TaskMode | null;
  draft: AppState["draft"];
  guidedSteps: AppState["guidedSteps"];
  guidedIntro: string;
  guidedDeliverable: AppState["guidedDeliverable"];
  guidedCustomDeliverable?: string;
  keyUrls: string[];
  attachedUrls: string[];
  activeTemplateId: string | null;
  activeTheme: AppState["activeTheme"];
  removedFromTheme: string[];
  basketFingerprints: string[];
  generatedDraft: string | null;
  pendingTaskId: string | null;
  pendingCreatedAt: string | null;
  savedAt: string;
};

// Only worth restoring once the user has actually written something.
export function isWorthSaving(state: AppState): boolean {
  if (!state.mode) return false;
  const wrote = state.draft.agent_request.trim().length > 0;
  const built = state.basket.length > 0 || state.guidedSteps.some((s) => s.description.trim());
  return wrote || built;
}

export function serializeDraftState(state: AppState, savedAt: string): SavedDraft {
  return {
    v: 1,
    screen: state.screen,
    mode: state.mode,
    draft: state.draft,
    guidedSteps: state.guidedSteps,
    guidedIntro: state.guidedIntro,
    guidedDeliverable: state.guidedDeliverable,
    guidedCustomDeliverable: state.guidedCustomDeliverable,
    keyUrls: state.keyUrls,
    attachedUrls: state.attachedUrls,
    activeTemplateId: state.activeTemplate?.id ?? null,
    activeTheme: state.activeTheme,
    removedFromTheme: state.removedFromTheme,
    basketFingerprints: state.basket.map((c) => c.fingerprint || "").filter(Boolean),
    generatedDraft: state.generatedDraft,
    pendingTaskId: state.pendingTaskId,
    pendingCreatedAt: state.pendingCreatedAt,
    savedAt,
  };
}

// Apply a saved draft back onto fresh state. Journeys (basket) are NOT restored
// here — they need a history reload; callers rehydrate the basket separately by
// matching basketFingerprints. Returns the screen to land on.
export function applyDraftState(state: AppState, saved: SavedDraft, template: AppState["activeTemplate"]): Screen {
  state.mode = saved.mode;
  state.draft = saved.draft;
  state.guidedSteps = saved.guidedSteps;
  // Older saves predate these fields — fall back to the state defaults so a
  // stale autosave can't inject undefined.
  state.guidedIntro = saved.guidedIntro ?? state.guidedIntro;
  state.guidedDeliverable = saved.guidedDeliverable ?? state.guidedDeliverable;
  state.guidedCustomDeliverable = saved.guidedCustomDeliverable ?? state.guidedCustomDeliverable;
  state.keyUrls = saved.keyUrls;
  state.attachedUrls = saved.attachedUrls;
  state.activeTemplate = template;
  state.activeTheme = saved.activeTheme;
  state.removedFromTheme = saved.removedFromTheme;
  state.generatedDraft = saved.generatedDraft;
  state.pendingTaskId = saved.pendingTaskId;
  state.pendingCreatedAt = saved.pendingCreatedAt;
  state.requestDirty = true; // restored text is the user's; don't regenerate over it

  // Guided/freeform restore fully. Compose/theme need journeys — if the basket
  // can't be rehydrated (no history loaded), keep the writing but send them to
  // the form rather than an empty picker.
  const historyBacked = saved.mode === "compose" || saved.mode === "theme";
  if (historyBacked && !state.basket.length) return "form";
  return saved.screen;
}
