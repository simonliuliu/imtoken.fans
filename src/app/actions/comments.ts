"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runModerationPipeline } from "@/lib/moderation/pipeline";
import { getCurrentProfile } from "@/lib/profile";
import { isBlacklisted } from "@/lib/user-tags";
import { hasPermission, requirePermission } from "@/lib/admin-guard";
import { softDeleteContent } from "@/lib/admin-moderation";
import { extractMentionedUsernames } from "@/lib/mentions";
import { awardXpByRule, deterministicUuid } from "@/lib/xp";
import type { CommentReportReason, CommentWithAuthor } from "@/lib/types";

// 关于「发完评论要手动刷新才看得到」（用户反馈的 bug）：
// 真正的原因在客户端——CommentItem 之前用 useState(replies) 把回复列表存进了本地 state，
// useState 只认第一次的初始值，服务端 revalidate 回来的新数据被这个陈旧 state 挡住了。
// 已改为从 props 派生（只把「本地删掉的 id」留在 state 里）。
//
// revalidatePath 本身是有效的（实测服务端数据会跟着更新）。不过详情页是动态渲染的
// （createClient 里读了 cookie），刷新要等一次完整的服务端往返；所以 postComment
// 额外把新评论整行回传，由客户端先插进列表（见 comment-section.tsx 的 localComments），
// 让用户立刻看到自己发的内容，服务端数据追上后按 id 去重。

// 列表页/首页/排行榜上都显示评论数，这些页面走缓存，发评论后需要一并失效，
// 否则详情页里评论数变了、列表页还是旧数字。
function revalidateCommentCounts(): void {
  revalidatePath("/[locale]/community/[section]", "page");
  revalidatePath("/");
  revalidatePath("/products");
  revalidatePath("/ideas");
  revalidatePath("/leaderboard");
}

export async function postComment(
  submissionId: string,
  body: string,
  pathname: string,
  parentId?: string
): Promise<{ error?: string; comment?: CommentWithAuthor }> {
  const t = await getTranslations("errors");
  const trimmed = body.trim();
  if (trimmed.length < 2 || trimmed.length > 2000) {
    return { error: t("commentLength") };
  }

  const profile = await getCurrentProfile();
  if (!profile) return { error: t("notSignedIn") };

  if (profile.mutedUntil && new Date(profile.mutedUntil) > new Date()) {
    return { error: t("muted", { until: new Date(profile.mutedUntil).toLocaleString(await getLocale()) }) };
  }
  if (await isBlacklisted(profile.id)) {
    return { error: t("blacklistedComment") };
  }

  const supabase = await createClient();
  const { data: inserted, error } = await supabase
    .from("comments")
    .insert({
      submission_id: submissionId,
      user_id: profile.id,
      parent_id: parentId ?? null,
      body: trimmed,
    })
    .select("id, submission_id, user_id, parent_id, body, created_at")
    .single();

  if (error || !inserted) return { error: error?.message ?? t("commentFailed") };

  const status = await runModerationPipeline({
    targetType: "comment",
    targetId: inserted.id,
    content: trimmed,
    authorId: profile.id,
  });

  // 通知要查父评论作者、查被 @的人、再插入，好几次往返，但收件人不是当前用户，
  // 晚几百毫秒到达完全没关系——挪到响应之后，不占用发评论的等待时间。
  after(() =>
    createCommentNotifications({
      commentId: inserted.id,
      submissionId,
      parentId: parentId ?? null,
      body: trimmed,
      actorId: profile.id,
    })
  );

  // 经验值也放到响应之后：加分要走 RPC + 可能写一条升级通知，
  // 但用户只关心评论有没有发出去，不该为这几百毫秒等着。
  // 只有真的发布出来的评论才计分——进了审核队列的等审核通过时再由 moderateQueueItem 补上。
  // refId = 评论 id，所以重复调用（审核通过再走一次）只会计一次分。
  if (status === "published") {
    after(() =>
      awardXpByRule({
        userId: profile.id,
        action: "comment_posted",
        refType: "comment",
        refId: inserted.id,
      })
    );
  }

  revalidatePath(pathname);
  revalidateCommentCounts();

  // 把完整的新评论回传给前端，客户端直接插进列表，用户不用等 revalidate 往返。
  // status 用 pipeline 的返回值，不再多查一次数据库。
  const comment: CommentWithAuthor = {
    id: inserted.id,
    submission_id: inserted.submission_id,
    user_id: inserted.user_id,
    parent_id: inserted.parent_id,
    body: inserted.body,
    created_at: inserted.created_at,
    status,
    pinned_at: null,
    deleted_at: null,
    author_username: profile.username,
    author_display_name: profile.displayName,
    author_role: profile.role,
    author_level: profile.level,
    vote_count: 0,
    viewer_has_voted: false,
  };
  return { comment };
}

