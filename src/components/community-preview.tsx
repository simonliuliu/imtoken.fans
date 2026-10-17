"use client";

import Image from "next/image";
import { FEEDBACK_CHANGED } from "@/lib/feedback";
import { CoCreationFeedContext } from "@/components/co-creation-feed-context";
import { CooperationPreview } from "@/components/cooperation-preview";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { SECTION_CATEGORIES, compareDemoPopularity, type CommunitySection, type DemoPost } from "@/lib/community-demo";
import { LevelBadge } from "@/components/level-badge";
import { Avatar } from "@/components/avatar";
import { TokenPersonasCard } from "@/components/token-personas-card";
import { CommunityGlyph } from "@/components/community-elements";

type SortMode = "recommended" | "latest" | "popular";
const SORTS: SortMode[] = ["recommended", "latest", "popular"];
const SPOTLIGHT_IDS = ["fake-support-message", "weekend-conversation", "ai-explainer"];
function postHref(post: DemoPost) { return `/community/${post.section}/${post.id}`; }

export function SortTabs({ value, onChange }: { value: SortMode; onChange: (value: SortMode) => void }) {
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

export function PostRow({ post }: { post: DemoPost }) {
  const t = useTranslations("community");
  const format = useFormatter();
  return <Link href={postHref(post)} className="community-post-row"><div className="community-post-main"><div className="community-post-author"><Avatar name={post.author} className={`community-avatar community-avatar-${post.author}`} /><span>{post.author}</span>{post.isExample ? <span className="community-demo-label">{t("realExample")}</span> : <LevelBadge level={post.level} size="xs" showIcon={false} />}<span className="community-post-location">· {t(`sections.${post.section}.name`)} › {t(`categories.${post.category}`)}</span></div><h2>{post.title ?? t(`posts.${post.id}.title`)}</h2><p className="community-post-excerpt">{post.excerpt ?? t(`posts.${post.id}.excerpt`)}</p><div className="community-post-meta"><time dateTime={post.createdAt}>{format.dateTime(new Date(post.createdAt), { month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time><span>{t("commentCount", { count: post.commentCount })}</span><span>{t("likeCount", { count: post.likes })}</span></div></div></Link>;
}

function HomeSpotlight({ posts }: { posts: DemoPost[] }) {
  const t = useTranslations("community");
  const [active, setActive] = useState(0);
  const [batch, setBatch] = useState(0);
  const slides = SPOTLIGHT_IDS.map((id) => posts.find((post) => post.id === id)).filter((post): post is DemoPost => Boolean(post));
  const post = slides[active];
  const banner = ["safety", "conversation", "builds"][active];
  if (!post) return null;
  const ranked = [...posts].sort(compareDemoPopularity);
  const popular = ranked.slice(batch * 6, batch * 6 + 6);
  function move(step: number) { setActive((value) => (value + step + slides.length) % slides.length); }
  return <div className="community-spotlight"><section className={`community-carousel community-carousel-${active}`} role="region" aria-roledescription={t("carouselRole")} aria-label={t("carouselTitle")} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowRight" ? 1 : -1); } }}><div className="community-carousel-art"><Image src={`/images/community-banners/${banner}.png`} alt="" fill sizes="(max-width: 767px) 100vw, (max-width: 1023px) 50vw, 480px" /></div><div className="community-carousel-top"><span>{t(`categories.${post.category}`)}</span></div><Link href={postHref(post)} className="community-carousel-link"><h1>{post.title ?? t(`posts.${post.id}.title`)}</h1><p>{post.excerpt ?? t(`posts.${post.id}.excerpt`)}</p><span className="community-carousel-cta">{t("readMore")} <span aria-hidden>↗</span></span></Link><div className="community-carousel-controls"><button type="button" onClick={() => move(-1)} aria-label={t("previousSlide")}>←</button><div className="community-carousel-dots">{slides.map((slide, index) => <button type="button" key={slide.id} aria-label={t("goToSlide", { index: index + 1 })} aria-current={index === active ? "true" : undefined} onClick={() => setActive(index)}><span /></button>)}</div><span className="sr-only" aria-live="polite">{t("slidePosition", { index: active + 1, count: slides.length })}</span><button type="button" onClick={() => move(1)} aria-label={t("nextSlide")}>→</button></div></section><section className="community-panel community-home-popular"><div className="community-panel-heading"><h2>{t("popularTitle")}</h2><button type="button" onClick={() => setBatch((value) => 1 - value)}>{t("refreshPopular")}</button></div><ol className="community-popular-list">{popular.map((item, index) => <li key={item.id}><span aria-hidden>{batch * 6 + index + 1}</span><Link href={postHref(item)}>{item.title ?? t(`posts.${item.id}.title`)}</Link></li>)}</ol></section></div>;
}

function DemoFeed({ posts, section, productsContent, initialCategory = "all", initialId = null, onCategoryChange }: { posts: DemoPost[]; section?: CommunitySection; productsContent?: ReactNode; initialCategory?: string; initialId?: string | null; onCategoryChange?: (category: string) => void }) {
  const t = useTranslations("community");
  const [sort, setSort] = useState<SortMode>("latest");
  const [category, setCategory] = useState(() => section && SECTION_CATEGORIES[section].includes(initialCategory) ? initialCategory : "all");
  const [visible, setVisible] = useState(8);
  const showProducts = section === "feedback" && category === "builds";
  const showFeedback = section === "feedback" && category === "wallet";
  useEffect(() => {
    if (section !== "feedback") return;
    const changed = () => { setCategory("wallet"); onCategoryChange?.("wallet"); };
    window.addEventListener(FEEDBACK_CHANGED, changed);
    return () => window.removeEventListener(FEEDBACK_CHANGED, changed);
  }, [section, onCategoryChange]);
  function changeCategory(next: string) {
    setCategory(next);
    onCategoryChange?.(next);
    setVisible(8);
    if (section) {
      const url = new URL(window.location.href);
      if (next === "all") url.searchParams.delete("category");
      else url.searchParams.set("category", next);
      window.history.replaceState(null, "", url);
    }
  }
  const filtered = posts.filter((post) => !(post.section === "feedback" && (post.category === "wallet" || (section === "feedback" && post.category === "builds"))) && (!section || post.section === section) && (category === "all" || post.category === category) && (sort !== "recommended" || post.featured === true)).sort((a, b) => sort === "popular" ? compareDemoPopularity(a, b) : b.createdAt.localeCompare(a.createdAt));
  const hasSidebar = !section || section === "discussion";
  return <div className={`community-layout ${hasSidebar ? section ? "community-discussion-layout" : "community-home-layout" : "community-board-layout"}`}>
    <section className="community-panel community-feed-panel" aria-label={t("feedLabel")}>
      {section && <div className="community-filter-row community-category-tabs" aria-label={t("categoryFilter")}>
        <button type="button" aria-pressed={category === "all"} onClick={() => changeCategory("all")}>{t("all")}</button>
        {SECTION_CATEGORIES[section].map((value) => <button key={value} type="button" aria-pressed={category === value} onClick={() => changeCategory(value)}>{t(`categories.${value}`)}</button>)}
      </div>}
      <div className="community-feed-heading"><SortTabs value={sort} onChange={(next) => { setSort(next); setVisible(8); }} />{section !== "feedback" && <span>{t("postCount", { count: filtered.length })}</span>}</div>
      <CoCreationFeedContext.Provider value={{ sort, category }}>
        {section === "feedback" && <>
          <div hidden={category !== "all" && !showFeedback}><CooperationPreview embedded initialId={initialId} sort={sort} overview={category === "all"} onOpen={() => changeCategory("wallet")} /></div>
          <div hidden={category !== "all" && !showProducts}>{productsContent}</div>
        </>}
        {!showProducts && !showFeedback && <>
          {section === "feedback" && category === "all" && <h2 className="border-b border-line py-4 text-sm font-semibold text-muted">{t("categories.changelog")}</h2>}
          {filtered.length ? <div>{filtered.slice(0, visible).map((post) => <PostRow key={post.id} post={post} />)}</div> : <div className="community-empty"><CommunityGlyph section={section ?? "discussion"} /><h2>{t("empty")}</h2><button type="button" className="community-button community-button-outline" onClick={() => { changeCategory("all"); setSort("latest"); }}>{t("showAll")}</button></div>}
          {filtered.length > visible && <button type="button" className="community-load-more" onClick={() => setVisible((count) => count + 8)}>{t("loadMore")}<span aria-hidden>↓</span></button>}
        </>}
      </CoCreationFeedContext.Provider>
    </section>
    {hasSidebar && !showProducts && <aside className="community-sidebar community-simple-sidebar community-personas-sidebar"><TokenPersonasCard external={!section} /></aside>}
  </div>;
}

export function CommunityHome({ posts }: { posts: DemoPost[] }) {
  return <div className="community-page community-home" id="main-content" tabIndex={-1}><div className="community-shell"><HomeSpotlight posts={posts} /><DemoFeed posts={posts} /></div></div>;
}

export function CommunityBoard({ posts, section, productsContent, initialCategory, initialId = null }: { posts: DemoPost[]; section: CommunitySection; productsContent?: ReactNode; initialCategory?: string; initialId?: string | null }) {
  const t = useTranslations("community");
  return <div className="community-page" id="main-content" tabIndex={-1}><div className="community-shell"><nav className="community-breadcrumb" aria-label={t("breadcrumb")}><Link href="/">{t("home")}</Link><span aria-hidden>/</span><span aria-current="page">{t(`sections.${section}.name`)}</span></nav><h1 className="sr-only">{t(`sections.${section}.name`)}</h1><DemoFeed posts={posts} section={section} productsContent={productsContent} initialCategory={initialCategory} initialId={initialId} /></div></div>;
}
