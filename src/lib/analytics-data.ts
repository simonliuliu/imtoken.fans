import "server-only";
import { submissionHref, type SubmissionType } from "@/lib/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { ANALYTICS_TZ, OTHER_ROUTE, PAGE_VIEW_RETENTION_DAYS } from "@/lib/analytics";

// 看板的查询层。和 admin-data.ts 同样的约定：一律走 service_role（聚合函数是 security definer，
// 只授权给了 service_role），调用方负责先做权限检查。
//
// 所有聚合都在数据库里做（见 0019_analytics.sql 的 analytics_* 函数）：
// page_views 会长到几十万行，把原始行拉到 Node 里再 reduce 是没法用的。

export interface AnalyticsSummary {
  views: number;
  visitors: number;
  memberViews: number;
  memberVisitors: number;
  newUsers: number;
  newSubmissions: number;
  newComments: number;
  newVotes: number;
}

export interface DailyPoint {
  day: string;
  views: number;
  visitors: number;
  members: number;
  newUsers: number;
  newSubmissions: number;
  newComments: number;
}

export interface RouteRow {
  route: string;
  views: number;
  visitors: number;
}

export interface ContentRow {
  submissionId: string;
  type: SubmissionType;
  href: string;
  title: string;
  views: number;
  visitors: number;
}

/** 来源 / 设备 / 地区共用的形状：一个名字（可能为空，表示"未知"）加两个计数。 */
export interface BreakdownRow {
  name: string | null;
  views: number;
  visitors: number;
}

export interface HourPoint {
  hour: number;
  views: number;
  visitors: number;
}

/** 访客 -> 注册 -> 激活 -> 创作。四级不是同一维度，展示时要标清楚（见 0020 的注释）。 */
export interface Funnel {
  visitors: number;
  signups: number;
  activated: number;
  creators: number;
}

export interface RetentionRow {
  day: string;
  size: number;
  returned: number;
}

export interface LevelRow {
  level: number;
  users: number;
}

export interface ContentHealth {
  approved: number;
  rejected: number;
  /** 存量：当前审核队列里还压着多少 */
  pending: number;
  /** 审核耗时（分钟）。null = 区间内没有任何审核动作 */
  medianReviewMinutes: number | null;
  p90ReviewMinutes: number | null;
  /** 存量：已发布但零评论的内容 */
  zeroComment: number;
  reportsNew: number;
  reportsResolved: number;
}

export interface Engagement {
  votesPaid: number;
  votesCreative: number;
  voters: number;
  investments: number;
  investUsd: number;
  commentVotes: number;
  commenters: number;
  contentVisitors: number;
}

export interface ActivityPoint {
  day: string;
  checkinUsers: number;
  draws: number;
  xpGranted: number;
}

export interface CheckinSummary {
  totalCheckins: number;
  users: number;
  xpAwarded: number;
  avgStreak: number;
  streak7plus: number;
  longestStreak: number;
}

export interface LotterySummary {
  draws: number;
  drawers: number;
  xpAwarded: number;
  xpCost: number;
  ticketsGranted: number;
  ticketsSpent: number;
  /** 存量：全站还没花掉的券，决定了后面还会被抽走多少奖品 */
  ticketsOutstanding: number;
  /** 存量：实物奖品抽中了但还没标记发放 */
  unfulfilled: number;
}

export interface PrizeRow {
  name: string;
  icon: string;
  draws: number;
  winners: number;
}

/** 未收录路径（404 / 失效外链）。path 是原始路径，没有做任何折叠。 */
export interface UnknownPathRow {
  path: string;
  views: number;
  visitors: number;
}

export interface XpRow {
  action: string;
  events: number;
  amount: number;
  users: number;
}

