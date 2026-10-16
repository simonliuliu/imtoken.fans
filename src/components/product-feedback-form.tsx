"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { AuthLoading } from "@/components/auth-loading";
import { useAuth } from "@/lib/auth-context";
import { getSignInHref } from "@/lib/auth-navigation";
import { readFeedback, writeFeedback } from "@/app/actions/feedback";
import { clearFeedbackDraft, saveFeedbackDraft, takeFeedbackDraft } from "@/lib/feedback-drafts";
import { FEEDBACK_CHANGED, FEEDBACK_MODULES, type FeedbackModule, type FeedbackPost } from "@/lib/feedback";

import styles from "./community-compose.module.css";

const blank = { title: "", body: "", module: "wallet" as FeedbackModule, kind: "bug" as "bug" | "suggestion", details: {} as Record<string, string> };

export function ProductFeedbackForm() {
  const { user, loading, sessionEpoch } = useAuth();
  return loading ? <AuthLoading /> : <FeedbackForm key={`${user?.id ?? "anonymous"}:${sessionEpoch}`} owner={user?.id ?? null} />;
}

function FeedbackForm({ owner }: { owner: string | null }) {
  const t = useTranslations("communitySubmit");
  const f = useTranslations("feedbackLive");
  const c = useTranslations("cooperation");
  const community = useTranslations("community");
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [form, setForm] = useState(blank);
  const [draftReady, setDraftReady] = useState(false);
  const [error, setError] = useState("");
  const [signInRequired, setSignInRequired] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [similar, setSimilar] = useState<FeedbackPost[]>([]);
  const [similarError, setSimilarError] = useState("");
  const requestId = useRef<string | null>(null);
  const requestSignature = useRef<string | null>(null);
  const inFlight = useRef(false);
  const errorRegion = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const [failureSequence, setFailureSequence] = useState(0);
  const [similarQuery, setSimilarQuery] = useState("");
  const matchingIdeas = similarQuery === form.title.trim() ? similar : [];
  const needsLogin = !owner || signInRequired;
  function showError(value: unknown, login = false) {
    setError(typeof value === "string" && value.trim() ? value : f("unexpected"));
    setSignInRequired(login); setFailureSequence((v) => v + 1);
  }
  useEffect(() => {
    if (!error) return;
    errorRegion.current?.focus({ preventScroll: true });
    errorRegion.current?.scrollIntoView({ block: "nearest" });
  }, [error, failureSequence]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = takeFeedbackDraft<{ title: string; body: string; module: FeedbackModule; kind?: "bug" | "suggestion"; details?: Record<string, string>; requestId?: string | null; requestSignature?: string | null }>("idea", owner, params.get("resume") === "1" || params.get("composeFeedback") === "1");
        if (saved && typeof saved.title === "string" && typeof saved.body === "string" && FEEDBACK_MODULES.includes(saved.module)) {
          setForm({ title: saved.title, body: saved.body, module: saved.module, kind: saved.kind === "suggestion" ? "suggestion" : "bug", details: saved.details && typeof saved.details === "object" ? Object.fromEntries(Object.entries(saved.details).filter(([, value]) => typeof value === "string")) : {} }); requestId.current = saved.requestId ?? null; requestSignature.current = saved.requestSignature ?? null;
        }
      } catch { setError(f("draftUnavailable")); }
      finally { setDraftReady(true); }
    }, 0);
    return () => window.clearTimeout(timer);
  // A draft is consumed once for this account/session mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  useEffect(() => {
    let stale = false;
    if (form.title.trim().length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const result = await readFeedback({ query: form.title.trim(), sort: "popular" });
        if (stale) return;
        const sameSession = result.ok && result.data.viewer.user_id === owner;
        setSimilar(sameSession ? result.data.posts.slice(0, 3) : []);
        setSimilarQuery(form.title.trim());
        setSimilarError(result.ok && !sameSession ? f("sessionChanged") : result.ok ? "" : result.error || f("unexpected"));
      } catch { if (!stale) { setSimilar([]); setSimilarError(f("unexpected")); } }
    }, 350);
    return () => { stale = true; clearTimeout(timer); };
  }, [form.title, owner, f]);
  useEffect(() => {
    if (!draftReady) return;
    try { saveFeedbackDraft("idea", owner, { ...form, requestId: requestId.current, requestSignature: requestSignature.current }); }
    catch { /* Explicit login handoff below reports storage failures. */ }
  }, [draftReady, form, owner]);
  const signInHref = getSignInHref("/submit/feedback?resume=1", locale);
  const setDetail = (key: string, value: string) => setForm((valueBefore) => ({ ...valueBefore, details: { ...valueBefore.details, [key]: value } }));
  function serializedDescription() {
    const names = form.kind === "bug" ? ["appVersion", "device", "steps", "expected", "actual"] : ["scenario", "proposal", "impact"];
    const detailText = names.filter((key) => form.details[key]?.trim()).map((key) => `${t(`fields.${key}`)}: ${key === "device" && ["ios", "android", "browserExtension", "other"].includes(form.details[key]) ? t(`deviceOptions.${form.details[key]}`) : form.details[key].trim()}`).join("\n\n");
    const kindLabel = t(form.kind === "bug" ? "bugType" : "suggestionType");
    return `${kindLabel}\n\n${form.body.trim()}${detailText ? `\n\n${detailText}` : ""}`;
  }
  function continueSignIn() {
    try { saveFeedbackDraft("idea", owner, { ...form, requestId: requestId.current, requestSignature: requestSignature.current }); }
    catch { showError(f("draftUnavailable")); return; }
    router.push(signInHref);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (inFlight.current) return;
    if (!draftReady) return;
    if (needsLogin) { continueSignIn(); return; }
    if (form.title.trim().length < 2 || form.body.trim().length < 2) { showError(t("feedbackRequirements")); return; }
    const description = serializedDescription();
    if (description.length > 5000) { showError(t("descriptionTooLong", { count: description.length })); return; }
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const signature = JSON.stringify({ title: form.title, description, module: form.module });
      if (requestSignature.current !== signature) { requestId.current = crypto.randomUUID(); requestSignature.current = signature; }
      try { saveFeedbackDraft("idea", owner, { ...form, requestId: requestId.current, requestSignature: requestSignature.current }); } catch { /* Keep the in-memory request for retry. */ }
      const result = await writeFeedback("create", { id: requestId.current, title: form.title, description, module: form.module, expected_user_id: owner });
      if (!mounted.current) return;
      if (!result.ok) { showError(result.error, result.code === "sign_in"); return; }
      if (typeof result.data?.id !== "string" || !result.data.id.trim()) { showError(f("unexpected")); return; }
      try { clearFeedbackDraft("idea", owner); } catch { /* Server submission succeeded. */ }
      window.dispatchEvent(new CustomEvent(FEEDBACK_CHANGED, { detail: { id: result.data.id } }));
      setNotice(f("saved")); router.push(`/community/feedback?category=wallet&idea=${result.data.id}`);
    } catch { if (mounted.current) showError(f("unexpected")); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const update = (patch: Partial<typeof form>) => setForm((value) => ({ ...value, ...patch }));
  const descriptionLength = serializedDescription().length;
  return <div className="community-page community-submit-page" id="main-content" tabIndex={-1}><div className="community-submit-shell">
    <nav className="community-breadcrumb" aria-label={t("typeNavigation")}><Link href="/">{community("home")}</Link><span aria-hidden>/</span><span>{t("feedbackTitle")}</span></nav>
    <header className="community-submit-heading"><h1>{t("feedbackTitle")}</h1><p>{t("feedbackIntro")}</p></header>
    <section className="community-submit-types" aria-label={t("typeNavigation")}>
      <Link href="/submit/post"><span aria-hidden>✍</span><span><strong>{t("postType")}</strong><small>{t("postTypeHelp")}</small></span></Link>
      <Link href="/submit/feedback" aria-current="page" className="is-active"><span aria-hidden>◌</span><span><strong>{t("feedbackType")}</strong><small>{t("feedbackTypeHelp")}</small></span></Link>
      <Link href="/submit/product"><span aria-hidden>◇</span><span><strong>{t("productType")}</strong><small>{t("productTypeHelp")}</small></span></Link>
    </section>
    <p className="community-submit-boundary">{t("feedbackVisibility")} {t("uploadDeferred")}</p>
    {notice && <p role="status" className="community-local-status">{notice}</p>}
    {similarError && <p role="status" className="community-local-status">{similarError}</p>}
    {matchingIdeas.length > 0 && <section aria-label={c("similarHeading")} className="community-panel p-4"><h2>{c("similarHeading")}</h2>{matchingIdeas.map((item) => <p key={item.id}><Link href={`/community/feedback?category=wallet&idea=${item.id}`}>{item.title}</Link></p>)}</section>}
    <form className="community-panel community-submit-form" onSubmit={submit} aria-busy={busy}>
      <fieldset className="community-feedback-kind"><legend>{t("feedbackKindLabel")}</legend>
        {(["bug", "suggestion"] as const).map((kind) => <button type="button" key={kind} aria-pressed={form.kind === kind} disabled={busy} onClick={() => update({ kind })}><strong>{t(kind === "bug" ? "bugType" : "suggestionType")}</strong><small>{t(kind === "bug" ? "bugTypeHelp" : "suggestionTypeHelp")}</small></button>)}
      </fieldset>
      <label>{t("fields.module")}<select value={form.module} disabled={busy} onChange={(event) => update({ module: event.target.value as FeedbackModule })}>{FEEDBACK_MODULES.map((module) => <option key={module} value={module}>{c(`modules.${module}`)}</option>)}</select></label>
      <label>{f("titleField")}<input required minLength={2} maxLength={120} disabled={busy} value={form.title} onChange={(event) => update({ title: event.target.value })} placeholder={t("titlePlaceholderFeedback")} /></label>
      <label>{t(form.kind === "bug" ? "fields.problem" : "fields.situation")}<textarea required minLength={2} maxLength={5000} disabled={busy} rows={6} value={form.body} onChange={(event) => update({ body: event.target.value })} placeholder={t(form.kind === "bug" ? "bugDescriptionPlaceholder" : "suggestionDescriptionPlaceholder")} /></label>
      {form.kind === "bug" ? <div className="community-feedback-fields"><label>{t("fields.appVersion")}<input disabled={busy} value={form.details.appVersion ?? ""} onChange={(event) => setDetail("appVersion", event.target.value)} placeholder={t("placeholders.appVersion")} /></label><label>{t("fields.device")}<select disabled={busy} value={form.details.device ?? ""} onChange={(event) => setDetail("device", event.target.value)}><option value="">{t("chooseOne")}</option>{["ios", "android", "browserExtension", "other"].map((value) => <option key={value} value={value}>{t(`deviceOptions.${value}`)}</option>)}</select></label><label className="community-field-wide">{t("fields.steps")}<textarea disabled={busy} rows={3} value={form.details.steps ?? ""} onChange={(event) => setDetail("steps", event.target.value)} placeholder={t("placeholders.steps")} /></label><label>{t("fields.expected")}<textarea disabled={busy} rows={3} value={form.details.expected ?? ""} onChange={(event) => setDetail("expected", event.target.value)} /></label><label>{t("fields.actual")}<textarea disabled={busy} rows={3} value={form.details.actual ?? ""} onChange={(event) => setDetail("actual", event.target.value)} /></label></div> : <div className="community-feedback-fields"><label>{t("fields.scenario")}<textarea disabled={busy} rows={3} value={form.details.scenario ?? ""} onChange={(event) => setDetail("scenario", event.target.value)} placeholder={t("placeholders.scenario")} /></label><label>{t("fields.proposal")}<textarea disabled={busy} rows={3} value={form.details.proposal ?? ""} onChange={(event) => setDetail("proposal", event.target.value)} placeholder={t("placeholders.proposal")} /></label><label className="community-field-wide">{t("fields.impact")}<textarea disabled={busy} rows={3} value={form.details.impact ?? ""} onChange={(event) => setDetail("impact", event.target.value)} placeholder={t("placeholders.impact")} /></label></div>}
      <p className="community-local-status" aria-live="polite">{t("feedbackLength", { count: descriptionLength })}</p>
      <div className="community-submit-privacy"><strong>{t("privacyTitle")}</strong><p>{t("privacyBody")}</p></div>
      <p className="community-local-status">{t("feedbackRequirements")}</p>
      {needsLogin && <p role="status" className={styles.loginNotice}>{f("signInBeforePublish")}</p>}
      {error && <div id={errorId} ref={errorRegion} role="alert" tabIndex={-1} className={styles.submitError}><p>{error}</p></div>}
      <button type={needsLogin ? "button" : "submit"} onClick={needsLogin ? continueSignIn : undefined} aria-describedby={error ? errorId : undefined} className="community-button" disabled={busy || !draftReady}>{busy ? f("saving") : needsLogin ? f("signInPublish") : t("publishFeedback")}</button>
    </form>
  </div></div>;
}
