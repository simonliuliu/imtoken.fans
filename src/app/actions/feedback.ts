"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { FEEDBACK_MODULES, FEEDBACK_STATES, FEEDBACK_MARKS, type FeedbackData, type FeedbackQuery, type FeedbackResult } from "@/lib/feedback";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ["create", "comment", "vote", "comment_vote", "edit", "edit_comment", "merge", "preview_merge", "unmerge"] as const;
type Action = typeof ACTIONS[number];
const configured = () => Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function failure(error: { message?: string; code?: string }): Promise<{ ok: false; error: string; code: string }> {
  const t = await getTranslations("feedbackErrors");
  const known = ["sign_in", "restricted", "forbidden", "invalid", "conflict", "not_found", "parent", "merge_blocked"] as const;
  const kind = known.find((key) => error.message?.includes(`feedback_${key}`));
  if (kind) return { ok: false, code: kind, error: t(kind) };
  if (["PGRST202", "PGRST205", "42P01", "42883"].includes(error.code ?? "")) return { ok: false, code: "migration", error: t("migration") };
  // Do not send SQL internals, connection strings or account data to the browser.
  return { ok: false, code: "request_failed", error: t("request_failed") };
}
async function configFailure() {
  const t = await getTranslations("feedbackErrors");
  return { ok: false as const, code: "configuration", error: t("configuration") };
}
function validText(value: unknown, max: number) { return typeof value === "string" && value.trim().length >= 2 && value.trim().length <= max; }
function validVersion(value: unknown) { return Number.isInteger(value) && Number(value) >= 1; }
function validPayload(action: Action, p: Record<string, unknown>): boolean {
  if (typeof p.id !== "string" || !UUID.test(p.id)) return false;
  if (action === "create" || action === "edit") {
    if (!validText(p.title, 120) || !validText(p.description, 5000) || !FEEDBACK_MODULES.includes(p.module as never)) return false;
  }
  if (action === "edit" && (!validVersion(p.version) || !FEEDBACK_STATES.includes(p.status as never) || !FEEDBACK_MARKS.includes(p.mark as never) || !["published", "hidden"].includes(String(p.visibility)))) return false;
  if (action === "comment" && (!validText(p.body, 2000) || typeof p.request_id !== "string" || !UUID.test(p.request_id) || (p.parent_id != null && (typeof p.parent_id !== "string" || !UUID.test(p.parent_id))))) return false;
  if ((action === "vote" || action === "comment_vote") && typeof p.supported !== "boolean") return false;
  if (action === "edit_comment" && (!validText(p.body, 2000) || !validVersion(p.version) || !FEEDBACK_MARKS.includes(p.mark as never) || !["published", "hidden"].includes(String(p.visibility)))) return false;
  if (["merge", "preview_merge"].includes(action) && (typeof p.other_id !== "string" || !UUID.test(p.other_id) || !validVersion(p.version) || !validVersion(p.other_version))) return false;
  return action !== "unmerge" || validVersion(p.version);
}

export async function readFeedback(query: FeedbackQuery = {}): Promise<FeedbackResult<FeedbackData>> {
  if (!configured()) return configFailure();
  if (query.id != null && !UUID.test(query.id) || (query.query?.length ?? 0) > 120 || !["all", ...FEEDBACK_MODULES].includes(query.module ?? "all") || !["all", ...FEEDBACK_STATES].includes(query.status ?? "all") || !["latest", "oldest", "popular"].includes(query.sort ?? "latest") || !Number.isInteger(query.offset ?? 0) || !Number.isInteger(query.commentOffset ?? 0) || (query.offset ?? 0) < 0 || (query.commentOffset ?? 0) < 0) return failure({ message: "feedback_invalid" });
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("feedback_read", { p_id: query.id ?? null, p_query: query.query?.trim() ?? "", p_module: query.module ?? "all", p_status: query.status ?? "all", p_sort: query.sort ?? "latest", p_offset: query.offset ?? 0, p_comment_offset: query.commentOffset ?? 0 });
    if (error) return failure(error);
    if (!data || !Array.isArray(data.posts) || !data.viewer) return failure({});
    return { ok: true, data: data as FeedbackData };
  } catch { return failure({}); }
}

export async function writeFeedback(action: Action, payload: Record<string, unknown>): Promise<FeedbackResult<{ id: string; comment_id?: string | null; support_count?: number }>> {
  if (!configured()) return configFailure();
  if (!ACTIONS.includes(action) || !payload || typeof payload !== "object" || !validPayload(action, payload)) return failure({ message: "feedback_invalid" });
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user) return failure({ message: "feedback_sign_in" });
    if (authError) return failure(authError);
    if (payload.expected_user_id !== user.id) return failure({ message: "feedback_sign_in" });
    const { data: profile, error: profileError } = await supabase.from("profiles").select("role, muted_until").eq("id", user.id).maybeSingle();
    if (profileError) return failure(profileError);
    if (!profile) return failure({ message: "feedback_sign_in" });
    if (["edit", "edit_comment", "merge", "preview_merge", "unmerge"].includes(action) && profile.role !== "admin") return failure({ message: "feedback_forbidden" });
    const { data: tags, error: tagsError } = await supabase.from("user_tags").select("tag_key").eq("user_id", user.id).eq("tag_key", "blacklisted");
    if (tagsError) return failure(tagsError);
    if (tags?.length || profile.muted_until && new Date(profile.muted_until) > new Date()) return failure({ message: "feedback_restricted" });
    // SQL repeats every authority/governance check and performs writes atomically.
    const { data, error } = await supabase.rpc("feedback_write", { p_action: action, p_payload: payload });
    if (error) return failure(error);
    if (!data?.id) return failure({});
    revalidatePath("/[locale]/community/[section]", "page");
    return { ok: true, data };
  } catch { return failure({}); }
}
