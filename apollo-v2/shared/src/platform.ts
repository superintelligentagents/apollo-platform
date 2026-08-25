import type { Cluster, ProfileOption } from "./types";

export type UploadJsonOptions = {
  taskId: string;
  filename: string;
  body: string;
  participantId: string;
  studyId?: string;
};

export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

// The single seam between the Tauri and web clients. Everything else —
// clustering, themes, schema, screens — is shared.
export type PlatformAdapter = {
  platform: "tauri" | "web";
  // Tauri: enumerate Chrome profiles. Web: null (the user picks a History file).
  detectProfiles(): Promise<ProfileOption[] | null>;
  // Returns raw clusters; callers run prepareJourneys() on the result.
  // "chrome-extension" reads via the helper extension (web only).
  loadClusters(source: ProfileOption | File | "chrome-extension"): Promise<Cluster[]>;
  // Resolves true when the Apollo History Helper extension is installed.
  detectExtension?(): Promise<boolean>;
  uploadJson(opts: UploadJsonOptions): Promise<void>;
  storage: KeyValueStore;
  // Web-only (File System Access API): a page can never read the History
  // file silently — but after one manual pick, the remembered handle makes
  // every later re-read a single click. Absent on desktop (native reads).
  pickHistoryFile?(): Promise<File | null>;
  readSavedHistoryFile?(): Promise<File | null>;
  hasSavedHistoryHandle?(): Promise<boolean>;
};

export const STORAGE_KEYS = {
  lastIdentity: "apollo-v2::last_identity",
  // Namespaced per participant so one person's submissions don't hide
  // journeys from another annotator on the same installation.
  processedFingerprints: (participantId: string) => `apollo-v2::processed_fingerprints::${participantId}`,
  uploadCount: (participantId: string, session: string) => `apollo-v2::uploads::${participantId}::${session}`,
  reviewCount: (participantId: string) => `apollo-v2::reviews::${participantId}`,
  // In-progress task, so a mid-task refresh can offer Resume instead of losing work.
  draftAutosave: (participantId: string) => `apollo-v2::draft::${participantId}`,
  // One line per successful upload, so the participant can see their own stats.
  uploadLog: (participantId: string) => `apollo-v2::upload_log::${participantId}`,
  // Shared-secret key that unlocks the reviewer flow on this device.
  reviewKey: "apollo-v2::review_key",
  // The in-flight claim + edits, so a refresh mid-review resumes instead of
  // stranding the lock for its full TTL.
  reviewClaim: "apollo-v2::review_claim",
  trajectoryClaim: "apollo-v2::trajectory_claim",
};

export interface UploadLogEntry {
  task_id: string;
  title: string;
  mode: string;
  level: string;
  strength?: string;
  score?: number;
  at: string; // ISO timestamp
  region?: string;
  subjects?: string[];
}

export async function loadUploadLog(storage: KeyValueStore, participantId: string): Promise<UploadLogEntry[]> {
  try {
    const raw = await storage.get(STORAGE_KEYS.uploadLog(participantId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as UploadLogEntry[];
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.task_id === "string") : [];
  } catch {
    return [];
  }
}

export async function appendUploadLog(
  storage: KeyValueStore,
  participantId: string,
  entry: UploadLogEntry
): Promise<UploadLogEntry[]> {
  const log = await loadUploadLog(storage, participantId);
  log.push(entry);
  const capped = log.slice(-500);
  await storage.set(STORAGE_KEYS.uploadLog(participantId), JSON.stringify(capped));
  return capped;
}

export async function loadProcessedFingerprints(storage: KeyValueStore, participantId: string): Promise<Set<string>> {
  try {
    const raw = await storage.get(STORAGE_KEYS.processedFingerprints(participantId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr.filter((s) => typeof s === "string" && s.length > 0));
  } catch {
    return new Set();
  }
}

export async function addProcessedFingerprints(
  storage: KeyValueStore,
  participantId: string,
  fingerprints: string[]
): Promise<void> {
  const existing = await loadProcessedFingerprints(storage, participantId);
  for (const fp of fingerprints) if (fp) existing.add(fp);
  await storage.set(STORAGE_KEYS.processedFingerprints(participantId), JSON.stringify([...existing].sort()));
}

export async function loadUploadCount(storage: KeyValueStore, participantId: string, session: string): Promise<number> {
  try {
    const raw = await storage.get(STORAGE_KEYS.uploadCount(participantId, session));
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function loadReviewCount(storage: KeyValueStore, participantId: string): Promise<number> {
  try {
    const raw = await storage.get(STORAGE_KEYS.reviewCount(participantId));
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function incrementUploadCount(
  storage: KeyValueStore,
  participantId: string,
  session: string
): Promise<number> {
  const current = await loadUploadCount(storage, participantId, session);
  const next = current + 1;
  await storage.set(STORAGE_KEYS.uploadCount(participantId, session), String(next));
  return next;
}
