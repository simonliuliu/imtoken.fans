import { getCommunityPosts } from "@/lib/community";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { CommunityBoard } from "@/components/community-preview";
import { CommunityProducts } from "@/components/community-products";
import { isCommunitySection, SECTION_CATEGORIES } from "@/lib/community-demo";

export default async function CommunityBoardPage({ params, searchParams }: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ category?: string | string[]; idea?: string | string[]; commentOffset?: string | string[] }>;
}) {
  const { section } = await params;
  if (!isCommunitySection(section)) notFound();
  const { category, idea, commentOffset } = await searchParams;
  const initialCategory = typeof category === "string" && SECTION_CATEGORIES[section].includes(category) ? category : "all";
  const t = await getTranslations("community");

  return (
    <CommunityBoard
      key={`${section}:${initialCategory}:${typeof idea === "string" ? idea : ""}:${typeof commentOffset === "string" ? commentOffset : "0"}`}
      posts={await getCommunityPosts(section)}
      section={section}
      initialCategory={initialCategory}
      initialId={typeof idea === "string" ? idea : null}
      productsContent={section === "feedback" ? (
        <Suspense fallback={<p className="community-panel p-6 text-sm text-muted" role="status">{t("loading")}</p>}>
          <CommunityProducts />
        </Suspense>
      ) : undefined}
    />
  );
}
