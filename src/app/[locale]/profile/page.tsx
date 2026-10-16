import { submissionHref } from "@/lib/types";
import { useTranslations } from "next-intl";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { createClient } from "@/lib/supabase/server";
import { deriveUser, type AuthMethod } from "@/lib/derive-user";
import { getCurrentProfile } from "@/lib/profile";
import { getUserBadges } from "@/lib/badges";
import { getOwnSubmissionCards } from "@/lib/submissions";
import { getUserTagsMap } from "@/lib/user-tags";
import { getOwnXpEvents } from "@/lib/xp";
import { xpActionLabel } from "@/lib/level";
import { EXPERTISE_OPTIONS } from "@/lib/expertise";
import { badgeInfo } from "@/lib/types";
import { EditProfileButton } from "@/components/edit-profile-modal";
import { UserBadgeInline } from "@/components/user-badge-inline";
import { LevelCard } from "@/components/level-progress";
import { Avatar } from "@/components/avatar";

// 三种登录方式的文案 key，对应 messages/*.json 的 profile.methodXxx。
const METHOD_KEY: Record<AuthMethod, "methodGoogle" | "methodWallet" | "methodPassword"> = {
  google: "methodGoogle",
  wallet: "methodWallet",
  password: "methodPassword",
};

export default async function ProfilePage() {
  const t = await getTranslations("profile");
  const tc = await getTranslations("common");
  const locale = await getLocale();
  const format = await getFormatter();
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const sessionUser = deriveUser(authUser);

  if (!sessionUser || !authUser) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center sm:px-6">
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft text-2xl">🔒</span>
        <h1 className="text-2xl font-extrabold text-ink">{t("signInTitle")}</h1>
        <p className="mt-2 text-sm text-muted">{t("signInBody")}</p>
        <Link
          href="/auth/sign-in?redirect=/profile"
          className="mt-6 rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink"
        >
          {tc("goSignIn")}
        </Link>
      </div>
    );
  }

  const [badges, submissions, currentProfile, tagsByUser, xpEvents] = await Promise.all([
    getUserBadges(authUser.id),
    getOwnSubmissionCards(authUser.id),
    getCurrentProfile(),
    getUserTagsMap([authUser.id]),
    getOwnXpEvents(8),
  ]);

  const displayName = currentProfile?.displayName || currentProfile?.username || sessionUser.name;

  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <div className="max-w-2xl">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar
              src={currentProfile?.avatarUrl}
              name={displayName}
              className="h-16 w-16 rounded-full bg-brand-soft font-display text-xl font-bold text-brand-ink"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-extrabold text-ink">{displayName}</h1>
                <UserBadgeInline
                  role={currentProfile?.role}
                  tags={tagsByUser[authUser.id]}
                  level={currentProfile?.level}
                />
              </div>
              <p className="font-mono text-xs text-faint">
                {currentProfile?.username ? `@${currentProfile.username} · ` : ""}
                {t("loggedInVia", { method: t(METHOD_KEY[sessionUser.method]) })}
              </p>
              {currentProfile?.bio && <p className="mt-1.5 max-w-md text-sm text-muted">{currentProfile.bio}</p>}
              {currentProfile && currentProfile.expertise.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {currentProfile.expertise.map((id) => {
                    const option = EXPERTISE_OPTIONS.find((o) => o.id === id);
                    if (!option) return null;
                    return (
                      <span
                        key={id}
                        className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-brand-ink"
                      >
                        {locale === "en" ? option.en : option.zh}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <EditProfileButton
            initialDisplayName={displayName}
            initialUsername={currentProfile?.username ?? ""}
            initialBio={currentProfile?.bio ?? ""}
            initialExpertise={currentProfile?.expertise ?? []}
            initialAvatarUrl={currentProfile?.avatarUrl ?? null}
            className="shrink-0 rounded-full border border-line px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-brand hover:text-brand-ink"
          />
        </div>

        {/* 等级与经验：只有本人看得到进度条和"还差多少升级"（别人的主页只显示经验总量）。 */}
        <div className="mt-8">
          <LevelCard xp={currentProfile?.xp ?? 0} level={currentProfile?.level ?? 0} />

          {xpEvents.length > 0 && (
            <details className="mt-2 rounded-2xl border border-line bg-surface px-5 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-ink">{t("recentXp")}</summary>
              <div className="mt-2 flex flex-col divide-y divide-line">
                {xpEvents.map((event) => (
                  <div key={event.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className={`text-sm ${event.revoked_at ? "text-faint line-through" : "text-muted"}`}>
                      {xpActionLabel(event.action, locale)}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="font-mono text-[10px] text-faint">
                        {format.dateTime(new Date(event.created_at), { dateStyle: "short" })}
                      </span>
                      <span
                        className={`font-mono text-xs font-bold ${
                          event.revoked_at ? "text-faint line-through" : event.amount >= 0 ? "text-good" : "text-risk"
                        }`}
                      >
                        {event.amount >= 0 ? "+" : ""}
                        {event.amount}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="mt-8">
          <h2 className="mb-3 text-lg font-bold text-ink">{t("badges")}</h2>
          {badges.length === 0 ? (
            <p className="text-sm text-muted">{t("noBadges")}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {badges.map((badge) => {
                const info = badgeInfo(badge.badge_key, locale);
                if (!info) return null;
                return (
                  <div key={badge.badge_key} className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3">
                    <span className="text-lg leading-none">{info.icon}</span>
                    <div>
                      <p className="text-sm font-semibold text-ink">{info.name}</p>
                      <p className="text-xs text-muted">{info.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-8">
          <h2 className="mb-3 text-lg font-bold text-ink">
            {t("mySubmissions", { count: submissions.length })}
          </h2>
          {submissions.length === 0 ? (
            <p className="text-sm text-muted">
              {t.rich("noSubmissions", {
                submitLink: (chunks) => (
                  <Link href="/submit" className="font-medium text-brand-ink hover:underline">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {submissions.map((s) => (
                <Link
                  key={s.id}
                  href={submissionHref(s)}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-brand"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{s.title}</p>
                    <p className="truncate text-xs text-muted">{s.tagline}</p>
                  </div>
                  <StatusPill status={s.status} />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const t = useTranslations("profile");
  const label =
    status === "published"
      ? t("statusPublished")
      : status === "pending"
        ? t("statusPending")
        : t("statusRejected");
  const cls =
    status === "published"
      ? "bg-good-soft text-good"
      : status === "pending"
        ? "bg-surface-2 text-muted"
        : "bg-risk-soft text-risk";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 font-mono text-[11px] font-medium ${cls}`}>{label}</span>;
}
