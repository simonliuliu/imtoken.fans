"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
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

export function ProductSubmissionForm() {
  const { user, sessionEpoch } = useAuth();
  // Switching accounts must recreate all in-memory form state.
  return <SubmitPageContent key={`${user?.id ?? "anonymous"}:${sessionEpoch}`} />;
}

function SubmitPageContent() {
  const t = useTranslations("submit");
  const tc = useTranslations("common");
  const { user, loading } = useAuth();
  const draftStorageKey = user ? `${DRAFT_STORAGE_KEY}:${user.id}` : null;
  const locale = useLocale();
  const router = useRouter();
  const [drafts, setDrafts] = useState({ product: emptyDraft() });
  const signInHref = getSignInHref("/submit/product", locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [published, setPublished] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [signInRequired, setSignInRequired] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = draftStorageKey ? window.localStorage.getItem(draftStorageKey) : null;
        if (saved) {
          const stored = JSON.parse(saved);
          if (stored && typeof stored === "object" && !Array.isArray(stored)) {
            // Keep legacy drafts in storage, but only restore/edit the product draft.
            const product = stored.product && typeof stored.product === "object" ? stored.product : {};
            const restored = emptyDraft();
            for (const key of Object.keys(restored) as (keyof Draft)[]) {
              const value = product[key];
              if (Array.isArray(restored[key])) {
                if (Array.isArray(value)) {
                  if (key === "team") restored.team = value.filter((item: TeamMember) => item && typeof item.name === "string" && typeof item.role === "string" && (item.link === undefined || typeof item.link === "string"));
                  else if (key === "socialLinks") restored.socialLinks = value.filter((item: SocialLink) => item && typeof item.label === "string" && typeof item.url === "string");
                  else Object.assign(restored, { [key]: value.filter((item: unknown) => typeof item === "string") });
                }
              } else if (typeof value === "string" || key === "logoPath" && value === null) Object.assign(restored, { [key]: value });
            }
            setDrafts({ ...stored, product: restored });
          }
        }
      } catch {
        setStorageError(true);
      } finally {
        setDraftReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftReady || !draftStorageKey) return;
    try { window.localStorage.setItem(draftStorageKey, JSON.stringify(drafts)); queueMicrotask(() => { if (mounted.current) setStorageError(false); }); }
    catch { queueMicrotask(() => { if (mounted.current) setStorageError(true); }); }
  }, [draftReady, drafts, draftStorageKey]);

  const draft = drafts.product;

  function continueSignIn() {
    try {
      if (draftStorageKey) window.localStorage.setItem(draftStorageKey, JSON.stringify(drafts));
      router.push(signInHref);
    } catch { setStorageError(true); setError(t("draftUnavailable")); }
  }

  function updateDraft(patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, product: { ...prev.product, ...patch } }));
  }

  if (loading) return <AuthLoading />;
  if (!user) return <div className="mx-auto max-w-3xl px-4 py-14"><h1 className="text-3xl font-extrabold text-ink">{t("title")}</h1><p className="my-5 text-muted">{t("signInRequired")}</p><Link className="community-button" href={signInHref}>{t("signInPublish")}</Link></div>;

  if (submitted) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center sm:px-6">
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-good-soft text-2xl">✅</span>
        <h1 className="text-2xl font-extrabold text-ink">
          {published ? t("successPublished") : t("successPending")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {published ? t("successPublishedProductBody") : t("successPendingProductBody")}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={() => {
              setSubmitted(false);
              setDrafts((prev) => ({ ...prev, product: emptyDraft() }));
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

  const titleOk = draft.title.trim().length > 1;
  const taglineOk = draft.tagline.trim().length > 1;
  const descriptionOk = draft.description.trim().length >= DESCRIPTION_MIN;
  const productReady =
    Boolean(draft.websiteUrl.trim()) &&
    Boolean(draft.logoPath) &&
    draft.screenshotPaths.length > 0 &&
    draft.tags.length > 0 &&
    draft.productPlatforms.length > 0;
  const canSubmit = titleOk && taglineOk && descriptionOk && productReady;
  const missingFields = [!titleOk && t("fieldTitle"), !taglineOk && t("fieldTagline"), !descriptionOk && t("fieldDescription"), !draft.websiteUrl.trim() && t("fieldWebsite"), !draft.logoPath && t("logoLabel"), !draft.screenshotPaths.length && t("screenshotsLabel", {max: MAX_SCREENSHOTS}), !draft.tags.length && t("fieldTags"), !draft.productPlatforms.length && t("fieldPlatforms")].filter(Boolean).join(" · ");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || busy || !draftReady) return;
    if (!canSubmit) { setError(t("missingRequired", { fields: missingFields })); return; }
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
    const result = await createSubmission({
      expectedUser: user!.id,
      type: "product",
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
    if (!mounted.current) return;
    if ("error" in result) {
      setSignInRequired(result.code === "sign_in");
      setError(result.error);
      return;
    }
    setPublished(result.published);
    setSubmitted(true);
    setDrafts((prev) => ({ ...prev, product: emptyDraft() }));
    } catch { if (mounted.current) setError(t("unexpectedError")); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-extrabold text-ink">{t("title")}</h1>
        <p className="mt-2 text-muted">{t("subtitle", { name: user.name })}</p>

        <form className="mt-8 flex flex-col gap-5 rounded-2xl border border-line bg-surface p-6" onSubmit={handleSubmit} aria-busy={busy}>
          <fieldset className="contents" disabled={busy}>
          <Field
            label={t("fieldTitle")}
            placeholder={t("fieldTitlePlaceholder")}
            value={draft.title}
            onChange={(v) => updateDraft({ title: v })}
            maxLength={60}
            hint={!titleOk && draft.title.length > 0 ? t("minChars", { min: 2 }) : undefined}
          />
          <Field
            label={t("fieldTagline")}
            placeholder={t("fieldTaglinePlaceholder")}
            value={draft.tagline}
            onChange={(v) => updateDraft({ tagline: v })}
            maxLength={60}
            hint={!taglineOk && draft.tagline.length > 0 ? t("minChars", { min: 2 }) : undefined}
          />
          <Field
            label={t("fieldDescription")}
            placeholder={t("fieldDescriptionPlaceholderProduct")}
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
          <Field
            label={t("fieldVideo")}
            placeholder={t("fieldVideoPlaceholder")}
            value={draft.videoUrl}
            onChange={(v) => updateDraft({ videoUrl: v })}
          />

          <LogoField logoPath={draft.logoPath} onChange={(path) => updateDraft({ logoPath: path })} />
          <ScreenshotsField
            paths={draft.screenshotPaths}
            onChange={(paths) => updateDraft({ screenshotPaths: paths })}
          />
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
          <TeamField team={draft.team} onChange={(team) => updateDraft({ team })} />
          <SocialLinksField
            socialLinks={draft.socialLinks}
            onChange={(socialLinks) => updateDraft({ socialLinks })}
          />

          <div className="rounded-xl bg-surface-2 p-4 text-sm text-muted">
            {t("processTitle")}
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>{t("processStep1")}</li>
              <li>{t("processStep2")}</li>
              <li>{t("processStep3")}</li>
            </ol>
          </div>

          <p className="font-mono text-[11px] text-faint">{storageError ? t("draftUnavailable") : draftReady ? t("draftSaved") : t("draftLoading")}</p>

          {missingFields && <p className="text-sm text-muted">{t("missingRequired", { fields: missingFields })}</p>}
          {signInRequired && <button type="button" className="community-button" onClick={continueSignIn}>{t("signInPublish")}</button>}
          {error && <p role="alert" className="rounded-lg bg-risk-soft px-3 py-2 text-xs text-risk">{error}</p>}

          <button
            type="submit"
            disabled={busy || !draftReady}
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? tc("submitting") : t("submitButton")}
          </button>
          </fieldset>
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
      try {
      const result = await uploadSubmissionMedia(formData);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onChange(result.path);
      } catch { setError(t("operationError")); }
    });
  }

  function handleRemove() {
    if (!logoPath) return;
    const path = logoPath;
    startTransition(async () => {
      try { const result = await deleteSubmissionMedia(path); if (result.error) { setError(result.error); return; } onChange(null); }
      catch { setError(t("operationError")); }
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
      try {
      const result = await uploadSubmissionMedia(formData);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onChange([...paths, result.path]);
      } catch { setError(t("operationError")); }
    });
  }

  function handleRemove(path: string) {
    startTransition(async () => {
      try { const result = await deleteSubmissionMedia(path); if (result.error) { setError(result.error); return; } onChange(paths.filter((p) => p !== path)); }
      catch { setError(t("operationError")); }
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