// 评论发布成功后触发通知：谁的评论被回复了、谁被 @了。
// 一律走 admin client——收件人不是当前登录用户，普通客户端的 RLS（写自己）覆盖不了这个场景，
// notifications 表本身也没有开放给 authenticated 的 insert 策略。
async function createCommentNotifications(params: {
  commentId: string;
  submissionId: string;
  parentId: string | null;
  body: string;
  actorId: string;
}): Promise<void> {
  const admin = createAdminClient();
  const notifiedUserIds = new Set<string>();

  if (params.parentId) {
    const { data: parentComment } = await admin
      .from("comments")
      .select("user_id")
      .eq("id", params.parentId)
      .maybeSingle();

    if (parentComment && parentComment.user_id !== params.actorId) {
      await admin.from("notifications").insert({
        user_id: parentComment.user_id,
        actor_id: params.actorId,
        type: "reply",
        submission_id: params.submissionId,
        comment_id: params.commentId,
      });
      notifiedUserIds.add(parentComment.user_id);
    }
  }

  const mentionedUsernames = extractMentionedUsernames(params.body);
  if (mentionedUsernames.length === 0) return;

  // 大小写不敏感匹配：username/password 注册的账号是强制小写，但 Google 登录直接拿
  // full_name 当 username，大小写不受控，用 .in() 精确匹配会漏掉这类账号。
  // "_" 是 ilike 的通配符（匹配任意单字符），用户名允许包含 "_"，这里要转义掉。
  const orFilter = mentionedUsernames
    .map((username) => `username.ilike.${username.replace(/_/g, "\\_")}`)
    .join(",");
  const { data: mentionedProfiles } = await admin.from("profiles").select("id, username").or(orFilter);

  const mentionRows = (mentionedProfiles ?? [])
    .filter((p) => p.id !== params.actorId && !notifiedUserIds.has(p.id))
    .map((p) => ({
      user_id: p.id,
      actor_id: params.actorId,
      type: "mention" as const,
      submission_id: params.submissionId,
      comment_id: params.commentId,
    }));

  if (mentionRows.length > 0) {
    await admin.from("notifications").insert(mentionRows);
  }
}

// Product Hunt 风格：单一点赞（不是产品页那种 paid/creative 双票种）。
// 先删后插同款套路，见 src/app/actions/votes.ts 的注释。
export async function toggleCommentVote(
  commentId: string,
  pathname: string
): Promise<{ error: string } | { voted: boolean }> {
  const t = await getTranslations("errors");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("notSignedIn") };

  const { data: deleted, error: deleteError } = await supabase
    .from("comment_votes")
    .delete()
    .eq("comment_id", commentId)
    .eq("user_id", user.id)
    .select("id");

  if (deleteError) return { error: deleteError.message };

  if (deleted && deleted.length > 0) {
    revalidatePath(pathname);
    return { voted: false };
  }

  const { error: insertError } = await supabase.from("comment_votes").insert({ comment_id: commentId, user_id: user.id });
  if (insertError && insertError.code !== "23505") return { error: insertError.message };

  // 「评论被点赞」的经验给的是评论作者，不是点赞的人。
  // 幂等钥匙是 (评论, 点赞人) 的哈希：取消点赞再点回来不会重复加分（见 deterministicUuid）。
  after(() => awardCommentUpvoteXp(commentId, user.id));

  revalidatePath(pathname);
  return { voted: true };
}

