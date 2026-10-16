"use client";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { clearFeedbackDraft, saveFeedbackDraft, takeFeedbackDraft } from "@/lib/feedback-drafts";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth-context";
import { getSignInHref } from "@/lib/auth-navigation";
import { createCommunityPost } from "@/app/actions/community";
import { COMMUNITY_SECTIONS, SECTION_CATEGORIES, type CommunitySection } from "@/lib/community-demo";
export function CommunitySubmit({ initialSection }: { mode?: "post" | "feedback"; initialSection?: CommunitySection }) {
 const t = useTranslations("communitySubmit");
 const tc = useTranslations("community");
 const tr = useTranslations("communityReal");
 const locale = useLocale();
 const router = useRouter();
 const { user, loading, sessionEpoch } = useAuth();
 const epoch = useRef(sessionEpoch);
 useEffect(() => { epoch.current = sessionEpoch; return () => { epoch.current = -1; }; }, [sessionEpoch]);
 return <PostForm key={`${user?.id ?? "guest"}:${sessionEpoch}`} initialSection={initialSection} userId={user?.id} loading={loading} currentEpoch={epoch} sessionEpoch={sessionEpoch} t={t} tc={tc} tr={tr} locale={locale} router={router} />;
}
function PostForm({ initialSection, userId, loading, currentEpoch, sessionEpoch, t, tc, tr, locale, router }: {
 initialSection?: CommunitySection; userId?: string; loading: boolean; currentEpoch: { current: number }; sessionEpoch: number;
 t: ReturnType<typeof useTranslations>; tc: ReturnType<typeof useTranslations>; tr: ReturnType<typeof useTranslations>; locale: string; router: ReturnType<typeof useRouter>;
}) {
 const params = useSearchParams();
 const [draftReady, setDraftReady] = useState(false);
 const [signInRequired, setSignInRequired] = useState(false);
 const inFlight = useRef(false);
 const initial = initialSection && initialSection !== "feedback" ? initialSection : "discussion";
 const [section,setSection] = useState<CommunitySection>(initial);
 const [category,setCategory] = useState(SECTION_CATEGORIES[initial].find(c=>c!=="announcements")!);
 const [title,setTitle] = useState("");
 const [body,setBody] = useState("");
 const [error,setError] = useState("");
 const [pending,startTransition] = useTransition();
 const request = useRef<{ signature: string; id: string } | null>(null);
 useEffect(() => {
  if (loading) return;
  const timer = window.setTimeout(() => {
   try {
    const saved = takeFeedbackDraft<{ section: CommunitySection; category: string; title: string; body: string; request: typeof request.current }>("post", userId ?? null, params.get("resume") === "1");
    if (saved && COMMUNITY_SECTIONS.includes(saved.section) && saved.section !== "feedback" && SECTION_CATEGORIES[saved.section].includes(saved.category) && saved.category !== "announcements" && typeof saved.title === "string" && typeof saved.body === "string") {
     setSection(saved.section); setCategory(saved.category); setTitle(saved.title); setBody(saved.body); request.current = saved.request;
    }
   } catch { setError(tr("draftUnavailable")); }
   setDraftReady(true);
  }, 0);
  return () => window.clearTimeout(timer);
 // A login handoff is claimed once per account/session mount.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [loading, userId]);
 useEffect(() => {
  if (!draftReady) return;
  try { saveFeedbackDraft("post", userId ?? null, {section, category, title, body, request: request.current}); }
  catch { /* The form remains usable; an explicit login handoff reports storage failure. */ }
 }, [draftReady, userId, section, category, title, body]);
 function continueSignIn() {
  try { saveFeedbackDraft("post", userId ?? null, {section, category, title, body, request: request.current}); }
  catch { setError(tr("draftUnavailable")); return; }
  router.push(getSignInHref(`/submit/post?section=${section}&resume=1`,locale));
 }
 const needsLogin = !userId || signInRequired;
 function submit(e: FormEvent) {
  e.preventDefault();
  if (loading || pending || inFlight.current || !draftReady) return;
  if (needsLogin) { continueSignIn(); return; }
  if (title.trim().length < 2 || body.trim().length < 10) { setError(tr("postRequirements")); return; }
  inFlight.current = true; setError("");
  const signature=JSON.stringify({section,category,title,body});
  startTransition(async()=>{
   try {
    if(request.current?.signature!==signature) request.current={signature,id:crypto.randomUUID()};
    const id=request.current.id;
    try { saveFeedbackDraft("post", userId ?? null, {section, category, title, body, request: request.current}); } catch { /* Submission can proceed; in-memory request remains stable. */ }
    const result=await createCommunityPost({expectedUser:userId!,requestId:id,section,category,title,body});
    if(currentEpoch.current!==sessionEpoch)return;
    if(result.error) { setError(result.error); setSignInRequired(result.code === "sign_in"); }
    else if(result.href) { try { clearFeedbackDraft("post", userId ?? null); } catch {} router.push(result.href); }
   } catch { if(currentEpoch.current===sessionEpoch)setError(tr("saveFailed")); }
   finally { inFlight.current = false; }
  });
 }
 return <div className="community-page community-submit-page" id="main-content"><div className="community-submit-shell">
  <nav className="community-breadcrumb" aria-label={tc("breadcrumb")}><Link href="/">{tc("home")}</Link><span>/</span><span>{t("postTitle")}</span></nav>
  <header className="community-submit-heading"><h1>{t("postTitle")}</h1><p>{tr("postIntro")}</p></header>
  <section className="community-submit-types" aria-label={t("typeNavigation")}><Link href="/submit/post" className="is-active">{t("postType")}</Link><Link href="/submit/feedback">{t("feedbackType")}</Link><Link href="/submit/product">{t("productType")}</Link></section>
  {loading ? <p role="status">{tc("loading")}</p> : <form className="community-panel community-submit-form" onSubmit={submit} aria-busy={pending}>
   <label>{t("fields.section")}<select disabled={pending} value={section} onChange={e=>{const next=e.target.value as CommunitySection;setSection(next);setCategory(SECTION_CATEGORIES[next].find(c=>c!=="announcements")!);}}>{COMMUNITY_SECTIONS.filter(s=>s!=="feedback").map(s=><option key={s} value={s}>{tc(`sections.${s}.name`)}</option>)}</select></label>
   <label>{t("fields.category")}<select disabled={pending} value={category} onChange={e=>setCategory(e.target.value)}>{SECTION_CATEGORIES[section].filter(c=>c!=="announcements").map(c=><option key={c} value={c}>{tc(`categories.${c}`)}</option>)}</select></label>
   <label>{t("fields.title")}<input disabled={pending} required minLength={2} maxLength={80} value={title} onChange={e=>setTitle(e.target.value)} /></label>
   <label>{t("fields.body")}<textarea disabled={pending} required minLength={10} maxLength={5000} rows={8} value={body} onChange={e=>setBody(e.target.value)} /></label>
   <div className="community-submit-privacy"><strong>{t("privacyTitle")}</strong><p>{t("privacyBody")}</p></div>
   <p className="community-local-status">{tr("postRequirements")}</p>
   {needsLogin && <p role="status">{tr("signInAgain")}</p>}
   {error && <p role="alert">{error}</p>}<button type={needsLogin ? "button" : "submit"} onClick={needsLogin ? continueSignIn : undefined} className="community-button" disabled={pending || !draftReady}>{tr(pending ? "saving" : needsLogin ? "signInPublish" : "publish")}</button>
  </form>}
 </div></div>;
}
