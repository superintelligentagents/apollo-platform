import { presignEndpoint } from "./config";
import type { EmailPrivacyReview } from "./types";

export type PCAdminKind = "email" | "calendar" | "tasks";

export interface PCAdminBundle {
  bundle_id: string;
  created_at: string;
  participant_id: string;
  participant_name: string;
  participant_email: string;
  email_count: number;
  calendar_count: number;
  task_count: number;
  edited_count: number;
  masked_count: number;
}

export interface PCAdminUser {
  participant_id: string;
  name: string;
  email: string;
  bundles: number;
  email_count: number;
  calendar_count: number;
  task_count: number;
}

export interface PCAdminSummary {
  totals: { bundles: number; email: number; calendar: number; tasks: number };
  users: PCAdminUser[];
  bundles: PCAdminBundle[];
}

export interface PCAdminDetail {
  bundle: PCAdminBundle;
  kind: PCAdminKind;
  protected_emails: string[];
  page: number;
  page_size: number;
  total: number;
  items: PCAdminItem[];
}

export type PCAdminItem = Record<string, unknown> & {
  record?: Record<string, unknown>;
  privacy_review?: EmailPrivacyReview;
  admin_edit?: {
    edited_by: string;
    edited_at: string;
    revision_count: number;
    original_record: Record<string, unknown>;
  };
};

function reviewBase(): string {
  return presignEndpoint().replace(/\/presign\/?$/, "");
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${reviewBase()}/review/pc-admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(json.error || `Admin API error (${response.status})`));
  return json;
}

export async function loadPCAdminSummary(reviewKey: string, adminEmail: string): Promise<PCAdminSummary> {
  return (await post({ reviewKey, admin_email: adminEmail })) as unknown as PCAdminSummary;
}

export async function loadPCAdminDetail(
  reviewKey: string,
  adminEmail: string,
  bundleId: string,
  kind: PCAdminKind,
  page = 0,
  query = ""
): Promise<PCAdminDetail> {
  return (await post({
    reviewKey,
    admin_email: adminEmail,
    action: "detail",
    bundle_id: bundleId,
    kind,
    page,
    page_size: 20,
    query,
  })) as unknown as PCAdminDetail;
}

export async function savePCAdminRecord(
  reviewKey: string,
  adminEmail: string,
  bundleId: string,
  kind: "email" | "calendar",
  itemId: string,
  finalRecord: Record<string, unknown>,
  baseRevisionCount: number
): Promise<{ ok: true; edited_at: string; revision_count: number }> {
  return (await post({
    reviewKey,
    admin_email: adminEmail,
    action: "save",
    bundle_id: bundleId,
    kind,
    item_id: itemId,
    final_record: finalRecord,
    base_revision_count: baseRevisionCount,
  })) as unknown as { ok: true; edited_at: string; revision_count: number };
}
