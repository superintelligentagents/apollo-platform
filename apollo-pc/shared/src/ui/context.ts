import type { PlatformAdapter } from "../platform";
import type { RecordStore } from "../store";
import type { PCTemplate } from "../templates";
import type {
  Entity,
  ItemDecision,
  ParticipantIdentity,
  PCTask,
  PrivacyAudit,
  ReplacementRule,
  SourceKind,
  SourceRecord,
} from "../types";
import type { ParseProgress, ParseStats, ParseIssue } from "../sources/types";

export type Screen =
  | "login"
  | "home"
  | "sources"
  | "import-mail"
  | "import-calendar"
  | "items"
  | "upload-email"
  | "upload-calendar"
  | "entities"
  | "tasks"
  | "task-edit"
  | "review"
  | "progress"
  | "task-review-queue"
  | "task-review-edit"
  | "trajectory-queue"
  | "trajectory-edit";

export type Notice = { text: string; tone: "info" | "ok" | "err" };

export type ItemFilters = {
  source: SourceKind | "all";
  from: string;
  to: string;
  query: string;
  queryScope: "all" | "email" | "sender" | "subject";
  status: "all" | "included" | "excluded" | "edited";
  category: string;
  direction: "all" | "received" | "sent";
  correspondent: string;
  service: string;
  domain: string;
  sender: string;
  recurrence: "all" | "recurring" | "one-off";
  linked: "all" | "linked" | "unlinked";
  page: number;
};

export type SourceImportInfo = {
  stats: ParseStats;
  issues: ParseIssue[];
  importedAt: string;
};

export type TaskDraft = {
  taskId: string; // stable across edits
  templateId: string;
  category: PCTask["category"];
  title: string;
  request: string;
  steps: { order: number; title: string; description: string }[];
  successCriteria: string[];
  referencedRecordIds: string[];
  expectedAnswer: string;
  notes: string;
};

export type AppState = {
  screen: Screen;
  identity: ParticipantIdentity | null;
  lastIdentity: ParticipantIdentity | null;
  uploadedCount: number;
  uploadedBySource: { email: number; calendar: number; knownBundles: number; legacyRecords: number };

  // Header-level records in memory; email bodies live in IndexedDB.
  records: Map<string, SourceRecord>;
  // Sparse — absence means the default inclusion for that record.
  decisions: Map<string, ItemDecision>;
  // Compact source-wide choices keep a 100k-message "select all/private"
  // action from creating and serializing 100k identical decisions.
  sourceInclusionDefaults: Partial<Record<SourceKind, boolean>>;
  // Email ids that a mined receipt points back at (promoted to included even
  // when they look promotional).
  receiptEmailIds: Set<string>;
  entities: Entity[];
  entityScope: "people" | "services" | "all";
  entityQuery: string;
  entityPage: number;
  entityIndexing: boolean;
  rules: ReplacementRule[];
  imports: Partial<Record<SourceKind, SourceImportInfo>>;

  tasks: PCTask[];
  taskDraft: TaskDraft | null;
  activeTemplate: PCTemplate | null;
  // Record-picker search inside task-edit.
  pickerQuery: string;
  pickerSource: "all" | "email" | "calendar" | "selected";
  pickerPage: number;
  pickerOpenId: string | null;
  pickerOpenBody: string | null;

  filters: ItemFilters;
  openItemId: string | null;
  openItemBody: string | null; // async-loaded from IndexedDB

  importing: { kind: SourceKind; progress: ParseProgress } | null;
  dateFloorMonths: number; // 0 = everything
  waDateOrder: "auto" | "dmy" | "mdy";

  // Stable across retries so a false-failure retry reuses the same S3 bundle
  // directory (the ingester dedupes by newest manifest).
  bundleId: string | null;
  bundleCreatedAt: string | null;
  uploadProgress: string | null;
  privacyAudit: PrivacyAudit | null;

  busy: string | null;
  notice: Notice | null;
  formErrors: Record<string, string>;
  reviewKey: string | null;
  reviewClaim: import("../review-client").ReviewClaim | null;
  reviewRubrics: import("../review-client").RubricRow[] | null;
  reviewEdits: { title: string; request: string; difficulty: string; evergreenChecked?: boolean } | null;
  trajectoryClaim: import("../review-client").TrajectoryClaim | null;
  trajectoryJudgment: import("../review-client").TrajectoryJudgmentDraft | null;
};

export type Ctx = {
  state: AppState;
  adapter: PlatformAdapter;
  store: RecordStore;
  rerender(): void;
  autosave(): void;
  update(patch: Partial<AppState>): void;
  actions: {
    login(identity: ParticipantIdentity): Promise<void>;
    goto(screen: Screen): void;
    importFiles(kind: SourceKind, files: File[]): Promise<void>;
    defaultIncluded(record: SourceRecord): boolean;
    isIncluded(record: SourceRecord): boolean;
    decisionFor(id: string): ItemDecision;
    invalidatePrivacyAudit(): void;
    toggleInclude(id: string): void;
    bulkInclude(ids: string[], included: boolean): void;
    bulkIncludeSources(sources: SourceKind[], included: boolean): void;
    setFieldEdit(id: string, field: string, value: string | null): void;
    setBodyEdit(id: string, value: string | null): void;
    openItem(id: string | null): void;
    updateEntity(entityId: string, patch: Partial<Entity>): void;
    addRule(rule: ReplacementRule): void;
    removeRule(index: number): void;
    startTask(template: PCTemplate): void;
    editTask(taskId: string): void;
    saveTaskDraft(): boolean;
    deleteTask(taskId: string): void;
    toggleTaskRecord(recordId: string): void;
    submitBundle(): Promise<void>;
    eraseAll(): Promise<void>;
    notifyInfo(message: string): void;
    notifyError(message: string): void;
    reviewerName(): string;
    reviewerPid(): string;
    startReview(claim: import("../review-client").ReviewClaim): void;
    endReview(message: string): void;
    startTrajectoryReview(claim: import("../review-client").TrajectoryClaim): void;
    endTrajectoryReview(message: string): void;
  };
};

export function emptyFilters(): ItemFilters {
  return { source: "all", from: "", to: "", query: "", queryScope: "all", status: "all", category: "all", direction: "all", correspondent: "", service: "", domain: "", sender: "", recurrence: "all", linked: "all", page: 0 };
}

export function initialState(): AppState {
  return {
    screen: "login",
    identity: null,
    lastIdentity: null,
    uploadedCount: 0,
    uploadedBySource: { email: 0, calendar: 0, knownBundles: 0, legacyRecords: 0 },
    records: new Map(),
    decisions: new Map(),
    sourceInclusionDefaults: {},
    receiptEmailIds: new Set(),
    entities: [],
    entityScope: "people",
    entityQuery: "",
    entityPage: 0,
    entityIndexing: false,
    rules: [],
    imports: {},
    tasks: [],
    taskDraft: null,
    activeTemplate: null,
    pickerQuery: "",
    pickerSource: "all",
    pickerPage: 0,
    pickerOpenId: null,
    pickerOpenBody: null,
    filters: emptyFilters(),
    openItemId: null,
    openItemBody: null,
    importing: null,
    dateFloorMonths: 12,
    waDateOrder: "auto",
    bundleId: null,
    bundleCreatedAt: null,
    uploadProgress: null,
    privacyAudit: null,
    busy: null,
    notice: null,
    formErrors: {},
    reviewKey: null,
    reviewClaim: null,
    reviewRubrics: null,
    reviewEdits: null,
    trajectoryClaim: null,
    trajectoryJudgment: null,
  };
}
