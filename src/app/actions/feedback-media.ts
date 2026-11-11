"use server";

import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FEEDBACK_MEDIA_TYPES } from "@/lib/feedback-media-limits.mjs";
import { inspectFeedbackMedia } from "@/lib/feedback-media-inspect.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
type Failure = { ok: false; code: "sign_in" | "invalid" | "restricted" | "forbidden" | "conflict" | "quota" | "not_found" | "unavailable" | "failed" };
type ReserveResult = { ok: true; id: string; state: "reserved"; bucket: string; path: string; token: string }
  | { ok: true; id: string; state: "validating" | "verified" } | Failure;
type Verification = { ok: boolean; code?: string; type?: string; size?: number; duration?: number | null; sha256?: string };
type Lease = { id: string; state: string; token?: string; bucket?: string; staging_path?: string; verified_path?: string; type?: string; size?: number };

function validUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

function failure(error?: { message?: string } | null): Failure {
  const message = error?.message ?? "";
  if (message.includes("feedback_sign_in")) return { ok: false, code: "sign_in" };
  if (message.includes("feedback_restricted")) return { ok: false, code: "restricted" };
  if (message.includes("feedback_forbidden")) return { ok: false, code: "forbidden" };
  for (const code of ["invalid", "conflict", "quota", "not_found"] as const) {
    if (message.includes(`feedback_media_${code}`) || message.includes(`feedback_${code}`)) return { ok: false, code };
  }
  return { ok: false, code: "failed" };
}

export interface FeedbackMediaItem {
  id: string; post_id: string; type: string; size: number; duration: number | null;
  review_state: "pending" | "approved" | "rejected"; revision: number; removed: boolean;
}

/** The database projects only media visible to the current viewer. */
export async function readFeedbackMedia(postId: string): Promise<{ ok: true; data: FeedbackMediaItem[] } | Failure> {
  if (!validUuid(postId)) return { ok: false, code: "invalid" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("feedback_media_list", { p_id: postId.toLowerCase() });
    if (error) return failure(error);
    return Array.isArray(data) ? { ok: true, data: data as FeedbackMediaItem[] } : failure();
  } catch { return failure(); }
}

export async function moderateFeedbackMedia(input: { id: string; expectedUserId: string; revision: number; action: "approve" | "reject" | "remove" | "restore"; reason: string }): Promise<{ ok: true; id: string; revision: number } | Failure> {
  if (!input || !validUuid(input.id) || !validUuid(input.expectedUserId) || !Number.isSafeInteger(input.revision)
      || input.revision < 1 || !["approve", "reject", "remove", "restore"].includes(input.action)
      || typeof input.reason !== "string" || input.reason.length > 500 || input.action === "reject" && !input.reason.trim()) return { ok: false, code: "invalid" };
  const id = input.id.toLowerCase();
  try {
    const supabase = await authenticated(input.expectedUserId.toLowerCase());
    if (!supabase) return { ok: false, code: "sign_in" };
    const { data, error } = await supabase.rpc("feedback_media_moderate", { p_id: id, p_revision: input.revision, p_action: input.action, p_reason: input.reason });
    if (error) return failure(error);
    return data?.id === id && Number.isSafeInteger(data.revision) ? { ok: true, id, revision: data.revision } : failure();
  } catch { return failure(); }
}
function validType(value: unknown): value is keyof typeof FEEDBACK_MEDIA_TYPES {
  return typeof value === "string" && Object.hasOwn(FEEDBACK_MEDIA_TYPES, value);
}
function validPaths(bucket: unknown, staging: unknown, verified: unknown, owner: string, id: string, type: unknown) {
  if (!validType(type)) return false;
  const expectedBucket = type.startsWith("image/") ? "feedback-media-images" : "feedback-media-videos";
  return bucket === expectedBucket && staging === `staging/${owner}/${id}` && verified === `verified/${owner}/${id}`;
}
async function authenticated(expectedUser: string) {
  if (!validUuid(expectedUser)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user || data.user.id !== expectedUser.toLowerCase()) return null;
  return supabase;
}

