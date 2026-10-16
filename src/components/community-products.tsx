import { getTranslations } from "next-intl/server";
import { getPublishedSubmissionCards } from "@/lib/submissions";
import { CommunityProductFeed } from "@/components/community-product-feed";
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

  return <CommunityProductFeed products={products} />;
}
