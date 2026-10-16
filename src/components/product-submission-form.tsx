"use client";

import { Suspense, useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth-context";
import { AuthLoading } from "@/components/auth-loading";
import { getSignInHref } from "@/lib/auth-navigation";
import { createSubmission } from "@/app/actions/submissions";
import { deleteSubmissionMedia, uploadSubmissionMedia } from "@/app/actions/media";
import { getSubmissionMediaUrl, MAX_SCREENSHOTS, MAX_SOCIAL_LINKS, MAX_TEAM_MEMBERS } from "@/lib/media";
import { TagPicker } from "@/components/tag-picker";
import { MAX_TAGS } from "@/lib/tag-taxonomy";
import {
  MAKER_RELATIONSHIPS,
  PRODUCT_LAUNCH_STAGES,
  PRODUCT_PLATFORMS,
  PRODUCT_PRICING,
} from "@/lib/product-hunter";
import type {
  MakerRelationship,
  ProductLaunchStage,
  ProductPlatform,
  ProductPricing,
  SocialLink,
  TeamMember,
} from "@/lib/types";

type SubmitType = "product" | "idea";

interface Draft {
  title: string;
  tagline: string;
  description: string;
  tags: string[];
  websiteUrl: string;
  videoUrl: string;
  logoPath: string | null;
  screenshotPaths: string[];
  team: TeamMember[];
  socialLinks: SocialLink[];
  productPlatforms: ProductPlatform[];
  pricingType: ProductPricing;
  launchStage: ProductLaunchStage;
  makerRelationship: MakerRelationship;
  makerNote: string;
  feedbackPrompt: string;
}

function emptyDraft(): Draft {
  return {
    title: "",
    tagline: "",
    description: "",
    tags: [],
    websiteUrl: "",
    videoUrl: "",
    logoPath: null,
    screenshotPaths: [],
    team: [],
    socialLinks: [],
    productPlatforms: [],
    pricingType: "free",
    launchStage: "live",
    makerRelationship: "creator",
    makerNote: "",
    feedbackPrompt: "",
  };
}

const DESCRIPTION_MIN = 10;
const DRAFT_STORAGE_KEY = "imtoken-fans-submission-drafts-v2";

export function ProductSubmissionForm({ fixedType = "product" }: { fixedType?: SubmitType }) {
  const { user } = useAuth();
  // Switching accounts must recreate all in-memory form state.
  return <Suspense fallback={<AuthLoading />}><SubmitPageContent key={`${user?.id ?? "anonymous"}:${fixedType}`} fixedType={fixedType} /></Suspense>;
}

function SubmitPageContent({ fixedType }: { fixedType: SubmitType }) {
  const t = useTranslations("submit");
  const tc = useTranslations("common");
  const tn = useTranslations("nav");
  const { user, loading } = useAuth();
  const draftStorageKey = user ? `${DRAFT_STORAGE_KEY}:${user.id}` : null;
  const locale = useLocale();

  const [drafts, setDrafts] = useState<Record<SubmitType, Draft>>({ product: emptyDraft(), idea: emptyDraft() });
  const type = fixedType;
  const signInHref = getSignInHref(`/submit?type=${type}`, locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [published, setPublished] = useState(false);
  const [draftReady, setDraftReady] = useState(false);


  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = draftStorageKey ? window.localStorage.getItem(draftStorageKey) : null;
        if (saved) setDrafts(JSON.parse(saved) as Record<SubmitType, Draft>);
      } catch {
        if (draftStorageKey) window.localStorage.removeItem(draftStorageKey);
      } finally {
        setDraftReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftReady || !draftStorageKey) return;
    window.localStorage.setItem(draftStorageKey, JSON.stringify(drafts));
  }, [draftReady, drafts, draftStorageKey]);

  const draft = drafts[type];

  function updateDraft(patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));
  }

  if (loading) return <AuthLoading />;
  if (!user) return <div className="community-panel p-6"><Link href={signInHref} className="community-button">{tn("signIn")}</Link></div>;

  if (submitted) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center sm:px-6">
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-good-soft text-2xl">✅</span>
        <h1 className="text-2xl font-extrabold text-ink">
          {published ? t("successPublished") : t("successPending")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {published
            ? type === "product"
              ? t("successPublishedProductBody")
              : t("successPublishedIdeaBody")
            : type === "product"
              ? t("successPendingProductBody")
              : t("successPendingIdeaBody")}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={() => {
              setSubmitted(false);
              setDrafts((prev) => ({ ...prev, [type]: emptyDraft() }));
            }}
            className="rounded-full border border-line px-5 py-2 text-sm font-medium text-ink transition-colors hover:border-brand"
          >
            {t("continueSubmit")}
          </button>
          <Link
            href="/profile"
            className="rounded-full bg-brand px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-ink"
          >
            {t("viewMySubmissions")}
          </Link>
        </div>
      </div>
    );
  }

  const isProduct = type === "product";
  const titleOk = draft.title.trim().length > 1;
  const taglineOk = draft.tagline.trim().length > 1;
  const descriptionOk = draft.description.trim().length >= DESCRIPTION_MIN;
  const productReady =
    !isProduct ||
    (Boolean(draft.websiteUrl.trim()) &&
      Boolean(draft.logoPath) &&
      draft.screenshotPaths.length > 0 &&
      draft.tags.length > 0 &&
      draft.productPlatforms.length > 0);
  const canSubmit = titleOk && taglineOk && descriptionOk && productReady && !busy;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    const result = await createSubmission({
      type,
      title: draft.title,
      tagline: draft.tagline,
      description: draft.description,
      tags: draft.tags,
      websiteUrl: draft.websiteUrl,
      videoUrl: draft.videoUrl,
      logoPath: draft.logoPath ?? undefined,
      screenshotPaths: draft.screenshotPaths,
      team: draft.team,
      socialLinks: draft.socialLinks,
      productPlatforms: draft.productPlatforms,
      pricingType: draft.pricingType,
      launchStage: draft.launchStage,
      makerRelationship: draft.makerRelationship,
      makerNote: draft.makerNote,
      feedbackPrompt: draft.feedbackPrompt,
    });
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setPublished(result.published);
    setSubmitted(true);
  }

  return (
    <div className="py-2">
      <div className="max-w-3xl">
        <h2 className="text-2xl font-extrabold text-ink">{t(isProduct ? "productTitle" : "ideaTitle")}</h2>
        <p className="mt-2 text-muted">{t("subtitle", { name: user.name })}</p>



        <form className="mt-8 flex flex-col gap-5 rounded-2xl border border-line bg-surface p-6" onSubmit={handleSubmit}>
          <Field
            label={t("fieldTitle")}
            placeholder={t("fieldTitlePlaceholder")}
            value={draft.title}
            onChange={(v) => updateDraft({ title: v })}
            maxLength={isProduct ? 60 : 100}
            hint={!titleOk && draft.title.length > 0 ? t("minChars", { min: 2 }) : undefined}
          />
          <Field
            label={t("fieldTagline")}
            placeholder={t("fieldTaglinePlaceholder")}
            value={draft.tagline}
            onChange={(v) => updateDraft({ tagline: v })}
            maxLength={isProduct ? 60 : 140}
            hint={!taglineOk && draft.tagline.length > 0 ? t("minChars", { min: 2 }) : undefined}
          />
          <Field
            label={t("fieldDescription")}
            placeholder={
              isProduct
                ? t("fieldDescriptionPlaceholderProduct")
                : t("fieldDescriptionPlaceholderIdea")
            }
            value={draft.description}
            onChange={(v) => updateDraft({ description: v })}
            textarea
            maxLength={5000}
            hint={
              !descriptionOk
                ? t("needMoreChars", {
                    remaining: DESCRIPTION_MIN - draft.description.trim().length,
                    min: DESCRIPTION_MIN,
                  })
                : undefined
            }
          />
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-ink">{t("fieldTags")}</span>
            <TagPicker value={draft.tags} onChange={(tags) => updateDraft({ tags })} max={MAX_TAGS} />
          </div>

          {/* 点子还没做出来，官网 / Logo / 团队 / 社交这几项对它没有意义——
              留着只会让人以为"没填就不完整"。所以只在提交产品时才出现。 */}
          {isProduct && (
            <>
              <Field
                label={t("fieldWebsite")}
                placeholder="https://..."
                value={draft.websiteUrl}
                onChange={(v) => updateDraft({ websiteUrl: v })}
                maxLength={300}
                hint={t("fieldWebsiteHint")}
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <SelectField
                  label={t("fieldStage")}
                  value={draft.launchStage}
                  onChange={(value) => updateDraft({ launchStage: value as ProductLaunchStage })}
                  options={PRODUCT_LAUNCH_STAGES.map((value) => ({ value, label: t(`stageOptions.${value}`) }))}
                />
                <SelectField
                  label={t("fieldPricing")}
                  value={draft.pricingType}
                  onChange={(value) => updateDraft({ pricingType: value as ProductPricing })}
                  options={PRODUCT_PRICING.map((value) => ({ value, label: t(`pricingOptions.${value}`) }))}
                />
                <SelectField
                  label={t("fieldRelationship")}
                  value={draft.makerRelationship}
                  onChange={(value) => updateDraft({ makerRelationship: value as MakerRelationship })}
                  options={MAKER_RELATIONSHIPS.map((value) => ({ value, label: t(`relationshipOptions.${value}`) }))}
                />
              </div>
              <PlatformPicker
                value={draft.productPlatforms}
                onChange={(productPlatforms) => updateDraft({ productPlatforms })}
              />
            </>
          )}
          <Field
            label={t("fieldVideo")}
            placeholder={t("fieldVideoPlaceholder")}
            value={draft.videoUrl}
            onChange={(v) => updateDraft({ videoUrl: v })}
          />

          {isProduct && (
            <LogoField logoPath={draft.logoPath} onChange={(path) => updateDraft({ logoPath: path })} />
          )}
          <ScreenshotsField
            paths={draft.screenshotPaths}
            onChange={(paths) => updateDraft({ screenshotPaths: paths })}
          />
          {isProduct && (
            <>
              <Field
                label={t("fieldMakerNote")}
                placeholder={t("fieldMakerNotePlaceholder")}
                value={draft.makerNote}
                onChange={(value) => updateDraft({ makerNote: value })}
                textarea
                maxLength={1200}
              />
              <Field
                label={t("fieldFeedbackPrompt")}
                placeholder={t("fieldFeedbackPromptPlaceholder")}
                value={draft.feedbackPrompt}
                onChange={(value) => updateDraft({ feedbackPrompt: value })}
                textarea
                maxLength={500}
              />
            </>
          )}
          {isProduct && <TeamField team={draft.team} onChange={(team) => updateDraft({ team })} />}
          {isProduct && (
            <SocialLinksField
              socialLinks={draft.socialLinks}
              onChange={(socialLinks) => updateDraft({ socialLinks })}
            />
          )}

          <div className="rounded-xl bg-surface-2 p-4 text-sm text-muted">
            {t("processTitle")}
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>{t("processStep1")}</li>
              <li>{t("processStep2")}</li>
              <li>{t("processStep3")}</li>
            </ol>
          </div>

          <p className="font-mono text-[11px] text-faint">{draftReady ? t("draftSaved") : t("draftLoading")}</p>

          {error && <p className="rounded-lg bg-risk-soft px-3 py-2 text-xs text-risk">{error}</p>}

          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? tc("submitting") : t("submitButton")}
          </button>
        </form>
      </div>
    </div>
  );
}


