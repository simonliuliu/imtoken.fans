import { submissionHref } from "@/lib/types";
import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  CommentReportReason,
  CommentReportStatus,
  Permissions,
  SubmissionCard,
  SubmissionStatus,
  SubmissionType,
  UserRole,
  UserTagKey,
} from "@/lib/types";
import { TRASH_RETENTION_DAYS } from "@/lib/types";
import type { ModerationMode, ModerationTargetType } from "@/lib/moderation/settings";

// 这个文件里的查询一律走 admin client（service_role，不受 RLS 限制）：
// 后台要看到全站所有人的数据，不只是当前登录用户自己能看到的那部分。
// 调用方（页面 / Server Action）负责先做权限检查。

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// PostgREST 的 range 是闭区间下标，翻页统一在这里换算，避免每处各写一遍 off-by-one。
function rangeFor(page: number, pageSize: number): [number, number] {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const from = (safePage - 1) * pageSize;
  return [from, from + pageSize - 1];
}

// ========== 概览统计 ==========

export interface AdminStats {
  pendingQueue: number;
  openReports: number;
  publishedSubmissions: number;
  pendingSubmissions: number;
  totalUsers: number;
  staffUsers: number;
  mutedUsers: number;
  trashItems: number;
}

// 用 React 的 cache() 包一层：layout（导航上的待处理数字）和页面正文都要这份统计，
// 同一次请求里只真的查一遍数据库。
export const getAdminStats = cache(async function getAdminStats(): Promise<AdminStats> {
  const admin = createAdminClient();
  const countOnly = { count: "exact" as const, head: true };
  const trashCutoff = trashCutoffIso();

  const [
    pendingQueue,
    openReports,
    publishedSubmissions,
    pendingSubmissions,
    totalUsers,
    staffUsers,
    mutedUsers,
    trashedComments,
    trashedSubmissions,
  ] = await Promise.all([
    admin.from("moderation_queue").select("id", countOnly).eq("result", "pending"),
    admin.from("comment_reports").select("id", countOnly).eq("status", "open"),
    admin.from("submissions").select("id", countOnly).eq("status", "published").is("deleted_at", null),
    admin.from("submissions").select("id", countOnly).eq("status", "pending").is("deleted_at", null),
    admin.from("profiles").select("id", countOnly),
    admin.from("profiles").select("id", countOnly).in("role", ["admin", "member"]),
    admin.from("profiles").select("id", countOnly).gt("muted_until", new Date().toISOString()),
    admin.from("comments").select("id", countOnly).gte("deleted_at", trashCutoff),
    admin.from("submissions").select("id", countOnly).gte("deleted_at", trashCutoff),
  ]);

  return {
    pendingQueue: pendingQueue.count ?? 0,
    openReports: openReports.count ?? 0,
    publishedSubmissions: publishedSubmissions.count ?? 0,
    pendingSubmissions: pendingSubmissions.count ?? 0,
    totalUsers: totalUsers.count ?? 0,
    staffUsers: staffUsers.count ?? 0,
    mutedUsers: mutedUsers.count ?? 0,
    trashItems: (trashedComments.count ?? 0) + (trashedSubmissions.count ?? 0),
  };
});

// ========== 审核队列 ==========

export interface QueueItem {
  id: string;
  target_type: ModerationTargetType;
  target_id: string;
  source: "human" | "ai";
  result: "pending" | "approved" | "rejected";
  reason: string | null;
  created_at: string;
  preview: string;
  author_username: string | null;
}