export interface AnalyticsOverview {
  /** false = 0019 迁移还没执行（表 / 函数不存在），页面显示提示而不是一片零。 */
  ready: boolean;
  rangeDays: number;
  from: string;
  to: string;
  summary: AnalyticsSummary;
  /** 上一段等长周期，用来算环比。 */
  previous: AnalyticsSummary;
  daily: DailyPoint[];
  routes: RouteRow[];
  content: ContentRow[];
  referrers: BreakdownRow[];
  devices: BreakdownRow[];
  countries: BreakdownRow[];
  hourly: HourPoint[];
  funnel: Funnel;
  retention: RetentionRow[];
  levels: LevelRow[];
  contentHealth: ContentHealth;
  engagement: Engagement;
  engagementPrev: Engagement;
  activityDaily: ActivityPoint[];
  checkin: CheckinSummary;
  checkinPrev: CheckinSummary;
  lottery: LotterySummary;
  lotteryPrev: LotterySummary;
  prizes: PrizeRow[];
  xp: XpRow[];
  unknownPaths: UnknownPathRow[];
}

const EMPTY_SUMMARY: AnalyticsSummary = {
  views: 0,
  visitors: 0,
  memberViews: 0,
  memberVisitors: 0,
  newUsers: 0,
  newSubmissions: 0,
  newComments: 0,
  newVotes: 0,
};

export const RANGE_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_RANGE_DAYS = 7;

export function normalizeRangeDays(raw: string | undefined): number {
  const value = Number(raw);
  return (RANGE_OPTIONS as readonly number[]).includes(value) ? value : DEFAULT_RANGE_DAYS;
}

