"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { getSignInHref } from "@/lib/auth-navigation";
import { Link } from "@/i18n/navigation";
import { useRouter } from "@/i18n/navigation";
import { dailyCheckIn } from "@/app/actions/activities";
import type { CheckinState } from "@/lib/activity-types";

// 每日签到。周期长度和每天的经验值都是后台配的（checkin_settings），
// 所以这里不能假设"一定是 7 天"——格子数、哪一天是大奖，全部按配置渲染。
// 最后一天默认是大奖（金色），判断依据是"这天的经验值是本周期里最高的"，
// 而不是写死 index === 6。
//
// 格子用 auto-fit 的 grid 排：一行放得下就平分整行，放不下自动换行。
// 这样周期天数被改成 5 天或 14 天都不会散架，也不用为每个天数写一套断点。

export function CheckinCard({ state, expectedUserId, onUpdated }: { state: CheckinState; expectedUserId: string | null; onUpdated: () => void }) {
  const isLoggedIn = Boolean(expectedUserId);
  const locale = useLocale();
  const t = useTranslations("checkin");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // 签到成功后的本地状态：不等服务端 revalidate 往返，立刻把格子点亮、按钮变灰。
  const [claimed, setClaimed] = useState<number[]>(state.claimedDayIndexes);
  const [done, setDone] = useState(state.checkedInToday);
  const [streak, setStreak] = useState(state.streak);
  const [flash, setFlash] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; if (flashTimer.current) clearTimeout(flashTimer.current); };
  }, []);
  // A successful fresh read (including another tab or a new Beijing day) is
  // authoritative even when local optimistic state still has the old values.
  const [syncedState, setSyncedState] = useState(state);
  if (syncedState !== state) {
    setSyncedState(state);
    setClaimed(state.claimedDayIndexes);
    setDone(state.checkedInToday);
    setStreak(state.streak);
  }

  const { settings, todayDayIndex, todayReward } = state;
  const days = Array.from({ length: settings.cycleLength }, (_, i) => i + 1);
  const cycleRewards = settings.dayRewards.slice(0, settings.cycleLength);
  const maxReward = Math.max(...cycleRewards, 0);
  // 大奖那天：本周期里经验最高的一天，且确实比第一天高（全都一样就没有"大奖"可言）。
  const bigDay = maxReward > (cycleRewards[0] ?? 0) ? cycleRewards.indexOf(maxReward) + 1 : 0;

  // 本周期已经走到第几天：今天签过就含今天，没签就是昨天为止。
  const doneInCycle = done ? todayDayIndex : todayDayIndex - 1;
  const cycleXp = cycleRewards.slice(0, Math.max(0, doneInCycle)).reduce((sum, n) => sum + (n || 0), 0);
  const daysToBig = bigDay > 0 ? bigDay - doneInCycle : 0;
  const percent = settings.cycleLength > 0 ? (Math.max(0, doneInCycle) / settings.cycleLength) * 100 : 0;

  function handleCheckIn() {
    setError(null);
    startTransition(async () => {
      if (!expectedUserId) return;
      const result = await dailyCheckIn(expectedUserId);
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.message);
        // "今天已经签到过了"说明本地状态过期了（比如在另一个标签页签过），直接同步过来。
        // 判断用服务端给的结构化标记，不去 match 提示文字——文案会跟着语言变。
        if (result.alreadyCheckedIn) { setDone(true); onUpdated(); }
        return;
      }
      setDone(true);
      setStreak(result.streak);
      setClaimed((prev) => (prev.includes(result.dayIndex) ? prev : [...prev, result.dayIndex]));
      setFlash(result.xpAwarded);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 1800);
      onUpdated();
      router.refresh();
    });
  }

  return (
    <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 sm:p-6">
      {/* 左上角一抹渐变光斑，和抽奖卡的深色面板凑成"一套活动"。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -top-28 h-64 w-64 rounded-full opacity-[0.18] blur-3xl"
        style={{ background: "radial-gradient(circle,#e72b74,transparent 70%)" }}
      />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-ink sm:text-xl">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-xl text-base"
              style={{ background: "var(--color-brand-soft)" }}
              aria-hidden
            >
              📅
            </span>
            {t("title")}
          </h2>
        </div>

        {/* 连续天数是签到最核心的那个数字，单独做成一枚勋章。 */}
        <div
          className="flex shrink-0 items-center gap-3 rounded-2xl px-4 py-2.5"
          style={{ background: "var(--color-brand-soft)" }}
        >
          <span className="text-2xl leading-none" aria-hidden>
            {streak > 0 ? "🔥" : "🌱"}
          </span>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-muted">{t("streakLabel")}</p>
            <p className="text-2xl font-extrabold leading-tight text-brand-ink">
              {streak}
              <span className="ml-0.5 text-xs font-semibold">{t("streakUnit")}</span>
            </p>
          </div>
        </div>
      </div>

      {/* 周期进度条。格子会换行，所以"连续"这件事靠这根条来表达，不靠格子之间连线。 */}
      <div className="relative mt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
          <span className="font-semibold text-ink">
            {t("cycleProgress", { done: Math.max(0, doneInCycle), total: settings.cycleLength })}
          </span>
          <span className="text-muted">
            {daysToBig > 0
              ? t("daysToBig", { days: daysToBig, reward: maxReward })
              : doneInCycle >= settings.cycleLength
                ? t("cycleComplete")
                : t("cycleEarned", { xp: cycleXp })}
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${percent}%`, background: "var(--color-brand)" }}
          />
        </div>
      </div>

      {/* 签到格子：一行放得下就平分，放不下自动换行 */}
      <div
        className="relative mt-5 grid gap-2.5"
        style={{ gridTemplateColumns: "repeat(auto-fit,minmax(88px,1fr))" }}
      >
        {days.map((day) => {
          const reward = settings.dayRewards[day - 1] ?? 0;
          const isClaimed = claimed.includes(day);
          const isToday = !done && day === todayDayIndex;
          const isBig = day === bigDay;

          return (
            <div
              key={day}
              className={`relative flex flex-col items-center gap-2 rounded-2xl border px-2 py-4 transition-all ${
                isClaimed
                  ? "border-brand/25 bg-brand-soft"
                  : isToday
                    ? "checkin-today border-brand bg-brand-soft"
                    : isBig
                      ? "border-warn/30 bg-warn-soft"
                      : "border-line bg-surface-2"
              }`}
            >
              {isBig && (
                <span
                  aria-hidden
                  className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[9px] font-bold leading-none text-white shadow-sm"
                  style={{ background: "linear-gradient(135deg,#fbbf24,#d97706)" }}
                >
                  {t("bigPrize")}
                </span>
              )}

              {/* 奖章：已领 = 绿底白勾，大奖 = 金底礼物，今天 = 蓝底靶心，未来 = 白底天数。
                  未来那几天故意不用 emoji：小尺寸下金币类 emoji 会糊成一坨深色球，
                  直接写天数既干净又能当步骤指示器。 */}
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-full font-bold ${
                  isClaimed || isBig || isToday
                    ? "text-lg text-white shadow-sm"
                    : "border border-line font-mono text-base text-faint"
                }`}
                style={{
                  background: isClaimed
                    ? "var(--color-brand)"
                    : isBig
                      ? "linear-gradient(135deg,#fbbf24,#d97706)"
                      : isToday
                        ? "linear-gradient(135deg,#60a5fa,#2563eb)"
                        : "var(--color-surface)",
                }}
                aria-hidden
              >
                {isClaimed ? "✓" : isBig ? "🎁" : isToday ? "🎯" : day}
              </span>

              <span
                className={`font-mono text-sm font-extrabold leading-none ${
                  isClaimed ? "text-brand-ink" : isBig ? "text-warn" : isToday ? "text-brand-ink" : "text-muted"
                }`}
              >
                +{reward}
                <span className="ml-0.5 text-[10px] font-bold text-current opacity-70">XP</span>
              </span>
              <span className="font-mono text-[10px] leading-none text-faint">
                {isToday ? t("today") : t("dayN", { day })}
              </span>
            </div>
          );
        })}
      </div>

      {/* 按钮区 */}
      <div className="relative mt-6 flex flex-wrap items-center gap-3">
        {!isLoggedIn ? (
          <Link
            href={getSignInHref("/community/activities?category=checkin", locale)}
            className="rounded-full bg-brand px-7 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-ink"
          >
            {t("signInToCheckin")}
          </Link>
        ) : !settings.enabled ? (
          <span className="rounded-full bg-surface-2 px-7 py-3 text-sm font-semibold text-muted">
            {t("disabled")}
          </span>
        ) : done ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-good-soft px-7 py-3 text-sm font-semibold text-good">
            {t("alreadyDone")}
          </span>
        ) : (
          <button
            type="button"
            disabled={isPending}
            onClick={handleCheckIn}
            className="relative rounded-full px-8 py-3 text-sm font-bold text-white shadow-md transition-transform hover:scale-[1.03] active:scale-100 disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: "var(--color-brand)" }}
          >
            {isPending ? t("checkingIn") : t("checkinNow", { reward: todayReward })}
          </button>
        )}

        {state.streakWillReset && !done && (
          <span className="text-xs text-warn">{t("streakWillReset")}</span>
        )}

        {/* 领取成功时飘一个 +N XP，比 toast 更轻，也更有"领到了"的感觉。 */}
        {flash !== null && (
          <span className="xp-float pointer-events-none absolute -top-2 left-24 font-mono text-sm font-bold text-good">
            +{flash} XP
          </span>
        )}
      </div>

      {error && <p className="relative mt-2 text-xs text-risk">{error}</p>}
    </section>
  );
}
