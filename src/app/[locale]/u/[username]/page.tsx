import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { getPublicProfileByUsername } from "@/lib/public-profile";
import { getPublishedSubmissionsByUser } from "@/lib/submissions";
import { getUserBadges } from "@/lib/badges";
import { getUserTagsMap } from "@/lib/user-tags";
import { badgeInfo } from "@/lib/types";
import { UserBadgeInline } from "@/components/user-badge-inline";
import { LevelCard } from "@/components/level-progress";
import { SubmissionListRow } from "@/components/submission-list-row";
import { FollowControls } from "@/components/follow-controls";
import { Avatar } from "@/components/avatar";

// 极简公开主页：@提及点进来的落地页，只展示公开信息，没有编辑入口，
// 也不展示冷却时间/禁言状态这类仅本人/管理员可见的信息。
export default async function PublicProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const t = await getTranslations("publicProfile");
  const locale = await getLocale();
  const format = await getFormatter();
  const { username } = await params;
  const profile = await getPublicProfileByUsername(username);
  if (!profile) notFound();

  const [badges, submissions, tagsByUser] = await Promise.all([
    getUserBadges(profile.id),
    getPublishedSubmissionsByUser(profile.id),
    getUserTagsMap([profile.id]),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
      <div className="flex items-center gap-4">
        <Avatar
          src={profile.avatarUrl}
          name={profile.displayName || profile.username}
          className="h-16 w-16 rounded-full bg-brand-soft font-display text-xl font-bold text-brand-ink"
        />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-extrabold text-ink">{profile.displayName || profile.username}</h1>
            <UserBadgeInline role={profile.role} tags={tagsByUser[profile.id]} level={profile.level} />
          </div>
          <p className="font-mono text-xs text-faint">
            @{profile.username} ·{" "}
            {t("joinedAt", {
              date: format.dateTime(new Date(profile.createdAt), { dateStyle: "medium" }),
            })}
          </p>
          {profile.bio && <p className="mt-1.5 max-w-md text-sm text-muted">{profile.bio}</p>}
        </div>
      </div>

      <FollowControls targetId={profile.id} username={profile.username} />

      {/* 别人的主页只展示等级和经验总量，不显示进度条和"还差多少升级"。 */}
      <div className="mt-8">
        <LevelCard xp={profile.xp} level={profile.level} variant="public" />
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
          {t("submissions", { count: submissions.length })}
        </h2>
        {submissions.length === 0 ? (
          <p className="text-sm text-muted">{t("noSubmissions")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {submissions.map((s, i) => (
              <SubmissionListRow key={s.id} submission={s} rank={i + 1} variant="plain" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
