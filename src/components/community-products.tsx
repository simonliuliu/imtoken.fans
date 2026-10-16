import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getPublishedSubmissionCards } from "@/lib/submissions";
import { ProductHunterExplorer } from "@/components/product-hunter-explorer";
import type { SubmissionCard } from "@/lib/types";

export async function CommunityProducts() {
  const t = await getTranslations("productHunter");
  let products: SubmissionCard[];

  try {
    products = await getPublishedSubmissionCards("product");
  } catch {
    return (
      <div className="community-panel p-6" role="alert">
        <h2 className="font-bold text-ink">{t("loadFailedTitle")}</h2>
        <p className="mt-2 text-sm text-muted">{t("loadFailedBody")}</p>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full" data-community-products>
      <section className="mb-5 overflow-hidden rounded-2xl border border-line bg-white">
        <div className="grid min-w-0 gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
          <div className="min-w-0">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-brand-ink">{t("eyebrow")}</p>
            <h2 className="mt-2 text-2xl font-extrabold text-ink sm:text-3xl">{t("title")}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted sm:text-base">{t("subtitle")}</p>
            <div className="mt-5 flex flex-wrap gap-2 text-xs text-muted">
              <span className="max-w-full rounded-full bg-surface-2 px-3 py-1.5 break-words">{t("principleUsable")}</span>
              <span className="max-w-full rounded-full bg-surface-2 px-3 py-1.5 break-words">{t("principleRelevant")}</span>
              <span className="max-w-full rounded-full bg-surface-2 px-3 py-1.5 break-words">{t("principleIndependent")}</span>
            </div>
          </div>
          <div className="min-w-0 rounded-2xl bg-brand-soft p-5 break-words">
            <h3 className="font-bold text-brand-ink">{t("ctaTitle")}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{t("ctaBody")}</p>
            <Link href="/submit?type=product" className="mt-4 inline-flex rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink">
              {t("submitProduct")}
            </Link>
          </div>
        </div>
      </section>

      <ProductHunterExplorer products={products} />
      <p className="mx-auto mt-5 max-w-3xl text-center text-xs leading-6 text-faint">{t("disclaimer")}</p>
    </div>
  );
}
