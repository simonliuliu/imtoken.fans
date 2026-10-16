import { CommunitySubmit } from "@/components/community-submit";
import { isCommunitySection } from "@/lib/community-demo";

export default async function PostSubmitPage({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const raw = (await searchParams).section;
  const section = typeof raw === "string" && isCommunitySection(raw) && raw !== "feedback" ? raw : undefined;
  return <CommunitySubmit key={section ?? "discussion"} mode="post" initialSection={section} />;
}
