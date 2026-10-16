"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth-context";
import { saveFeedbackDraft, takeFeedbackDraft, clearFeedbackDraft } from "@/lib/feedback-drafts";
import { Link, useRouter } from "@/i18n/navigation";
import { readFeedback, writeFeedback } from "@/app/actions/feedback";
import { FEEDBACK_MODULES, FEEDBACK_CHANGED, FEEDBACK_COMPOSE, type FeedbackModule, type FeedbackPost } from "@/lib/feedback";
import styles from "./community-compose.module.css";
import { COMMUNITY_SECTIONS, SECTION_CATEGORIES, type CommunitySection } from "@/lib/community-demo";

export function CommunityGlyph({ section }: { section: CommunitySection }) {
  const shapes = {
    safety: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    feedback: <><path d="M4 4h16v12H9l-5 4V4Z" /><path d="M8 8h8M8 12h5" /></>,
    discussion: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M2 21v-3a6 6 0 0 1 12 0v3M15 15a5 5 0 0 1 7 4v2" /></>,
    activities: <><path d="M4 7h16v14H4zM8 3v7M16 3v7M4 12h16m-11 5 2 2 4-4" /></>,
  };
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{shapes[section]}</svg>;
}

export function ComposeDemoButton(props: { section?: CommunitySection; compact?: boolean }) {
  const { user, loading, sessionEpoch } = useAuth();
  const t = useTranslations("community");
  if (loading) return <button type="button" disabled className="community-button" aria-label={t("compose")}>{t("compose")}</button>;
  return <Composer key={`${user?.id ?? "anonymous"}:${sessionEpoch}`} {...props} owner={user?.id ?? null} />;
}
export function Composer({ section = "discussion", compact = false, owner, pageMode }: { section?: CommunitySection; compact?: boolean; owner: string | null; pageMode?: "post" | "feedback" }) {
  const t = useTranslations("community");
  const f = useTranslations("feedbackLive");
  const c = useTranslations("cooperation");
  const router = useRouter();
  const dialogTitle = useId();
  const errorId = useId();
  const errorRegion = useRef<HTMLDivElement>(null);
  const loginRegion = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [board, setBoard] = useState<CommunitySection>(pageMode === "feedback" ? "feedback" : section);
  const [category, setCategory] = useState(SECTION_CATEGORIES[pageMode === "feedback" ? "feedback" : section].find((value) => value !== "announcements" && value !== "changelog")!);
  const [module, setModule] = useState<FeedbackModule>("wallet");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [failureSequence, setFailureSequence] = useState(0);
  const [signIn, setSignIn] = useState(false);
  const [similar, setSimilar] = useState<FeedbackPost[]>([]);
  const [similarError, setSimilarError] = useState("");
  const [similarQuery, setSimilarQuery] = useState("");
  const realFeedback = board === "feedback" && category === "wallet";
  const needsLogin = realFeedback && (!owner || signIn);
  const matchingIdeas = similarQuery === title.trim() ? similar : [];
  function showError(message: unknown) {
    setError(typeof message === "string" && message.trim() ? message : f("unexpected"));
    setFailureSequence((value) => value + 1);
  }
  useEffect(() => {
    if (!error) return;
    errorRegion.current?.focus({ preventScroll: true });
    errorRegion.current?.scrollIntoView({ block: "nearest" });
  }, [error, failureSequence]);
  useEffect(() => {
    if (!signIn) return;
    loginRegion.current?.focus({ preventScroll: true });
    loginRegion.current?.scrollIntoView({ block: "nearest" });
  }, [signIn]);
  useEffect(() => {
    if (!compact && pageMode !== "feedback") return;
    const open = () => { setBoard("feedback"); setCategory("wallet"); setPreview(false); setError(""); dialog.current?.showModal(); };
    window.addEventListener(FEEDBACK_COMPOSE, open);
    if (owner && new URLSearchParams(window.location.search).get("composeFeedback") === "1") {
      const timer = setTimeout(() => {
        try {
          const stored = takeFeedbackDraft<{ title: string; body: string; module: FeedbackModule; requestId: string | null }>("idea", owner, true);
          if (stored && typeof stored.title === "string" && typeof stored.body === "string") { setTitle(stored.title); setBody(stored.body); if (FEEDBACK_MODULES.includes(stored.module)) setModule(stored.module); requestId.current = stored.requestId ?? null; open(); }
        } catch { open(); setError(f("draftUnavailable")); }
      }, 0);
      return () => { clearTimeout(timer); window.removeEventListener(FEEDBACK_COMPOSE, open); };
    }
    return () => window.removeEventListener(FEEDBACK_COMPOSE, open);
  }, [compact, pageMode, f, owner]);
  useEffect(() => {
    let stale = false;
    if (!realFeedback || title.trim().length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const result = await readFeedback({ query: title.trim(), sort: "popular" });
        if (stale) return;
        const sameSession = result.ok && result.data.viewer.user_id === owner;
        setSimilar(sameSession ? result.data.posts.slice(0, 3) : []);
        setSimilarQuery(title.trim());
        const message = result.ok ? sameSession ? "" : f("sessionChanged") : result.error;
        setSimilarError(typeof message === "string" && (message.trim() || sameSession) ? message : f("unexpected"));
      } catch {
        if (!stale) { setSimilar([]); setSimilarError(f("unexpected")); }
      }
    }, 350);
    return () => { stale = true; clearTimeout(timer); };
  }, [title, realFeedback, owner, f]);
  function continueSignIn() {
    try { saveFeedbackDraft("idea", owner, { title, body, module, requestId: requestId.current }); }
    catch { showError(f("draftUnavailable")); return; }
    router.push(`/auth/sign-in?redirect=${encodeURIComponent("/community/feedback?category=wallet&composeFeedback=1")}`);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (inFlight.current) return;
    if (!realFeedback) { setPreview(true); return; }
    if (!owner || signIn) { continueSignIn(); return; }
    inFlight.current = true;
    setPending(true); setError(""); setSignIn(false);
    try {
      requestId.current ??= crypto.randomUUID();
      const result = await writeFeedback("create", { id: requestId.current, title, description: body, module, expected_user_id: owner });
      if (!mounted.current) return;
      if (!result.ok) { if (result.code === "sign_in") { setSignIn(true); setError(""); } else showError(result.error); return; }
      if (!result.data || typeof result.data.id !== "string" || !result.data.id.trim()) { showError(f("unexpected")); return; }
      try { clearFeedbackDraft("idea", owner); } catch { /* Publishing succeeded independently of browser draft storage. */ }
      setTitle(""); setBody(""); requestId.current = null; dialog.current?.close();
      window.dispatchEvent(new CustomEvent(FEEDBACK_CHANGED, { detail: { id: result.data.id } }));
      router.push(`/community/feedback?category=wallet&idea=${result.data.id}`);
    } catch { if (mounted.current) showError(f("unexpected")); } finally { inFlight.current = false; if (mounted.current) setPending(false); }
  }
  const signInHref = `/auth/sign-in?redirect=${encodeURIComponent("/submit?type=feedback&composeFeedback=1")}`;
  const content = <div className="community-dialog-content"><div className="community-dialog-heading"><h2 id={dialogTitle}>{realFeedback ? f("composeTitle") : t("composeTitle")}</h2>{!pageMode && <button type="button" className="community-icon-button" aria-label={realFeedback ? f("close") : t("close")} disabled={pending} onClick={() => dialog.current?.close()}>×</button>}</div>
      <p className="community-compose-notice">{realFeedback ? f("publishNotice") : t("composeNotice")}</p>
      {preview ? <div className="community-preview-result" role="status"><span className="community-demo-label">{t("previewOnly")}</span><p className="community-preview-category">{t(`sections.${board}.name`)} › {t(`categories.${category}`)}</p><h3>{title}</h3><p className="community-preview-body">{body}</p><button type="button" className="community-button community-button-outline" onClick={() => setPreview(false)}>{t("editPreview")}</button></div> : <form onSubmit={submit}>
        {pageMode !== "feedback" && <><label>{t("boardField")}<select disabled={pending} value={board} onChange={(event) => { const value = event.target.value as CommunitySection; setBoard(value); setCategory(SECTION_CATEGORIES[value].find((item) => item !== "announcements" && item !== "changelog")!); setError(""); setSignIn(false); }}>{COMMUNITY_SECTIONS.filter((value) => !pageMode || value !== "feedback").map((value) => <option key={value} value={value}>{t(`sections.${value}.name`)}</option>)}</select></label>
        <label>{t("contentTypeField")}<select disabled={pending} value={category} onChange={(event) => { setCategory(event.target.value); setError(""); setSignIn(false); }}>{SECTION_CATEGORIES[board].filter((value) => value !== "changelog" && value !== "announcements").map((value) => <option key={value} value={value}>{t(`categories.${value}`)}</option>)}</select></label></>}
        {realFeedback && <label>{c("moduleLabel")}<select disabled={pending} value={module} onChange={(event) => setModule(event.target.value as FeedbackModule)}>{FEEDBACK_MODULES.map((value) => <option key={value} value={value}>{c(`modules.${value}`)}</option>)}</select></label>}
        <label>{realFeedback ? f("titleField") : t("titleField")}<input required minLength={2} maxLength={realFeedback ? 120 : 60} disabled={pending} value={title} onChange={(event) => { setTitle(event.target.value); setSimilar([]); setSimilarQuery(""); setSimilarError(""); }} placeholder={t("titlePlaceholder")} /></label>
        {realFeedback && matchingIdeas.length > 0 && <section aria-label={c("similarHeading")}><h3>{c("similarHeading")}</h3><p>{f("similarHelp")}</p>{matchingIdeas.map((idea) => <p key={idea.id}><Link href={`/community/feedback?category=wallet&idea=${idea.id}`} onClick={() => { dialog.current?.close(); window.dispatchEvent(new CustomEvent(FEEDBACK_CHANGED, { detail: { id: idea.id } })); }}>{idea.title}</Link></p>)}</section>}
        {realFeedback && title.trim().length >= 2 && similarError && <p className={styles.searchStatus} role="status">{f("similarSearchError", { error: similarError })}</p>}
        <label>{realFeedback ? f("bodyField") : t("bodyField")}<textarea required minLength={2} maxLength={realFeedback ? 5000 : 2000} disabled={pending} rows={7} value={body} onChange={(event) => setBody(event.target.value)} placeholder={realFeedback ? c("descriptionPlaceholder") : t("bodyPlaceholder")} /></label>
        {realFeedback && <p className="community-compose-notice">{f("safety")}</p>}
        {needsLogin && <div ref={loginRegion} role="status" tabIndex={-1} className={styles.loginNotice}>{f("signInBeforePublish")}</div>}
        {error && <div ref={errorRegion} id={errorId} role="alert" tabIndex={-1} className={styles.submitError}><p>{error}</p></div>}
        <button type={needsLogin ? "button" : "submit"} onClick={needsLogin ? continueSignIn : undefined} aria-describedby={error ? errorId : undefined} disabled={pending || !needsLogin && (title.trim().length < 2 || body.trim().length < 2)} className="community-button">{pending ? f("saving") : needsLogin ? f("signInPublish") : realFeedback ? f("publish") : t("previewCta")}<span aria-hidden>↗</span></button>
      </form>}
    </div>;
  if (pageMode) return <section className="community-panel publish-form">{content}</section>;
  return <><button ref={trigger} aria-label={t("compose")} className={`community-button ${compact ? "community-compose-compact" : ""}`} type="button" onClick={() => { setPreview(false); setError(""); setSignIn(false); dialog.current?.showModal(); }}>{t("compose")}<span aria-hidden>＋</span></button>
    <dialog ref={dialog} onCancel={(event) => { if (pending) event.preventDefault(); }} aria-labelledby={dialogTitle} className="community-compose-dialog" onClose={() => trigger.current?.focus()} onClick={(event) => { if (event.target === dialog.current && !pending) dialog.current?.close(); }}>{content}</dialog></>;
}
