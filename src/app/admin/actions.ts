"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminForAction, requirePermission } from "@/lib/admin-guard";
import { purgeContent, restoreContent, softDeleteContent, type ContentKind } from "@/lib/admin-moderation";
import { refreshBadgesForUser } from "@/lib/badges";
import { notifyBadgeAwarded } from "@/lib/notify";
import { awardXpByRule, revokeContentXp } from "@/lib/xp";
import type { ModerationMode, ModerationTargetType } from "@/lib/moderation/settings";
import type { MuteDuration, Permissions, UserRole, UserTagKey } from "@/lib/types";
import { BADGE_INFO, PERMANENT_MUTE_UNTIL, muteDurationLabel } from "@/lib/types";

// 后台从单页拆成了多页，改动之后要失效的路径不止 /admin 一个。
// 统一在这里列全，避免「在举报页处理完，回收站页还是旧数据」这类不一致。
const ADMIN_PATHS = ["/admin", "/admin/content", "/admin/trash", "/admin/users", "/admin/reports"];

function revalidateAdmin(): void {
  for (const path of ADMIN_PATHS) revalidatePath(path);
}

// 列表页/首页/排行榜上都显示评论数和内容卡片，后台删/恢复内容后需要一并失效。
function revalidatePublicLists(): void {
  revalidatePath("/[locale]/community/[section]", "page");
  revalidatePath("/");
  revalidatePath("/products");
  revalidatePath("/ideas");
  revalidatePath("/leaderboard");
}

// ========== 内容审核设置 ==========

// 内容审核模式（不审核/人工/AI）是全站配置，只有 admin 能改，不下放给 member。
export async function updateModerationMode(
  targetType: ModerationTargetType,
  mode: ModerationMode
): Promise<{ error?: string }> {
  const guard = await requireAdminForAction();
  if ("error" in guard) return { error: guard.error };

  const admin = createAdminClient();
  const { error } = await admin
    .from("moderation_settings")
    .update({ mode, updated_at: new Date().toISOString(), updated_by: guard.profile.id })
    .eq("target_type", targetType);

  if (error) return { error: error.message };
  revalidateAdmin();
  return {};
}

// ========== 审核队列 ==========