function Field({
  label,
  placeholder,
  value,
  onChange,
  textarea,
  hint,
  maxLength,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
  hint?: string;
  maxLength?: number;
}): ReactNode {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-ink">{label}</span>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={4}
          maxLength={maxLength}
          className="rounded-lg border border-line bg-bg px-3 py-2 text-ink placeholder:text-faint focus:border-brand focus:outline-none"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          className="rounded-lg border border-line bg-bg px-3 py-2 text-ink placeholder:text-faint focus:border-brand focus:outline-none"
        />
      )}
      {hint && <span className="font-mono text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-ink">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-line bg-bg px-3 py-2 text-ink focus:border-brand focus:outline-none"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function PlatformPicker({ value, onChange }: { value: ProductPlatform[]; onChange: (value: ProductPlatform[]) => void }) {
  const t = useTranslations("submit");
  function toggle(platform: ProductPlatform) {
    onChange(value.includes(platform) ? value.filter((item) => item !== platform) : [...value, platform]);
  }
  return (
    <fieldset className="text-sm">
      <legend className="font-medium text-ink">{t("fieldPlatforms")}</legend>
      <p className="mt-1 text-xs text-faint">{t("fieldPlatformsHint")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {PRODUCT_PLATFORMS.map((platform) => (
          <button
            key={platform}
            type="button"
            aria-pressed={value.includes(platform)}
            onClick={() => toggle(platform)}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              value.includes(platform)
                ? "border-brand bg-brand-soft text-brand-ink"
                : "border-line text-muted hover:border-brand"
            }`}
          >
            {t(`platformOptions.${platform}`)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function LogoField({ logoPath, onChange }: { logoPath: string | null; onChange: (path: string | null) => void }) {
  const t = useTranslations("submit");
  const tc = useTranslations("common");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("file", file);
      const result = await uploadSubmissionMedia(formData);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onChange(result.path);
    });
  }

  function handleRemove() {
    if (!logoPath) return;
    const path = logoPath;
    onChange(null);
    startTransition(async () => {
      await deleteSubmissionMedia(path);
    });
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-ink">{t("logoLabel")}</span>
      <div className="flex items-center gap-3">
        {logoPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={getSubmissionMediaUrl(logoPath)} alt={t("logoAlt")} className="h-16 w-16 rounded-xl object-cover" />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-dashed border-line text-faint">
            {t("logoEmpty")}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={isPending}
            onChange={(e) => handleFile(e.target.files?.[0])}
            className="text-xs text-muted"
          />
          {logoPath && (
            <button type="button" onClick={handleRemove} className="w-fit text-xs text-risk hover:underline">
              {tc("remove")}
            </button>
          )}
        </div>
      </div>
      {error && <span className="text-xs text-risk">{error}</span>}
    </div>
  );
}

function ScreenshotsField({ paths, onChange }: { paths: string[]; onChange: (paths: string[]) => void }) {
  const t = useTranslations("submit");
  const tc = useTranslations("common");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleFile(file: File | undefined) {
    if (!file) return;
    if (paths.length >= MAX_SCREENSHOTS) {
      setError(t("maxScreenshots", { max: MAX_SCREENSHOTS }));
      return;
    }
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("file", file);
      const result = await uploadSubmissionMedia(formData);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onChange([...paths, result.path]);
    });
  }

  function handleRemove(path: string) {
    onChange(paths.filter((p) => p !== path));
    startTransition(async () => {
      await deleteSubmissionMedia(path);
    });
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-ink">{t("screenshotsLabel", { max: MAX_SCREENSHOTS })}</span>
      <div className="flex flex-wrap gap-3">
        {paths.map((path) => (
          <div key={path} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={getSubmissionMediaUrl(path)} alt={t("screenshotAlt")} className="h-20 w-32 rounded-lg object-cover" />
            <button
              type="button"
              onClick={() => handleRemove(path)}
              className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-risk text-xs text-white"
              aria-label={t("removeScreenshot")}
            >
              ×
            </button>
          </div>
        ))}
        {paths.length < MAX_SCREENSHOTS && (
          <label className="flex h-20 w-32 cursor-pointer items-center justify-center rounded-lg border border-dashed border-line text-xs text-faint hover:border-brand">
            {isPending ? tc("uploading") : t("addScreenshot")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={isPending}
              onChange={(e) => handleFile(e.target.files?.[0])}
              className="hidden"
            />
          </label>
        )}
      </div>
      {error && <span className="text-xs text-risk">{error}</span>}
    </div>
  );
}

function TeamField({ team, onChange }: { team: TeamMember[]; onChange: (team: TeamMember[]) => void }) {
  const t = useTranslations("submit");
  const tc = useTranslations("common");
  function updateMember(index: number, patch: Partial<TeamMember>) {
    onChange(team.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }
  function removeMember(index: number) {
    onChange(team.filter((_, i) => i !== index));
  }
  function addMember() {
    if (team.length >= MAX_TEAM_MEMBERS) return;
    onChange([...team, { name: "", role: "" }]);
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <span className="font-medium text-ink">{t("teamLabel", { max: MAX_TEAM_MEMBERS })}</span>
      {team.map((member, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg p-2.5">
          <input
            value={member.name}
            onChange={(e) => updateMember(index, { name: e.target.value })}
            placeholder={t("memberName")}
            className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />
          <input
            value={member.role}
            onChange={(e) => updateMember(index, { role: e.target.value })}
            placeholder={t("memberRole")}
            className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />
          <input
            value={member.link ?? ""}
            onChange={(e) => updateMember(index, { link: e.target.value })}
            placeholder={t("memberLink")}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />
          <button type="button" onClick={() => removeMember(index)} className="text-xs text-risk hover:underline">
            {tc("remove")}
          </button>
        </div>
      ))}
      {team.length < MAX_TEAM_MEMBERS && (
        <button
          type="button"
          onClick={addMember}
          className="w-fit rounded-full border border-line px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand hover:text-brand-ink"
        >
          {t("addMember")}
        </button>
      )}
    </div>
  );
}

function SocialLinksField({
  socialLinks,
  onChange,
}: {
  socialLinks: SocialLink[];
  onChange: (links: SocialLink[]) => void;
}) {
  const t = useTranslations("submit");
  const tc = useTranslations("common");
  function updateLink(index: number, patch: Partial<SocialLink>) {
    onChange(socialLinks.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function removeLink(index: number) {
    onChange(socialLinks.filter((_, i) => i !== index));
  }
  function addLink() {
    if (socialLinks.length >= MAX_SOCIAL_LINKS) return;
    onChange([...socialLinks, { label: "", url: "" }]);
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <span className="font-medium text-ink">{t("socialLabel", { max: MAX_SOCIAL_LINKS })}</span>
      {socialLinks.map((link, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg p-2.5">
          <input
            value={link.label}
            onChange={(e) => updateLink(index, { label: e.target.value })}
            placeholder={t("socialPlatform")}
            className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />
          <input
            value={link.url}
            onChange={(e) => updateLink(index, { url: e.target.value })}
            placeholder="https://..."
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />
          <button type="button" onClick={() => removeLink(index)} className="text-xs text-risk hover:underline">
            {tc("remove")}
          </button>
        </div>
      ))}
      {socialLinks.length < MAX_SOCIAL_LINKS && (
        <button
          type="button"
          onClick={addLink}
          className="w-fit rounded-full border border-line px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand hover:text-brand-ink"
        >
          {t("addLink")}
        </button>
      )}
    </div>
  );
}
