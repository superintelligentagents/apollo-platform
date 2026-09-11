import { describe, expect, it } from "vitest";
import {
  assertEncryptedPresignFields,
  assertSecureUploadUrl,
  completeUploadedObject,
  uploadCompletionEndpoint,
} from "../src/upload";
import { afterEach, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("upload transport policy", () => {
  it("requires HTTPS outside local development", () => {
    expect(() => assertSecureUploadUrl("https://uploads.example.com/form")).not.toThrow();
    expect(() => assertSecureUploadUrl("http://localhost:4000/presign")).not.toThrow();
    expect(() => assertSecureUploadUrl("http://127.0.0.1:4000/presign")).not.toThrow();
    expect(() => assertSecureUploadUrl("http://uploads.example.com/form")).toThrow("must use HTTPS");
    expect(() => assertSecureUploadUrl("not-a-url")).toThrow("invalid");
  });

  it("requires the presigned form to enforce server-side encryption", () => {
    expect(() => assertEncryptedPresignFields({ "x-amz-server-side-encryption": "AES256" })).not.toThrow();
    expect(() => assertEncryptedPresignFields({})).toThrow("server-side encryption");
    expect(() => assertEncryptedPresignFields({ "x-amz-server-side-encryption": "aws:kms" })).toThrow("server-side encryption");
  });

  it("acknowledges a completed upload through the matching API", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(uploadCompletionEndpoint("https://api.example.com/presign")).toBe("https://api.example.com/upload/complete");
    await completeUploadedObject("https://api.example.com/presign", {
      url: "https://bucket.example.com",
      fields: {},
      key: "prolific/journeys/pid/pc/pid/internal/bundle-fixture/1_review_task_a.json",
      completion: { token: "signed-token", expires_at: 1234 },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/upload/complete", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      key: "prolific/journeys/pid/pc/pid/internal/bundle-fixture/1_review_task_a.json",
      token: "signed-token",
      expires_at: 1234,
    });
  });
});