export async function getAnalyticsOverview(rangeDays: number): Promise<AnalyticsOverview> {
  const admin = createAdminClient();
  const { from, to, prevFrom, prevTo } = rangeBounds(rangeDays);

  const now = { p_from: from, p_to: to };
  const prev = { p_from: prevFrom, p_to: prevTo };
  const nowTz = { ...now, p_tz: ANALYTICS_TZ };

  // 一次性并发发出去。都是小表上的索引扫描，串行的话这一页要等十几秒；
  // 环比只对"运营真的会盯的量"再查一遍上一段（访问 / 互动 / 签到 / 抽奖），
  // 存量类指标（积压、券余额、等级分布）没有"上期"的概念，不重复查。
  const [
    summary,
    previous,
    daily,
    routes,
    content,
    referrers,
    devices,
    countries,
    hourly,
    funnel,
    retention,
    levels,
    contentHealth,
    engagement,
    engagementPrev,
    activityDaily,
    checkin,
    checkinPrev,
    lottery,
    lotteryPrev,
    prizes,
    xp,
    unknownPaths,
  ] = await Promise.all([
    rpcRows(admin, "analytics_summary", now),
    rpcRows(admin, "analytics_summary", prev),
    rpcRows(admin, "analytics_daily", nowTz),
    rpcRows(admin, "analytics_top_routes", { ...now, p_limit: 12 }),
    rpcRows(admin, "analytics_top_content", { ...now, p_limit: 10 }),
    rpcRows(admin, "analytics_referrers", { ...now, p_limit: 8 }),
    rpcRows(admin, "analytics_devices", now),
    rpcRows(admin, "analytics_countries", { ...now, p_limit: 8 }),
    rpcRows(admin, "analytics_hourly", nowTz),
    rpcRows(admin, "analytics_funnel", now),
    rpcRows(admin, "analytics_retention", nowTz),
    rpcRows(admin, "analytics_levels", {}),
    rpcRows(admin, "analytics_content_health", now),
    rpcRows(admin, "analytics_engagement", now),
    rpcRows(admin, "analytics_engagement", prev),
    rpcRows(admin, "analytics_activity_daily", nowTz),
    rpcRows(admin, "analytics_checkin_summary", nowTz),
    rpcRows(admin, "analytics_checkin_summary", { ...prev, p_tz: ANALYTICS_TZ }),
    rpcRows(admin, "analytics_lottery_summary", now),
    rpcRows(admin, "analytics_lottery_summary", prev),
    rpcRows(admin, "analytics_lottery_prizes", { ...now, p_limit: 12 }),
    rpcRows(admin, "analytics_xp_breakdown", now),
    rpcRows(admin, "analytics_unknown_paths", { ...now, p_route: OTHER_ROUTE, p_limit: 10 }),
  ]);

  const postIds = content.rows.filter(row => row.submission_type === "post").map(row => String(row.submission_id));
  const { data: communityRows } = postIds.length
    ? await admin.from("submissions").select("id, community_section, legacy_slug").in("id", postIds)
    : { data: [] };
  const postLinks = new Map((communityRows ?? []).map(row => [row.id, submissionHref({ ...row, type: "post" })]));

  return {
    // 一个来自 0019、一个来自 0020：任意一个文件没执行都要让页面弹提示，
    // 否则只缺 0020 时半张看板静悄悄地全是 0，看的人会以为是真没数据。
    ready: summary.ok && funnel.ok,
    rangeDays,
    from,
    to,
    summary: readSummary(summary.rows[0]),
    previous: readSummary(previous.rows[0]),
    daily: daily.rows.map((row) => ({
      day: String(row.day),
      views: num(row.views),
      visitors: num(row.visitors),
      members: num(row.members),
      newUsers: num(row.new_users),
      newSubmissions: num(row.new_submissions),
      newComments: num(row.new_comments),
    })),
    routes: routes.rows.map((row) => ({
      route: String(row.route),
      views: num(row.views),
      visitors: num(row.visitors),
    })),
    content: content.rows.map((row) => ({
      submissionId: String(row.submission_id),
      type: row.submission_type === "post" ? "post" : row.submission_type === "idea" ? "idea" : "product",
      href: row.submission_type === "post" ? postLinks.get(String(row.submission_id)) ?? "/community/discussion" : `/${row.submission_type === "idea" ? "ideas" : "products"}/${row.submission_id}`,
      title: String(row.title ?? ""),
      views: num(row.views),
      visitors: num(row.visitors),
    })),
    referrers: referrers.rows.map((row) => toBreakdown(row.referrer_host, row)),
    devices: devices.rows.map((row) => toBreakdown(row.device, row)),
    countries: countries.rows.map((row) => toBreakdown(row.country, row)),
    hourly: hourly.rows.map((row) => ({
      hour: num(row.hour),
      views: num(row.views),
      visitors: num(row.visitors),
    })),
    funnel: {
      visitors: num(funnel.rows[0]?.visitor_count),
      signups: num(funnel.rows[0]?.signup_count),
      activated: num(funnel.rows[0]?.activated_count),
      creators: num(funnel.rows[0]?.creator_count),
    },
    retention: retention.rows.map((row) => ({
      day: String(row.cohort_day),
      size: num(row.cohort_size),
      returned: num(row.returned_count),
    })),
    levels: levels.rows.map((row) => ({
      level: num(row.level_value),
      users: num(row.user_count),
    })),
    contentHealth: {
      approved: num(contentHealth.rows[0]?.approved_count),
      rejected: num(contentHealth.rows[0]?.rejected_count),
      pending: num(contentHealth.rows[0]?.pending_count),
      // 这两个允许是 null（区间内没人审过任何东西），不能用 num() 压成 0——
      // "中位耗时 0 分钟"和"没有数据"在看板上是两回事。
      medianReviewMinutes: numOrNull(contentHealth.rows[0]?.median_review_minutes),
      p90ReviewMinutes: numOrNull(contentHealth.rows[0]?.p90_review_minutes),
      zeroComment: num(contentHealth.rows[0]?.zero_comment_count),
      reportsNew: num(contentHealth.rows[0]?.report_new_count),
      reportsResolved: num(contentHealth.rows[0]?.report_resolved_count),
    },
    engagement: readEngagement(engagement.rows[0]),
    engagementPrev: readEngagement(engagementPrev.rows[0]),
    activityDaily: activityDaily.rows.map((row) => ({
      day: String(row.day),
      checkinUsers: num(row.checkin_user_count),
      draws: num(row.draw_count),
      xpGranted: num(row.xp_granted),
    })),
    checkin: readCheckin(checkin.rows[0]),
    checkinPrev: readCheckin(checkinPrev.rows[0]),
    lottery: readLottery(lottery.rows[0]),
    lotteryPrev: readLottery(lotteryPrev.rows[0]),
    prizes: prizes.rows.map((row) => ({
      name: String(row.prize_name ?? ""),
      icon: String(row.prize_icon ?? "\u{1F381}"),
      draws: num(row.draw_count),
      winners: num(row.winner_count),
    })),
    xp: xp.rows.map((row) => ({
      action: String(row.action_key ?? ""),
      events: num(row.event_count),
      amount: num(row.amount_total),
      users: num(row.user_count),
    })),
    unknownPaths: unknownPaths.rows.map((row) => ({
      path: String(row.path ?? ""),
      views: num(row.view_count),
      visitors: num(row.visitor_count),
    })),
  };
}

