"use client";

import { useMemo, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Avatar } from "@/components/avatar";
import { getSubmissionMediaUrl } from "@/lib/media";
import { PRODUCT_LAUNCH_STAGES, PRODUCT_PLATFORMS, PRODUCT_PRICING, PRODUCT_RATING_MIN_COUNT } from "@/lib/product-hunter";
import { getTagLabel } from "@/lib/tag-taxonomy";
import type { SubmissionCard } from "@/lib/types";

type SortId = "latest" | "hot" | "rating";

export function ProductHunterExplorer({ products }: { products: SubmissionCard[] }) {
  const t = useTranslations("productHunter");
  const locale = useLocale();
  const format = useFormatter();
  const [sort, setSort] = useState<SortId>("latest");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [pricing, setPricing] = useState("all");
  const [stage, setStage] = useState("all");
  const [tag, setTag] = useState("all");

  const tags = useMemo(() => {
    const count = new Map<string, number>();
    for (const product of products) for (const value of product.tags) count.set(value, (count.get(value) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
  }, [products]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase(locale);
    const filtered = products.filter((product) => {
      if (keyword && !`${product.title} ${product.tagline} ${product.description} ${product.tags.join(" ")}`.toLocaleLowerCase(locale).includes(keyword)) return false;
      if (platform !== "all" && !product.product_platforms.includes(platform as SubmissionCard["product_platforms"][number])) return false;
      if (pricing !== "all" && product.pricing_type !== pricing) return false;
      if (stage !== "all" && product.launch_stage !== stage) return false;
      if (tag !== "all" && !product.tags.includes(tag)) return false;
      return true;
    });

    return filtered.sort((a, b) => {
      if (sort === "latest") return dateOf(b) - dateOf(a);
      if (sort === "rating") {
        const aQualified = a.rating_count >= PRODUCT_RATING_MIN_COUNT;
        const bQualified = b.rating_count >= PRODUCT_RATING_MIN_COUNT;
        if (aQualified !== bQualified) return bQualified ? 1 : -1;
        return (b.rating_average ?? 0) - (a.rating_average ?? 0) || b.rating_count - a.rating_count;
      }
      return hotScore(b) - hotScore(a);
    });
  }, [products, query, platform, pricing, stage, tag, sort, locale]);

  const activeFilters = [platform, pricing, stage, tag].filter((value) => value !== "all").length + Number(Boolean(query.trim()));

  function clearFilters() {
    setQuery("");
    setPlatform("all");
    setPricing("all");
    setStage("all");
    setTag("all");
  }

  return (
    <div>
      <div className="community-panel min-w-0 max-w-full overflow-hidden p-0!">
        <div className="border-b border-line px-5 py-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="community-tabs" role="tablist" aria-label={t("sortLabel")}>
              {(["latest", "hot", "rating"] as SortId[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={sort === value}
                  onClick={() => setSort(value)}
                >
                  {t(`sort.${value}`)}
                </button>
              ))}
            </div>
            <span className="text-xs text-faint">{t("resultCount", { count: visible.length })}</span>
          </div>

          <div className="mt-4 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(0,150px))]">
            <label className="relative col-span-2 sm:col-span-1">
              <span className="sr-only">{t("searchLabel")}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchPlaceholder")}
                className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
              />
            </label>
            <FilterSelect label={t("platformLabel")} value={platform} onChange={setPlatform}>
              <option value="all">{t("allPlatforms")}</option>
              {PRODUCT_PLATFORMS.map((value) => <option key={value} value={value}>{t(`platforms.${value}`)}</option>)}
            </FilterSelect>
            <FilterSelect label={t("pricingLabel")} value={pricing} onChange={setPricing}>
              <option value="all">{t("allPricing")}</option>
              {PRODUCT_PRICING.map((value) => <option key={value} value={value}>{t(`pricing.${value}`)}</option>)}
            </FilterSelect>
            <FilterSelect label={t("stageLabel")} value={stage} onChange={setStage}>
              <option value="all">{t("allStages")}</option>
              {PRODUCT_LAUNCH_STAGES.map((value) => <option key={value} value={value}>{t(`stages.${value}`)}</option>)}
            </FilterSelect>
            <FilterSelect label={t("categoryLabel")} value={tag} onChange={setTag}>
              <option value="all">{t("allCategories")}</option>
              {tags.map((value) => <option key={value} value={value}>{getTagLabel(value, locale)}</option>)}
            </FilterSelect>
          </div>
          {activeFilters > 0 && (
            <button type="button" onClick={clearFilters} className="mt-3 text-xs font-semibold text-brand-ink hover:underline">
              {t("clearFilters", { count: activeFilters })}
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <div className="p-10 text-center">
            <h2 className="font-semibold text-ink">{t("emptyTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("emptyBody")}</p>
            {activeFilters > 0 && <button type="button" onClick={clearFilters} className="mt-4 rounded-full border border-line px-4 py-2 text-sm text-brand-ink">{t("showAll")}</button>}
          </div>
        ) : (
          <div className="divide-y divide-line px-5 sm:px-6">
            {visible.map((product, index) => (
              <article key={product.id} className="group py-5">
                <div className="grid grid-cols-[1.25rem_3rem_minmax(0,1fr)] items-start gap-3 sm:flex sm:gap-4">
                  <span className="mt-2 w-5 shrink-0 text-center font-mono text-xs text-faint">{index + 1}</span>
                  <Avatar
                    src={product.logo_path ? getSubmissionMediaUrl(product.logo_path) : null}
                    name={product.title}
                    className="h-12 w-12 rounded-xl bg-brand-soft text-base font-bold text-brand-ink sm:h-14 sm:w-14"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/products/${product.id}`} className="break-words font-bold text-ink group-hover:text-brand-ink">{product.title}</Link>
                      {product.launch_stage && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand-ink">{t(`stages.${product.launch_stage}`)}</span>}
                    </div>
                    <p className="mt-1 text-sm leading-6 text-muted">{product.tagline}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
                      {product.product_platforms.slice(0, 2).map((value) => <span key={value}>{t(`platforms.${value}`)}</span>)}
                      {product.pricing_type && <span>{t(`pricing.${product.pricing_type}`)}</span>}
                      <time dateTime={product.published_at ?? product.created_at}>
                        {format.dateTime(new Date(product.published_at ?? product.created_at), { month: "short", day: "numeric" })}
                      </time>
                    </div>
                    {product.tags.length > 0 && <p className="mt-2 truncate text-xs text-faint">{product.tags.slice(0, 3).map((value) => getTagLabel(value, locale)).join(" · ")}</p>}
                  </div>
                  <div className="col-start-3 grid shrink-0 grid-cols-2 gap-2">
                    <Metric label={t("ratingMetric")} value={product.rating_count ? `${product.rating_average?.toFixed(1)}★` : "—"} detail={t("ratingCount", { count: product.rating_count })} />
                    <Metric label={t("supportMetric")} value={String(product.support_count)} detail={t("commentCount", { count: product.comment_count })} />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full min-w-0 max-w-full rounded-lg border border-line bg-bg px-2.5 text-xs text-muted focus:border-brand focus:outline-none">
        {children}
      </select>
    </label>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-16 rounded-xl border border-line bg-surface-2 px-2 py-2 text-center sm:min-w-20">
      <span className="block font-mono text-[9px] uppercase tracking-wide text-faint">{label}</span>
      <strong className="mt-0.5 block text-sm text-ink">{value}</strong>
      <span className="mt-0.5 hidden text-[10px] text-faint sm:block">{detail}</span>
    </div>
  );
}

function dateOf(product: SubmissionCard): number {
  return new Date(product.published_at ?? product.created_at).getTime();
}

function hotScore(product: SubmissionCard): number {
  const ageDays = Math.max(0, (Date.now() - dateOf(product)) / 86_400_000);
  const engagement = product.support_count * 2 + product.rating_count * 3 + product.comment_count * 1.5;
  return engagement / Math.pow(ageDays + 2, 0.55);
}
