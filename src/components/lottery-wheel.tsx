"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { getSignInHref } from "@/lib/auth-navigation";
import { Link } from "@/i18n/navigation";
import { useRouter } from "@/i18n/navigation";
import { drawLottery, type LotteryResult } from "@/app/actions/activities";
import {
  WHEEL_RING_CELLS,
  lotteryWindowStatus,
  type LotteryPrize,
  type LotterySettings,
  type LotteryWindowStatus,
  type LotteryWinner,
} from "@/lib/activity-types";
import { Modal } from "@/components/modal";
import { LevelBadge } from "@/components/level-badge";

// 九宫格抽奖。抽一次消耗抽奖券，手里没券按钮就点不动，
// 券的数量一直显示在抽奖按钮下面。
//
// 活动时间（starts_at / ends_at）由后台配置，未开始 / 已结束时按钮同样点不动。
// 前端算一遍只是为了把按钮置灰和给出文案，真正的判定在数据库函数里——
// 客户端的时钟不可信，也挡不住直接调 Server Action。
//
// 动画的关键点是「先转起来，再决定停在哪」：
// 点击后立刻开始匀速游走（不等服务端返回），服务端把中奖奖位返回来之后，
// 从当前格子继续走 2 圈并按缓动减速，正好停在中奖格上。
// 如果反过来（先 await 再开始转），用户会先看到几百毫秒的卡顿，很出戏。

const SPIN_INTERVAL_MS = 70; // 匀速阶段每格的间隔
const LAND_MIN_MS = 80; // 减速阶段的起始间隔
const LAND_MAX_MS = 340; // 减速阶段的最终间隔（停下来那一格停得住）
const LAND_LAPS = 2; // 收到结果后至少再转几圈
const SLOTS = WHEEL_RING_CELLS.length;

interface ConfettiPiece {
  id: number;
  left: number;
  delay: number;
  duration: number;
  color: string;
  rotate: number;
}

