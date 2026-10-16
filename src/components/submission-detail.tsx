import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { ReactNode } from "react";
import type { CommentWithAuthor, SubmissionCard } from "@/lib/types";
import { getCurrentProfile } from "@/lib/profile";
import { hasPermission } from "@/lib/admin-guard";
import { getSubmissionMediaUrl } from "@/lib/media";
import { getTagLabel } from "@/lib/tag-taxonomy";
import { getUserTagsMap } from "@/lib/user-tags";
import { VoteButtons } from "@/components/vote-buttons";
import { InvestButton } from "@/components/invest-button";
import { CommentSection } from "@/components/comment-section";
import { SubmissionStatsForm } from "@/components/submission-stats-form";
import { UserBadgeInline } from "@/components/user-badge-inline";
import { Avatar } from "@/components/avatar";
import { ProductEngagement as ProductEngagementSection } from "@/components/product-engagement";
import type { ProductEngagement } from "@/lib/submissions";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export async function SubmissionDetail({
  submission,
  similar,
  comments,
  voteFlags,
  productEngagement,
}: {
  submission: SubmissionCard;
  similar: SubmissionCard[];
  comments: CommentWithAuthor[];
  voteFlags: { paid: boolean; creative: boolean };
  productEngagement?: ProductEngagement;
}) {
  const t = await getTranslations("submissionDetail");
  const tc = await getTranslations("common");
  const community = await getTranslations("community");
  const locale = await getLocale();
  const format = await getFormatter();
  const profile = await getCurrentProfile();
  const isLoggedIn = Boolean(profile);
  const isOwner = profile?.id === submission.submitted_by;
  const canModerateComments = Boolean(profile && hasPermission(profile, "moderate_comments"));
  // 提交作者也能置顶自己这条提交下的评论（Server Action 里会再校验一次，前端只管显不显示按钮）。
  const canPinComments = canModerateComments || isOwner;
  const score = submission.votes_paid + submission.votes_creative;

  const tagsByUser = await getUserTagsMap([
    submission.submitted_by,
    ...comments.map((c) => c.user_id),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      {submission.type === "product" && (
        <nav className="community-breadcrumb mb-6" aria-label={community("breadcrumb")}>
          <Link href="/community/feedback">{community("sections.feedback.name")}</Link>
          <span aria-hidden>/</span>
          <Link href="/community/feedback?category=builds">{community("categories.builds")}</Link>
          <span aria-hidden>/</span>
          <span>{submission.title}</span>
        </nav>
      )}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px] lg:gap-10">
        <div className="min-w-0">
          {/* 头部 */}
          <div className="flex items-start gap-4">
            <Avatar
              src={submission.logo_path ? getSubmissionMediaUrl(submission.logo_path) : null}
              name={submission.title}
              className="h-14 w-14 rounded-2xl bg-gradient-to-br from-brand to-brand-ink font-display text-xl font-bold text-white"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-ink sm:text-2xl">{submission.title}</h1>
                <span
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-medium ${
                    submission.type === "product" ? "bg-brand-soft text-brand-ink" : "bg-surface-2 text-muted"
                  }`}
                >
                  {submission.type === "product" ? tc("product") : tc("idea")}
                </span>
                {submission.status !== "published" && (
                  <span className="rounded-full bg-risk-soft px-2.5 py-0.5 font-mono text-[11px] font-medium text-risk">
                    {submission.status === "pending" ? t("pending") : t("rejected")}
                    {t("ownerOnly")}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted">{submission.tagline}</p>
            </div>
          </div>

          {(submission.website_url || submission.video_url) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {submission.website_url && (
                <a
                  href={submission.website_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand-ink"
                >
                  🔗 {t("visitWebsite")}
                </a>
              )}
              {submission.video_url && (
                <a
                  href={submission.video_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand-ink"
                >
                  ▶ {t("watchDemo")}
                </a>
              )}
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-1.5">
            {submission.tags.map((tag) => (
              <span key={tag} className="rounded-md bg-surface-2 px-2.5 py-1 text-xs text-muted">
                {getTagLabel(tag, locale)}
              </span>
            ))}
          </div>

          {/* 页内导航 */}
          <nav className="mt-8 flex gap-5 border-b border-line font-mono text-xs uppercase tracking-wide text-faint">
            <a href="#overview" className="border-b-2 border-brand pb-2.5 text-brand-ink">
              {t("overview")}
            </a>
            {submission.team.length > 0 && (
              <a href="#team" className="pb-2.5 transition-colors hover:text-ink">
                {t("team")}
              </a>
            )}
            <a href="#comments" className="pb-2.5 transition-colors hover:text-ink">
              {t("comments")} ({submission.comment_count})
            </a>
            {submission.type === "product" && (
              <a href="#product-rating" className="pb-2.5 transition-colors hover:text-ink">
                {t("ratings")} ({submission.rating_count})
              </a>
            )}
          </nav>

          <section id="overview" className="mt-6 scroll-mt-20">
            <p className="whitespace-pre-line text-[15px] leading-7 text-ink">{submission.description}</p>

            {submission.screenshot_paths.length > 0 && (
              <div className="mt-6 flex gap-3 overflow-x-auto pb-1">
                {submission.screenshot_paths.map((path) => (
                  <a key={path} href={getSubmissionMediaUrl(path)} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={getSubmissionMediaUrl(path)}
                      alt={t("screenshotAlt", { title: submission.title })}
                      className="h-40 w-64 shrink-0 rounded-xl border border-line object-cover"
                    />
                  </a>
                ))}
              </div>
            )}

            {submission.type === "product" && submission.maker_note && (
              <div className="mt-6 rounded-2xl border border-line bg-surface p-5">
                <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{t("makerNote")}</p>
                <p className="mt-2 whitespace-pre-line text-sm leading-7 text-ink">{submission.maker_note}</p>
              </div>
            )}

            {submission.type === "product" && submission.feedback_prompt && (
              <div className="mt-4 rounded-2xl bg-brand-soft p-5">
                <p className="font-semibold text-brand-ink">{t("feedbackPrompt")}</p>
                <p className="mt-1 whitespace-pre-line text-sm leading-6 text-muted">{submission.feedback_prompt}</p>
              </div>
            )}

            {(submission.stats_users !== null || submission.stats_dau !== null) && (
              <div className="mt-8 grid grid-cols-2 gap-4 rounded-2xl border border-line bg-surface p-5 sm:grid-cols-3">
                <Stat label={t("statsUsers")} value={submission.stats_users?.toLocaleString()} />
                <Stat label={t("statsDau")} value={submission.stats_dau?.toLocaleString()} />
                <Stat
                  label={t("statsUpdatedAt")}
                  value={
                    submission.stats_updated_at
                      ? format.dateTime(new Date(submission.stats_updated_at), { dateStyle: "medium" })
                      : undefined
                  }
                />
              </div>
            )}

            {isOwner && (
              <div className="mt-4">
                <SubmissionStatsForm
                  submissionId={submission.id}
                  initialStatsUsers={submission.stats_users}
                  initialStatsDau={submission.stats_dau}
                />
              </div>
            )}

            {submission.type === "idea" && (
              <>
                <VoteButtons
                  submissionId={submission.id}
                  isLoggedIn={isLoggedIn}
                  initialVotesPaid={submission.votes_paid}
                  initialVotesCreative={submission.votes_creative}
                  initialVoted={voteFlags}
                />
                <InvestButton submissionId={submission.id} isLoggedIn={isLoggedIn} initialTotal={submission.sim_invest_usd} />
              </>
            )}
          </section>

          {submission.type === "product" && productEngagement && (
            <ProductEngagementSection
              submissionId={submission.id}
              submittedBy={submission.submitted_by}
              initialViewerId={productEngagement.viewerId}
              initialSupportCount={submission.support_count}
              initialSupported={productEngagement.viewerSupported}
              ratingAverage={submission.rating_average}
              ratingCount={submission.rating_count}
              reviews={productEngagement.reviews}
            />
          )}

          {submission.team.length > 0 && (
            <section id="team" className="mt-12 scroll-mt-20">
              <h2 className="mb-4 text-lg font-bold text-ink">{t("teamTitle")}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {submission.team.map((member, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft font-display text-sm font-bold text-brand-ink">
                      {member.name.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{member.name}</p>
                      <p className="truncate text-xs text-muted">{member.role}</p>
                      {member.link && (
                        <a
                          href={member.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate font-mono text-[11px] text-brand-ink hover:underline"
                        >
                          {member.link.replace(/^https?:\/\//, "")}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <CommentSection
            submissionId={submission.id}
            commentCount={submission.comment_count}
            comments={comments}
            isLoggedIn={isLoggedIn}
            canModerate={canModerateComments}
            canPin={canPinComments}
            tagsByUser={tagsByUser}
          />
        </div>

        {/* 侧边栏 */}
        <aside className="flex flex-col gap-5">
          <div className="rounded-2xl border border-line bg-surface p-5">
            {submission.type === "product" ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{t("rating")}</p>
                  <p className="mt-1 text-3xl font-extrabold text-ink">{submission.rating_average?.toFixed(1) ?? "—"}</p>
                  <p className="mt-1 text-xs text-faint">{t("ratingCount", { count: submission.rating_count })}</p>
                </div>
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{t("supports")}</p>
                  <p className="mt-1 text-3xl font-extrabold text-ink">{submission.support_count}</p>
                </div>
              </div>
            ) : (
              <>
                <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{t("totalVotes")}</p>
                <p className="mt-1 text-3xl font-extrabold text-ink">{score}</p>
              </>
            )}
          </div>

          <div className="rounded-2xl border border-line bg-surface p-5">
            <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-faint">{t("basicInfo")}</p>
            <dl className="flex flex-col gap-2.5 text-sm">
              <InfoRow
                term={t("submitter")}
                value={
                  <span className="inline-flex items-center gap-1.5">
                    {submission.submitted_by_username ?? tc("anonymous")}
                    <UserBadgeInline
                      role={submission.submitted_by_role}
                      tags={tagsByUser[submission.submitted_by]}
                      level={submission.submitted_by_level}
                    />
                  </span>
                }
              />
              <InfoRow
                term={t("submittedAt")}
                value={format.dateTime(new Date(submission.created_at), { dateStyle: "medium" })}
              />
              <InfoRow
                term={t("category")}
                value={submission.type === "product" ? t("categoryProduct") : t("categoryIdea")}
              />
              {submission.type === "product" && submission.launch_stage && (
                <InfoRow term={t("launchStage")} value={t(`stages.${submission.launch_stage}`)} />
              )}
              {submission.type === "product" && submission.pricing_type && (
                <InfoRow term={t("pricing")} value={t(`pricingOptions.${submission.pricing_type}`)} />
              )}
              {submission.type === "product" && submission.product_platforms.length > 0 && (
                <InfoRow
                  term={t("platforms")}
                  value={submission.product_platforms.map((platform) => t(`platformOptions.${platform}`)).join(" · ")}
                />
              )}
              {submission.type === "idea" && <InfoRow term={t("simInvestTotal")} value={usd.format(submission.sim_invest_usd)} />}
              {submission.website_url && (
                <InfoRow term={t("website")} value={submission.website_url.replace(/^https?:\/\//, "")} />
              )}
            </dl>
          </div>

          {submission.social_links.length > 0 && (
            <div className="rounded-2xl border border-line bg-surface p-5">
              <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-faint">{t("social")}</p>
              <div className="flex flex-wrap gap-2">
                {submission.social_links.map((link, i) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-brand hover:text-brand-ink"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          )}

          {similar.length > 0 && (
            <div className="rounded-2xl border border-line bg-surface p-5">
              <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-faint">{t("similar")}</p>
              <div className="flex flex-col gap-3">
                {similar.map((s) => (
                  <Link
                    key={s.id}
                    href={`/${s.type === "product" ? "products" : "ideas"}/${s.id}`}
                    className="flex items-center gap-2.5 rounded-lg transition-colors hover:bg-surface-2"
                  >
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-brand-ink font-display text-xs font-bold text-white"
                      aria-hidden
                    >
                      {s.title.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{s.title}</p>
                      <p className="truncate text-xs text-muted">{s.tagline}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function InfoRow({ term, value }: { term: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted">{term}</dt>
      <dd className="truncate font-mono text-xs text-ink">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: string | number }) {
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-1 text-lg font-bold text-ink">{value ?? "—"}</p>
    </div>
  );
}
