import { getCommunityPosts } from "@/lib/community";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CommunityHome } from "@/components/community-preview";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return { title: t("homeTitle"), description: t("homeDescription") };
}
export default async function HomePage() { return <CommunityHome posts={await getCommunityPosts()} />; }
