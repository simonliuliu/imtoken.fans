"use server";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import type { ActivityRead } from "@/lib/community-activity-types";
import { getCheckinState, getLotteryState } from "@/lib/activities";
import type { CheckinState, LotteryState } from "@/lib/activity-types";
import { getCommunityPosts } from "@/lib/community";
import type { DemoPost } from "@/lib/community-demo";

const errors = ["session", "forbidden", "invalid", "unavailable", "not_started", "ended", "blocked", "frozen", "not_joined", "already_submitted", "attempts_exhausted", "evidence", "checkin_missing", "review_missing", "reward_exhausted", "quiz_wrong"] as const;
async function message(raw?: string) {
  const t = await getTranslations("activityCenter.errors");
  const key = errors.find((key) => raw?.includes(`activity_${key}`));
  return t(key ?? "load");
}
export async function readCommunityActivities(expectedUserId: string | null, activityId?: string): Promise<{ data?: ActivityRead; error?: string }> {
  try {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if ((user?.id ?? null) !== expectedUserId) return { error: await message("activity_session") };
    const { data, error } = await client.rpc("activity_read", { p_expected_user_id: expectedUserId, p_activity_id: activityId ?? null });
    return error ? { error: await message(error.message) } : { data: data as ActivityRead };
  } catch { return { error: await message() }; }
}
export async function readActivityCommunityPosts(expectedUserId: string | null): Promise<{ data?: DemoPost[]; error?: string }> {
  try {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if ((user?.id ?? null) !== expectedUserId) return { error: await message("activity_session") };
    return { data: await getCommunityPosts("activities") };
  } catch { return { error: await message() }; }
}
export async function writeCommunityActivity(expectedUserId: string, activityId: string, action: "join" | "follow" | "unfollow" | "checkin" | "quiz" | "submit", payload: { answer?: number; evidence?: string } = {}): Promise<{ error?: string }> {
  try {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user || user.id !== expectedUserId) return { error: await message("activity_session") };
    const { data, error } = await client.rpc("activity_write", { p_expected_user_id: expectedUserId, p_activity_id: activityId, p_action: action, p_payload: payload });
    return error || data?.ok === false ? { error: await message(error?.message ?? data?.error) } : {};
  } catch { return { error: await message() }; }
}
export async function readCheckinLottery(expectedUserId: string | null): Promise<{ data?: { checkin: CheckinState; lottery: LotteryState }; error?: string }> {
  try {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if ((user?.id ?? null) !== expectedUserId) return { error: await message("activity_session") };
    const checks = await Promise.all([
      client.from("checkin_settings").select("id").eq("id", true).single(),
      client.from("lottery_settings").select("id").eq("id", true).single(),
      client.from("lottery_prizes").select("id").limit(1),
    ]);
    if (checks.some((r) => r.error)) return { error: await message() };
    const [checkin, lottery] = await Promise.all([getCheckinState(expectedUserId), getLotteryState(expectedUserId)]);
    return { data: { checkin, lottery } };
  } catch { return { error: await message() }; }
}