export async function getPendingQueueItems(limit?: number): Promise<QueueItem[]> {
  const admin = createAdminClient();
  let query = admin
    .from("moderation_queue")
    .select("id, target_type, target_id, source, result, reason, created_at")
    .eq("result", "pending")
    .order("created_at", { ascending: true });
  if (limit) query = query.limit(limit);
  const { data: queueRows } = await query;

  const rows = queueRows ?? [];
  if (rows.length === 0) return [];

  const submissionIds = rows.filter((r) => r.target_type === "submission").map((r) => r.target_id);
  const commentIds = rows.filter((r) => r.target_type === "comment").map((r) => r.target_id);

  // 已经进回收站（或已被彻底清除）的内容不该再出现在审核队列里：
  // 审核它没有意义（通过了也还是不可见），还会挡住真正待处理的条目。
  // 队列行本身留着不动——内容一旦被恢复，它会自动重新出现在这里。
  const [submissionResult, commentResult] = await Promise.all([
    submissionIds.length
      ? admin
          .from("submissions")
          .select("id, title, tagline, type, submitted_by")
          .in("id", submissionIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; title: string; tagline: string; type: string; submitted_by: string }[] }),
    commentIds.length
      ? admin.from("comments").select("id, body, user_id").in("id", commentIds).is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; body: string; user_id: string }[] }),
  ]);

  const submissionMap = new Map((submissionResult.data ?? []).map((r) => [r.id, r]));
  const commentMap = new Map((commentResult.data ?? []).map((r) => [r.id, r]));

  const authorIds = [
    ...new Set([
      ...(submissionResult.data ?? []).map((r) => r.submitted_by),
      ...(commentResult.data ?? []).map((r) => r.user_id),
    ]),
  ];
  const usernameMap = await getUsernameMap(authorIds);

  return rows.flatMap((row) => {
    if (row.target_type === "submission") {
      const s = submissionMap.get(row.target_id);
      if (!s) return [];
      return [
        {
          ...row,
          preview: `[${s.type === "product" ? "产品" : s.type === "post" ? "社区帖" : "点子"}] ${s.title} — ${s.tagline}`,
          author_username: usernameMap.get(s.submitted_by) ?? null,
        },
      ];
    }
    const c = commentMap.get(row.target_id);
    if (!c) return [];
    return [
      {
        ...row,
        preview: c.body.slice(0, 140),
        author_username: usernameMap.get(c.user_id) ?? null,
      },
    ];
  });
}

async function getUsernameMap(userIds: string[]): Promise<Map<string, string | null>> {
  if (userIds.length === 0) return new Map();
  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, username, display_name").in("id", userIds);
  return new Map((data ?? []).map((p) => [p.id, p.display_name ?? p.username]));
}

// ========== 内容管理 ==========

export interface SubmissionFilters {
  status?: SubmissionStatus | "all";
  type?: SubmissionType | "all";
  q?: string;
  page?: number;
  pageSize?: number;
}

// 内容量会越来越大，所以这里不再一次拉 200 条，而是服务端分页 + 搜索。
// 回收站里的内容（deleted_at 非空）不在这个列表里出现，它们有独立的页面。
export async function getSubmissionsForAdmin(filters: SubmissionFilters = {}): Promise<Paginated<SubmissionCard>> {
  const { status = "all", type = "all", q = "", page = 1, pageSize = 25 } = filters;
  const admin = createAdminClient();
  const [from, to] = rangeFor(page, pageSize);

  let query = admin
    .from("submission_cards")
    .select("*", { count: "exact" })
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (status !== "all") query = query.eq("status", status);
  if (type !== "all") query = query.eq("type", type);
  if (q.trim()) {
    const term = escapeLike(q.trim());
    query = query.or(`title.ilike.%${term}%,tagline.ilike.%${term}%`);
  }

  const { data, count } = await query;
  return {
    rows: (data ?? []) as SubmissionCard[],
    total: count ?? 0,
    page: Math.max(1, Math.floor(page) || 1),
    pageSize,
  };
}

// ilike 里 % 和 _ 是通配符，用户搜 "100%_off" 这种字符串时要转义掉，
// 否则会被当成模式匹配（"_" 匹配任意单字符）。
function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, (char) => `\\${char}`);
}

// ========== 用户管理 ==========

export interface AdminUserRow {
  id: string;
  username: string | null;
  display_name: string | null;
  role: UserRole;
  permissions: Permissions;
  muted_until: string | null;
  wallet_address: string | null;
  created_at: string;
  xp: number;
  level: number;
  lottery_tickets: number;
  tags: UserTagKey[];
  badges: string[];
  granted_badges: string[];
}

export interface UserFilters {
  q?: string;
  role?: UserRole | "staff" | "all";
  page?: number;
  pageSize?: number;
}

