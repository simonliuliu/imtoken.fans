"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentProfile } from "@/lib/profile";
import { isBlacklisted } from "@/lib/user-tags";
import { createLevelUpNotification, notifyBadgeAwarded, notifyTicketChange } from "@/lib/notify";

// 签到和抽奖的实际逻辑都在数据库函数里（perform_checkin / perform_lottery_draw）：
// 「一天只能签一次」「抽奖券够不够、扣一张」「奖品库存别超发」这几件事都必须原子，
// 放在应用层用「先查再写」实现的话，连点两下就能签两次、用一张券抽两次、抽超库存。
// 这两个函数只 grant 给了 service_role，所以这里走 admin client。

// perform_checkin / perform_lottery_draw 是数据库函数，失败原因是写死在 SQL 里的中文。
// 想让英文界面也说英文，就得在这一层把这些中文映射回文案 key，再用 next-intl 翻。
// 加新的失败分支时：SQL 里加一条 message，这里补一条映射，两个 messages/*.json 各补一条。
const DB_MESSAGE_KEY: { match: RegExp; key: string }[] = [
  { match: /^签到暂未开放$/, key: "checkinDisabled" },
  { match: /^今天已经签到过了$/, key: "alreadyCheckedIn" },
  { match: /^用户不存在$/, key: "userNotFound" },
  { match: /^抽奖暂未开放$/, key: "lotteryDisabled" },
  { match: /^抽奖活动还没开始$/, key: "lotteryNotStarted" },
  { match: /^抽奖活动已经结束了$/, key: "lotteryEnded" },
  { match: /^今天的抽奖次数已经用完了$/, key: "lotteryOutOfDraws" },
  { match: /^奖品已经全部抽完了/, key: "lotteryOutOfStock" },
  { match: /^抽奖券不够了，每次抽奖需要 (\d+) 张$/, key: "lotteryNotEnoughTickets" },
  { match: /^经验值不足，每次抽奖需要 (\d+) 点$/, key: "lotteryNotEnoughXp" },
];

async function translateDbMessage(raw: string): Promise<string> {
  const t = await getTranslations("activityErrors");
  for (const entry of DB_MESSAGE_KEY) {
    const matched = raw.match(entry.match);
    if (matched) return t(entry.key, { cost: matched[1] ?? "" });
  }
  // 映射表没覆盖到的（SQL 改了、这里忘了跟）就原样透出，至少不会变成空白提示。
  return raw;
}

export interface CheckinResult {
  ok: boolean;
  message: string;
  /** 失败原因是"今天已经签到过了"。前端靠这个同步本地状态，不去猜 message 的文字 */
  alreadyCheckedIn: boolean;
  dayIndex: number;
  streak: number;
  xpAwarded: number;
  newXp: number;
  leveledUp: boolean;
  newLevel: number;
}

interface RawCheckinRow {
  ok: boolean;
  message: string;
  day_index: number;
  streak: number;
  xp_awarded: number;
  new_xp: number;
  old_level: number;
  new_level: number;
}

export async function dailyCheckIn(expectedUserId: string): Promise<CheckinResult> {
  const t = await getTranslations("errors");
  const fail = (message: string, alreadyCheckedIn = false): CheckinResult => ({
    ok: false,
    message,
    alreadyCheckedIn,
    dayIndex: 0,
    streak: 0,
    xpAwarded: 0,
    newXp: 0,
    leveledUp: false,
    newLevel: 0,
  });

  const profile = await getCurrentProfile();
  if (!profile) return fail(t("notSignedIn"));
  if (profile.id !== expectedUserId) return fail(t("sessionChanged"));
  if (await isBlacklisted(profile.id)) return fail(t("blacklistedActivity"));

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("perform_checkin", { p_user_id: profile.id });

  if (error) {
    console.error("[dailyCheckIn] 签到失败:", error);
    return fail(t("checkinFailed"));
  }

  const row = (data as RawCheckinRow[] | null)?.[0];
  if (!row) return fail(t("checkinFailed"));
  if (!row.ok) {
    return fail(await translateDbMessage(row.message), row.message.includes("已经签到"));
  }

  const leveledUp = row.new_level > row.old_level;
  if (leveledUp) await createLevelUpNotification(profile.id, row.new_level);

  revalidatePath("/activities");
  revalidatePath("/community/activities");
  revalidatePath("/profile");

  return {
    ok: true,
    message: row.message,
    alreadyCheckedIn: false,
    dayIndex: row.day_index,
    streak: row.streak,
    xpAwarded: row.xp_awarded,
    newXp: row.new_xp,
    leveledUp,
    newLevel: row.new_level,
  };
}

