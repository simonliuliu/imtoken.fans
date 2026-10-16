import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ReactNode } from "react";
import type { SubmissionCard } from "@/lib/types";
import { getSubmissionMediaUrl } from "@/lib/media";
import { getTagLabel } from "@/lib/tag-taxonomy";
import { Avatar } from "@/components/avatar";

export function SubmissionListRow({
  submission,
  rank,
  variant = "plain",
  showTypeBadge = true,
}: {
  submission: SubmissionCard;
  rank: number;
  variant?: "plain" | "ranked";
  showTypeBadge?: boolean;
}) {
  const t = useTranslations("submissionRow");
  const locale = useLocale();
  const href = `/${submission.type === "post" ? `community/${submission.community_section}/${submission.legacy_slug ?? submission.id}` : `${submission.type === "product" ? "products" : "ideas"}/${submission.id}`}`;
  const score = submission.type === "post" ? Number(submission.community_like_count ?? 0) : submission.type === "product" ? submission.support_count : submission.votes_paid + submission.votes_creative;

  return (
    <Link href={href} className="group flex items-center gap-3 py-3 sm:gap-4">
      {variant === "ranked" && <RankBadge rank={rank} title={t("rankTitle", { rank })} />}
      <Avatar
        src={submission.logo_path ? getSubmissionMediaUrl(submission.logo_path) : null}
        name={submission.title}
        className="h-11 w-11 rounded-lg bg-gradient-to-br from-brand to-brand-ink font-display text-sm font-bold text-white sm:h-12 sm:w-12"
      />

      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm font-bold leading-snug text-ink sm:text-[15px]">
          {variant === "plain" && <span className="text-faint">{rank}.</span>}
          <span className="group-hover:text-brand-ink">{submission.title}</span>
          {showTypeBadge && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                submission.type === "product" ? "bg-brand-soft text-brand-ink" : "bg-surface-2 text-muted"
              }`}
            >
              {submission.type === "product" ? t("product") : submission.type === "post" ? t("post") : t("idea")}
            </span>
          )}
        </h3>
        <p className="truncate text-[13px] text-muted">{submission.tagline}</p>
        {submission.type === "product" &&
          (submission.stats_users !== null || submission.stats_dau !== null) && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-faint">
              {submission.stats_users !== null && (
                <span>
                  {t("users")} {submission.stats_users.toLocaleString()}
                </span>
              )}
              {submission.stats_dau !== null && (
                <span>
                  {t("dau")} {submission.stats_dau.toLocaleString()}
                </span>
              )}
            </p>
          )}
        {submission.tags.length > 0 && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-faint">
            <TagIcon />
            {submission.tags
              .slice(0, 3)
              .map((tag) => getTagLabel(tag, locale))
              .join(" · ")}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <StatBox
          icon={<CommentIcon />}
          value={submission.comment_count}
          title={t("comments", { count: submission.comment_count })}
        />
        <StatBox
          icon={<UpvoteIcon />}
          value={score}
          title={submission.type === "post" ? t("likes", { count: score }) : submission.type === "product" ? t("supports", { count: score }) : t("votes", { count: score })}
        />
      </div>
    </Link>
  );
}

const MEDALS: Record<number, { emoji: string; bg: string; ring: string }> = {
  1: { emoji: "🥇", bg: "bg-gradient-to-br from-[#FFE3A3] to-[#F0B429]", ring: "ring-2 ring-[#F0B429]/40" },
  2: { emoji: "🥈", bg: "bg-gradient-to-br from-[#EDF1F6] to-[#B9C2D0]", ring: "ring-2 ring-[#B9C2D0]/50" },
  3: { emoji: "🥉", bg: "bg-gradient-to-br from-[#F3CBA6] to-[#D08A54]", ring: "ring-2 ring-[#D08A54]/40" },
};

function RankBadge({ rank, title }: { rank: number; title: string }) {
  const medal = MEDALS[rank];
  if (medal) {
    return (
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${medal.bg} ${medal.ring} shadow-sm`}
        title={title}
      >
        <span aria-hidden className="text-sm">
          {medal.emoji}
        </span>
      </span>
    );
  }
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-xs font-semibold text-faint"
      title={title}
    >
      {rank}
    </span>
  );
}

function StatBox({ icon, value, title }: { icon: ReactNode; value: number; title: string }) {
  return (
    <div
      title={title}
      className="flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-line bg-surface py-1.5 text-muted transition-colors group-hover:border-brand/40 group-hover:text-brand-ink sm:w-12"
    >
      {icon}
      <span className="text-xs font-bold text-ink">{value}</span>
    </div>
  );
}

function TagIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M20.6 13.4 12 22l-9-9V3h10l9 9a2 2 0 0 1 0 2.83Z" />
      <circle cx="6.5" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.35 0-2.62-.32-3.73-.9L4 20l1.2-4.2A8.5 8.5 0 1 1 21 11.5Z" />
    </svg>
  );
}

function UpvoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