/** Reserve one immutable staging path. This action is not connected to a form yet. */
export async function reserveFeedbackMedia(input: { id: string; draftId: string; expectedUserId: string; type: string; size: number }): Promise<ReserveResult> {
  if (!input || !validUuid(input.id) || !validUuid(input.draftId) || !validUuid(input.expectedUserId)
      || !validType(input.type) || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > FEEDBACK_MEDIA_TYPES[input.type]) return { ok: false, code: "invalid" };
  const id = input.id.toLowerCase(); const draftId = input.draftId.toLowerCase(); const owner = input.expectedUserId.toLowerCase();
  try {
    const supabase = await authenticated(owner);
    if (!supabase) return { ok: false, code: "sign_in" };
    const { data, error } = await supabase.rpc("feedback_media_reserve", { p_id: id, p_draft_id: draftId, p_type: input.type, p_size: input.size });
    if (error) return failure(error);
    if (data?.id !== id || !["reserved", "validating", "verified"].includes(data?.state)) return failure();
    if (data.state !== "reserved") return { ok: true, id, state: data.state };
    if (!validPaths(data.bucket, data.staging_path, `verified/${owner}/${id}`, owner, id, input.type)) return failure();
    const signed = await supabase.storage.from(data.bucket).createSignedUploadUrl(data.staging_path, { upsert: false });
    if (signed.error || !signed.data?.token || signed.data.path !== data.staging_path) return failure();
    return { ok: true, id, state: "reserved", bucket: data.bucket, path: data.staging_path, token: signed.data.token };
  } catch { return failure(); }
}

/** Mark an unattached upload for delayed cleanup; never delete files directly. */
export async function cancelFeedbackMedia(input: { id: string; expectedUserId: string }): Promise<{ ok: true } | Failure> {
  if (!input || !validUuid(input.id) || !validUuid(input.expectedUserId)) return { ok: false, code: "invalid" };
  try {
    const supabase = await authenticated(input.expectedUserId.toLowerCase());
    if (!supabase) return { ok: false, code: "sign_in" };
    const { data, error } = await supabase.rpc("feedback_media_cancel", { p_id: input.id.toLowerCase() });
    if (error) return failure(error);
    return data?.state === "cleanup_pending" ? { ok: true } : failure();
  } catch { return failure(); }
}

/** Validate actual bytes under a service-only lease and copy them to an immutable path. */
export async function verifyFeedbackMedia(input: { id: string; expectedUserId: string }): Promise<{ ok: true; id: string } | Failure> {
  if (!input || !validUuid(input.id) || !validUuid(input.expectedUserId)) return { ok: false, code: "invalid" };
  const id = input.id.toLowerCase(); const owner = input.expectedUserId.toLowerCase();
  let release: (() => Promise<unknown>) | undefined;
  try {
    if (!await authenticated(owner)) return { ok: false, code: "sign_in" };
    const admin = createAdminClient();
    const started = await admin.rpc("feedback_media_begin_validation", { p_id: id, p_owner: owner });
    if (started.error) return failure(started.error);
    const lease = started.data as Lease | null;
    if (lease?.id !== id) return failure();
    if (lease.state === "verified") return { ok: true, id };
    if (lease.state !== "validating" || !validUuid(lease.token)
        || !validPaths(lease.bucket, lease.staging_path, lease.verified_path, owner, id, lease.type)
        || !validType(lease.type) || !Number.isSafeInteger(lease.size) || !lease.size || lease.size <= 0 || lease.size > FEEDBACK_MEDIA_TYPES[lease.type]) return failure();
    const token = lease.token; const bucket = lease.bucket!; const staging = lease.staging_path!; const verified = lease.verified_path!;
    const type = lease.type; const size = lease.size!;
    release = async () => admin.rpc("feedback_media_release_validation", { p_id: id, p_owner: owner, p_token: token });
    const store = admin.storage.from(bucket);
    const source = await store.download(staging, {}, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    if (source.error || !source.data || source.data.size !== size) return failure();
    const bytes = new Uint8Array(await source.data.arrayBuffer());
    const inspected = await inspectFeedbackMedia(bytes, type, size) as Verification;
    if (!inspected.ok) return { ok: false, code: inspected.code === "decoder_unavailable" ? "unavailable" : "invalid" };
    if (inspected.type !== type || inspected.size !== size || !inspected.sha256 || !SHA256.test(inspected.sha256)) return failure();
    const copied = await store.upload(verified, bytes, { contentType: type, upsert: false });
    if (copied.error) {
      // A prior request can have copied the bytes before losing its response.
      // Reuse that immutable object only if it exactly matches this inspected file.
      const previous = await store.download(verified, {}, { signal: AbortSignal.timeout(30000), cache: "no-store" });
      if (previous.error || !previous.data || previous.data.size !== size) return failure();
      const previousDigest = createHash("sha256").update(new Uint8Array(await previous.data.arrayBuffer())).digest("hex");
      if (previousDigest !== inspected.sha256) return failure();
    }
    const completed = await admin.rpc("feedback_media_record_verified", { p_id: id, p_owner: owner, p_token: token, p_sha256: inspected.sha256, p_duration: inspected.duration ?? null });
    if (completed.error) return failure(completed.error);
    if (completed.data?.id !== id || completed.data.state !== "verified") return failure();
    release = undefined;
    return { ok: true, id };
  } catch { return failure(); }
  finally { if (release) { try { await release(); } catch { /* a lost lease expires safely */ } } }
}