export async function getAdminUsers(filters: UserFilters = {}): Promise<Paginated<AdminUserRow>> {
  const { q = "", role = "all", page = 1, pageSize = 25 } = filters;
  const admin = createAdminClient();
  const [from, to] = rangeFor(page, pageSize);

  let query = admin
    .from("profiles")
    .select(
      "id, username, display_name, role, permissions, muted_until, wallet_address, created_at, xp, level, lottery_tickets",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  // "staff" = Admin + Manager，概览页和用户页的第一个筛选项都用它。
  if (role === "staff") query = query.in("role", ["admin", "member"]);
  else if (role !== "all") query = query.eq("role", role);

  if (q.trim()) {
    const term = escapeLike(q.trim());
    query = query.or(
      `username.ilike.%${term}%,display_name.ilike.%${term}%,wallet_address.ilike.%${term}%`
    );
  }

  const { data: profiles, count } = await query;
  const rows = profiles ?? [];

  return {
    rows: await decorateUsers(rows),
    total: count ?? 0,
    page: Math.max(1, Math.floor(page) || 1),
    pageSize,
  };
}

type RawProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  role: UserRole;
  permissions: unknown;
  muted_until: string | null;
  wallet_address: string | null;
  created_at: string;
  xp: number | null;
  level: number | null;
  lottery_tickets: number | null;
};

// 标签和徽章只按当前这一页的用户 id 查，不再全表扫 user_tags / badges。
async function decorateUsers(rows: RawProfileRow[]): Promise<AdminUserRow[]> {
  if (rows.length === 0) return [];
  const admin = createAdminClient();
  const ids = rows.map((r) => r.id);

  const [{ data: tagRows }, { data: badgeRows }] = await Promise.all([
    admin.from("user_tags").select("user_id, tag_key").in("user_id", ids),
    admin.from("badges").select("user_id, badge_key, granted_by").in("user_id", ids),
  ]);

  const tagsByUser = new Map<string, UserTagKey[]>();
  for (const row of tagRows ?? []) {
    const list = tagsByUser.get(row.user_id) ?? [];
    list.push(row.tag_key as UserTagKey);
    tagsByUser.set(row.user_id, list);
  }

  const badgesByUser = new Map<string, string[]>();
  const grantedByUser = new Map<string, string[]>();
  for (const row of badgeRows ?? []) {
    const list = badgesByUser.get(row.user_id) ?? [];
    list.push(row.badge_key);
    badgesByUser.set(row.user_id, list);
    // granted_by 非空 = 人工颁发的，只有这些能在后台撤销。
    if (row.granted_by) {
      const granted = grantedByUser.get(row.user_id) ?? [];
      granted.push(row.badge_key);
      grantedByUser.set(row.user_id, granted);
    }
  }

  return rows.map((p) => ({
    id: p.id,
    username: p.username,
    display_name: p.display_name,
    role: p.role,
    permissions: (p.permissions as Permissions) ?? {},
    muted_until: p.muted_until,
    wallet_address: p.wallet_address,
    created_at: p.created_at,
    xp: p.xp ?? 0,
    level: p.level ?? 0,
    lottery_tickets: p.lottery_tickets ?? 0,
    tags: tagsByUser.get(p.id) ?? [],
    badges: badgesByUser.get(p.id) ?? [],
    granted_badges: grantedByUser.get(p.id) ?? [],
  }));
}

// ========== 举报管理 ==========

export interface CommentReportRow {
  id: string;
  // 评论被彻底清除后这里是 null（外键 on delete set null），正文回落到 comment_snapshot。
  comment_id: string | null;
  reason: CommentReportReason;
  status: CommentReportStatus;
  resolution: string | null;
  created_at: string;
  reviewed_at: string | null;
  reporter_username: string | null;
  reviewer_username: string | null;
  comment_body: string;
  comment_deleted: boolean;
  comment_author_id: string | null;
  comment_author_username: string | null;
  comment_author_muted_until: string | null;
  submission_id: string | null;
  submission_href: string | null;
  submission_type: SubmissionType | null;
  submission_title: string | null;
}

export interface ReportFilters {
  status?: CommentReportStatus | "handled" | "all";
  page?: number;
  pageSize?: number;
}

