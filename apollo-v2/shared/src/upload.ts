export type PresignResponse = {
  url: string;
  fields: Record<string, string>;
};

export type PresignRequest = {
  participantId: string;
  studyId?: string;
  taskId: string;
  filename: string;
  contentType?: string;
};

const RETRY_ATTEMPTS = 4;

export function shouldRetryUploadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function uploadRetryDelayMs(attempt: number, random = Math.random()): number {
  const base = Math.min(2_000, 250 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random * 0.5));
}

async function retryFetch(makeRequest: () => Promise<Response>): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await makeRequest();
      if (!shouldRetryUploadStatus(response.status) || attempt === RETRY_ATTEMPTS - 1) return response;
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, uploadRetryDelayMs(attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error("Upload request failed after retries.");
}

export async function requestPresign(endpoint: string, req: PresignRequest): Promise<PresignResponse> {
  const res = await retryFetch(() => fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participantId: req.participantId,
      studyId: req.studyId,
      taskId: req.taskId,
      filename: req.filename,
      contentType: req.contentType || "application/json",
    }),
  }));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Presign failed: HTTP ${res.status} ${text.trim()}`.trim());
  }
  const data = (await res.json()) as Partial<PresignResponse>;
  if (!data.url || !data.fields) throw new Error("Presign returned a malformed response.");
  return { url: data.url, fields: data.fields };
}

export async function uploadViaPresign(
  presign: PresignResponse,
  body: string,
  filename: string,
  contentType = "application/json"
): Promise<void> {
  const res = await retryFetch(() => {
    // Rebuild the multipart body for every attempt so a browser never has to
    // reuse an already-consumed request body after a transient failure.
    const formData = new FormData();
    Object.entries(presign.fields).forEach(([k, v]) => formData.append(k, v));
    formData.append("file", new Blob([body], { type: contentType }), filename);
    return fetch(presign.url, { method: "POST", body: formData });
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status} ${res.statusText}`);
}

// Browser upload path: presign + multipart POST in one call. The Tauri client
// uses the equivalent Rust `upload_json` command instead.
export async function uploadJsonBrowser(
  endpoint: string,
  req: PresignRequest,
  body: string
): Promise<void> {
  const presign = await requestPresign(endpoint, req);
  await uploadViaPresign(presign, body, req.filename);
}
