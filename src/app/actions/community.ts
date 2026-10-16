"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
export async function createCommunityPost(input: { expectedUser: string; requestId: string; section: string; category: string; title: string; body: string }) {
  const t = await getTranslations("communityReal");
  const db = await createClient();
  const { data, error } = await db.rpc("community_post_create", { p_expected: input.expectedUser, p_request: input.requestId, p_section: input.section, p_category: input.category, p_title: input.title, p_body: input.body });
  if (error || !data) return { error: t("saveFailed") };
  revalidatePath("/[locale]", "layout");
  return { href: `/community/${input.section}/${data}` };
}
export async function setCommunityLike(expectedUser: string, submissionId: string, liked: boolean) {
  const t = await getTranslations("communityReal");
  const db = await createClient();
  const { error } = await db.rpc("community_like_write", { p_expected: expectedUser, p_submission: submissionId, p_liked: liked });
  if (error) return { error: t("saveFailed") };
  revalidatePath("/[locale]", "layout");
  return { liked };
}
