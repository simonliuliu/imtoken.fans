import "server-only";
import { getLocale } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { DemoPost } from "@/lib/community-demo";
import type { SubmissionCard } from "@/lib/types";

export interface CommunityCard extends SubmissionCard {
  community_section: DemoPost["section"];
  community_category: string;
  legacy_slug: string | null;
  is_example: boolean;
  example_author: string | null;
  example_content: Record<string, { title: string; excerpt: string; body1: string; body2: string; body3: string; author: string }> | null;
  community_like_count: number;
}
export function communityHref(row: Pick<CommunityCard, "id" | "community_section" | "legacy_slug">) {
  return `/community/${row.community_section}/${row.legacy_slug ?? row.id}`;
}
export async function getCommunityPosts(section?: string): Promise<DemoPost[]> {
  if (!isSupabaseConfigured()) return [];
  const db = await createClient();
  let query = db.from("submission_cards").select("*").eq("type", "post").eq("status", "published").is("deleted_at", null).order("created_at", { ascending: false });
  if (section) query = query.eq("community_section", section);
  const { data, error } = await query;
  if (error) throw error;
  const locale = await getLocale();
  return (data as CommunityCard[] ?? []).map((row) => toCommunityPost(row, locale));
}
export function toCommunityPost(row: CommunityCard, locale: string): DemoPost {
  const example = row.is_example ? row.example_content?.[locale] ?? row.example_content?.zh : null;
  return {
    id: row.legacy_slug ?? row.id, submissionId: row.id,
    section: row.community_section, category: row.community_category,
    author: example?.author ?? row.submitted_by_username ?? "", authorUsername: row.submitted_by_username,
    authorId: row.submitted_by, level: row.is_example ? 0 : row.submitted_by_level ?? 0,
    createdAt: row.created_at, likes: Number(row.community_like_count), commentCount: Number(row.comment_count), votes: 0,
    featured: row.is_example, isExample: row.is_example,
    title: example?.title ?? row.title, excerpt: example?.excerpt ?? row.tagline,
    body: example ? [example.body1, example.body2, example.body3].join("\n\n") : row.description,
    moderationStatus: row.status,
  };
}
export async function getCommunityPost(section: string, identifier: string) {
  const db = await createClient();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const { data, error } = await db.from("submission_cards").select("*").eq("type", "post").eq("community_section", section).eq(uuid ? "id" : "legacy_slug", identifier).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  return data ? toCommunityPost(data as CommunityCard, await getLocale()) : null;
}
