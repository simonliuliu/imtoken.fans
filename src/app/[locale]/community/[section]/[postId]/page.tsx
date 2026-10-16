import { redirect } from "@/i18n/navigation";
import { notFound } from "next/navigation";
import { CommunityPost } from "@/components/community-post";
import { getCommunityPost } from "@/lib/community";
import { getCommentsForSubmission } from "@/lib/submissions";
import { getCurrentProfile } from "@/lib/profile";
import { hasPermission } from "@/lib/admin-guard";
import { createClient } from "@/lib/supabase/server";
import { isCommunitySection } from "@/lib/community-demo";
export default async function CommunityPostPage({ params }: { params: Promise<{ locale: string; section: string; postId: string }> }) {
  const { locale, section, postId } = await params;
  if (!isCommunitySection(section)) notFound();
  if (postId === "clearer-transaction") redirect({ href: "/community/feedback?category=wallet", locale });
  const post = await getCommunityPost(section, postId);
  if (!post) notFound();
  const [comments, profile, db] = await Promise.all([getCommentsForSubmission(post.submissionId!), getCurrentProfile(), createClient()]);
  const { data: like } = profile ? await db.from("community_likes").select("user_id").eq("submission_id", post.submissionId!).eq("user_id", profile.id).maybeSingle() : { data: null };
  return <CommunityPost key={`${post.submissionId}:${profile?.id ?? "guest"}`} post={post} serverViewerId={profile?.id ?? null} comments={comments} viewerLiked={Boolean(like)} canModerate={Boolean(profile && hasPermission(profile, "moderate_comments"))} />;
}
