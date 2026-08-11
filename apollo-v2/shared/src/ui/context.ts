import type { Cluster, Difficulty, GuidedStep, ParticipantIdentity, ProfileOption, TaskMode, ThemeSuggestion } from "../types";
import type { PlatformAdapter } from "../platform";
import type { DeliverableKind, TaskTemplate } from "../templates";

export type Screen =
  | "login"
  | "home"
  | "submit"
  | "history"
  | "compose"
  | "themes"
  | "guided"
  | "form"
  | "review"
  | "examples"
  | "progress"
  | "review-queue"
  | "review-edit"
  | "trajectory-queue"
  | "trajectory-edit";

export type TaskDraft = {
  task_title: string;
  agent_request: string;
  task_summary: string;
  difficulty: Difficulty | "";
  site_scope: string[];
  success_criteria: string[];
  required_outputs: string[];
  notes: string;
};

export type Notice = { text: string; tone: "info" | "ok" | "err" };

export type AppState = {
  screen: Screen;
  identity: ParticipantIdentity | null;
  lastIdentity: ParticipantIdentity | null;
  uploadedCount: number;
  reviewedCount: number;
  profiles: ProfileOption[] | null;
  selectedProfilePath: string | null;
  journeys: Cluster[];
  historyLoaded: boolean;
  busy: string | null;
  mode: TaskMode | null;
  basket: Cluster[];
  suggestions: ThemeSuggestion[] | null;
  activeTheme: ThemeSuggestion | null;
  removedFromTheme: string[];
  draft: TaskDraft;
  // What the auto-draft was generated from/as — lets us refresh a stale,
  // still-unedited draft when the journey selection changes.
  draftBasketKey: string;
  lastDraftTitle: string;
  // The exact generated request text, retained to measure how much the author
  // actually edited (a low-effort signal). Null when hand-written from blank.
  generatedDraft: string | null;
  // True when a saved autosave for the last identity exists at mount.
  hasResumableDraft: boolean;
  // After a resume of a history-backed task, the basket to rebuild once the
  // user reloads their history (journeys aren't persisted).
  pendingBasketFingerprints: string[];
  // True once the user edits site chips by hand — stops auto re-derivation.
  scopeDirty: boolean;
  // True once the user types in the request box — their words are never overwritten.
  requestDirty: boolean;
  // Stable across retries of the same draft so a false-failure retry can't
  // create a second S3 object with a different task_id.
  pendingTaskId: string | null;
  pendingCreatedAt: string | null;
  keyUrls: string[];
  attachedUrls: string[];
  activeTemplate: TaskTemplate | null;
  guidedIntro: string;
  guidedDeliverable: DeliverableKind;
  // The author's own words when guidedDeliverable === "custom".
  guidedCustomDeliverable: string;
  guidedSteps: GuidedStep[];
  notice: Notice | null;
  formErrors: Record<string, string>;
  processed: Set<string>;
  // where to return after loading history
  afterHistory: Screen | null;
  // Reviewing: the shared-secret key (persisted per device), the currently
  // claimed task + lock token, and the working rubric rows.
  reviewKey: string | null;
  reviewClaim: import("../review-client").ReviewClaim | null;
  reviewRubrics: import("../review-client").RubricRow[] | null;
  // Title/request/difficulty edits survive re-renders and refreshes (rubrics
  // already live in reviewRubrics). Null = not yet edited, seed from the task.
  reviewEdits: { title: string; request: string; difficulty: string; evergreenChecked?: boolean } | null;
  trajectoryClaim: import("../review-client").TrajectoryClaim | null;
  trajectoryJudgment: import("../review-client").TrajectoryJudgmentDraft | null;
};

export type Ctx = {
  state: AppState;
  adapter: PlatformAdapter;
  update(patch: Partial<AppState>): void;
  rerender(): void;
  // Debounced persist of the in-progress task (called from nav + input paths).
  autosave(): void;
  actions: {
    login(identity: ParticipantIdentity): Promise<void>;
    resumeDraft(): Promise<void>;
    discardDraft(): Promise<void>;
    goto(screen: Screen): void;
    startMode(mode: TaskMode): void;
    detectProfiles(): Promise<void>;
    loadHistory(source: ProfileOption | File | "chrome-extension"): Promise<void>;
    pickTheme(theme: ThemeSuggestion): void;
    pickTemplate(template: TaskTemplate): void;
    finishGuided(): void;
    toggleJourney(c: Cluster): void;
    clearBasket(): void;
    moveJourney(index: number, delta: number): void;
    removeJourney(index: number): void;
    continueToForm(): void;
    continueToReview(): boolean;
    uploadTask(): Promise<void>;
    // Reviewing
    setReviewKey(key: string | null): void;
    reviewerName(): string;
    // The signed-in reviewer's participant id (slugified email) — the same id
    // embedded in their own submissions' sub_keys. Empty when not logged in.
    reviewerPid(): string;
    startReview(claim: import("../review-client").ReviewClaim): void;
    endReview(message: string): void;
    startTrajectoryReview(claim: import("../review-client").TrajectoryClaim): void;
    endTrajectoryReview(message: string): void;
    notifyInfo(message: string): void;
    notifyError(message: string): void;
  };
};

export function emptyDraft(): TaskDraft {
  return {
    task_title: "",
    agent_request: "",
    task_summary: "",
    difficulty: "high", // all collected tasks are long-horizon by definition
    site_scope: [],
    success_criteria: [""],
    required_outputs: [],
    notes: "",
  };
}

export function initialState(): AppState {
  return {
    screen: "login",
    identity: null,
    lastIdentity: null,
    uploadedCount: 0,
    reviewedCount: 0,
    profiles: null,
    selectedProfilePath: null,
    journeys: [],
    historyLoaded: false,
    busy: null,
    mode: null,
    basket: [],
    suggestions: null,
    activeTheme: null,
    removedFromTheme: [],
    draft: emptyDraft(),
    draftBasketKey: "",
    lastDraftTitle: "",
    generatedDraft: null,
    hasResumableDraft: false,
    pendingBasketFingerprints: [],
    scopeDirty: false,
    requestDirty: false,
    pendingTaskId: null,
    pendingCreatedAt: null,
    keyUrls: [],
    attachedUrls: [],
    activeTemplate: null,
    guidedIntro: "",
    guidedDeliverable: "doc",
    guidedCustomDeliverable: "",
    guidedSteps: [],
    notice: null,
    formErrors: {},
    processed: new Set(),
    afterHistory: null,
    reviewKey: null,
    reviewClaim: null,
    reviewRubrics: null,
    reviewEdits: null,
    trajectoryClaim: null,
    trajectoryJudgment: null,
  };
}
