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

export function assertSecureUploadUrl(raw: string, purpose = "upload"): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${purpose} URL is invalid.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`${purpose} must use HTTPS.`);
  }
}

export function assertEncryptedPresignFields(fields: Record<string, string>): void {
  if (fields["x-amz-server-side-encryption"] !== "AES256") {
    throw new Error("Presigned upload must require server-side encryption.");
  }
}

export async function requestPresign(endpoint: string, req: PresignRequest): Promise<PresignResponse> {
  assertSecureUploadUrl(endpoint, "Presign endpoint");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participantId: req.participantId,
      studyId: req.studyId,
      taskId: req.taskId,
      filename: req.filename,
      contentType: req.contentType || "application/json",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Presign failed: HTTP ${res.status} ${text.trim()}`.trim());
  }
  const data = (await res.json()) as Partial<PresignResponse>;
  if (!data.url || !data.fields) throw new Error("Presign returned a malformed response.");
  assertSecureUploadUrl(data.url, "Presigned upload");
  assertEncryptedPresignFields(data.fields);
  return { url: data.url, fields: data.fields };
}

export async function uploadViaPresign(
  presign: PresignResponse,
  body: string,
  filename: string,
  contentType = "application/json"
): Promise<void> {
  assertSecureUploadUrl(presign.url, "Presigned upload");
  assertEncryptedPresignFields(presign.fields);
  const formData = new FormData();
  Object.entries(presign.fields).forEach(([k, v]) => formData.append(k, v));
  formData.append("file", new Blob([body], { type: contentType }), filename);
  const res = await fetch(presign.url, { method: "POST", body: formData });
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