// 「已处理」在界面上是一个 tab，但底层是 resolved + dismissed 两个状态，
// 所以这里额外支持一个 handled 伪状态。
export async function getCommentReports(filters: ReportFilters = {}): Promise<Paginated<CommentReportRow>> {
  const { status = "open", page = 1, pageSize = 25 } = filters;
  const admin = createAdminClient();
  const [from, to] = rangeFor(page, pageSize);

  let query = admin
    .from("comment_reports")
    .select(
      "id, comment_id, reason, status, resolution, comment_snapshot, created_at, reviewed_at, reporter_id, reviewed_by",
      { count: "exact" }
    )
    .range(from, to);

  if (status === "handled") query = query.in("status", ["resolved", "dismissed"]);
  else if (status !== "all") query = query.eq("status", status);

  // 待处理的按最早优先（先来先处理），已处理的按最近处理时间倒序。
  query =
    status === "open"
      ? query.order("created_at", { ascending: true })
      : query.order("reviewed_at", { ascending: false, nullsFirst: false });

  const { data: reportRows, count } = await query;
  const rows = reportRows ?? [];
  const pageMeta = { total: count ?? 0, page: Math.max(1, Math.floor(page) || 1), pageSize };
  if (rows.length === 0) return { rows: [], ...pageMeta };

  const commentIds = [...new Set(rows.map((r) => r.comment_id).filter((id): id is string => Boolean(id)))];
  const { data: comments } = commentIds.length
    ? await admin.from("comments").select("id, body, user_id, submission_id, deleted_at").in("id", commentIds)
    : { data: [] as { id: string; body: string; user_id: string; submission_id: string; deleted_at: string | null }[] };

  const commentMap = new Map((comments ?? []).map((c) => [c.id, c]));
  const submissionIds = [...new Set((comments ?? []).map((c) => c.submission_id))];

  const profileIds = [
    ...new Set(
      [
        ...rows.map((r) => r.reporter_id),
        ...rows.map((r) => r.reviewed_by),
        ...(comments ?? []).map((c) => c.user_id),
      ].filter((id): id is string => Boolean(id))
    ),
  ];

  const [{ data: profiles }, { data: submissions }] = await Promise.all([
    profileIds.length
      ? admin.from("profiles").select("id, username, display_name, muted_until").in("id", profileIds)
      : Promise.resolve({ data: [] as { id: string; username: string | null; display_name: string | null; muted_until: string | null }[] }),
    submissionIds.length
      ? admin.from("submissions").select("id, type, title, community_section, legacy_slug").in("id", submissionIds)
      : Promise.resolve({ data: [] as { id: string; type: SubmissionType; title: string }[] }),
  ]);

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
  const submissionMap = new Map((submissions ?? []).map((s) => [s.id, s]));
  const nameOf = (id: string | null) => {
    if (!id) return null;
    const p = profileMap.get(id);
    return p ? (p.display_name ?? p.username) : null;
  };

  return {
    rows: rows.map((row) => {
      const comment = row.comment_id ? commentMap.get(row.comment_id) : undefined;
      const author = comment ? profileMap.get(comment.user_id) : undefined;
      const submission = comment ? submissionMap.get(comment.submission_id) : undefined;
      return {
        id: row.id,
        comment_id: row.comment_id,
        reason: row.reason as CommentReportReason,
        status: row.status as CommentReportStatus,
        resolution: row.resolution,
        created_at: row.created_at,
        reviewed_at: row.reviewed_at,
        reporter_username: nameOf(row.reporter_id),
        reviewer_username: nameOf(row.reviewed_by),
        comment_body: comment?.body ?? row.comment_snapshot ?? "（评论已彻底删除）",
        comment_deleted: comment ? comment.deleted_at !== null : true,
        comment_author_id: comment ? comment.user_id : null,
        comment_author_username: author ? (author.display_name ?? author.username) : null,
        comment_author_muted_until: author ? author.muted_until : null,
        submission_href: submission ? submissionHref(submission) : null,
        submission_id: comment ? comment.submission_id : null,
        submission_type: submission ? submission.type : null,
        submission_title: submission ? submission.title : null,
      };
    }),
    ...pageMeta,
  };
}

// ========== 回收站 ==========

