"use server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/admin-guard";
import type { AdminActivityRead } from "@/lib/community-activity-types";

const errorText = (raw?: string) => {
  if (raw?.includes("activity_session")) return "账号已变化，请刷新后重试。";
  if (raw?.includes("activity_forbidden")) return "没有活动管理权限。";
  if (raw?.includes("activity_frozen")) return "已发布的规则、奖励、任务与时间不可修改，请新建活动。";
  if (raw?.includes("activity_reward_exhausted")) return "奖励名额已用尽，不能继续发奖。";
  if (raw?.includes("activity_review_missing")) return "产品体验评价不存在、不属于该用户或不在活动期间。";
  if (raw?.includes("activity_blocked")) return "该用户当前被禁言或列入黑名单，无法发奖。";
  if (raw?.includes("activity_invalid") || raw?.includes("constraint") || raw?.includes("syntax")) return "配置或操作无效，请检查时间、必填字段、题目选项与正确答案。";
  return "活动配置或加载失败，请检查数据库迁移和权限后重试。";
};
export async function readAdminCommunityActivities(expectedUserId: string): Promise<{ data?: AdminActivityRead; error?: string }> {
  try {
    const guard = await requirePermission("manage_campaigns");
    if ("error" in guard) return guard;
    if (guard.profile.id !== expectedUserId) return { error: errorText("activity_session") };
    const client = await createClient();
    const { data, error } = await client.rpc("activity_admin_read", { p_expected_user_id: expectedUserId });
    return error ? { error: errorText(error.message) } : { data: data as AdminActivityRead };
  } catch { return { error: errorText() }; }
}
export async function writeAdminCommunityActivity(expectedUserId: string, action: "save" | "publish" | "cancel" | "approve" | "reject", activityId: string | null, payload: Record<string, unknown> = {}): Promise<{ error?: string; id?: string }> {
  try {
    const guard = await requirePermission("manage_campaigns");
    if ("error" in guard) return guard;
    if (guard.profile.id !== expectedUserId) return { error: errorText("activity_session") };
    const client = await createClient();
    const { data, error } = await client.rpc("activity_admin_write", { p_expected_user_id: expectedUserId, p_action: action, p_activity_id: activityId, p_payload: payload });
    return error ? { error: errorText(error.message) } : { id: data?.id };
  } catch { return { error: errorText() }; }
}
