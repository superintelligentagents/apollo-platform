// Read-only production load probe for author history. It creates no records.

const endpoint = process.env.E2E_PC_REVIEW_ENDPOINT
  || "https://t1ynh195m1.execute-api.us-east-1.amazonaws.com";
const reviewKey = process.env.E2E_PC_REVIEW_KEY || "";
const requestCount = Math.max(1, Number(process.env.E2E_LOAD_REQUESTS) || 200);
const timeoutMs = Math.max(1_000, Number(process.env.E2E_LOAD_TIMEOUT_MS) || 30_000);

if (!reviewKey) throw new Error("E2E_PC_REVIEW_KEY is required");

async function readHistory(participantId) {
  const started = performance.now();
  try {
    const response = await fetch(`${endpoint}/review/my-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewKey,
        participant_id: participantId,
        offset: 0,
        limit: 10,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok && Array.isArray(body.items),
      status: response.status,
      ms: performance.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.name : "Error",
      ms: performance.now() - started,
    };
  }
}

const stamp = Date.now().toString(36);
const participantIds = Array.from(
  { length: requestCount },
  (_, index) => `load-probe-${stamp}-${String(index).padStart(4, "0")}`,
);
const wallStarted = performance.now();
const first = await Promise.all(participantIds.map(readHistory));
const failedIndexes = first.flatMap((result, index) => result.ok ? [] : [index]);

// A browser can safely retry this read-only request. Record both the raw burst
// and eventual result so transport noise is visible rather than hidden.
const retries = failedIndexes.length
  ? await Promise.all(failedIndexes.map(async (index) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return readHistory(participantIds[index]);
    }))
  : [];

const final = [...first];
failedIndexes.forEach((index, retryIndex) => {
  final[index] = retries[retryIndex];
});
const latencies = first.map((result) => result.ms).sort((a, b) => a - b);
const percentile = (fraction) => Math.round(
  latencies[Math.min(latencies.length - 1, Math.floor(fraction * latencies.length))] || 0,
);
const statusCounts = {};
for (const result of first) statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;

const summary = {
  requests: requestCount,
  first_attempt_successful: first.filter((result) => result.ok).length,
  first_attempt_failed: failedIndexes.length,
  recovered_by_retry: retries.filter((result) => result.ok).length,
  final_failed: final.filter((result) => !result.ok).length,
  status_counts: statusCounts,
  wall_ms: Math.round(performance.now() - wallStarted),
  p50_ms: percentile(0.50),
  p95_ms: percentile(0.95),
  p99_ms: percentile(0.99),
  max_ms: Math.round(latencies.at(-1) || 0),
};
console.log(JSON.stringify(summary, null, 2));

if (summary.final_failed) throw new Error(`${summary.final_failed} author-history requests failed after retry`);
if (summary.p95_ms > 5_000) throw new Error(`Author-history p95 ${summary.p95_ms}ms exceeds 5000ms`);
