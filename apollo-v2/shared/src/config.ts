export const APP_NAME = "apollo-v2";
export const APP_VERSION = "0.2.0";
export const CONSENT_VERSION = "2026-07-24";

export const DEFAULT_PRESIGN_ENDPOINT = "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/presign";

// Presign lambda caps uploads at 5 MB; leave headroom for form encoding.
export const MAX_UPLOAD_BYTES = 4_500_000;
export const LONG_TASK_FILENAME = "long_task.json";

function envOverride(key: string): string | undefined {
  const env = (import.meta as { env?: Record<string, string> }).env;
  return env?.[key];
}

export function presignEndpoint(): string {
  return envOverride("VITE_PRESIGN_ENDPOINT") || DEFAULT_PRESIGN_ENDPOINT;
}

// Baked-in review key for the internal team build (VITE_REVIEW_KEY at build
// time). The lambda still verifies every call — this only skips manual entry.
export function defaultReviewKey(): string | null {
  return envOverride("VITE_REVIEW_KEY") || null;
}
