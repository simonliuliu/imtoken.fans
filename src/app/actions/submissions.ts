"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentProfile } from "@/lib/profile";
import { isBlacklisted } from "@/lib/user-tags";
import { normalizeTags } from "@/lib/tag-taxonomy";
import { runModerationPipeline } from "@/lib/moderation/pipeline";
import { MAX_SCREENSHOTS, MAX_SOCIAL_LINKS, MAX_TEAM_MEMBERS } from "@/lib/media";
import { awardXpByRule } from "@/lib/xp";
import {
  isMakerRelationship,
  isProductLaunchStage,
  isProductPlatform,
  isProductPricing,
} from "@/lib/product-hunter";
import type {
  MakerRelationship,
  ProductLaunchStage,
  ProductPlatform,
  ProductPricing,
  SocialLink,
  TeamMember,
} from "@/lib/types";

export interface CreateSubmissionInput {
  type: "product";
  expectedUser?: string;
  title: string;
  tagline: string;
  description: string;
  tags: string[];
  websiteUrl?: string;
  videoUrl?: string;
  logoPath?: string;
  screenshotPaths?: string[];
  team?: TeamMember[];
  socialLinks?: SocialLink[];
  productPlatforms?: ProductPlatform[];
  pricingType?: ProductPricing;
  launchStage?: ProductLaunchStage;
  makerRelationship?: MakerRelationship;
  makerNote?: string;
  feedbackPrompt?: string;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function createSubmission(
  input: CreateSubmissionInput
): Promise<{ error: string; code?: "sign_in" | "session_changed" } | { submissionId: string; published: boolean }> {
  const t = await getTranslations("errors");
  // Old clients and direct Server Action requests must not reopen idea submissions.
  if (!input || input.type !== "product") return { error: t("productSubmissionsOnly") };
  const title = input.title.trim();
  const tagline = input.tagline.trim();
  const description = input.description.trim();

  if (title.length < 2 || title.length > 60) {
    return { error: t("productTitleLength") };
  }
  if (tagline.length < 2 || tagline.length > 60) {
    return { error: t("productTaglineLength") };
  }
  if (description.length < 10 || description.length > 5000) return { error: t("descriptionLength") };

  const websiteUrl = input.websiteUrl?.trim() || null;
  if (websiteUrl && (!isValidHttpUrl(websiteUrl) || websiteUrl.length > 300)) {
    return { error: t("websiteUrlInvalid") };
  }
  const videoUrl = input.videoUrl?.trim() || null;
  if (videoUrl && (!isValidHttpUrl(videoUrl) || videoUrl.length > 300)) {
    return { error: t("videoUrlInvalid") };
  }

  const team = (input.team ?? []).slice(0, MAX_TEAM_MEMBERS).map((member) => ({
    name: member.name.trim().slice(0, 60),
    role: member.role.trim().slice(0, 60),
    link: member.link?.trim() ? member.link.trim().slice(0, 300) : undefined,
  }));
  if (team.some((member) => !member.name || !member.role)) {
    return { error: t("teamMemberRequired") };
  }
  if (team.some((member) => member.link && !isValidHttpUrl(member.link))) {
    return { error: t("teamLinkInvalid") };
  }

  const socialLinks = (input.socialLinks ?? []).slice(0, MAX_SOCIAL_LINKS).map((link) => ({
    label: link.label.trim().slice(0, 30),
    url: link.url.trim().slice(0, 300),
  }));
  if (socialLinks.some((link) => !link.label || !link.url || !isValidHttpUrl(link.url))) {
    return { error: t("socialLinkInvalid") };
  }

  const profile = await getCurrentProfile();
  if (!profile) return { error: t("notSignedIn"), code: "sign_in" };
  if (input.expectedUser && profile.id !== input.expectedUser) return { error: t("submissionSessionChanged"), code: "session_changed" };

  const logoPath = input.logoPath?.trim() || null;
  if (logoPath && !logoPath.startsWith(`${profile.id}/`)) {
    return { error: t("logoNotOwned") };
  }
  const screenshotPaths = (input.screenshotPaths ?? []).slice(0, MAX_SCREENSHOTS);
  if (screenshotPaths.some((path) => !path.startsWith(`${profile.id}/`))) {
    return { error: t("screenshotNotOwned") };
  }

  const productPlatforms = [...new Set(input.productPlatforms ?? [])].filter(isProductPlatform);
  const pricingType = input.pricingType && isProductPricing(input.pricingType) ? input.pricingType : null;
  const launchStage = input.launchStage && isProductLaunchStage(input.launchStage) ? input.launchStage : null;
  const makerRelationship =
    input.makerRelationship && isMakerRelationship(input.makerRelationship) ? input.makerRelationship : null;
  const makerNote = input.makerNote?.trim().slice(0, 1200) || null;
  const feedbackPrompt = input.feedbackPrompt?.trim().slice(0, 500) || null;

  if (!websiteUrl) return { error: t("productWebsiteRequired") };
  if (!logoPath) return { error: t("productLogoRequired") };
  if (screenshotPaths.length === 0) return { error: t("productScreenshotRequired") };
  if (productPlatforms.length === 0) return { error: t("productPlatformRequired") };
  if (!pricingType || !launchStage || !makerRelationship) return { error: t("productDetailsRequired") };
  if (await isBlacklisted(profile.id)) {
    return { error: t("blacklistedSubmit") };
  }

  const tags = normalizeTags(input.tags);
  if (tags.length === 0) return { error: t("productTagRequired") };

  const supabase = await createClient();
  const admin = createAdminClient();
  {
    // 待审核投稿对其他普通用户不可见，因此必须用服务端管理员客户端做全量重复检测。
    const { data: duplicate, error: duplicateError } = await admin
      .from("submissions")
      .select("id")
      .eq("type", "product")
      .eq("website_url", websiteUrl)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (duplicateError) {
      console.error("[createSubmission] 检查重复产品失败:", duplicateError);
      return { error: t("submitFailed") };
    }
    if (duplicate) return { error: t("productAlreadySubmitted") };
  }

  const { data: inserted, error } = await supabase
    .from("submissions")
    .insert({
      type: "product",
      title,
      tagline,
      description,
      tags,
      submitted_by: profile.id,
      website_url: websiteUrl,
      video_url: videoUrl,
      logo_path: logoPath,
      screenshot_paths: screenshotPaths,
      team,
      social_links: socialLinks,
      product_platforms: productPlatforms,
      pricing_type: pricingType,
      launch_stage: launchStage,
      maker_relationship: makerRelationship,
      maker_note: makerNote,
      feedback_prompt: feedbackPrompt,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error("[createSubmission] 创建投稿失败:", error);
    return { error: t("submitFailed") };
  }

  // 社区产品始终先人工审核，不按旧点子规则免审或写入统一投稿冷却。
  await runModerationPipeline({
    targetType: "submission",
    targetId: inserted.id,
    content: `${title}\n${tagline}\n\n${description}`,
    authorId: profile.id,
    requireManual: true,
  });

  // 查询实际状态，避免与管理员同步审核发生竞争时向用户展示过时状态。
  const { data: finalRow } = await supabase.from("submissions").select("status").eq("id", inserted.id).maybeSingle();
  const published = finalRow?.status === "published";

  // 发布成功才给经验；还在审核队列里的等审核通过时由 moderateQueueItem 补上。
  // refId = 提交 id，所以两条路径都调用也只会计一次分。
  if (published) {
    after(() =>
      awardXpByRule({
        userId: profile.id,
        action: "submission_product",
        refType: "submission",
        refId: inserted.id,
      })
    );
  }

  return { submissionId: inserted.id, published };
}

export async function updateSubmissionStats(
  submissionId: string,
  input: { statsUsers: number; statsDau: number }
): Promise<{ error?: string }> {
  const t = await getTranslations("errors");
  if (!Number.isFinite(input.statsUsers) || input.statsUsers < 0) return { error: t("statsUsersInvalid") };
  if (!Number.isFinite(input.statsDau) || input.statsDau < 0) return { error: t("statsDauInvalid") };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("submissions")
    .update({
      stats_users: Math.round(input.statsUsers),
      stats_dau: Math.round(input.statsDau),
      stats_updated_at: new Date().toISOString(),
    })
    .eq("id", submissionId)
    .select("id")
    .maybeSingle();

  if (error) return { error: error.message };
  // RLS + 列级 GRANT 已经保证只有作者能改到这一行；没改到行说明不是本人，给个友好提示
  // 而不是让调用方看到一个"成功但什么都没变"的空结果。
  if (!data) return { error: t("submissionNotFoundOrNotOwner") };

  revalidatePath(`/products/${submissionId}`);
  revalidatePath(`/ideas/${submissionId}`);
  return {};
}