async function awardCommentUpvoteXp(commentId: string, voterId: string): Promise<void> {
  const admin = createAdminClient();
  const { data: comment } = await admin.from("comments").select("user_id").eq("id", commentId).maybeSingle();
  // 自己给自己点赞不算——不然一个人就能无限给自己刷分。
  if (!comment || comment.user_id === voterId) return;

  await awardXpByRule({
    userId: comment.user_id,
    action: "comment_upvote_received",
    refType: "comment_vote",
    refId: deterministicUuid(commentId, voterId),
  });
}

// 置顶只对顶层评论有意义（回复的排序规则不受置顶影响）。
// 三种人可以置顶：admin / 有 moderate_comments 权限的 member / 该提交的作者本人，
// 其中作者只能置顶自己提交下面的评论——所以这里不能只查权限，还要比对 submitted_by。
export async function toggleCommentPin(
  commentId: string,
  pathname: string
): Promise<{ error: string } | { pinned: boolean }> {
  const t = await getTranslations("errors");
  const profile = await getCurrentProfile();
  if (!profile) return { error: t("notSignedIn") };

  const admin = createAdminClient();
  const { data: comment, error: commentError } = await admin
    .from("comments")
    .select("id, submission_id, parent_id, pinned_at")
    .eq("id", commentId)
    .maybeSingle();

  if (commentError) return { error: commentError.message };
  if (!comment) return { error: t("commentNotFound") };
  if (comment.parent_id) return { error: t("pinTopLevelOnly") };

  const isModerator = hasPermission(profile, "moderate_comments");
  let allowed = isModerator;

  if (!allowed) {
    const { data: submission } = await admin
      .from("submissions")
      .select("submitted_by")
      .eq("id", comment.submission_id)
      .maybeSingle();
    allowed = submission?.submitted_by === profile.id;
  }

  if (!allowed) return { error: t("noPinPermission") };

  const nextPinned = comment.pinned_at === null;
  const { error } = await admin
    .from("comments")
    .update({ pinned_at: nextPinned ? new Date().toISOString() : null })
    .eq("id", commentId);

  if (error) return { error: error.message };

  await admin.from("admin_logs").insert({
    admin_id: profile.id,
    action: nextPinned ? "comment_pinned" : "comment_unpinned",
    target_type: "comment",
    target_id: commentId,
  });

  revalidatePath(pathname);
  return { pinned: nextPinned };
}

export async function reportComment(
  commentId: string,
  reason: CommentReportReason,
  pathname: string
): Promise<{ error?: string }> {
  const t = await getTranslations("errors");
  const profile = await getCurrentProfile();
  if (!profile) return { error: t("notSignedIn") };

  const supabase = await createClient();
  const { error } = await supabase
    .from("comment_reports")
    .insert({ comment_id: commentId, reporter_id: profile.id, reason });

  if (error) {
    if (error.code === "23505") return { error: t("alreadyReported") };
    return { error: error.message };
  }

  revalidatePath(pathname);
  return {};
}

// "删除"不是真的 SQL DELETE，而是打上 deleted_at 软删除标记（见 0014 迁移）：
// 前台所有查询都过滤 deleted_at is null，所以内容立刻从站点上消失，
// 但记录还在库里，后台「回收站」7 天内可以恢复，超期由 purge_expired_deleted_content() 清掉。
//
// deleted_prev_status 记下删除前的状态，恢复时原样还回去——否则一条本来待审核的评论
// 会被恢复成已发布，绕过审核。
export async function deleteComment(
  commentId: string,
  pathname: string,
  reason?: string
): Promise<{ error?: string }> {
  const guard = await requirePermission("moderate_comments");
  if ("error" in guard) return { error: guard.error };

  const result = await softDeleteContent({
    kind: "comment",
    id: commentId,
    actorId: guard.profile.id,
    reason,
  });
  if (result.error) return result;

  revalidatePath(pathname);
  revalidateCommentCounts();
  return {};
}