function trashCutoffIso(): string {
  return new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export interface TrashItem {
  kind: "comment" | "submission";
  id: string;
  preview: string;
  title: string | null;
  author_username: string | null;
  deleted_at: string;
  deleted_by_username: string | null;
  delete_reason: string | null;
  prev_status: SubmissionStatus | null;
  expires_at: string;
}

// 保留期内的被删内容。超期的行由 purgeExpiredTrash() 真删掉，
// 这里再叠一层 gte(cutoff) 过滤：即使清理还没跑，界面上也不会出现「已经该消失」的条目。
export async function getTrashItems(limit?: number): Promise<TrashItem[]> {
  const admin = createAdminClient();
  const cutoff = trashCutoffIso();

  let commentQuery = admin
    .from("comments")
    .select("id, body, user_id, submission_id, deleted_at, deleted_by, delete_reason, deleted_prev_status")
    .gte("deleted_at", cutoff)
    .order("deleted_at", { ascending: false });
  let submissionQuery = admin
    .from("submissions")
    .select("id, type, title, tagline, submitted_by, deleted_at, deleted_by, delete_reason, deleted_prev_status")
    .gte("deleted_at", cutoff)
    .order("deleted_at", { ascending: false });

  if (limit) {
    commentQuery = commentQuery.limit(limit);
    submissionQuery = submissionQuery.limit(limit);
  }

  const [{ data: comments }, { data: submissions }] = await Promise.all([commentQuery, submissionQuery]);

  const submissionIds = [...new Set((comments ?? []).map((c) => c.submission_id))];
  const profileIds = [
    ...new Set(
      [
        ...(comments ?? []).flatMap((c) => [c.user_id, c.deleted_by]),
        ...(submissions ?? []).flatMap((s) => [s.submitted_by, s.deleted_by]),
      ].filter((id): id is string => Boolean(id))
    ),
  ];

  const [usernameMap, { data: parentSubmissions }] = await Promise.all([
    getUsernameMap(profileIds),
    submissionIds.length
      ? admin.from("submissions").select("id, title").in("id", submissionIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ]);
  const parentTitleMap = new Map((parentSubmissions ?? []).map((s) => [s.id, s.title]));

  const expiresAt = (deletedAt: string) =>
    new Date(new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const items: TrashItem[] = [
    ...(comments ?? []).map((c) => ({
      kind: "comment" as const,
      id: c.id,
      preview: c.body.slice(0, 200),
      title: parentTitleMap.get(c.submission_id) ?? null,
      author_username: usernameMap.get(c.user_id) ?? null,
      deleted_at: c.deleted_at as string,
      deleted_by_username: c.deleted_by ? (usernameMap.get(c.deleted_by) ?? null) : null,
      delete_reason: c.delete_reason,
      prev_status: c.deleted_prev_status as SubmissionStatus | null,
      expires_at: expiresAt(c.deleted_at as string),
    })),
    ...(submissions ?? []).map((s) => ({
      kind: "submission" as const,
      id: s.id,
      preview: s.tagline,
      title: `[${s.type === "product" ? "产品" : s.type === "post" ? "社区帖" : "点子"}] ${s.title}`,
      author_username: usernameMap.get(s.submitted_by) ?? null,
      deleted_at: s.deleted_at as string,
      deleted_by_username: s.deleted_by ? (usernameMap.get(s.deleted_by) ?? null) : null,
      delete_reason: s.delete_reason,
      prev_status: s.deleted_prev_status as SubmissionStatus | null,
      expires_at: expiresAt(s.deleted_at as string),
    })),
  ].sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));

  return limit ? items.slice(0, limit) : items;
}

// 「过了一周自动清空」的执行点。数据库里有 pg_cron 的话可以挂定时任务，
// 但不能假设它开着——所以每次有人打开后台（layout 里调一次）就顺手清一遍。
// 函数本身是幂等的，重复调用只是多一次没删到东西的查询。
export async function purgeExpiredTrash(): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("purge_expired_deleted_content", { retention_days: TRASH_RETENTION_DAYS });
  // 清理失败不该让整个后台打不开：迁移还没跑、或者临时的网络问题，都只记一行日志。
  if (error) console.error("[admin] purge_expired_deleted_content failed:", error.message);
}

// ========== 审核设置 ==========

export async function getModerationModes(): Promise<Record<ModerationTargetType, ModerationMode>> {
  const admin = createAdminClient();
  const { data } = await admin.from("moderation_settings").select("target_type, mode");
  const result: Record<ModerationTargetType, ModerationMode> = { submission: "human", comment: "human" };
  for (const row of data ?? []) {
    result[row.target_type as ModerationTargetType] = row.mode as ModerationMode;
  }
  return result;
}
