"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { toggleProductSupport, upsertProductRating } from "@/app/actions/product-hunter";
import {
  PRODUCT_RATING_IMPROVEMENTS,
  PRODUCT_RATING_STRENGTHS,
} from "@/lib/product-hunter";
import type {
  ProductRating,
  ProductRatingImprovement,
  ProductRatingStrength,
} from "@/lib/types";
import { Avatar } from "@/components/avatar";
import { LevelBadge } from "@/components/level-badge";
import { AuthLoading } from "@/components/auth-loading";
import { useAuth } from "@/lib/auth-context";
import { getSignInHref } from "@/lib/auth-navigation";

export function ProductEngagement(props: {
  submissionId: string;
  submittedBy: string;
  initialViewerId: string | null;
  initialSupportCount: number;
  initialSupported: boolean;
  ratingAverage: number | null;
  ratingCount: number;
  reviews: ProductRating[];
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const viewerId = user?.id ?? null;

  // 切换账号/退出时跟随社区会话，并重新获取这个用户自己的支持状态；不沿用上一账号的标记。
  useEffect(() => {
    if (!loading && viewerId !== props.initialViewerId) router.refresh();
  }, [loading, viewerId, props.initialViewerId, router]);

  return (
    <ProductEngagementContent
      key={`${viewerId ?? "guest"}:${props.initialViewerId ?? "guest"}`}
      {...props}
      authLoading={loading || viewerId !== props.initialViewerId}
      isLoggedIn={Boolean(user)}
      isOwner={viewerId === props.submittedBy}
      initialSupported={viewerId === props.initialViewerId && props.initialSupported}
      viewerRating={props.reviews.find((review) => review.user_id === viewerId) ?? null}
    />
  );
}

function ProductEngagementContent({
  submissionId,
  authLoading,
  isLoggedIn,
  isOwner,
  initialSupportCount,
  initialSupported,
  ratingAverage,
  ratingCount,
  reviews,
  viewerRating,
}: {
  submissionId: string;
  authLoading: boolean;
  isLoggedIn: boolean;
  isOwner: boolean;
  initialSupportCount: number;
  initialSupported: boolean;
  ratingAverage: number | null;
  ratingCount: number;
  reviews: ProductRating[];
  viewerRating: ProductRating | null;
}) {
  const t = useTranslations("productRating");
  const locale = useLocale();
  const format = useFormatter();
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [supported, setSupported] = useState(initialSupported);
  const [supportCount, setSupportCount] = useState(initialSupportCount);
  const [rating, setRating] = useState(viewerRating?.rating ?? 0);
  const [body, setBody] = useState(viewerRating?.body ?? "");
  const [strengths, setStrengths] = useState<ProductRatingStrength[]>(viewerRating?.strengths ?? []);
  const [improvements, setImprovements] = useState<ProductRatingImprovement[]>(viewerRating?.improvements ?? []);
  const [experienced, setExperienced] = useState(Boolean(viewerRating));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const distribution = useMemo(
    () => [5, 4, 3, 2, 1].map((star) => ({ star, count: reviews.filter((review) => review.rating === star).length })),
    [reviews]
  );
  const signInHref = getSignInHref(`${pathname}#product-rating`, locale);

  function handleSupport() {
    setError(null);
    if (!isLoggedIn) return;
    startTransition(async () => {
      const result = await toggleProductSupport(submissionId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSupported(result.supported);
      setSupportCount((count) => Math.max(0, count + (result.supported ? 1 : -1)));
      router.refresh();
    });
  }

  function toggleStrength(value: ProductRatingStrength) {
    setStrengths((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : current.length < 3 ? [...current, value] : current
    );
  }

  function toggleImprovement(value: ProductRatingImprovement) {
    setImprovements((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : current.length < 3 ? [...current, value] : current
    );
  }

  function handleRatingSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await upsertProductRating({
        submissionId,
        rating,
        body,
        strengths,
        improvements,
        experienced,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <section id="product-rating" className="mt-10 scroll-mt-20 space-y-5">
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{t("supportEyebrow")}</p>
            <h2 className="mt-1 text-lg font-bold text-ink">{t("supportTitle")}</h2>
            <p className="mt-1 text-sm leading-6 text-muted">{t("supportDescription")}</p>
          </div>
          {authLoading ? <AuthLoading compact /> : isLoggedIn ? (
            <button
              type="button"
              aria-pressed={supported}
              disabled={isPending}
              onClick={handleSupport}
              className={`min-w-36 rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${
                supported
                  ? "border-brand bg-brand-soft text-brand-ink"
                  : "border-brand bg-brand text-white hover:bg-brand-ink"
              }`}
            >
              {supported ? t("supported", { count: supportCount }) : t("support", { count: supportCount })}
            </button>
          ) : (
            <Link href={signInHref} className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-ink">
              {t("signInToSupport")}
            </Link>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{t("ratingEyebrow")}</p>
            <div className="mt-2 flex items-end gap-2">
              <strong className="text-4xl font-extrabold text-ink">{ratingAverage?.toFixed(1) ?? "—"}</strong>
              <span className="pb-1 text-sm text-faint">/ 5</span>
            </div>
            <p className="mt-1 text-sm text-muted">{t("ratingCount", { count: ratingCount })}</p>
            <div className="mt-4 space-y-1.5">
              {distribution.map((item) => (
                <div key={item.star} className="grid grid-cols-[28px_1fr_24px] items-center gap-2 text-xs text-faint">
                  <span>{item.star}★</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-brand"
                      style={{ width: `${ratingCount ? (item.count / ratingCount) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="text-right">{item.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:border-l lg:border-line lg:pl-6">
            <h2 className="text-lg font-bold text-ink">{viewerRating ? t("editTitle") : t("formTitle")}</h2>
            {authLoading ? <AuthLoading compact /> : isOwner ? (
              <p className="mt-2 rounded-xl bg-surface-2 px-4 py-3 text-sm leading-6 text-muted">{t("ownerCannotRate")}</p>
            ) : !isLoggedIn ? (
              <p className="mt-2 text-sm text-muted">
                <Link href={signInHref} className="font-semibold text-brand-ink hover:underline">{t("signInToRate")}</Link>
              </p>
            ) : (
              <form onSubmit={handleRatingSubmit} className="mt-4 space-y-5">
                <fieldset>
                  <legend className="text-sm font-medium text-ink">{t("scoreLabel")}</legend>
                  <div className="mt-2 flex gap-1" role="radiogroup" aria-label={t("scoreLabel")}>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={rating === value}
                        aria-label={t("starLabel", { count: value })}
                        onClick={() => setRating(value)}
                        className={`text-3xl leading-none ${value <= rating ? "text-brand" : "text-line"}`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                </fieldset>

                <TagGroup
                  label={t("strengthsLabel")}
                  hint={t("chooseUpToThree")}
                  values={PRODUCT_RATING_STRENGTHS}
                  selected={strengths}
                  onToggle={(value) => toggleStrength(value as ProductRatingStrength)}
                  labelFor={(value) => t(`strengths.${value}`)}
                />
                <TagGroup
                  label={t("improvementsLabel")}
                  hint={t("chooseUpToThree")}
                  values={PRODUCT_RATING_IMPROVEMENTS}
                  selected={improvements}
                  onToggle={(value) => toggleImprovement(value as ProductRatingImprovement)}
                  labelFor={(value) => t(`improvements.${value}`)}
                />

                <label className="block text-sm">
                  <span className="font-medium text-ink">{t("reviewLabel")}</span>
                  <textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    minLength={20}
                    maxLength={1000}
                    rows={4}
                    placeholder={t("reviewPlaceholder")}
                    className="mt-1.5 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-ink placeholder:text-faint focus:border-brand focus:outline-none"
                  />
                  <span className="mt-1 block font-mono text-[11px] text-faint">{t("reviewLength", { count: body.trim().length })}</span>
                </label>

                <label className="flex items-start gap-2 text-sm leading-6 text-muted">
                  <input
                    type="checkbox"
                    checked={experienced}
                    onChange={(event) => setExperienced(event.target.checked)}
                    className="mt-1 accent-brand"
                  />
                  <span>{t("experienceConfirm")}</span>
                </label>

                {error && <p className="rounded-lg bg-risk-soft px-3 py-2 text-xs text-risk">{error}</p>}
                {saved && <p className="rounded-lg bg-good-soft px-3 py-2 text-xs text-good">{t("saved")}</p>}
                <button
                  type="submit"
                  disabled={isPending || rating === 0 || body.trim().length < 20 || !experienced}
                  className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isPending ? t("saving") : viewerRating ? t("update") : t("publish")}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">{t("reviewsTitle")}</h2>
          <span className="text-sm text-faint">{t("ratingCount", { count: reviews.length })}</span>
        </div>
        {reviews.length === 0 ? (
          <p className="mt-5 rounded-xl bg-surface-2 px-4 py-5 text-sm text-muted">{t("emptyReviews")}</p>
        ) : (
          <div className="mt-2 divide-y divide-line">
            {reviews.map((review) => (
              <article key={review.id} className="py-5">
                <div className="flex items-start gap-3">
                  <Avatar
                    src={review.author_avatar_url}
                    name={review.author_display_name ?? review.author_username}
                    className="h-10 w-10 rounded-full bg-brand-soft text-sm font-bold text-brand-ink"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-ink">{review.author_display_name ?? review.author_username ?? t("communityMember")}</strong>
                      <LevelBadge level={review.author_level} size="xs" showIcon={false} />
                      <span className="text-brand" aria-label={t("starLabel", { count: review.rating })}>{"★".repeat(review.rating)}</span>
                      <time className="text-xs text-faint" dateTime={review.updated_at}>
                        {format.dateTime(new Date(review.updated_at), { year: "numeric", month: "short", day: "numeric" })}
                      </time>
                    </div>
                    <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted">{review.body}</p>
                    {(review.strengths.length > 0 || review.improvements.length > 0) && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {review.strengths.map((value) => (
                          <span key={value} className="rounded-full bg-good-soft px-2.5 py-1 text-[11px] text-good">+ {t(`strengths.${value}`)}</span>
                        ))}
                        {review.improvements.map((value) => (
                          <span key={value} className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] text-warn">△ {t(`improvements.${value}`)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TagGroup({
  label,
  hint,
  values,
  selected,
  onToggle,
  labelFor,
}: {
  label: string;
  hint: string;
  values: readonly string[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  labelFor: (value: string) => string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">
        {label} <span className="font-normal text-faint">· {hint}</span>
      </legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={selected.includes(value)}
            onClick={() => onToggle(value)}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              selected.includes(value)
                ? "border-brand bg-brand-soft text-brand-ink"
                : "border-line text-muted hover:border-brand"
            }`}
          >
            {labelFor(value)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
