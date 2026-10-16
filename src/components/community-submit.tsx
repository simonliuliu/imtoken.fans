"use client";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
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
 const initial = initialSection && initialSection !== "feedback" ? initialSection : "discussion";
 const [section,setSection] = useState<CommunitySection>(initial);
 const [category,setCategory] = useState(SECTION_CATEGORIES[initial].find(c=>c!=="announcements")!);
 const [title,setTitle] = useState("");
 const [body,setBody] = useState("");
 const [error,setError] = useState("");
 const [pending,startTransition] = useTransition();
 const request = useRef<{ signature: string; id: string } | null>(null);
 function submit(e: FormEvent) {
  e.preventDefault();
  if (!userId || loading || pending) return;
  const signature=JSON.stringify({section,category,title,body});
  if(request.current?.signature!==signature) request.current={signature,id:crypto.randomUUID()};
  const id=request.current.id;
  startTransition(async()=>{
   try {
    const result=await createCommunityPost({expectedUser:userId,requestId:id,section,category,title,body});
    if(currentEpoch.current!==sessionEpoch)return;
    if(result.error)setError(result.error); else if(result.href)router.push(result.href);
   } catch { if(currentEpoch.current===sessionEpoch)setError(tr("saveFailed")); }
  });
 }
 return <div className="community-page community-submit-page" id="main-content"><div className="community-submit-shell">
  <nav className="community-breadcrumb" aria-label={tc("breadcrumb")}><Link href="/">{tc("home")}</Link><span>/</span><span>{t("postTitle")}</span></nav>
  <header className="community-submit-heading"><h1>{t("postTitle")}</h1><p>{tr("postIntro")}</p></header>
  <section className="community-submit-types" aria-label={t("typeNavigation")}><Link href="/submit/post" className="is-active">{t("postType")}</Link><Link href="/submit/feedback">{t("feedbackType")}</Link><Link href="/submit/product">{t("productType")}</Link></section>
  {loading ? <p role="status">{tc("loading")}</p> : !userId ? <Link className="community-button" href={getSignInHref(`/submit/post?section=${section}`,locale)}>{tr("signIn")}</Link> : <form className="community-panel community-submit-form" onSubmit={submit}>
   <label>{t("fields.section")}<select disabled={pending} value={section} onChange={e=>{const next=e.target.value as CommunitySection;setSection(next);setCategory(SECTION_CATEGORIES[next].find(c=>c!=="announcements")!);}}>{COMMUNITY_SECTIONS.filter(s=>s!=="feedback").map(s=><option key={s} value={s}>{tc(`sections.${s}.name`)}</option>)}</select></label>
   <label>{t("fields.category")}<select disabled={pending} value={category} onChange={e=>setCategory(e.target.value)}>{SECTION_CATEGORIES[section].filter(c=>c!=="announcements").map(c=><option key={c} value={c}>{tc(`categories.${c}`)}</option>)}</select></label>
   <label>{t("fields.title")}<input disabled={pending} required minLength={2} maxLength={80} value={title} onChange={e=>setTitle(e.target.value)} /></label>
   <label>{t("fields.body")}<textarea disabled={pending} required minLength={10} maxLength={5000} rows={8} value={body} onChange={e=>setBody(e.target.value)} /></label>
   <div className="community-submit-privacy"><strong>{t("privacyTitle")}</strong><p>{t("privacyBody")}</p></div>
   {error && <p role="alert">{error}</p>}<button className="community-button" disabled={pending || title.trim().length<2 || body.trim().length<10}>{tr(pending?"saving":"publish")}</button>
  </form>}
 </div></div>;
}