/**
 * 后台总览页的「今日访问」用。单独一个轻量查询，不拖慢总览页——
 * 那一页本来就已经在并发查七八个后台统计了。
 */
export async function getTodayTraffic(): Promise<{
  today: { views: number; visitors: number; members: number };
  yesterday: { views: number; visitors: number; members: number };
}> {
  const admin = createAdminClient();
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = zonedDayStart(new Date(), ANALYTICS_TZ);
  const iso = (ms: number) => new Date(ms).toISOString();

  const [today, yesterday] = await Promise.all([
    rpcRows(admin, "analytics_traffic", { p_from: iso(todayStart), p_to: iso(todayStart + dayMs) }),
    rpcRows(admin, "analytics_traffic", { p_from: iso(todayStart - dayMs), p_to: iso(todayStart) }),
  ]);

  const read = (row: Row | undefined) => ({
    views: num(row?.view_count),
    visitors: num(row?.visitor_count),
    members: num(row?.member_count),
  });
  return { today: read(today.rows[0]), yesterday: read(yesterday.rows[0]) };
}

/** 后台总览页的「今日活动」用：今天签到多少人、抽了多少次。 */
export async function getTodayActivity(): Promise<{
  checkinUsers: number;
  draws: number;
  xpGranted: number;
}> {
  const admin = createAdminClient();
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = zonedDayStart(new Date(), ANALYTICS_TZ);
  const { rows } = await rpcRows(admin, "analytics_activity_daily", {
    p_from: new Date(todayStart).toISOString(),
    p_to: new Date(todayStart + dayMs).toISOString(),
    p_tz: ANALYTICS_TZ,
  });
  const row = rows[0];
  return {
    checkinUsers: num(row?.checkin_user_count),
    draws: num(row?.draw_count),
    xpGranted: num(row?.xp_granted),
  };
}

/** 原始访问记录的保留期执行点，和 purgeExpiredTrash() 一样由"有人打开后台"触发。 */
export async function purgeExpiredPageViews(): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("purge_expired_page_views", {
    p_retention_days: PAGE_VIEW_RETENTION_DAYS,
  });
  if (error) console.error("[analytics] purge_expired_page_views failed:", error.message);
}

type Row = Record<string, unknown>;
type AdminClient = ReturnType<typeof createAdminClient>;

// 迁移没跑时 rpc 会报 42883（函数不存在）/ 42P01（表不存在）。
// 这种情况下返回空结果 + ok:false，让页面提示"去执行迁移"，而不是抛 500。
async function rpcRows(
  admin: AdminClient,
  fn: string,
  params: Row
): Promise<{ ok: boolean; rows: Row[] }> {
  const { data, error } = await admin.rpc(fn, params);
  if (error) {
    console.error(`[analytics] ${fn} failed:`, error.message);
    return { ok: false, rows: [] };
  }
  return { ok: true, rows: Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [] };
}

function readSummary(row: Row | undefined): AnalyticsSummary {
  if (!row) return EMPTY_SUMMARY;
  return {
    views: num(row.views),
    visitors: num(row.visitors),
    memberViews: num(row.member_views),
    memberVisitors: num(row.member_visitors),
    newUsers: num(row.new_users),
    newSubmissions: num(row.new_submissions),
    newComments: num(row.new_comments),
    newVotes: num(row.new_votes),
  };
}

