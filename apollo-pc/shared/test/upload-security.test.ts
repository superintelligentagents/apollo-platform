import { describe, expect, it } from "vitest";
import { assertEncryptedPresignFields, assertSecureUploadUrl } from "../src/upload";

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
});
