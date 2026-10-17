import { CommunityActivityCenter } from "@/components/community-activity-center";
import { CommunityPost } from "@/components/community-post";
import { getCommunityPost } from "@/lib/community";
import { getCommentsForSubmission } from "@/lib/submissions";
import { getCurrentProfile } from "@/lib/profile";
import { hasPermission } from "@/lib/admin-guard";
import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
export default async function ActivityDetailPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  // Preserve the mainline forum flow for both migrated slugs and real UUID posts.
  // Community posts and managed task activities remain separate business models.
  const post = await getCommunityPost("activities", postId);
  if (post) {
    const [comments, profile, db] = await Promise.all([getCommentsForSubmission(post.submissionId!), getCurrentProfile(), createClient()]);
    const { data: like } = profile ? await db.from("community_likes").select("user_id").eq("submission_id", post.submissionId!).eq("user_id", profile.id).maybeSingle() : { data: null };
    return <CommunityPost key={`${post.submissionId}:${profile?.id ?? "guest"}`} post={post} serverViewerId={profile?.id ?? null} comments={comments} viewerLiked={Boolean(like)} canModerate={Boolean(profile && hasPermission(profile, "moderate_comments"))} />;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId)) notFound();
  return <Suspense><CommunityActivityCenter activityId={postId} /></Suspense>;
}
