"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Avatar } from "@/components/avatar";
import { getSubmissionMediaUrl } from "@/lib/media";
import { useCoCreationFeed } from "@/components/co-creation-feed-context";
import type { SubmissionCard } from "@/lib/types";

/** Published products retain their real detail routes and product-specific metrics. */
export function CommunityProductFeed({ products }: { products: SubmissionCard[] }) {
  const t = useTranslations("productHunter");
  const c = useTranslations("community");
  const format = useFormatter();
  const { sort, category } = useCoCreationFeed();
  // The current product model has no editorial recommendation field.
  const visible = (sort === "recommended" ? [] : [...products]).sort((a, b) => sort === "popular"
    ? b.comment_count - a.comment_count || dateOf(b) - dateOf(a)
    : dateOf(b) - dateOf(a));
  return <section aria-label={c("categories.builds")} data-community-products>
    {category === "all" && <h2 className="border-b border-line py-4 text-sm font-semibold text-muted">{c("categories.builds")}</h2>}
    {visible.length ? visible.map((product) => <article key={product.id} className="community-post-row">
      <Avatar src={product.logo_path ? getSubmissionMediaUrl(product.logo_path) : null} name={product.title} className="h-12 w-12 shrink-0 rounded-xl bg-brand-soft text-base font-bold text-brand-ink" />
      <div className="community-post-main">
        <div className="community-post-author"><span>{product.submitted_by_username}</span><span>{c("categories.builds")}</span>{product.launch_stage && <span>{t(`stages.${product.launch_stage}`)}</span>}</div>
        <h2><Link href={`/products/${product.id}`}>{product.title}</Link></h2>
        <p className="community-post-excerpt">{product.tagline}</p>
        <div className="community-post-meta"><time dateTime={product.published_at ?? product.created_at}>{format.dateTime(new Date(product.published_at ?? product.created_at), { month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time><span>{t("supportMetric")} {format.number(product.support_count)}</span><span>{t("commentCount", { count: product.comment_count })}</span>{product.rating_count > 0 && <span>{t("ratingMetric")} {format.number(product.rating_average ?? 0, { maximumFractionDigits: 1 })} · {t("ratingCount", { count: product.rating_count })}</span>}</div>
      </div>
    </article>) : <div className="community-empty"><h2>{t(sort === "recommended" ? "recommendedEmptyTitle" : "emptyTitle")}</h2><p className="mt-2 text-sm text-muted">{t(sort === "recommended" ? "recommendedEmptyBody" : "emptyBody")}</p></div>}
  </section>;
}
function dateOf(product: SubmissionCard) { return new Date(product.published_at ?? product.created_at).getTime(); }
