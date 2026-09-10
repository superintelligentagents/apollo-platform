export const APP_NAME = "apollo-pc";
export const APP_VERSION = "0.5.3";
export const CONSENT_VERSION = "2026-08-12";

export const DEFAULT_PRESIGN_ENDPOINT = "https://t1ynh195m1.execute-api.us-east-1.amazonaws.com/presign";

// Presign lambda caps uploads at 5 MB; leave headroom for form encoding.
export const MAX_UPLOAD_BYTES = 4_500_000;
export const MANIFEST_FILENAME = "manifest.json";
export const TASKS_FILENAME = "tasks.json";

// Email bodies are capped at parse time (head + tail) so a full mailbox of
// records stays memory- and upload-sized. Mirrors apollo-v2's visit truncation.
export const MAX_BODY_CHARS = 5000;
export const BODY_KEEP_HEAD = 4000;
export const BODY_KEEP_TAIL = 800;

// Documents are often the primary task context (for example, a resume), so
// preserve substantially more text than an individual email body. The final
// bundle still has the existing per-part upload limit and privacy review.
export const MAX_DOCUMENT_CHARS = 200_000;

export function presignEndpoint(): string {
  // Substitute only the public endpoint; never serialize the complete Vite environment.
  return (import.meta as ImportMeta & { env: { VITE_PRESIGN_ENDPOINT?: string } }).env.VITE_PRESIGN_ENDPOINT || DEFAULT_PRESIGN_ENDPOINT;
}
