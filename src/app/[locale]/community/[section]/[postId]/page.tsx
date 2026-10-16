import { redirect } from "@/i18n/navigation";
import { notFound } from "next/navigation";
import { CommunityPost } from "@/components/community-preview";
import { DEMO_POSTS, isCommunitySection } from "@/lib/community-demo";

export default async function CommunityPostPage({ params }: { params: Promise<{ locale: string; section: string; postId: string }> }) {
  const { locale, section, postId } = await params;
  if (!isCommunitySection(section)) notFound();
  const post = DEMO_POSTS.find((item) => item.id === postId && item.section === section);
  if (!post) notFound();
  if (post.section === "feedback" && post.category === "wallet") redirect({ href: "/community/feedback?category=wallet", locale });
  return <CommunityPost key={post.id} post={post} />;
}
