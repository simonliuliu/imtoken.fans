import type { Metadata } from "next";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentProfile } from "@/lib/profile";
import { getCheckinSettings, getLotterySettings, getLotteryPrizes } from "@/lib/activities";
import { getXpRules } from "@/lib/xp";
import { LEVEL_THRESHOLDS, LEVEL_STEPS, LEVEL_TIERS, levelTierName, xpActionInfo } from "@/lib/level";
import { BADGE_INFO, badgeInfo } from "@/lib/types";
import { LevelBadge } from "@/components/level-badge";

export async function generateMetadata(): Promise<Metadata> {
  const tMeta = await getTranslations("meta");
  return { title: tMeta("faqTitle"), description: tMeta("faqDescription") };
}

// 规则说明页。所有数值都从数据库配置读，后台改完这一页跟着变——
// 不把 "+20 经验" 这类数字写死在文案里，否则运营一调规则，说明页就开始骗人。
export default async function FaqPage() {
  const t = await getTranslations("faq");
  const locale = await getLocale();
  const format = await getFormatter();
  const formatTime = (iso: string) =>
    format.dateTime(new Date(iso), {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const [profile, xpRules, checkin, lottery, prizes] = await Promise.all([
    getCurrentProfile(),
    getXpRules(),
    getCheckinSettings(),
    getLotterySettings(),
    getLotteryPrizes(),
  ]);

  const activeRules = xpRules.filter((rule) => rule.enabled && rule.amount !== 0);
  const cycleTotal = checkin.dayRewards
    .slice(0, checkin.cycleLength)
    .reduce((sum, value) => sum + (value || 0), 0);
  const bigDay = checkin.dayRewards.slice(0, checkin.cycleLength).indexOf(
    Math.max(...checkin.dayRewards.slice(0, checkin.cycleLength), 0)
  );
  const ticketPrizes = prizes.filter((prize) => prize.active && prize.kind === "ticket");

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-2xl font-extrabold text-ink sm:text-3xl">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("subtitle")}</p>
      </header>

      <section className="mt-6 rounded-2xl border border-line bg-surface p-5">
        <h2 className="text-sm font-bold text-ink">{t("docsTitle")}</h2>
        <nav className="mt-3 flex flex-wrap gap-2">
          {[
            { href: "/about", label: t("docsAbout") },
            { href: "/how-it-works", label: t("docsHow") },
            { href: "/for-makers", label: t("docsMakers") },
            { href: "/for-testers", label: t("docsTesters") },
            { href: "/community-guidelines", label: t("docsGuidelines") },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-brand hover:text-brand-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </section>

      <nav className="mt-4 flex flex-wrap gap-2">
        {[
          { href: "#xp", label: t("navXp") },
          { href: "#levels", label: t("navLevels") },
          { href: "#checkin", label: t("navCheckin") },
          { href: "#lottery", label: t("navLottery") },
          { href: "#badges", label: t("navBadges") },
          { href: "#submissions", label: t("navSubmissions") },
        ].map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-brand hover:text-brand-ink"
          >
            {item.label}
          </a>
        ))}
      </nav>

      {/* ========== 怎么拿经验值 ========== */}
      <Section id="xp" title={t("xpTitle")}>
        <p className="text-sm leading-6 text-muted">
          {t.rich("xpIntro", {
            activitiesLink: (chunks) => (
              <Link href="/activities" className="font-medium text-brand-ink hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>

        {activeRules.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("xpAllDisabled")}</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {activeRules.map((rule) => {
              const info = xpActionInfo(rule.action_key, locale);
              return (
                <div
                  key={rule.action_key}
                  className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{info.label}</p>
                    <p className="text-xs text-muted">
                      {info.description}
                      {rule.daily_cap > 0 && t("xpDailyCap", { cap: rule.daily_cap })}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-good-soft px-2.5 py-1 font-mono text-xs font-bold text-good">
                    +{rule.amount}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <ul className="mt-4 flex flex-col gap-1.5 text-xs leading-5 text-muted">
          <li>{t("xpNote1")}</li>
          <li>{t("xpNote2")}</li>
          <li>{t("xpNote3")}</li>
        </ul>
      </Section>

      {/* ========== 等级一览 ========== */}
      <Section id="levels" title={t("levelsTitle")}>
        <p className="text-sm leading-6 text-muted">
          {t.rich("levelsIntro", {
            max: LEVEL_TIERS.length - 1,
            topTier: levelTierName(LEVEL_TIERS.length - 1, locale),
            profileLink: (chunks) => (
              <Link href="/profile" className="font-medium text-brand-ink hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="pb-2 font-mono text-[11px] uppercase tracking-wide text-faint">
                  {t("tableLevel")}
                </th>
                <th className="pb-2 font-mono text-[11px] uppercase tracking-wide text-faint">
                  {t("tableTier")}
                </th>
                <th className="pb-2 text-right font-mono text-[11px] uppercase tracking-wide text-faint">
                  {t("tableTotalXp")}
                </th>
                <th className="pb-2 text-right font-mono text-[11px] uppercase tracking-wide text-faint">
                  {t("tableStepXp")}
                </th>
              </tr>
            </thead>
            <tbody>
              {LEVEL_TIERS.map((_tier, level) => {
                const reached = (profile?.level ?? 0) >= level;
                return (
                  <tr
                    key={level}
                    className={`border-b border-line last:border-b-0 ${reached ? "bg-brand-soft/40" : ""}`}
                  >
                    <td className="py-2">
                      <LevelBadge level={level} size="sm" />
                    </td>
                    <td className="py-2 font-semibold text-ink">{levelTierName(level, locale)}</td>
                    <td className="py-2 text-right font-mono text-xs text-muted">
                      {LEVEL_THRESHOLDS[level].toLocaleString()}
                    </td>
                    <td className="py-2 text-right font-mono text-xs text-faint">
                      {level === 0 ? "—" : `+${LEVEL_STEPS[level - 1].toLocaleString()}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ========== 签到 ========== */}
      <Section id="checkin" title={t("checkinTitle")}>
        {!checkin.enabled ? (
          <p className="text-sm text-muted">{t("checkinDisabled")}</p>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted">
              {bigDay >= 0
                ? t("checkinIntro", {
                    cycle: checkin.cycleLength,
                    bigDay: bigDay + 1,
                    total: cycleTotal.toLocaleString(),
                  })
                : t("checkinIntroNoBigDay", {
                    cycle: checkin.cycleLength,
                    total: cycleTotal.toLocaleString(),
                  })}
            </p>

            <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-7">
              {Array.from({ length: checkin.cycleLength }, (_, i) => (
                <div key={i} className="rounded-xl bg-surface-2 px-1 py-2 text-center">
                  <p className="font-mono text-[10px] text-faint">{t("checkinDayN", { day: i + 1 })}</p>
                  <p
                    className={`font-mono text-sm font-bold ${
                      i === bigDay ? "text-warn" : "text-ink"
                    }`}
                  >
                    +{checkin.dayRewards[i] ?? 0}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-3 text-xs text-muted">{t("checkinTimezone")}</p>
          </>
        )}
      </Section>

      {/* ========== 抽奖 ========== */}
      <Section id="lottery" title={t("lotteryTitle")}>
        <ul className="flex flex-col gap-2 text-sm leading-6 text-muted">
          <li>
            {lottery.costXp > 0
              ? t("lotteryCostWithXp", { tickets: lottery.costTickets, xp: lottery.costXp })
              : t("lotteryCost", { tickets: lottery.costTickets })}
          </li>
          <li>{ticketPrizes.length > 0 ? t("lotterySourceWithTicketPrize") : t("lotterySource")}</li>
          <li>{t("lotteryOdds")}</li>
          <li>{t("lotteryDelivery")}</li>
          {lottery.drawsPerDay > 0 && <li>{t("lotteryDrawsPerDay", { count: lottery.drawsPerDay })}</li>}
          {(lottery.startsAt || lottery.endsAt) && (
            <li>
              {t("lotteryWindow", {
                start: lottery.startsAt ? formatTime(lottery.startsAt) : t("longTerm"),
                end: lottery.endsAt ? formatTime(lottery.endsAt) : t("longTerm"),
              })}
            </li>
          )}
        </ul>
      </Section>

      {/* ========== 徽章 ========== */}
      <Section id="badges" title={t("badgesTitle")}>
        <p className="text-sm leading-6 text-muted">{t("badgesIntro")}</p>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Object.keys(BADGE_INFO).map((key) => {
            const badge = badgeInfo(key, locale);
            if (!badge) return null;
            return (
              <div key={key} className="flex items-start gap-2 rounded-xl bg-surface-2 p-3">
                <span className="text-lg leading-none" aria-hidden>
                  {badge.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">
                    {badge.name}
                    <span className="ml-1.5 font-mono text-[10px] font-normal text-faint">
                      {badge.grantable ? t("badgeGranted") : t("badgeAuto")}
                    </span>
                  </p>
                  <p className="text-xs text-muted">{badge.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ========== 提交与审核 ========== */}
      <Section id="submissions" title={t("submissionsTitle")}>
        <ul className="flex flex-col gap-2 text-sm leading-6 text-muted">
          <li>{t("submissionsNote1")}</li>
          <li>{t("submissionsNote2")}</li>
          <li>{t("submissionsNote3")}</li>
          <li>{t("submissionsNote4")}</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8 scroll-mt-24 rounded-2xl border border-line bg-surface p-5">
      <h2 className="mb-3 text-lg font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

