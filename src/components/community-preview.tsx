"use client";

import Image from "next/image";
import { Fragment, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { DEMO_POSTS, SECTION_CATEGORIES, hasDemoSupport, compareDemoPopularity, demoSeedComments, type DemoComment, type CommunitySection, type DemoPost } from "@/lib/community-demo";
import { LevelBadge } from "@/components/level-badge";
import { Avatar } from "@/components/avatar";
import { TokenPersonasCard } from "@/components/token-personas-card";
import { CommunityGlyph, ComposeDemoButton } from "@/components/community-elements";

type SortMode = "recommended" | "latest" | "popular";
const SORTS: SortMode[] = ["recommended", "latest", "popular"];
const SPOTLIGHT_IDS = ["fake-support-message", "weekend-conversation", "ai-explainer"];
function postHref(post: DemoPost) { return `/community/${post.section}/${post.id}`; }

function SortTabs({ value, onChange }: { value: SortMode; onChange: (value: SortMode) => void }) {
  const t = useTranslations("community");
  function handleKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
    onChange(SORTS[next]);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[next].focus();
  }
  return <div className="community-tabs" role="tablist" aria-label={t("sortLabel")}>{SORTS.map((sort, index) => <button type="button" role="tab" aria-selected={value === sort} tabIndex={value === sort ? 0 : -1} key={sort} onClick={() => onChange(sort)} onKeyDown={(event) => handleKey(event, index)}>{t(`sort.${sort}`)}</button>)}</div>;
}