function readEngagement(row: Row | undefined): Engagement {
  return {
    votesPaid: num(row?.vote_paid_count),
    votesCreative: num(row?.vote_creative_count),
    voters: num(row?.voter_count),
    investments: num(row?.investment_count),
    investUsd: num(row?.invest_usd),
    commentVotes: num(row?.comment_vote_count),
    commenters: num(row?.commenter_count),
    contentVisitors: num(row?.content_visitor_count),
  };
}

function readCheckin(row: Row | undefined): CheckinSummary {
  return {
    totalCheckins: num(row?.total_checkins),
    users: num(row?.checkin_user_count),
    xpAwarded: num(row?.xp_awarded),
    avgStreak: num(row?.avg_streak),
    streak7plus: num(row?.streak_7plus_count),
    longestStreak: num(row?.longest_streak),
  };
}

function readLottery(row: Row | undefined): LotterySummary {
  return {
    draws: num(row?.draw_count),
    drawers: num(row?.drawer_count),
    xpAwarded: num(row?.xp_awarded),
    xpCost: num(row?.xp_cost),
    ticketsGranted: num(row?.tickets_granted),
    ticketsSpent: num(row?.tickets_spent),
    ticketsOutstanding: num(row?.tickets_outstanding),
    unfulfilled: num(row?.unfulfilled_count),
  };
}

function toBreakdown(name: unknown, row: Row): BreakdownRow {
  return {
    name: typeof name === "string" && name ? name : null,
    views: num(row.views),
    visitors: num(row.visitors),
  };
}

// bigint 在 PostgREST 的 JSON 里会变成字符串（超出 JS 安全整数范围时），统一收口成 number。
function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// 允许"没有数据"的指标用这个：null / undefined 原样保留，不压成 0。
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ========== 时间区间 ==========

/**
 * 区间按 ANALYTICS_TZ 的自然日对齐，且到"今天结束"为止（不是"此刻"）。
 * 否则 7 天窗口的两端各切掉半天，今天的数字会一直比昨天矮，看起来像每天都在掉量。
 *
 * 上一段周期紧贴着当前段（prevTo === from），长度相同，用于环比。
 */
function rangeBounds(rangeDays: number): { from: string; to: string; prevFrom: string; prevTo: string } {
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = zonedDayStart(new Date(), ANALYTICS_TZ);
  const to = todayStart + dayMs; // 半开区间的右端：今天的 24:00
  const from = to - rangeDays * dayMs;

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    prevFrom: new Date(from - rangeDays * dayMs).toISOString(),
    prevTo: new Date(from).toISOString(),
  };
}

/**
 * 给定时刻在指定时区的当天 0 点，返回 UTC 毫秒。
 * 先按时区格式化出年月日，再反推那个"本地 0 点"对应的绝对时刻；
 * 时区偏移要用目标时刻自己的偏移来算，所以做了一次修正（跨夏令时切换的日子才用得上，
 * Asia/Shanghai 没有夏令时，第一次就已经准了）。
 */
function zonedDayStart(instant: Date, timeZone: string): number {
  const [year, month, day] = ymdInZone(instant, timeZone);
  const guess = Date.UTC(year, month - 1, day);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const corrected = guess - offset;
  const offsetAgain = zoneOffsetMs(new Date(corrected), timeZone);
  return guess - offsetAgain;
}

const YMD_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = YMD_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    YMD_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

function partsInZone(instant: Date, timeZone: string): number[] {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // en-CA 的 hour 在 hour12:false 下会把午夜给成 24，归一化回 0。
  const hour = get("hour") % 24;
  return [get("year"), get("month"), get("day"), hour, get("minute"), get("second")];
}

function ymdInZone(instant: Date, timeZone: string): number[] {
  return partsInZone(instant, timeZone).slice(0, 3);
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const [year, month, day, hour, minute, second] = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // 抹掉毫秒差：格式化拿不到毫秒，两边都对齐到秒再相减。
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}
