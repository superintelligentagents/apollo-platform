const CHROME_EPOCH_MS = Date.UTC(1601, 0, 1);

// Chrome stores visit_time as microseconds since 1601-01-01 UTC.
export function chromeTimeToIso(ts: number): string {
  return new Date(CHROME_EPOCH_MS + ts / 1000).toISOString();
}