const CONFETTI_COLORS = ["#f43f5e", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#fbbf24"];

type LotteryT = ReturnType<typeof useTranslations<"lottery">>;

// 活动时间只精确到分钟就够了，秒对运营配的档期没有意义。
// 用 next-intl 的 formatter 而不是 toLocaleString("zh-CN")，英文界面才会显示英文月份。
type DateFormatter = ReturnType<typeof useFormatter>;
function makeWindowTimeFormatter(format: DateFormatter) {
  return (iso: string | null): string => {
    if (!iso) return "";
    return format.dateTime(new Date(iso), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };
}

export function LotteryWheel({
  prizes,
  settings,
  tickets: serverTickets,
  drawsLeft: serverDrawsLeft,
  recentWinners,
  expectedUserId,
  stateVersion,
  onUpdated,
}: {
  prizes: LotteryPrize[];
  settings: LotterySettings;
  tickets: number;
  /** null = 没设每日上限，只看券够不够 */
  drawsLeft: number | null;
  recentWinners: LotteryWinner[];
  expectedUserId: string | null;
  stateVersion: number;
  onUpdated: () => void;
}) {
  const isLoggedIn = Boolean(expectedUserId);
  const t = useTranslations("lottery");
  const format = useFormatter();
  const formatWindowTime = makeWindowTimeFormatter(format);
  const router = useRouter();
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [winnerSlot, setWinnerSlot] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<LotteryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confetti, setConfetti] = useState<ConfettiPiece[]>([]);

  // 抽完一次立刻把券余额和剩余次数改掉，不等服务端 revalidate 往返。
  // 服务端数据回来（router.refresh 之后 props 变了）就丢掉本地覆盖值，以服务端为准——
  // 这是 React 官方推荐的「props 变化时重置 state」写法：在渲染期比对并 setState。
  const [local, setLocal] = useState<{ tickets: number; drawsLeft: number | null } | null>(null);
  const [syncedProps, setSyncedProps] = useState({ tickets: serverTickets, drawsLeft: serverDrawsLeft, version: stateVersion });
  if (syncedProps.tickets !== serverTickets || syncedProps.drawsLeft !== serverDrawsLeft || syncedProps.version !== stateVersion) {
    setSyncedProps({ tickets: serverTickets, drawsLeft: serverDrawsLeft, version: stateVersion });
    setLocal(null);
  }
  const tickets = local?.tickets ?? serverTickets;
  const drawsLeft = local ? local.drawsLeft : serverDrawsLeft;

  // 当前停在第几格。用 ref 而不是 state：定时器回调里要读最新值，
  // 闭包捕获的 state 会是旧的。
  const slotRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; stoppedRef.current = true; clearTimer(); };
  }, [clearTimer]);

  // 按奖位序号（0-7）建索引：服务端返回的是 position，要映射到九宫格的格子。
  const prizeBySlot = new Map(prizes.map((prize) => [prize.position, prize]));

  function step() {
    slotRef.current = (slotRef.current + 1) % SLOTS;
    setActiveSlot(slotRef.current);
  }

  function startSpin() {
    stoppedRef.current = false;
    const tick = () => {
      if (stoppedRef.current) return;
      step();
      timerRef.current = setTimeout(tick, SPIN_INTERVAL_MS);
    };
    tick();
  }

  function landOn(target: number, onDone: () => void) {
    stoppedRef.current = true;
    clearTimer();

    const distance = (target - slotRef.current + SLOTS) % SLOTS;
    const steps = LAND_LAPS * SLOTS + (distance === 0 ? SLOTS : distance);
    let i = 0;

    const run = () => {
      i += 1;
      step();
      if (i >= steps) {
        onDone();
        return;
      }
      // 缓出：指数越大，最后几格越明显地"一格一格挪"，落定感更强。
      const t = i / steps;
      const delay = LAND_MIN_MS + (LAND_MAX_MS - LAND_MIN_MS) * Math.pow(t, 2.6);
      timerRef.current = setTimeout(run, delay);
    };
    run();
  }

  function fireConfetti() {
    setConfetti(
      Array.from({ length: 28 }, (_, id) => ({
        id,
        left: Math.random() * 100,
        delay: Math.random() * 0.35,
        duration: 1.5 + Math.random() * 1.1,
        color: CONFETTI_COLORS[id % CONFETTI_COLORS.length],
        rotate: Math.random() * 360,
      }))
    );
    setTimeout(() => setConfetti([]), 3000);
  }

  async function handleDraw() {
    if (spinning) return;
    setError(null);
    setResult(null);
    setWinnerSlot(null);
    setSpinning(true);
    startSpin();

    if (!expectedUserId) return;
    const draw = await drawLottery(expectedUserId);
    if (!mountedRef.current) return;

    if (!draw.ok || draw.prizePosition === null) {
      stoppedRef.current = true;
      clearTimer();
      setActiveSlot(null);
      setSpinning(false);
      // 失败时服务端也会把当前余额回传（比如"券不够了"），顺手同步过来。
      setLocal({ tickets: draw.ticketBalance, drawsLeft: draw.drawsLeft });
      setError(draw.message);
      onUpdated();
      return;
    }

    landOn(draw.prizePosition, () => {
      setWinnerSlot(draw.prizePosition);
      setSpinning(false);
      setLocal({ tickets: draw.ticketBalance, drawsLeft: draw.drawsLeft });
      setResult(draw);
      // 只有真的中了东西才撒花，"谢谢参与"撒花会很讽刺。
      if (draw.prizeKind !== "none") fireConfetti();
      onUpdated();
      router.refresh();
    });
  }

  const windowStatus = lotteryWindowStatus(settings);
  const subtitle =
    windowStatus === "disabled"
      ? t("disabled")
      : windowStatus === "not_started"
        ? t("notStarted", { time: formatWindowTime(settings.startsAt) })
        : windowStatus === "ended"
          ? t("ended", { time: formatWindowTime(settings.endsAt) })
          : drawsLeft !== null
            ? t("drawsLeft", { count: drawsLeft })
            : "";
  const outOfDraws = drawsLeft !== null && drawsLeft <= 0;
  const outOfTickets = tickets < settings.costTickets;
  const canDraw = isLoggedIn && windowStatus === "open" && !outOfDraws && !outOfTickets && !spinning;

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-line p-5"
      style={{ background: "var(--color-surface)" }}
    >
      {/* 顶部光斑，让深色面板不至于死板 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-16 -top-20 h-56 w-56 rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(circle,#fbbf24,transparent 70%)" }}
      />

      {confetti.length > 0 && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          {confetti.map((piece) => (
            <span
              key={piece.id}
              className="confetti-piece"
              style={{
                left: `${piece.left}%`,
                background: piece.color,
                animationDelay: `${piece.delay}s`,
                animationDuration: `${piece.duration}s`,
                transform: `rotate(${piece.rotate}deg)`,
              }}
            />
          ))}
        </div>
      )}

      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-ink sm:text-xl">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-soft text-base"
              aria-hidden
            >
              🎰
            </span>
            {t("title")}
          </h2>
          {/* 只在有话可说时才渲染：活动没开放/没开始/已结束，或者设了每日次数上限。
              "每次消耗 N 张券"不写在这里——抽奖按钮下面就挂着券数量，右边奖品表也写着，
              标题底下再说一遍是第三遍。 */}
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          {/* 正在进行中的活动也要把截止时间摆出来，制造一点紧迫感。 */}
          {windowStatus === "open" && settings.endsAt && (
            <p className="mt-0.5 font-mono text-[11px] text-brand-ink">
              {t("endsAt", { time: formatWindowTime(settings.endsAt) })}
            </p>
          )}
        </div>

        {/* 券余额和签到卡右上角的"已连续 N 天"是同一个位置、同一种分量的数字。 */}
        {isLoggedIn && (
          <div
            className="flex shrink-0 items-center gap-3 rounded-2xl px-4 py-2.5"
            style={{ background: "rgba(255,255,255,.14)" }}
          >
            <span className="text-2xl leading-none" aria-hidden>
              🎟️
            </span>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wide text-muted">{t("myTickets")}</p>
              <p className="text-2xl font-extrabold leading-tight text-brand-ink">
                {tickets}
                <span className="ml-0.5 text-xs font-semibold">{t("ticketUnit")}</span>
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 左边九宫格、右边奖品概率表：卡片是整页宽的，右半边空着不如把概率摆出来——
          本来藏在弹窗里的信息，明着给反而更让人想玩。 */}
      <div className="relative mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,400px)_1fr]">
      <div>

      {/* 九宫格 */}
      <div className="relative mx-auto grid max-w-md grid-cols-3 gap-2 sm:gap-2.5">
        {Array.from({ length: 9 }, (_, cell) => {
          if (cell === 4) {
            return (
              <DrawButton
                key="center"
                t={t}
                canDraw={canDraw}
                spinning={spinning}
                isLoggedIn={isLoggedIn}
                windowStatus={windowStatus}
                outOfDraws={outOfDraws}
                outOfTickets={outOfTickets}
                tickets={tickets}
                onClick={handleDraw}
              />
            );
          }

          const slot = WHEEL_RING_CELLS.indexOf(cell as (typeof WHEEL_RING_CELLS)[number]);
          const prize = prizeBySlot.get(slot);
          const isActive = activeSlot === slot;
          const isWinner = winnerSlot === slot;
          const soldOut = prize ? prize.stock !== null && prize.awardedCount >= prize.stock : false;

          return (
            <div
              key={cell}
              className={`relative flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border px-1 text-center transition-all duration-100 ${
                isWinner
                  ? "wheel-winner border-amber-300 bg-white"
                  : isActive
                    ? "scale-[1.06] border-amber-300 bg-white shadow-[0_0_22px_rgba(251,191,36,.75)]"
                    : "border-line bg-surface-2"
              }`}
            >
              <span className={`text-2xl leading-none sm:text-[28px] ${soldOut ? "opacity-40 grayscale" : ""}`} aria-hidden>
                {prize?.icon ?? "❔"}
              </span>
              <span
                className={`line-clamp-2 text-[10px] font-semibold leading-tight sm:text-[11px] ${
                  isActive || isWinner ? "text-ink" : "text-ink"
                }`}
              >
                {prize?.name || t("emptySlot")}
              </span>
              {prize && prize.stock !== null && (
                <span
                  className={`font-mono text-[9px] ${
                    isActive || isWinner ? "text-muted" : soldOut ? "text-faint" : "text-brand-ink"
                  }`}
                >
                  {soldOut ? t("soldOut") : t("remaining", { count: prize.stock - prize.awardedCount })}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="relative mt-4 rounded-xl bg-brand-soft px-3 py-2 text-center text-xs font-medium text-brand-ink">
          {error}
        </p>
      )}

      </div>

      <PrizeOdds prizes={prizes} settings={settings} t={t} formatWindowTime={formatWindowTime} />
      </div>

      {/* 最近中奖播报 */}
      {recentWinners.length > 0 && (
        <div className="relative mt-5 overflow-hidden rounded-xl bg-surface-2 py-2">
          <div className="marquee flex w-max gap-6 px-3">
            {/* 内容复制一份接在后面，滚到一半时和开头无缝衔接 */}
            {[...recentWinners, ...recentWinners].map((winner, i) => (
              <span key={`${winner.id}-${i}`} className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                <LevelBadge level={winner.level} size="xs" showIcon={false} />
                <span className="font-semibold text-ink">
                  {winner.displayName || winner.username || t("mysteryUser")}
                </span>
                {t("won")}
                <span className="font-semibold text-amber-200">
                  {winner.prizeIcon} {winner.prizeName}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <ResultModal result={result} onClose={() => setResult(null)} t={t} />
    </section>
  );
}

function DrawButton({
  canDraw,
  spinning,
  isLoggedIn,
  windowStatus,
  outOfDraws,
  outOfTickets,
  tickets,
  onClick,
  t,
}: {
  canDraw: boolean;
  spinning: boolean;
  isLoggedIn: boolean;
  windowStatus: LotteryWindowStatus;
  outOfDraws: boolean;
  outOfTickets: boolean;
  tickets: number;
  onClick: () => void;
  t: LotteryT;
}) {
  const locale = useLocale();
  if (!isLoggedIn) {
    return (
      <Link
        href={getSignInHref("/community/activities?category=checkin", locale)}
        className="flex aspect-square flex-col items-center justify-center rounded-xl text-center text-xs font-bold text-white shadow-lg"
        style={{ background: "var(--color-brand)" }}
      >
        <span className="text-lg leading-none" aria-hidden>
          🔒
        </span>
        <span className="mt-1">{t("signInToDraw")}</span>
      </Link>
    );
  }

  const label =
    windowStatus === "disabled"
      ? t("btnDisabled")
      : windowStatus === "not_started"
        ? t("btnNotStarted")
        : windowStatus === "ended"
          ? t("btnEnded")
          : spinning
            ? t("btnSpinning")
            : outOfDraws
              ? t("btnOutOfDraws")
              : outOfTickets
                ? t("btnOutOfTickets")
                : t("btnDraw");

  return (
    <button
      type="button"
      disabled={!canDraw}
      onClick={onClick}
      className={`flex aspect-square flex-col items-center justify-center rounded-xl text-center font-bold text-white shadow-lg transition-transform ${
        canDraw ? "hover:scale-[1.05] active:scale-95" : "cursor-not-allowed opacity-70 grayscale"
      } ${spinning ? "animate-pulse" : ""}`}
      style={{ background: "var(--color-brand)" }}
    >
      <span className="text-2xl leading-none" aria-hidden>
        {spinning ? "🎲" : "🎯"}
      </span>
      <span className="mt-1 text-xs sm:text-sm">{label}</span>
      {/* 抽奖按钮下面永远挂着当前券数量——这是用户点之前最想知道的那个数字。 */}
      {!spinning && (
        <span
          className={`mt-0.5 rounded-full px-1.5 font-mono text-[11px] font-bold ${
            outOfTickets ? "bg-black/25 text-white/70" : "bg-white/25 text-white"
          }`}
        >
          🎟️ {tickets}
        </span>
      )}
    </button>
  );
}

function ResultModal({
  result,
  onClose,
  t,
}: {
  result: LotteryResult | null;
  onClose: () => void;
  t: LotteryT;
}) {
  const won = result?.ok && result.prizeKind !== "none";

  return (
    <Modal open={Boolean(result)} onClose={onClose} widthClassName="max-w-sm">
      {result && (
        <div className="flex flex-col items-center text-center">
          <span
            className="prize-pop flex h-24 w-24 items-center justify-center rounded-full text-5xl"
            style={{
              background: won
                ? "linear-gradient(135deg,#fef3c7,#fcd34d)"
                : "linear-gradient(135deg,#f1f5f9,#e2e8f0)",
            }}
            aria-hidden
          >
            {result.prizeIcon}
          </span>

          <p className="mt-4 text-sm font-semibold text-muted">{won ? t("resultWon") : t("resultLost")}</p>
          <p className="mt-1 text-2xl font-extrabold text-ink">{result.prizeName}</p>

          {result.xpAwarded > 0 && (
            <p className="mt-2 rounded-full bg-good-soft px-3 py-1 font-mono text-sm font-bold text-good">
              +{result.xpAwarded} XP
            </p>
          )}
          {result.ticketsAwarded > 0 && (
            <p className="mt-2 rounded-full bg-warn-soft px-3 py-1 font-mono text-sm font-bold text-warn">
              {t("ticketsAwarded", { count: result.ticketsAwarded })}
            </p>
          )}
          {result.prizeKind === "badge" && (
            <p className="mt-2 text-xs text-muted">{t("badgeAwarded")}</p>
          )}
          {result.prizeKind === "item" && (
            <p className="mt-2 text-xs text-muted">{t("itemAwarded")}</p>
          )}
          {result.leveledUp && (
            <p className="mt-3 flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-ink">
              {t("leveledUp")} <LevelBadge level={result.newLevel} size="xs" showName />
            </p>
          )}

          <p className="mt-4 font-mono text-[11px] text-faint">
            {t("ticketBalance", { count: result.ticketBalance })}
            {result.drawsLeft !== null && t("drawsLeftSuffix", { count: result.drawsLeft })}
          </p>

          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink"
          >
            {t("gotIt")}
          </button>
        </div>
      )}
    </Modal>
  );
}

// 概率是按权重算出来的（weight / 所有可抽奖品权重之和），直接摆出来比藏着更让人愿意玩。
// 这块原来是个弹窗，卡片改成整页宽之后挪到右栏常驻——右半边本来就是空的。
function PrizeOdds({
  prizes,
  settings,
  t,
  formatWindowTime,
}: {
  prizes: LotteryPrize[];
  settings: LotterySettings;
  t: LotteryT;
  formatWindowTime: (iso: string | null) => string;
}) {
  const drawable = prizes.filter(
    (prize) => prize.active && prize.weight > 0 && (prize.stock === null || prize.awardedCount < prize.stock)
  );
  const totalWeight = drawable.reduce((sum, prize) => sum + prize.weight, 0);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-ink">{t("oddsTitle")}</p>
        <p className="font-mono text-[10px] text-muted">{t("oddsLive")}</p>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {prizes.map((prize) => {
          const soldOut = prize.stock !== null && prize.awardedCount >= prize.stock;
          const chance =
            totalWeight > 0 && !soldOut && prize.active && prize.weight > 0
              ? (prize.weight / totalWeight) * 100
              : 0;

          return (
            <div
              key={prize.id}
              className="relative flex items-center gap-3 overflow-hidden rounded-xl bg-surface-2 px-3 py-2"
            >
              {/* 概率条铺在整行底下，比只写一个百分数更容易一眼比出大小 */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-brand/5"
                style={{ width: `${Math.min(100, chance)}%` }}
              />
              <span className={`relative text-xl leading-none ${soldOut ? "opacity-40 grayscale" : ""}`} aria-hidden>
                {prize.icon}
              </span>
              <div className="relative min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-ink">{prize.name || t("emptySlot")}</p>
                <p className="font-mono text-[10px] text-muted">
                  {prize.stock === null
                    ? t("unlimited")
                    : soldOut
                      ? t("limitedSoldOut", { stock: prize.stock })
                      : t("limitedRemaining", {
                          stock: prize.stock,
                          remaining: prize.stock - prize.awardedCount,
                        })}
                </p>
              </div>
              <span className="relative shrink-0 font-mono text-xs font-bold text-brand-ink">
                {chance > 0 ? `${chance.toFixed(1)}%` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {/* 规则性的文字都在 FAQ 里，这儿只留和"这一期"有关的信息：档期、每日上限。 */}
      {(settings.startsAt || settings.endsAt || settings.drawsPerDay > 0) && (
        <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-[11px] leading-5 text-muted">
          {(settings.startsAt || settings.endsAt) && (
            <p>
              {t("windowRange", {
                start: settings.startsAt ? formatWindowTime(settings.startsAt) : t("longTerm"),
                end: settings.endsAt ? formatWindowTime(settings.endsAt) : t("longTerm"),
              })}
            </p>
          )}
          {settings.drawsPerDay > 0 && <p>{t("drawsPerDay", { count: settings.drawsPerDay })}</p>}
        </div>
      )}
    </div>
  );
}
