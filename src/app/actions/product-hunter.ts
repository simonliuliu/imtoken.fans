"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/profile";
import { isBlacklisted } from "@/lib/user-tags";
import {
  PRODUCT_RATING_IMPROVEMENTS,
  PRODUCT_RATING_STRENGTHS,
} from "@/lib/product-hunter";
import type { ProductRatingImprovement, ProductRatingStrength } from "@/lib/types";

export async function toggleProductSupport(
  submissionId: string
): Promise<{ error: string } | { supported: boolean }> {
  const t = await getTranslations("productRating.errors");
  const profile = await getCurrentProfile();
  if (!profile) return { error: t("signIn") };
  if (await isBlacklisted(profile.id)) return { error: t("notAllowed") };

  const supabase = await createClient();
  const { data: product } = await supabase
    .from("submissions")
    .select("id")
    .eq("id", submissionId)
    .eq("type", "product")
    .eq("status", "published")
    .is("deleted_at", null)
    .maybeSingle();
  if (!product) return { error: t("unavailable") };

  const { data: deleted, error: deleteError } = await supabase
    .from("product_supports")
    .delete()
    .eq("submission_id", submissionId)
    .eq("user_id", profile.id)
    .select("id");
  if (deleteError) {
    console.error("[toggleProductSupport] 删除支持票失败:", deleteError);
    return { error: t("operationFailed") };
  }

  if (deleted && deleted.length > 0) {
    revalidateProductPaths();
    return { supported: false };
  }

  const { error } = await supabase.from("product_supports").insert({
    submission_id: submissionId,
    user_id: profile.id,
  });
  if (error && error.code !== "23505") {
    console.error("[toggleProductSupport] 新增支持票失败:", error);
    return { error: t("operationFailed") };
  }

  revalidateProductPaths();
  return { supported: true };
}

export interface UpsertProductRatingInput {
  submissionId: string;
  rating: number;
  body: string;
  strengths: ProductRatingStrength[];
  improvements: ProductRatingImprovement[];
  experienced: boolean;
}

export async function upsertProductRating(
  input: UpsertProductRatingInput
): Promise<{ error: string } | { saved: true }> {
  const t = await getTranslations("productRating.errors");
  const profile = await getCurrentProfile();
  if (!profile) return { error: t("signIn") };
  if (await isBlacklisted(profile.id)) return { error: t("notAllowed") };

  const rating = Math.round(input.rating);
  const body = input.body.trim();
  const strengths = [...new Set(input.strengths)].filter((value): value is ProductRatingStrength =>
    PRODUCT_RATING_STRENGTHS.includes(value as ProductRatingStrength)
  ).slice(0, 3);
  const improvements = [...new Set(input.improvements)].filter((value): value is ProductRatingImprovement =>
    PRODUCT_RATING_IMPROVEMENTS.includes(value as ProductRatingImprovement)
  ).slice(0, 3);

  if (rating < 1 || rating > 5) return { error: t("ratingRequired") };
  if (body.length < 20 || body.length > 1000) return { error: t("bodyLength") };
  if (!input.experienced) return { error: t("experienceRequired") };

  const supabase = await createClient();
  const { data: product } = await supabase
    .from("submissions")
    .select("id, submitted_by")
    .eq("id", input.submissionId)
    .eq("type", "product")
    .eq("status", "published")
    .is("deleted_at", null)
    .maybeSingle();

  if (!product) return { error: t("unavailable") };
  if (product.submitted_by === profile.id) return { error: t("ownProduct") };

  const { error } = await supabase.from("product_ratings").upsert(
    {
      submission_id: input.submissionId,
      user_id: profile.id,
      rating,
      body,
      strengths,
      improvements,
      experienced: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "submission_id,user_id" }
  );
  if (error) {
    console.error("[upsertProductRating] 保存体验评分失败:", error);
    return { error: t("operationFailed") };
  }

  revalidateProductPaths();
  return { saved: true };
}

function revalidateProductPaths() {
  revalidatePath("/[locale]/community/[section]", "page");
  revalidatePath("/[locale]/products", "page");
  revalidatePath("/[locale]/products/[id]", "page");
}
