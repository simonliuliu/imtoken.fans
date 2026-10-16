"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { AuthLoading } from "@/components/auth-loading";
import { useAuth } from "@/lib/auth-context";
import { getSignInHref } from "@/lib/auth-navigation";
import { readFeedback, writeFeedback } from "@/app/actions/feedback";
import { clearFeedbackDraft, saveFeedbackDraft, readFeedbackDraft } from "@/lib/feedback-drafts";
import { FEEDBACK_CHANGED, FEEDBACK_MODULES, type FeedbackModule, type FeedbackPost } from "@/lib/feedback";

import styles from "./community-compose.module.css";

const blank = { title: "", body: "", module: "wallet" as FeedbackModule, kind: "bug" as "bug" | "suggestion", details: {} as Record<string, string> };

const DRAFT_KIND = "product-feedback-v2";
type Form = typeof blank;
type Pending = { id: string; title: string; description: string; module: FeedbackModule; expected_user_id: string };
type Draft = { form: Form; pending: Pending | null; legacyPending?: boolean; legacyId?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validForm(value: unknown): value is Form {
  if (!value || typeof value !== "object") return false;
  const v = value as Form;
  return typeof v.title === "string" && typeof v.body === "string" && FEEDBACK_MODULES.includes(v.module) && ["bug", "suggestion"].includes(v.kind) && !!v.details && typeof v.details === "object" && !Array.isArray(v.details) && Object.entries(v.details).every(([key, value]) => ["appVersion", "device", "steps", "expected", "actual", "scenario", "proposal", "impact"].includes(key) && typeof value === "string") && (!v.details.device || ["ios", "android", "browserExtension", "other"].includes(v.details.device));
}
function validPending(value: unknown, owner: string | null): value is Pending {
  const p = value as Pending | null;
  return !!p && UUID.test(p.id) && typeof p.title === "string" && typeof p.description === "string" && FEEDBACK_MODULES.includes(p.module) && p.expected_user_id === owner;
}

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
  const [error, setError] = useState("");
  const [signInRequired, setSignInRequired] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [similar, setSimilar] = useState<FeedbackPost[]>([]);
  const [similarError, setSimilarError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const formRef = useRef<Form>(blank);
  const [ready, setReady] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const initialized = useRef(false);
  const completed = useRef(false);
  const [finished, setFinished] = useState(false);
  const [legacyPending, setLegacyPending] = useState(false);
  const [legacyId, setLegacyId] = useState<string | null>(null);
  const legacyIdRef = useRef<string | null>(null);
  const legacyRef = useRef(false);
  const [storageWarning, setStorageWarning] = useState(false);
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
      if (initialized.current) return;
      initialized.current = true;
      try {
        let saved = readFeedbackDraft<Draft>(DRAFT_KIND, owner, (value) => !!value?.pending || !!value?.legacyPending);
        const resume = params.get("resume") === "1" || params.get("composeFeedback") === "1";
        if (!saved && owner && resume) {
          const anonymous = readFeedbackDraft<Draft>(DRAFT_KIND, null);
          if (anonymous) {
            if (!validForm(anonymous.form) || anonymous.pending || anonymous.legacyPending) throw new Error("Invalid anonymous draft");
            saveFeedbackDraft(DRAFT_KIND, owner, anonymous);
            saved = anonymous;
            try { clearFeedbackDraft(DRAFT_KIND, null); } catch { setStorageWarning(true); }
          }
        }
        if (!saved && resume) {
          type OldDraft = Form & { requestId?: string };
          let oldOwner = owner;
          let old = readFeedbackDraft<OldDraft>("idea", owner, (value) => !!value?.requestId);
          if (!old && owner) { oldOwner = null; old = readFeedbackDraft<OldDraft>("idea", null, (value) => !!value?.requestId); }
          if (old) {
            const migrated: Draft = { form: { ...old, kind: old.kind === "suggestion" ? "suggestion" : "bug", details: old.details ?? {} }, pending: null, legacyPending: !!old.requestId, legacyId: old.requestId };
            if (!validForm(migrated.form)) throw new Error("Invalid legacy draft");
            saveFeedbackDraft(DRAFT_KIND, owner, migrated, { retainUntilResolved: !!old.requestId });
            saved = migrated;
            try { clearFeedbackDraft("idea", oldOwner); } catch { setStorageWarning(true); }
          }
        }
        if (saved) {
          if (!validForm(saved.form) || (saved.pending !== null && !validPending(saved.pending, owner))) { clearFeedbackDraft(DRAFT_KIND, owner); throw new Error("Invalid draft"); }
          formRef.current = saved.form;
          pendingRef.current = saved.pending;
          legacyRef.current = !!saved.legacyPending;
          legacyIdRef.current = saved.legacyId && UUID.test(saved.legacyId) ? saved.legacyId : null; setLegacyId(legacyIdRef.current);
          setForm(saved.form); setPending(saved.pending); setLegacyPending(!!saved.legacyPending);
        }
      } catch { setStorageWarning(true); setReady(false); return; }
      setStorageWarning(false); setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  // Account/session remounts isolate editors. Locale remounts read the same owner draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, recoveryAttempt]);
  function persist(value = formRef.current, snapshot = pendingRef.current) {
    if (completed.current) return false;
    try { saveFeedbackDraft(DRAFT_KIND, owner, { form: value, pending: snapshot, legacyPending: legacyRef.current, legacyId: legacyIdRef.current }, { retainUntilResolved: !!snapshot || legacyRef.current }); setStorageWarning(false); return true; }
    catch { setStorageWarning(true); return false; }
  }
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
  const signInHref = getSignInHref("/submit/feedback?resume=1", locale);
  const setDetail = (key: string, value: string) => update({ details: { ...formRef.current.details, [key]: value } });
  function serializedDescription() {
    const names = form.kind === "bug" ? ["appVersion", "device", "steps", "expected", "actual"] : ["scenario", "proposal", "impact"];
    const detailText = names.filter((key) => form.details[key]?.trim()).map((key) => `${t(`fields.${key}`)}: ${key === "device" ? t(`deviceOptions.${form.details[key]}`) : form.details[key].trim()}`).join("\n\n");
    const kindLabel = t(form.kind === "bug" ? "bugType" : "suggestionType");
    return `${kindLabel}\n\n${form.body.trim()}${detailText ? `\n\n${detailText}` : ""}`;
  }
  function continueSignIn() {
    if (!ready || !persist()) return;
    router.push(signInHref);
  }
  function retryLegacy(event: FormEvent) {
    if (!ready || inFlight.current || completed.current || !owner || !legacyRef.current || !legacyIdRef.current) return;
    const description = serializedDescription();
    if (formRef.current.title.trim().length < 2 || formRef.current.body.trim().length < 2 || description.length > 5000) { showError(f("invalidDraft")); return; }
    const snapshot: Pending = { id: legacyIdRef.current, title: formRef.current.title, description, module: formRef.current.module, expected_user_id: owner };
    try {
      // The old request may already exist. Reuse its UUID so a content mismatch
      // produces a conflict instead of accidentally publishing a duplicate.
      saveFeedbackDraft(DRAFT_KIND, owner, { form: formRef.current, pending: snapshot, legacyPending: false }, { retainUntilResolved: true });
    } catch { setStorageWarning(true); return; }
    legacyRef.current = false; setLegacyPending(false);
    pendingRef.current = snapshot; setPending(snapshot);
    return submit(event);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || completed.current || inFlight.current || legacyRef.current) return;
    if (needsLogin) { continueSignIn(); return; }
    let snapshot = pendingRef.current;
    const firstAttempt = !snapshot;
    if (!snapshot) {
      const description = serializedDescription();
      if (formRef.current.title.trim().length < 2 || formRef.current.body.trim().length < 2) { showError(f("invalidDraft")); return; }
      if (description.length > 5000) { showError(t("descriptionTooLong", { count: description.length })); return; }
      try { snapshot = { id: crypto.randomUUID(), title: formRef.current.title, description, module: formRef.current.module, expected_user_id: owner! }; }
      catch { showError(f("unexpected")); return; }
      // Durably bind the UUID to its exact payload before any request can reach the server.
      if (!persist(formRef.current, snapshot)) return;
      pendingRef.current = snapshot; setPending(snapshot);
    }
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await writeFeedback("create", { ...snapshot });
      if (!mounted.current) return;
      if (!result.ok) {
        // These responses conclusively reject this attempt before a commit. Unknown errors
        // (including malformed success) must keep the immutable original snapshot.
        if (firstAttempt && ["invalid", "restricted", "forbidden", "sign_in", "configuration", "migration"].includes(result.code ?? "")) {
          pendingRef.current = null; setPending(null); persist(formRef.current, null);
        }
        showError(result.error, result.code === "sign_in"); return;
      }
      if (typeof result.data?.id !== "string" || !result.data.id.trim()) { showError(f("unexpected")); return; }
      completed.current = true; setFinished(true);
      try { clearFeedbackDraft(DRAFT_KIND, owner); clearFeedbackDraft("idea", owner); } catch { setStorageWarning(true); }
      window.dispatchEvent(new CustomEvent(FEEDBACK_CHANGED, { detail: { id: result.data.id } }));
      setNotice(f("saved")); router.push(`/community/feedback?category=wallet&idea=${result.data.id}`);
    } catch { if (mounted.current) showError(f("unexpected")); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const locked = !ready || busy || !!pending || legacyPending || finished;
  function update(patch: Partial<Form>) {
    if (!ready || inFlight.current || pendingRef.current || legacyRef.current || completed.current) return;
    const value = { ...formRef.current, ...patch };
    formRef.current = value; setForm(value); persist(value);
  }
  const descriptionLength = pending?.description.length ?? serializedDescription().length;
  return <div className="community-page community-submit-page" id="main-content" tabIndex={-1}><div className="community-submit-shell">
    <nav className="community-breadcrumb" aria-label={t("typeNavigation")}><Link href="/">{community("home")}</Link><span aria-hidden>/</span><span>{t("feedbackTitle")}</span></nav>
    <header className="community-submit-heading"><h1>{t("feedbackTitle")}</h1><p>{t("feedbackIntro")}</p></header>
    <section className="community-submit-types" aria-label={t("typeNavigation")}>
      <Link href="/submit/post"><span aria-hidden>✍</span><span><strong>{t("postType")}</strong><small>{t("postTypeHelp")}</small></span></Link>
      <Link href="/submit/feedback" aria-current="page" className="is-active"><span aria-hidden>◌</span><span><strong>{t("feedbackType")}</strong><small>{t("feedbackTypeHelp")}</small></span></Link>
      <Link href="/submit/product"><span aria-hidden>◇</span><span><strong>{t("productType")}</strong><small>{t("productTypeHelp")}</small></span></Link>
    </section>
    <p className="community-submit-boundary">{t("feedbackVisibility")} {t("uploadDeferred")}</p>
    {storageWarning && <p role="alert" className={styles.submitError}>{f("persistentDraftUnavailable")} {!ready && <button type="button" className="community-button" onClick={() => { initialized.current = false; setRecoveryAttempt((value) => value + 1); }}>{f("reloadDraft")}</button>}</p>}
    {legacyPending && <p role="alert" className={styles.submitError}>{f("legacyPending")} <Link href={legacyId ? `/community/feedback?category=wallet&idea=${legacyId}` : "/community/feedback?category=wallet"}>{f("checkPublished")}</Link> {legacyId && owner && <button type="button" className="community-button" disabled={!ready || busy} onClick={retryLegacy}>{f("retryLegacy")}</button>}</p>}
    {pending && !busy && <p role="status" className="community-local-status">{f("pendingRetry")} <Link href={`/community/feedback?category=wallet&idea=${pending.id}`}>{f("checkPublished")}</Link></p>}
    {notice && <p role="status" className="community-local-status">{notice}</p>}
    {similarError && <p role="status" className="community-local-status">{similarError}</p>}
    {matchingIdeas.length > 0 && <section aria-label={c("similarHeading")} className="community-panel p-4"><h2>{c("similarHeading")}</h2>{matchingIdeas.map((item) => <p key={item.id}><Link href={`/community/feedback?category=wallet&idea=${item.id}`}>{item.title}</Link></p>)}</section>}
    <form className="community-panel community-submit-form" onSubmit={submit}>
      <fieldset className="community-feedback-kind"><legend>{t("feedbackKindLabel")}</legend>
        {(["bug", "suggestion"] as const).map((kind) => <button type="button" key={kind} aria-pressed={form.kind === kind} disabled={locked} onClick={() => update({ kind })}><strong>{t(kind === "bug" ? "bugType" : "suggestionType")}</strong><small>{t(kind === "bug" ? "bugTypeHelp" : "suggestionTypeHelp")}</small></button>)}
      </fieldset>
      <label>{t("fields.module")}<select value={form.module} disabled={locked} onChange={(event) => update({ module: event.target.value as FeedbackModule })}>{FEEDBACK_MODULES.map((module) => <option key={module} value={module}>{c(`modules.${module}`)}</option>)}</select></label>
      <label>{f("titleField")}<input required minLength={2} maxLength={120} disabled={locked} value={form.title} onChange={(event) => update({ title: event.target.value })} placeholder={t("titlePlaceholderFeedback")} /></label>
      <label>{t(form.kind === "bug" ? "fields.problem" : "fields.situation")}<textarea required minLength={2} maxLength={5000} disabled={locked} rows={6} value={form.body} onChange={(event) => update({ body: event.target.value })} placeholder={t(form.kind === "bug" ? "bugDescriptionPlaceholder" : "suggestionDescriptionPlaceholder")} /></label>
      {form.kind === "bug" ? <div className="community-feedback-fields"><label>{t("fields.appVersion")}<input disabled={locked} value={form.details.appVersion ?? ""} onChange={(event) => setDetail("appVersion", event.target.value)} placeholder={t("placeholders.appVersion")} /></label><label>{t("fields.device")}<select disabled={locked} value={form.details.device ?? ""} onChange={(event) => setDetail("device", event.target.value)}><option value="">{t("chooseOne")}</option>{["ios", "android", "browserExtension", "other"].map((value) => <option key={value} value={value}>{t(`deviceOptions.${value}`)}</option>)}</select></label><label className="community-field-wide">{t("fields.steps")}<textarea disabled={locked} rows={3} value={form.details.steps ?? ""} onChange={(event) => setDetail("steps", event.target.value)} placeholder={t("placeholders.steps")} /></label><label>{t("fields.expected")}<textarea disabled={locked} rows={3} value={form.details.expected ?? ""} onChange={(event) => setDetail("expected", event.target.value)} /></label><label>{t("fields.actual")}<textarea disabled={locked} rows={3} value={form.details.actual ?? ""} onChange={(event) => setDetail("actual", event.target.value)} /></label></div> : <div className="community-feedback-fields"><label>{t("fields.scenario")}<textarea disabled={locked} rows={3} value={form.details.scenario ?? ""} onChange={(event) => setDetail("scenario", event.target.value)} placeholder={t("placeholders.scenario")} /></label><label>{t("fields.proposal")}<textarea disabled={locked} rows={3} value={form.details.proposal ?? ""} onChange={(event) => setDetail("proposal", event.target.value)} placeholder={t("placeholders.proposal")} /></label><label className="community-field-wide">{t("fields.impact")}<textarea disabled={locked} rows={3} value={form.details.impact ?? ""} onChange={(event) => setDetail("impact", event.target.value)} placeholder={t("placeholders.impact")} /></label></div>}
      <p className="community-local-status" aria-live="polite">{t("feedbackLength", { count: descriptionLength })}</p>
      <div className="community-submit-privacy"><strong>{t("privacyTitle")}</strong><p>{t("privacyBody")}</p></div>
      {needsLogin && <p role="status" className={styles.loginNotice}>{f("signInBeforePublish")}</p>}
      {error && <div id={errorId} ref={errorRegion} role="alert" tabIndex={-1} className={styles.submitError}><p>{error}</p></div>}
      <button type={needsLogin ? "button" : "submit"} onClick={needsLogin ? continueSignIn : undefined} aria-describedby={error ? errorId : undefined} className="community-button" disabled={!ready || busy || legacyPending || finished || !needsLogin && !pending && (form.title.trim().length < 2 || form.body.trim().length < 2 || descriptionLength > 5000)}>{busy ? f("saving") : needsLogin ? f("signInPublish") : pending ? f("retryOriginal") : t("publishFeedback")}</button>
    </form>
  </div></div>;
}
