"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { COMMUNITY_SECTIONS, SECTION_CATEGORIES, isCommunitySection, type CommunitySection } from "@/lib/community-demo";

type Mode = "post" | "feedback";
type FeedbackKind = "bug" | "suggestion";

export function CommunitySubmit({ mode = "post", initialSection }: { mode?: Mode; initialSection?: CommunitySection }) {
  const t = useTranslations("communitySubmit");
  const tc = useTranslations("community");
  const safeInitialSection = initialSection && isCommunitySection(initialSection) && initialSection !== "feedback" ? initialSection : null;
  const [section, setSection] = useState<CommunitySection>(mode === "feedback" ? "feedback" : safeInitialSection ?? "discussion");
  const [category, setCategory] = useState(mode === "feedback" ? "wallet" : SECTION_CATEGORIES[safeInitialSection ?? "discussion"].find((item) => item !== "announcements" && item !== "changelog") ?? "community");
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [details, setDetails] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState("");

  const isFeedback = mode === "feedback";
  const visibleCategories = SECTION_CATEGORIES[section].filter((value) => value !== "announcements" && value !== "changelog");
  const visibleDetailKeys = isFeedback
    ? feedbackKind === "bug"
      ? new Set(["module", "appVersion", "device", "steps", "expected", "actual"])
      : new Set(["module", "scenario", "proposal", "impact"])
    : new Set<string>();

  function updateDetail(key: string, value: string) {
    setDetails((previous) => ({ ...previous, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setPreview(true);
    setNotice(t("previewCreated"));
  }

  return (
    <div className="community-page community-submit-page" id="main-content" tabIndex={-1}>
      <div className="community-submit-shell">
        <nav className="community-breadcrumb" aria-label={tc("breadcrumb")}>
          <Link href="/">{tc("home")}</Link><span aria-hidden>/</span><span>{t(isFeedback ? "feedbackTitle" : "postTitle")}</span>
        </nav>

        <header className="community-submit-heading">
          <span className="community-demo-label">{t("previewLabel")}</span>
          <h1>{t(isFeedback ? "feedbackTitle" : "postTitle")}</h1>
          <p>{t(isFeedback ? "feedbackIntro" : "postIntro")}</p>
        </header>

        <section className="community-submit-types" aria-label={t("typeNavigation")}>
          <Link href="/submit/post" aria-current={!isFeedback ? "page" : undefined} className={!isFeedback ? "is-active" : ""}>
            <span aria-hidden>✍</span><span><strong>{t("postType")}</strong><small>{t("postTypeHelp")}</small></span>
          </Link>
          <Link href="/submit/feedback" aria-current={isFeedback ? "page" : undefined} className={isFeedback ? "is-active" : ""}>
            <span aria-hidden>◌</span><span><strong>{t("feedbackType")}</strong><small>{t("feedbackTypeHelp")}</small></span>
          </Link>
          <Link href="/submit/product"><span aria-hidden>◇</span><span><strong>{t("productType")}</strong><small>{t("productTypeHelp")}</small></span></Link>
        </section>

        <p className="community-submit-boundary">{t(isFeedback ? "feedbackBoundary" : "postBoundary")}</p>

        {preview ? (
          <section className="community-panel community-submit-form community-submit-result" aria-labelledby="community-submit-result-title">
            <span className="community-demo-label">{t("previewLabel")}</span>
            <p className="community-preview-category">{isFeedback ? t(feedbackKind === "bug" ? "bugType" : "suggestionType") : `${tc(`sections.${section}.name`)} › ${tc(`categories.${category}`)}`}</p>
            <h2 id="community-submit-result-title">{title}</h2>
            <p>{body}</p>
            {Object.entries(details).filter(([key, value]) => visibleDetailKeys.has(key) && value.trim()).map(([key, value]) => <p key={key}><strong>{t(`fields.${key}`)}:</strong> {key === "device" ? t(`deviceOptions.${value}`) : value}</p>)}
            <div className="community-submit-result-actions">
              <button type="button" className="community-button community-button-outline" onClick={() => setPreview(false)}>{t("editPreview")}</button>
              <button type="button" className="community-button" onClick={() => { setTitle(""); setBody(""); setDetails({}); setPreview(false); setNotice(t("resetNotice")); }}>{t("startOver")}</button>
            </div>
          </section>
        ) : (
          <form className="community-panel community-submit-form" onSubmit={submit}>
            {isFeedback && <fieldset className="community-feedback-kind">
              <legend>{t("feedbackKindLabel")}</legend>
              <button type="button" aria-pressed={feedbackKind === "bug"} onClick={() => { if (feedbackKind !== "bug") { setFeedbackKind("bug"); setDetails({}); } }}><strong>{t("bugType")}</strong><small>{t("bugTypeHelp")}</small></button>
              <button type="button" aria-pressed={feedbackKind === "suggestion"} onClick={() => { if (feedbackKind !== "suggestion") { setFeedbackKind("suggestion"); setDetails({}); } }}><strong>{t("suggestionType")}</strong><small>{t("suggestionTypeHelp")}</small></button>
            </fieldset>}

            <label>{t("fields.section")}
              <select value={section} disabled={isFeedback} onChange={(event) => { const next = event.target.value as CommunitySection; setSection(next); setCategory(SECTION_CATEGORIES[next].find((item) => item !== "announcements" && item !== "changelog") ?? "community"); }}>
                {COMMUNITY_SECTIONS.filter((value) => isFeedback ? value === "feedback" : value !== "feedback").map((value) => <option key={value} value={value}>{tc(`sections.${value}.name`)}</option>)}
              </select>
            </label>
            {!isFeedback && <label>{t("fields.category")}
              <select value={category} onChange={(event) => setCategory(event.target.value)}>{visibleCategories.map((value) => <option key={value} value={value}>{tc(`categories.${value}`)}</option>)}</select>
            </label>}
            {isFeedback && <label>{t("fields.module")}<input value={details.module ?? ""} onChange={(event) => updateDetail("module", event.target.value)} placeholder={t("placeholders.module")} /></label>}
            <label>{t("fields.title")}<input required maxLength={isFeedback ? 100 : 80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t(isFeedback ? "titlePlaceholderFeedback" : "titlePlaceholderPost")} /></label>
            <label>{t(isFeedback ? (feedbackKind === "bug" ? "fields.problem" : "fields.situation") : "fields.body")}
              <textarea required rows={6} maxLength={5000} value={body} onChange={(event) => setBody(event.target.value)} placeholder={t(isFeedback ? (feedbackKind === "bug" ? "bugDescriptionPlaceholder" : "suggestionDescriptionPlaceholder") : "bodyPlaceholder")} />
            </label>
            {isFeedback && (feedbackKind === "bug" ? <div className="community-feedback-fields">
              <label>{t("fields.appVersion")}<input value={details.appVersion ?? ""} onChange={(event) => updateDetail("appVersion", event.target.value)} placeholder={t("placeholders.appVersion")} /></label>
              <label>{t("fields.device")}
                <select value={details.device ?? ""} onChange={(event) => updateDetail("device", event.target.value)}><option value="">{t("chooseOne")}</option>{["ios", "android", "browserExtension", "other"].map((value) => <option key={value} value={value}>{t(`deviceOptions.${value}`)}</option>)}</select>
              </label>
              <label className="community-field-wide">{t("fields.steps")}<textarea rows={3} value={details.steps ?? ""} onChange={(event) => updateDetail("steps", event.target.value)} placeholder={t("placeholders.steps")} /></label>
              <label>{t("fields.expected")}<textarea rows={3} value={details.expected ?? ""} onChange={(event) => updateDetail("expected", event.target.value)} /></label>
              <label>{t("fields.actual")}<textarea rows={3} value={details.actual ?? ""} onChange={(event) => updateDetail("actual", event.target.value)} /></label>
            </div> : <div className="community-feedback-fields">
              <label>{t("fields.scenario")}<textarea rows={3} value={details.scenario ?? ""} onChange={(event) => updateDetail("scenario", event.target.value)} placeholder={t("placeholders.scenario")} /></label>
              <label>{t("fields.proposal")}<textarea rows={3} value={details.proposal ?? ""} onChange={(event) => updateDetail("proposal", event.target.value)} placeholder={t("placeholders.proposal")} /></label>
              <label className="community-field-wide">{t("fields.impact")}<textarea rows={3} value={details.impact ?? ""} onChange={(event) => updateDetail("impact", event.target.value)} placeholder={t("placeholders.impact")} /></label>
            </div>)}
            <div className="community-submit-upload"><strong>{t("fields.attachments")}</strong><p>{t("uploadDeferred")}</p></div>
            <div className="community-submit-privacy"><strong>{t("privacyTitle")}</strong><p>{t("privacyBody")}</p></div>
            <div className="community-submit-result-actions"><button type="submit" disabled={!title.trim() || !body.trim()} className="community-button">{t("previewSubmit")}</button></div>
          </form>
        )}
        {notice && <p className="community-local-status" role="status">{notice}</p>}
      </div>
    </div>
  );
}