export interface LotteryResult {
  ok: boolean;
  message: string;
  /** 中奖奖位在九宫格外圈的序号（0-7），前端的选中动画要停在这一格 */
  prizePosition: number | null;
  prizeName: string;
  prizeIcon: string;
  prizeKind: string;
  xpAwarded: number;
  ticketsAwarded: number;
  /** 抽完之后手里还有几张券 */
  ticketBalance: number;
  newXp: number;
  leveledUp: boolean;
  newLevel: number;
  /** 今天还能抽几次；null = 没设每日上限，只看券够不够 */
  drawsLeft: number | null;
}

interface RawLotteryRow {
  ok: boolean;
  message: string;
  prize_id: string | null;
  prize_name: string;
  prize_icon: string;
  prize_kind: string;
  prize_position: number | null;
  xp_awarded: number;
  tickets_awarded: number;
  ticket_balance: number;
  new_xp: number;
  old_level: number;
  new_level: number;
  draws_left: number;
}

export async function drawLottery(expectedUserId: string): Promise<LotteryResult> {
  const t = await getTranslations("errors");
  // 数据库函数用 -1 表示"没设每日上限"，到了 TS 这层统一成 null，前端就不用记这个约定。
  const normalizeDrawsLeft = (value: number | null | undefined): number | null =>
    value === undefined || value === null || value < 0 ? null : value;

  const fail = (message: string, drawsLeft: number | null = null, tickets = 0): LotteryResult => ({
    ok: false,
    message,
    prizePosition: null,
    prizeName: "",
    prizeIcon: "",
    prizeKind: "",
    xpAwarded: 0,
    ticketsAwarded: 0,
    ticketBalance: tickets,
    newXp: 0,
    leveledUp: false,
    newLevel: 0,
    drawsLeft,
  });

  const profile = await getCurrentProfile();
  if (!profile) return fail(t("notSignedIn"));
  if (profile.id !== expectedUserId) return fail(t("sessionChanged"));
  if (await isBlacklisted(profile.id)) return fail(t("blacklistedActivity"));

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("perform_lottery_draw", { p_user_id: profile.id });

  if (error) {
    console.error("[drawLottery] 抽奖失败:", error);
    return fail(t("lotteryFailed"));
  }

  const row = (data as RawLotteryRow[] | null)?.[0];
  if (!row) return fail(t("lotteryFailed"));
  if (!row.ok) {
    return fail(
      await translateDbMessage(row.message),
      normalizeDrawsLeft(row.draws_left),
      row.ticket_balance ?? 0
    );
  }

  const leveledUp = row.new_level > row.old_level;
  if (leveledUp) await createLevelUpNotification(profile.id, row.new_level);

  // 中奖弹窗当场就告诉用户抽到了什么，但券和徽章是会留在账号上的资产，
  // 通知里留一条记录，之后回头对得上账。
  if ((row.tickets_awarded ?? 0) > 0) {
    await notifyTicketChange(profile.id, row.tickets_awarded, row.ticket_balance ?? 0, "lottery_prize");
  }
  if (row.prize_kind === "badge") await notifyLotteryBadge(profile.id, row.prize_id);

  revalidatePath("/activities");
  revalidatePath("/community/activities");
  revalidatePath("/profile");

  return {
    ok: true,
    message: row.message,
    prizePosition: row.prize_position,
    prizeName: row.prize_name,
    prizeIcon: row.prize_icon,
    prizeKind: row.prize_kind,
    xpAwarded: row.xp_awarded,
    ticketsAwarded: row.tickets_awarded ?? 0,
    ticketBalance: row.ticket_balance ?? 0,
    newXp: row.new_xp,
    leveledUp,
    newLevel: row.new_level,
    drawsLeft: normalizeDrawsLeft(row.draws_left),
  };
}

// 徽章是数据库函数里直接 insert 的，返回值里只有 prize_id，
// 想在通知里显示"你获得了内测成员徽章"就得回查一次奖品配置拿 badge_key。
async function notifyLotteryBadge(userId: string, prizeId: string | null): Promise<void> {
  if (!prizeId) return;
  const admin = createAdminClient();
  const { data } = await admin.from("lottery_prizes").select("badge_key").eq("id", prizeId).maybeSingle();
  if (data?.badge_key) await notifyBadgeAwarded(userId, data.badge_key);
}