export async function moderateQueueItem(
  queueId: string,
  decision: "approved" | "rejected",
  reason?: string
): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const { data: queueItem, error: queueError } = await admin
    .from("moderation_queue")
    .select("id, target_type, target_id")
    .eq("id", queueId)
    .maybeSingle();

  if (queueError) return { error: queueError.message };
  if (!queueItem) return { error: "未找到该审核记录" };

  // 提交和评论分属不同的权限——评论审核模式默认是"不审核"，但 admin 之后可能把它切回
  // 人工/AI，这种情况下应该看 moderate_comments 而不是 moderate_submissions。
  const guard = await requirePermission(
    queueItem.target_type === "submission" ? "moderate_submissions" : "moderate_comments"
  );
  if ("error" in guard) return { error: guard.error };

  const table = queueItem.target_type === "submission" ? "submissions" : "comments";
  const authorColumn = queueItem.target_type === "submission" ? "submitted_by" : "user_id";
  // 提交还要知道是产品还是点子（两者的经验值不一样）。
  const returningColumns = queueItem.target_type === "submission" ? "submitted_by, type" : "user_id";
  const status = decision === "approved" ? "published" : "rejected";

  // 只改还没进回收站的内容：队列面板已经把被删的条目过滤掉了，
  // 但页面数据可能是几分钟前的，这里再挡一次，避免「通过」一条其实已经删掉的内容。
  const { data: targetRow, error: targetError } = await admin
    .from(table)
    .update({ status })
    .eq("id", queueItem.target_id)
    .is("deleted_at", null)
    .select(returningColumns)
    .maybeSingle<Record<string, string>>();

  if (targetError) return { error: targetError.message };
  if (!targetRow) return { error: "这条内容已经被删除了，请刷新页面" };

  await admin
    .from("moderation_queue")
    .update({
      result: decision,
      reason: reason ?? null,
      reviewed_by: guard.profile.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", queueId);

  // member 也可能走到这里，auth.uid() 不一定是 admin，所以 admin_logs 也要用 admin client
  // 写（不能再指望 "is_admin()" 的 RLS 策略放行），权限已经在上面 requirePermission 里查过了。
  await admin.from("admin_logs").insert({
    admin_id: guard.profile.id,
    action: `moderation_${decision}`,
    target_type: queueItem.target_type,
    target_id: queueItem.target_id,
    detail: { reason: reason ?? null },
  });

  // 审核结果决定经验值的去向：通过就发（refId = 内容 id，和"免审直接发布"那条路径共用
  // 同一把幂等钥匙，两边都跑也只会计一次分）；驳回就把可能已经发过的收回。
  const authorId = targetRow[authorColumn];
  if (authorId) {
    if (decision === "approved") {
      await refreshBadgesForUser(authorId);
      await awardXpByRule({
        userId: authorId,
        action:
          queueItem.target_type === "comment"
            ? "comment_posted"
            : targetRow.type === "product"
              ? "submission_product"
              : "submission_idea",
        refType: queueItem.target_type,
        refId: queueItem.target_id,
      });
    } else {
      await revokeContentXp(queueItem.target_type, queueItem.target_id, authorId);
    }
  }

  revalidateAdmin();
  revalidatePublicLists();
  return {};
}

// ========== 内容管理 ==========

export async function setSubmissionStatus(
  submissionId: string,
  status: "published" | "rejected" | "pending"
): Promise<{ error?: string }> {
  const guard = await requirePermission("moderate_submissions");
  if ("error" in guard) return { error: guard.error };

  const admin = createAdminClient();
  const { error } = await admin.from("submissions").update({ status }).eq("id", submissionId);
  if (error) return { error: error.message };

  await admin.from("admin_logs").insert({
    admin_id: guard.profile.id,
    action: `submission_set_status_${status}`,
    target_type: "submission",
    target_id: submissionId,
  });

  revalidateAdmin();
  revalidatePublicLists();
  return {};
}

// 删除提交 = 软删除进回收站，7 天内可恢复。和「设为已驳回」是两件事：
// 驳回的内容作者还能看到、还能改；删除的内容对谁都不可见。
export async function deleteSubmission(submissionId: string, reason?: string): Promise<{ error?: string }> {
  const guard = await requirePermission("moderate_submissions");
  if ("error" in guard) return { error: guard.error };

  const result = await softDeleteContent({
    kind: "submission",
    id: submissionId,
    actorId: guard.profile.id,
    reason,
  });
  if (result.error) return result;

  revalidateAdmin();
  revalidatePublicLists();
  return {};
}

// ========== 回收站 ==========

// 恢复权限跟着内容类型走：恢复提交要 moderate_submissions，恢复评论要 moderate_comments。
export async function restoreTrashItem(kind: ContentKind, id: string): Promise<{ error?: string }> {
  const guard = await requirePermission(kind === "submission" ? "moderate_submissions" : "moderate_comments");
  if ("error" in guard) return { error: guard.error };

  const result = await restoreContent(kind, id, guard.profile.id);
  if (result.error) return result;

  revalidateAdmin();
  revalidatePublicLists();
  return {};
}

// 不等一周、立刻彻底删除，不可撤销，所以只有 admin 能做。
export async function purgeTrashItem(kind: ContentKind, id: string): Promise<{ error?: string }> {
  const guard = await requireAdminForAction();
  if ("error" in guard) return { error: guard.error };

  const result = await purgeContent(kind, id, guard.profile.id);
  if (result.error) return result;

  revalidateAdmin();
  return {};
}

// ========== 用户管理 ==========

// 角色本身（谁是 Admin/Manager/User）只有 admin 能改，不下放。
export async function setUserRole(userId: string, role: UserRole): Promise<{ error?: string }> {
  const guard = await requireAdminForAction();
  if ("error" in guard) return { error: guard.error };
  // 不允许把自己降级：否则一个人手滑就可能把最后一个 admin 变成普通用户，没人能改回来。
  if (userId === guard.profile.id && role !== "admin") return { error: "不能修改自己的角色" };

  const admin = createAdminClient();
  const { error } = await admin.from("profiles").update({ role }).eq("id", userId);
  if (error) return { error: error.message };

  await admin.from("admin_logs").insert({
    admin_id: guard.profile.id,
    action: `user_role_set_${role}`,
    target_type: "profile",
    target_id: userId,
  });

  revalidateAdmin();
  return {};
}

// Manager 的具体权限开关，同样只有 admin 能设置。
export async function setMemberPermissions(userId: string, permissions: Permissions): Promise<{ error?: string }> {
  const guard = await requireAdminForAction();
  if ("error" in guard) return { error: guard.error };

  const admin = createAdminClient();
  const { error } = await admin.from("profiles").update({ permissions }).eq("id", userId);
  if (error) return { error: error.message };

  await admin.from("admin_logs").insert({
    admin_id: guard.profile.id,
    action: "user_permissions_updated",
    target_type: "profile",
    target_id: userId,
    detail: { permissions },
  });

  revalidateAdmin();
  return {};
}

export async function setUserTag(userId: string, tagKey: UserTagKey, on: boolean): Promise<{ error?: string }> {
  const guard = await requirePermission("manage_user_tags");
  if ("error" in guard) return { error: guard.error };

  const admin = createAdminClient();
  if (on) {
    const { error } = await admin
      .from("user_tags")
      .upsert({ user_id: userId, tag_key: tagKey, set_by: guard.profile.id }, { onConflict: "user_id,tag_key" });
    if (error) return { error: error.message };
  } else {
    const { error } = await admin.from("user_tags").delete().eq("user_id", userId).eq("tag_key", tagKey);
    if (error) return { error: error.message };
  }

  await admin.from("admin_logs").insert({
    admin_id: guard.profile.id,
    action: on ? `tag_added_${tagKey}` : `tag_removed_${tagKey}`,
    target_type: "profile",
    target_id: userId,
  });

  revalidateAdmin();
  return {};
}

// 颁发 / 撤销荣誉徽章。granted_by 记下是谁给的，同时也是「人工授予」的标记：
// 自动成就（发过点子、评论过……）的 granted_by 是 null，撤销时会被这里的 not-null 条件挡住，
// 因为撤了下次 refreshBadgesForUser 又会算回来，撤销只对人工徽章有意义。
export async function setUserBadge(userId: string, badgeKey: string, on: boolean): Promise<{ error?: string }> {
  const guard = await requirePermission("grant_badges");
  if ("error" in guard) return { error: guard.error };

  // badge_key 是文本列（不是枚举），必须在应用层校验，否则能写进任意字符串，
  // 前台渲染时 BADGE_INFO[key] 查不到就成了一个空徽章。
  if (!BADGE_INFO[badgeKey]?.grantable) return { error: "这个徽章不支持手动颁发" };

  const admin = createAdminClient();
  if (on) {
    const { error } = await admin
      .from("badges")
      .upsert(
        { user_id: userId, badge_key: badgeKey, level: 1, granted_by: guard.profile.id },
        { onConflict: "user_id,badge_key" }
      );
    if (error) return { error: error.message };
  } else {
    const { error } = await admin
      .from("badges")
      .delete()
      .eq("user_id", userId)
      .eq("badge_key", badgeKey)
      .not("granted_by", "is", null);
    if (error) return { error: error.message };
  }

  // 撤销徽章不发通知：那是纠错动作，特意去戳一下用户没什么意义。
  if (on) await notifyBadgeAwarded(userId, badgeKey);

  await admin.from("admin_logs").insert({
    admin_id: guard.profile.id,
    action: on ? `badge_granted_${badgeKey}` : `badge_revoked_${badgeKey}`,
    target_type: "profile",
    target_id: userId,
  });

  revalidateAdmin();
  revalidatePath("/u");
  return {};
}

// duration=null 表示解除禁言；"permanent" 用 9999 年当到期时间（见 PERMANENT_MUTE_UNTIL）。
export async function muteUser(userId: string, duration: MuteDuration | null): Promise<{ error?: string }> {
  const guard = await requirePermission("moderate_comments");
  if ("error" in guard) return { error: guard.error };
  if (userId === guard.profile.id) return { error: "不能禁言自己" };

  const mutedUntil = mutedUntilFor(duration);

  const admin = createAdminClient();
  const { error } = await admin.from("profiles").update({ muted_until: mutedUntil }).eq("id", userId);
  if (error) return { error: error.message };

  await admin.from("admin_logs").insert({
    admin_id: guard.profile.id,
    action: duration === null ? "user_unmuted" : `user_muted_${duration}`,
    target_type: "profile",
    target_id: userId,
  });

  revalidateAdmin();
  return { };
}

function mutedUntilFor(duration: MuteDuration | null): string | null {
  if (duration === null) return null;
  if (duration === "permanent") return PERMANENT_MUTE_UNTIL;
  return new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString();
}

// ========== 举报处理 ==========

export interface ResolveReportInput {
  // dismiss = 举报不成立，驳回；accept = 举报成立，按下面两个开关执行处置。
  decision: "dismiss" | "accept";
  deleteComment?: boolean;
  muteDuration?: MuteDuration | null;
  note?: string;
}

// 处理一条评论举报。「通过」时可以同时删除评论和禁言作者（两个独立开关），
// 处置结果写进 comment_reports.resolution，「已处理」列表里直接展示，不用再翻 admin_logs。
export async function resolveCommentReport(
  reportId: string,
  input: ResolveReportInput
): Promise<{ error?: string }> {
  const guard = await requirePermission("moderate_comments");
  if ("error" in guard) return { error: guard.error };

  const admin = createAdminClient();
  const { data: report, error: reportError } = await admin
    .from("comment_reports")
    .select("id, comment_id, status")
    .eq("id", reportId)
    .maybeSingle();

  if (reportError) return { error: reportError.message };
  if (!report) return { error: "未找到该举报记录" };
  if (report.status !== "open") return { error: "这条举报已经被处理过了" };

  // 被举报的评论。comment_id 为 null 说明评论已经被回收站清理程序彻底删掉了
  // （外键 on delete set null），这种举报只能驳回或者标记成已处理，没有处置对象。
  const { data: comment } = report.comment_id
    ? await admin.from("comments").select("id, user_id, body").eq("id", report.comment_id).maybeSingle()
    : { data: null };

  const actions: string[] = [];

  if (input.decision === "accept") {
    const wantsMute = input.muteDuration !== undefined && input.muteDuration !== null;
    if ((input.deleteComment || wantsMute) && !comment) {
      return { error: "这条评论已被彻底删除，只能驳回举报" };
    }

    if (input.deleteComment && comment) {
      const result = await softDeleteContent({
        kind: "comment",
        id: comment.id,
        actorId: guard.profile.id,
        reason: input.note || "举报处理：删除评论",
        logAction: "comment_deleted_via_report",
      });
      if (result.error) return result;
      actions.push("删除评论");
    }

    // 禁言的对象是被举报评论的作者，所以必须从评论行上取 user_id，
    // 不能拿举报人或者当前管理员去凑。
    if (wantsMute && comment) {
      const muteResult = await applyMute(comment.user_id, input.muteDuration as MuteDuration, guard.profile.id);
      if (muteResult.error) return muteResult;
      actions.push(`禁言 ${muteDurationLabel(input.muteDuration as MuteDuration)}`);
    }

    if (actions.length === 0) actions.push("举报成立，未采取处置");
  }

  const resolution = [
    input.decision === "dismiss" ? "驳回举报" : actions.join(" + "),
    input.note?.trim() ? `备注：${input.note.trim()}` : null,
  ]
    .filter(Boolean)
    .join("；");

  const { error } = await admin
    .from("comment_reports")
    .update({
      status: input.decision === "dismiss" ? "dismissed" : "resolved",
      resolution,
      // 正文快照：一周后清理程序会把删掉的评论真删掉，届时 comment_id 变 null，
      // 「已处理」列表还要能显示当初被举报的是什么内容。
      comment_snapshot: comment ? comment.body.slice(0, 2000) : null,
      reviewed_by: guard.profile.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", reportId);
  if (error) return { error: error.message };

  revalidateAdmin();
  revalidatePublicLists();
  return {};
}

// 举报处理内部用的禁言：权限已经由外层的 requirePermission("moderate_comments") 查过，
// 这里不再走 muteUser（那是给按钮用的入口，会重复查一次权限）。
async function applyMute(userId: string, duration: MuteDuration, actorId: string): Promise<{ error?: string }> {
  if (userId === actorId) return { error: "不能禁言自己" };

  const admin = createAdminClient();
  const { error } = await admin.from("profiles").update({ muted_until: mutedUntilFor(duration) }).eq("id", userId);
  if (error) return { error: error.message };

  await admin.from("admin_logs").insert({
    admin_id: actorId,
    action: `user_muted_${duration}_via_report`,
    target_type: "profile",
    target_id: userId,
  });
  return {};
}
