import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { awardXpByRule, revokeContentXp } from "@/lib/xp";
import type { SubmissionStatus } from "@/lib/types";

// 软删除 / 恢复 / 彻底删除的共用实现。评论和提交两张表的列名一样
// （deleted_at / deleted_by / delete_reason / deleted_prev_status，见 0014 迁移），
// 所以只用 kind 决定表名，逻辑完全共用。
//
// 「删除」为什么既打 deleted_at 又把 status 置成 rejected：
// 前台的可见性靠 deleted_at is null 过滤（应用层），status 是数据库 RLS 那一层的兜底——
// 万一以后新加的查询忘了过滤 deleted_at，RLS 也不会把它当已发布内容放出去。
// 恢复时用 deleted_prev_status 把状态原样还回去。

export type ContentKind = "comment" | "submission";

const TABLE: Record<ContentKind, string> = { comment: "comments", submission: "submissions" };

// 删除/恢复要同时处理经验值，所以读行时把作者（和提交的类型）一起取出来。
// 两张表的作者列名不一样：评论是 user_id，提交是 submitted_by。
const READ_COLUMNS: Record<ContentKind, string> = {
  comment: "id, status, deleted_at, deleted_prev_status, user_id",
  submission: "id, status, deleted_at, deleted_prev_status, submitted_by, type",
};

function authorIdOf(kind: ContentKind, row: Record<string, unknown>): string | null {
  return ((kind === "comment" ? row.user_id : row.submitted_by) as string | null) ?? null;
}

interface SoftDeleteParams {
  kind: ContentKind;
  id: string;
  actorId: string;
  reason?: string;
  logAction?: string;
}

export async function softDeleteContent(params: SoftDeleteParams): Promise<{ error?: string }> {
  const { kind, id, actorId, reason, logAction } = params;
  const admin = createAdminClient();
  const table = TABLE[kind];

  const { data: row, error: readError } = await admin
    .from(table)
    .select(READ_COLUMNS[kind])
    .eq("id", id)
    .maybeSingle<Record<string, unknown>>();

  if (readError) return { error: readError.message };
  if (!row) return { error: kind === "comment" ? "未找到该评论" : "未找到该内容" };
  // 已经在回收站里了就当成功——两个人同时点删除、或者举报处理里连带删除，不该报错。
  if (row.deleted_at) return {};

  const { error } = await admin
    .from(table)
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: actorId,
      delete_reason: reason?.trim() || null,
      deleted_prev_status: row.status,
      status: "rejected",
    })
    .eq("id", id);

  if (error) return { error: error.message };

  // 内容没了，它带来的经验也要收回，否则「发一堆水内容拿分，被删了分还留着」。
  // revokeXp 是幂等的（流水上打 revoked_at），重复删除不会重复扣。
  const authorId = authorIdOf(kind, row);
  if (authorId) await revokeContentXp(kind, id, authorId);

  await admin.from("admin_logs").insert({
    admin_id: actorId,
    action: logAction ?? `${kind}_deleted`,
    target_type: kind,
    target_id: id,
    detail: { reason: reason?.trim() || null },
  });

  return {};
}

export async function restoreContent(kind: ContentKind, id: string, actorId: string): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const table = TABLE[kind];

  const { data: row, error: readError } = await admin
    .from(table)
    .select(READ_COLUMNS[kind])
    .eq("id", id)
    .maybeSingle<Record<string, unknown>>();

  if (readError) return { error: readError.message };
  if (!row) return { error: "这条内容已经被彻底删除，无法恢复" };
  if (!row.deleted_at) return { error: "这条内容不在回收站里" };

  const restoredStatus = (row.deleted_prev_status as SubmissionStatus | null) ?? "pending";

  const { error } = await admin
    .from(table)
    .update({
      deleted_at: null,
      deleted_by: null,
      delete_reason: null,
      deleted_prev_status: null,
      status: restoredStatus,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  // 恢复成"已发布"才把经验补回去。恢复成 pending 的先不给，
  // 等审核通过时由 moderateQueueItem 那条路径补（避免绕过审核先拿分）。
  const authorId = authorIdOf(kind, row);
  if (authorId && restoredStatus === "published") {
    await awardXpByRule({
      userId: authorId,
      action:
        kind === "comment"
          ? "comment_posted"
          : row.type === "post" ? "submission_post" : row.type === "product"
            ? "submission_product"
            : "submission_idea",
      refType: kind,
      refId: id,
    });
  }

  await admin.from("admin_logs").insert({
    admin_id: actorId,
    action: `${kind}_restored`,
    target_type: kind,
    target_id: id,
  });

  return {};
}

// 不等一周、立刻彻底删除。只有 admin 能做（调用方检查），日志先写再删——
// 删完之后 target_id 指向的行就不存在了，admin_logs.target_id 没有外键约束，留着当审计线索。
export async function purgeContent(kind: ContentKind, id: string, actorId: string): Promise<{ error?: string }> {
  const admin = createAdminClient();

  await admin.from("admin_logs").insert({
    admin_id: actorId,
    action: `${kind}_purged`,
    target_type: kind,
    target_id: id,
  });

  const { error } = await admin.from(TABLE[kind]).delete().eq("id", id).not("deleted_at", "is", null);
  if (error) return { error: error.message };
  return {};
}
