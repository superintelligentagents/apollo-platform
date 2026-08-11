export const APP_NAME = "apollo-pc";
export const APP_VERSION = "0.2.4";
export const CONSENT_VERSION = "2026-08-12";

export const DEFAULT_PRESIGN_ENDPOINT = "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/presign";

// Presign lambda caps uploads at 5 MB; leave headroom for form encoding.
export const MAX_UPLOAD_BYTES = 4_500_000;
export const MANIFEST_FILENAME = "manifest.json";
export const TASKS_FILENAME = "tasks.json";

// Email bodies are capped at parse time (head + tail) so a full mailbox of
// records stays memory- and upload-sized. Mirrors apollo-v2's visit truncation.
export const MAX_BODY_CHARS = 5000;
export const BODY_KEEP_HEAD = 4000;
export const BODY_KEEP_TAIL = 800;

function envOverride(key: string): string | undefined {
  const env = (import.meta as { env?: Record<string, string> }).env;
  return env?.[key];
}

export function presignEndpoint(): string {
  return envOverride("VITE_PRESIGN_ENDPOINT") || DEFAULT_PRESIGN_ENDPOINT;
}

export function defaultReviewKey(): string | null {
  return envOverride("VITE_REVIEW_KEY") || null;
}