function PostRow({ post }: { post: DemoPost }) {
  const t = useTranslations("community");
  const format = useFormatter();
  return <Link href={postHref(post)} className="community-post-row"><div className="community-post-main"><div className="community-post-author"><Avatar name={t(`authors.${post.author}`)} className={`community-avatar community-avatar-${post.author}`} /><span>{t(`authors.${post.author}`)}</span><LevelBadge level={post.level} size="xs" showIcon={false} /><span className="community-post-location">· {t(`sections.${post.section}.name`)} › {t(`categories.${post.category}`)}</span></div><h2>{t(`posts.${post.id}.title`)}</h2><p className="community-post-excerpt">{t(`posts.${post.id}.excerpt`)}</p><div className="community-post-meta"><time dateTime={post.createdAt}>{format.dateTime(new Date(post.createdAt), { month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time><span>{t("commentCount", { count: post.commentCount })}</span><span>{t("likeCount", { count: post.likes })}</span>{hasDemoSupport(post) && <span>{t("supportCount", { count: post.votes })}</span>}</div></div></Link>;
}

function PopularPosts({ section, exclude }: { section?: CommunitySection; exclude?: string }) {
  const t = useTranslations("community");
  const posts = DEMO_POSTS.filter((post) => (!section || post.section === section) && post.id !== exclude).sort(compareDemoPopularity).slice(0, 5);
  return <section className="community-panel"><div className="community-panel-heading"><h2>{t("popularTitle")}</h2></div><ol className="community-popular-list">{posts.map((post, index) => <li key={post.id}><span aria-hidden>{index + 1}</span><Link href={postHref(post)}>{t(`posts.${post.id}.title`)}</Link></li>)}</ol></section>;
}

function SafetyNote({ inline = false }: { inline?: boolean }) {
  const t = useTranslations("community");
  return <section className={`community-panel community-safety-note ${inline ? "community-inline-safety" : ""}`}><h2>{t("safetyTitle")}</h2><ul><li>{t("safetyTip1")}</li><li>{t("safetyTip2")}</li><li>{t("safetyTip3")}</li></ul><Link href="/community/safety/approval-checklist">{t("viewGuide")} <span aria-hidden>›</span></Link></section>;
}

function ParticipationCard() {
  const t = useTranslations("community");
  return <section className="community-panel community-participation"><h2>{t("participate")}</h2><ComposeDemoButton /><Link href="/activities">{t("goCheckin")} <span aria-hidden>↗</span></Link></section>;
}

function HomeSpotlight() {
  const t = useTranslations("community");
  const [active, setActive] = useState(0);
  const [batch, setBatch] = useState(0);
  const slides = SPOTLIGHT_IDS.map((id) => DEMO_POSTS.find((post) => post.id === id)!);
  const post = slides[active];
  const banner = ["safety", "conversation", "builds"][active];
  const ranked = [...DEMO_POSTS].sort(compareDemoPopularity);
  const popular = Array.from({ length: 6 }, (_, index) => ranked[batch * 6 + index]);
  function move(step: number) { setActive((value) => (value + step + slides.length) % slides.length); }
  return <div className="community-spotlight"><section className={`community-carousel community-carousel-${active}`} role="region" aria-roledescription={t("carouselRole")} aria-label={t("carouselTitle")} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowRight" ? 1 : -1); } }}><div className="community-carousel-art"><Image src={`/images/community-banners/${banner}.png`} alt="" fill sizes="(max-width: 767px) 100vw, (max-width: 1023px) 50vw, 480px" /></div><div className="community-carousel-top"><span>{t(`categories.${post.category}`)}</span></div><Link href={postHref(post)} className="community-carousel-link"><h1>{t(`posts.${post.id}.title`)}</h1><p>{t(`posts.${post.id}.excerpt`)}</p><span className="community-carousel-cta">{t("readMore")} <span aria-hidden>↗</span></span></Link><div className="community-carousel-controls"><button type="button" onClick={() => move(-1)} aria-label={t("previousSlide")}>←</button><div className="community-carousel-dots">{slides.map((slide, index) => <button type="button" key={slide.id} aria-label={t("goToSlide", { index: index + 1 })} aria-current={index === active ? "true" : undefined} onClick={() => setActive(index)}><span /></button>)}</div><span className="sr-only" aria-live="polite">{t("slidePosition", { index: active + 1, count: slides.length })}</span><button type="button" onClick={() => move(1)} aria-label={t("nextSlide")}>→</button></div></section><section className="community-panel community-home-popular"><div className="community-panel-heading"><h2>{t("popularTitle")}</h2><button type="button" onClick={() => setBatch((value) => 1 - value)}>{t("refreshPopular")}</button></div><ol className="community-popular-list">{popular.map((item, index) => <li key={item.id}><span aria-hidden>{batch * 6 + index + 1}</span><Link href={postHref(item)}>{t(`posts.${item.id}.title`)}</Link></li>)}</ol></section></div>;
}

function DemoFeed({ section, productsContent, initialCategory = "all", onCategoryChange }: { section?: CommunitySection; productsContent?: ReactNode; initialCategory?: string; onCategoryChange?: (category: string) => void }) {
  const t = useTranslations("community");
  const [sort, setSort] = useState<SortMode>(section ? "latest" : "recommended");
  const [category, setCategory] = useState(() => section && SECTION_CATEGORIES[section].includes(initialCategory) ? initialCategory : "all");
  const [status, setStatus] = useState("all");
  const [visible, setVisible] = useState(8);
  const showProducts = section === "feedback" && category === "builds";
  function changeCategory(next: string) {
    setCategory(next);
    onCategoryChange?.(next);
    setStatus("all");
    setVisible(8);
    if (section) {
      const url = new URL(window.location.href);
      if (next === "all") url.searchParams.delete("category");
      else url.searchParams.set("category", next);
      window.history.replaceState(null, "", url);
    }
  }
  const filtered = DEMO_POSTS.filter((post) => (!section || post.section === section) && (category === "all" || post.category === category) && (status === "all" || post.status === status) && (sort !== "recommended" || post.featured === true)).sort((a, b) => sort === "popular" ? compareDemoPopularity(a, b) : b.createdAt.localeCompare(a.createdAt));
  return <div className={`community-layout ${section === "discussion" ? "community-discussion-layout" : section ? "" : "community-home-layout"}`}>
    <section className={showProducts ? undefined : "community-panel community-feed-panel"} style={showProducts ? { gridColumn: "1 / -1" } : undefined} aria-label={t("feedLabel")}>
      {!showProducts && <div className="community-feed-heading"><SortTabs value={sort} onChange={(next) => { setSort(next); setVisible(8); }} /><span>{t("exampleCount", { count: filtered.length })}</span></div>}
      {section && <div className={`community-filter-row${showProducts ? " community-panel" : ""}`} style={showProducts ? { paddingInline: 16, marginBottom: 20 } : undefined} aria-label={t("categoryFilter")}>
        <button type="button" aria-pressed={category === "all"} onClick={() => changeCategory("all")}>{t("all")}</button>
        {SECTION_CATEGORIES[section].map((value) => <button key={value} type="button" aria-pressed={category === value} onClick={() => changeCategory(value)}>{t(`categories.${value}`)}</button>)}
      </div>}
      {/* Keep the explorer mounted so switching forum categories preserves its filters. */}
      {section === "feedback" && <div hidden={!showProducts} style={!showProducts ? { display: "none" } : undefined}>{productsContent}</div>}
      {!showProducts && <>
        {section === "feedback" && category === "wallet" && <div className="community-filter-row community-status-filter" aria-label={t("statusFilter")}><span>{t("statusFilter")}</span>{["all", "pending", "discussion", "recorded"].map((value) => <button key={value} type="button" aria-pressed={status === value} onClick={() => { setStatus(value); setVisible(8); }}>{value === "all" ? t("all") : t(`states.${value}`)}</button>)}</div>}
        {filtered.length ? <div>{filtered.slice(0, visible).map((post, index) => <Fragment key={post.id}><PostRow post={post} />{index === 3 && !section && <SafetyNote inline />}</Fragment>)}</div> : <div className="community-empty"><CommunityGlyph section={section ?? "discussion"} /><h2>{t("empty")}</h2><button type="button" className="community-button community-button-outline" onClick={() => { changeCategory("all"); setSort("latest"); }}>{t("showAll")}</button></div>}
        {filtered.length > visible && <button type="button" className="community-load-more" onClick={() => setVisible((count) => count + 8)}>{t("loadMore")}<span aria-hidden>↓</span></button>}
      </>}
    </section>
    {!showProducts && <aside className={`community-sidebar community-simple-sidebar ${!section || section === "discussion" ? "community-personas-sidebar" : ""}`}>{!section || section === "discussion" ? <TokenPersonasCard /> : <ParticipationCard />}<SafetyNote /></aside>}
  </div>;
}

export function CommunityHome() {
  return <div className="community-page community-home" id="main-content" tabIndex={-1}><div className="community-shell"><HomeSpotlight /><DemoFeed /></div></div>;
}

export function CommunityBoard({ section, productsContent, initialCategory }: { section: CommunitySection; productsContent?: ReactNode; initialCategory?: string }) {
  const t = useTranslations("community");
  const [category, setCategory] = useState(initialCategory ?? "all");
  const showProducts = section === "feedback" && category === "builds";
  return <div className="community-page" id="main-content" tabIndex={-1}><div className="community-shell"><nav className="community-breadcrumb" aria-label={t("breadcrumb")}><Link href="/">{t("home")}</Link><span aria-hidden>/</span><span>{t(`sections.${section}.name`)}</span></nav><div className="community-board-heading"><span className={`community-entry-icon community-entry-${section}`}><CommunityGlyph section={section} /></span><div><h1>{t(`sections.${section}.name`)}</h1><p>{t(`sections.${section}.description`)}</p></div>{!showProducts && <ComposeDemoButton section={section} />}</div><DemoFeed section={section} productsContent={productsContent} initialCategory={initialCategory} onCategoryChange={setCategory} /></div></div>;
}

function DemoComments({ post, onCountChange }: { post: DemoPost; onCountChange: (count: number) => void }) {
  const t = useTranslations("community");
  const [comments, setComments] = useState<DemoComment[]>(() => demoSeedComments(post));
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [sort, setSort] = useState<"popular" | "latest">("popular");
  const [liked, setLiked] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  function submit(event: FormEvent) {
    event.preventDefault(); if (!body.trim()) return;
    setComments((previous) => [...previous, { id: `local-${previous.length}`, body: body.trim(), author: "you", level: 2, likes: 0, order: previous.length + 1, parent: replyTo ?? undefined, local: true }]);
    onCountChange(comments.length + 1);
    setBody(""); setReplyTo(null); setAnnouncement(t("commentAdded"));
  }
  function toggleLike(id: string) { setLiked((previous) => previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]); setAnnouncement(t("localInteraction")); }
  function renderComment(comment: DemoComment, reply = false) {
    return <div className={`community-comment ${reply ? "community-comment-reply" : ""}`} key={comment.id}><Avatar name={t(`authors.${comment.author}`)} className={`community-avatar community-avatar-${comment.author}`} /><div className="community-comment-content"><div className="community-comment-author"><strong>{t(`authors.${comment.author}`)}</strong><LevelBadge level={comment.level} size="xs" showIcon={false} />{comment.local && <span>{t("justNow")}</span>}</div><p>{comment.local ? comment.body : t(`comments.${comment.body}`)}</p><div className="community-comment-actions"><button type="button" aria-pressed={liked.includes(comment.id)} onClick={() => toggleLike(comment.id)}>{liked.includes(comment.id) ? "♥" : "♡"} {t("likeCount", { count: comment.likes + Number(liked.includes(comment.id)) })}</button><button type="button" onClick={() => { setReplyTo(comment.parent ?? comment.id); input.current?.focus(); }}>{t("reply")}</button></div>{!reply && comments.filter((item) => item.parent === comment.id).map((item) => renderComment(item, true))}</div></div>;
  }
  return <section className="community-panel community-comments" id="comments"><div className="community-panel-heading"><h2>{t("commentsTitle", { count: comments.length })}</h2><div className="community-comment-sort"><button type="button" aria-pressed={sort === "popular"} onClick={() => setSort("popular")}>{t("sort.popular")}</button><button type="button" aria-pressed={sort === "latest"} onClick={() => setSort("latest")}>{t("sort.latest")}</button></div></div><form onSubmit={submit}>{replyTo && <div className="community-reply-target">{t("replyingTo", { name: t(`authors.${comments.find((comment) => comment.id === replyTo)?.author ?? "you"}`) })}<button type="button" onClick={() => setReplyTo(null)}>{t("cancelReply")}</button></div>}<label className="sr-only" htmlFor="demo-comment-body">{t("commentPlaceholder")}</label><textarea id="demo-comment-body" ref={input} maxLength={1000} rows={3} value={body} onChange={(event) => setBody(event.target.value)} placeholder={t("commentPlaceholder")} /><div className="community-comment-submit"><button type="submit" className="community-button" disabled={!body.trim()}>{replyTo ? t("addReply") : t("addComment")}</button></div></form>{announcement && <p className="community-local-status" role="status">{announcement}</p>}<div className="community-comment-list">{comments.filter((comment) => !comment.parent).sort((a, b) => sort === "latest" ? b.order - a.order : (b.likes + Number(liked.includes(b.id))) - (a.likes + Number(liked.includes(a.id)))).map((comment) => renderComment(comment))}</div></section>;
}

export function CommunityPost({ post }: { post: DemoPost }) {
  const t = useTranslations("community");
  const format = useFormatter();
  const [liked, setLiked] = useState(false);
  const [supported, setSupported] = useState(false);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  const [interactionStatus, setInteractionStatus] = useState("");
  function toggleLike() { setLiked((value) => !value); setInteractionStatus(t("localInteraction")); }
  function toggleSupport() { setSupported((value) => !value); setInteractionStatus(t("localInteraction")); }
  const related = DEMO_POSTS.filter((item) => item.section === post.section && item.id !== post.id).slice(0, 3);
  const jumpTo = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); if (id === "comments") document.getElementById("demo-comment-body")?.focus({ preventScroll: true }); };
  return <div className="community-page community-detail-page" id="main-content" tabIndex={-1}><div className="community-shell"><nav className="community-breadcrumb" aria-label={t("breadcrumb")}><Link href="/">{t("home")}</Link><span aria-hidden>/</span><Link href={`/community/${post.section}`}>{t(`sections.${post.section}.name`)}</Link><span aria-hidden>/</span><span>{t(`categories.${post.category}`)}</span></nav><div className="community-layout"><div className="community-detail-main"><article className="community-panel community-article"><div className="community-post-labels"><span className="community-category">{t(`categories.${post.category}`)}</span>{post.status && <span className={`community-state community-state-${post.status}`}>{t(`states.${post.status}`)}</span>}</div><h1>{t(`posts.${post.id}.title`)}</h1><div className="community-article-author"><Avatar name={t(`authors.${post.author}`)} className={`community-avatar community-avatar-${post.author}`} /><strong>{t(`authors.${post.author}`)}</strong><LevelBadge level={post.level} showIcon={false} /><time dateTime={post.createdAt}>{format.dateTime(new Date(post.createdAt), { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time></div><div className="community-article-body"><p className="community-article-lede">{t(`posts.${post.id}.excerpt`)}</p>{["body1", "body2", "body3"].map((key) => <p key={key}>{t(`posts.${post.id}.${key}`)}</p>)}{hasDemoSupport(post) && <section id="demo-poll" className="community-poll" aria-labelledby="support-title"><h2 id="support-title">{t(post.category === "builds" ? "supportBuild" : "supportFeedback")}</h2><button type="button" aria-pressed={supported} onClick={toggleSupport}><span>{t(supported ? "supported" : "support")}</span><strong>{format.number(post.votes + Number(supported))}</strong></button><p aria-live="polite">{t("supportCount", { count: post.votes + Number(supported) })}</p></section>}</div><div className="community-detail-actions"><button type="button" aria-pressed={liked} onClick={toggleLike}>{liked ? "♥" : "♡"} {t("likeCount", { count: post.likes + Number(liked) })}</button><button type="button" onClick={() => jumpTo("comments")}>{t("commentCount", { count: commentCount })}</button>{hasDemoSupport(post) && <button type="button" onClick={() => jumpTo("demo-poll")}>{t("support")}</button>}</div>{interactionStatus && <p className="community-local-status" role="status">{interactionStatus}</p>}<p className="sr-only" aria-live="polite">{t("likeCount", { count: post.likes + Number(liked) })}</p></article><DemoComments post={post} onCountChange={setCommentCount} /></div><aside className="community-sidebar"><section className="community-panel community-author-card"><Avatar name={t(`authors.${post.author}`)} className={`community-avatar community-avatar-${post.author}`} /><h2>{t(`authors.${post.author}`)}</h2><LevelBadge level={post.level} showName /><div><strong>{t("authorPostCount", { count: DEMO_POSTS.filter((item) => item.author === post.author).length })}</strong></div><Link href={`/community/${post.section}`}>{t("backToBoard")}<span aria-hidden>↗</span></Link></section><PopularPosts section={post.section} exclude={post.id} /></aside></div><section className="community-panel community-related"><div className="community-panel-heading"><h2>{t("related")}</h2><Link href={`/community/${post.section}`}>{t("backToBoard")} ↗</Link></div>{related.map((item) => <PostRow key={item.id} post={item} />)}</section></div><div className="community-mobile-actions"><button type="button" aria-pressed={liked} onClick={toggleLike}>{liked ? "♥" : "♡"} {t("likeCount", { count: post.likes + Number(liked) })}</button><button type="button" onClick={() => jumpTo("comments")}>{t("commentCount", { count: commentCount })}</button>{hasDemoSupport(post) && <button type="button" onClick={() => jumpTo("demo-poll")}>{t("support")}</button>}</div></div>;
}
