export type UploadJsonOptions = {
  taskId: string; // the bundle id — validated by the presign lambda's pc/ branch
  filename: string;
  body: string;
  participantId: string;
  studyId?: string;
};

export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

// The seam between shells. Web-only today, but the shape keeps a future
// desktop build possible (mirrors apollo-v2's PlatformAdapter).
export type PlatformAdapter = {
  platform: "web";
  uploadJson(opts: UploadJsonOptions): Promise<void>;
  storage: KeyValueStore;
};

export const STORAGE_KEYS = {
  lastIdentity: "apollo-pc::last_identity",
  reviewKey: "apollo-pc::review_key",
  reviewClaim: "apollo-pc::review_claim",
  trajectoryClaim: "apollo-pc::trajectory_claim",
  // Small hot state only: decisions, rules, tasks, filters. Records live in
  // IndexedDB; the real→alias entity map lives in IndexedDB meta.
  decisions: (participantId: string) => `apollo-pc::decisions::${participantId}`,
  uploadLog: (participantId: string) => `apollo-pc::upload_log::${participantId}`,
};

export interface UploadLogEntry {
  bundle_id: string;
  sources: string[];
  record_count: number;
  source_counts?: Partial<Record<"email" | "calendar", number>>;
  task_count: number;
  at: string;
}

export async function loadUploadLog(storage: KeyValueStore, participantId: string): Promise<UploadLogEntry[]> {
  try {
    const raw = await storage.get(STORAGE_KEYS.uploadLog(participantId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as UploadLogEntry[];
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.bundle_id === "string") : [];
  } catch {
    return [];
  }
}

export async function appendUploadLog(
  storage: KeyValueStore,
  participantId: string,
  entry: UploadLogEntry
): Promise<void> {
  const log = await loadUploadLog(storage, participantId);
  log.push(entry);
  await storage.set(STORAGE_KEYS.uploadLog(participantId), JSON.stringify(log.slice(-200)));
}
