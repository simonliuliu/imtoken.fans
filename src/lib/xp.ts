import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createLevelUpNotification } from "@/lib/notify";
import { XP_ACTION_KEYS, type XpActionKey } from "@/lib/level";

// 经验值的服务端入口。所有加/减分都走这里，不在别处直接改 profiles.xp——
// 原子性和幂等都在数据库函数里（见 0016 迁移的 award_xp / award_xp_by_rule / revoke_xp）。
//
// 一律用 admin client（service_role）：这几个函数只 grant 给了 service_role，
// 而且加分的对象常常不是当前登录用户（比如"你的评论被别人点赞"，加分给评论作者）。

export interface XpResult {
  awarded: number;
  newXp: number;
  oldLevel: number;
  newLevel: number;
  leveledUp: boolean;
}

const EMPTY: XpResult = { awarded: 0, newXp: 0, oldLevel: 0, newLevel: 0, leveledUp: false };

interface RawXpRow {
  awarded?: number;
  revoked?: number;
  new_xp: number;
  old_level: number;
  new_level: number;
}

function toResult(row: RawXpRow | null | undefined): XpResult {
  if (!row) return EMPTY;
  const awarded = row.awarded ?? row.revoked ?? 0;
  return {
    awarded,
    newXp: row.new_xp ?? 0,
    oldLevel: row.old_level ?? 0,
    newLevel: row.new_level ?? 0,
    leveledUp: (row.new_level ?? 0) > (row.old_level ?? 0),
  };
}

// 按后台配置的规则加分。金额、开关、每日上限都在数据库里，调用方只描述"做了什么"。
// refId 是幂等的钥匙：同一条评论 / 同一个提交 / 同一个作品的投票，重复调用只计一次分。
export async function awardXpByRule(params: {
  userId: string | null | undefined;
  action: XpActionKey;
  refType?: string;
  refId?: string | null;
  detail?: Record<string, unknown>;
  /** 升级时是否发通知，默认发 */
  notify?: boolean;
}): Promise<XpResult> {
  if (!params.userId) return EMPTY;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("award_xp_by_rule", {
    p_user_id: params.userId,
    p_action: params.action,
    p_ref_type: params.refType ?? null,
    p_ref_id: params.refId ?? null,
    p_detail: params.detail ?? null,
  });

  if (error) {
    // 加经验失败不该让主流程（发评论、投票）跟着失败，但一定要留日志：
    // 静默失败的表现是"发了评论经验不涨"，没有日志根本查不出来。
    console.error(`[awardXpByRule] ${params.action} 失败:`, error);
    return EMPTY;
  }

  const result = toResult((data as RawXpRow[] | null)?.[0]);
  if (result.leveledUp && params.notify !== false) {
    await createLevelUpNotification(params.userId, result.newLevel);
  }
  return result;
}

// 直接给定金额（签到、抽奖、管理员手动调整）。amount 可以是负数。
export async function adjustXp(params: {
  userId: string;
  action: string;
  amount: number;
  refType?: string;
  refId?: string | null;
  detail?: Record<string, unknown>;
  notify?: boolean;
}): Promise<XpResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("award_xp", {
    p_user_id: params.userId,
    p_action: params.action,
    p_amount: Math.trunc(params.amount),
    p_ref_type: params.refType ?? null,
    p_ref_id: params.refId ?? null,
    p_detail: params.detail ?? null,
  });

  if (error) {
    console.error(`[adjustXp] ${params.action} 失败:`, error);
    return EMPTY;
  }

  const result = toResult((data as RawXpRow[] | null)?.[0]);
  if (result.leveledUp && params.notify !== false) {
    await createLevelUpNotification(params.userId, result.newLevel);
  }
  return result;
}

// 撤销某个对象带来的经验：内容被删除 / 审核驳回时调用。
// 幂等（重复调用不会重复扣），降级不发通知——"你降级了"这种通知只会让人不爽。
export async function revokeXp(params: {
  userId: string | null | undefined;
  action: XpActionKey;
  refId: string;
}): Promise<XpResult> {
  if (!params.userId) return EMPTY;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("revoke_xp", {
    p_user_id: params.userId,
    p_action: params.action,
    p_ref_id: params.refId,
  });

  if (error) {
    console.error(`[revokeXp] ${params.action} 失败:`, error);
    return EMPTY;
  }
  return toResult((data as RawXpRow[] | null)?.[0]);
}

// 内容被删/驳回时，把它可能产生过的经验一次性撤掉。
// 提交不知道是产品还是点子时两种都撤一遍——没发过的那种会被 revoke_xp 当成空操作。
export async function revokeContentXp(kind: "comment" | "submission", id: string, authorId: string): Promise<void> {
  if (kind === "comment") {
    await revokeXp({ userId: authorId, action: "comment_posted", refId: id });
    return;
  }
  await Promise.all([
    revokeXp({ userId: authorId, action: "submission_product", refId: id }),
    revokeXp({ userId: authorId, action: "submission_idea", refId: id }),
    revokeXp({ userId: authorId, action: "submission_post", refId: id }),
  ]);
}

// 把若干个 id 拼成一个稳定的 UUID，用来当 xp_events 的幂等钥匙。
//
// 「评论被点赞」这条规则的幂等边界是 (评论, 点赞的人)：同一个人给同一条评论点赞，
// 不管点赞取消再点多少次，评论作者只该拿一次经验。但 xp_events.ref_id 是单个 uuid，
// 存不下这个二元组，所以按 UUIDv5 的做法把两个 id 哈希成一个确定的 uuid。
// （直接用 comment_votes 那一行的 id 不行：取消点赞会删行，重新点赞是新 id，就能反复刷分。）
export function deterministicUuid(...parts: string[]): string {
  const digest = createHash("sha1").update(parts.join(":")).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ========== 读取 ==========

export interface XpRule {
  action_key: XpActionKey;
  amount: number;
  daily_cap: number;
  enabled: boolean;
}

// xp_rules 公开可读（活动页要把"怎么拿经验"摆出来），普通客户端就够。
// 顺序按 XP_ACTION_KEYS 的声明顺序，不按数据库返回顺序——展示顺序要稳定。
export async function getXpRules(): Promise<XpRule[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("xp_rules").select("action_key, amount, daily_cap, enabled");
  const byKey = new Map((data ?? []).map((row) => [row.action_key as XpActionKey, row as XpRule]));
  return XP_ACTION_KEYS.map(
    (key) => byKey.get(key) ?? { action_key: key, amount: 0, daily_cap: 0, enabled: false }
  );
}

export interface XpEventRow {
  id: string;
  action: string;
  amount: number;
  created_at: string;
  revoked_at: string | null;
}

// 个人中心的"经验明细"。xp_events 的 RLS 只放开本人可读，普通客户端就够。
export async function getOwnXpEvents(limit = 20): Promise<XpEventRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("xp_events")
    .select("id, action, amount, created_at, revoked_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as XpEventRow[];
}
