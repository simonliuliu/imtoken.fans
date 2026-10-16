"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth-context";
import { getSignInHref } from "@/lib/auth-navigation";
import { setCommunityLike } from "@/app/actions/community";
import { LevelBadge } from "@/components/level-badge";
import { CommentSection } from "@/components/comment-section";
import type { DemoPost } from "@/lib/community-demo";
import type { CommentWithAuthor } from "@/lib/types";
type Props = { post: DemoPost; comments: CommentWithAuthor[]; viewerLiked: boolean; canModerate: boolean; serverViewerId: string | null };
export function CommunityPost(props: Props) {
  const { user, sessionEpoch } = useAuth();
  return <CommunityPostBody key={`${user?.id ?? "guest"}:${sessionEpoch}`} {...props} />;
}
function CommunityPostBody({ post, comments, viewerLiked, canModerate, serverViewerId }: Props) {
  const locale = useLocale();
  const t = useTranslations("community");
  const tr = useTranslations("communityReal");
  const format = useFormatter();
  const { user, loading, sessionEpoch } = useAuth();
  const epoch = useRef(sessionEpoch);
 useEffect(() => { epoch.current = sessionEpoch; return () => { epoch.current = -1; }; }, [sessionEpoch]);
  const initialLiked = user?.id === serverViewerId && viewerLiked;
  const [liked, setLiked] = useState(initialLiked);
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  const pathname = `/community/${post.section}/${post.id}`;
  function like() {
    if (!user || !post.submissionId) return;
    const started = sessionEpoch;
    startTransition(async () => {
      try {
        const result = await setCommunityLike(user.id, post.submissionId!, !liked);
        if (epoch.current !== started) return;
        if (result.error) setNotice(result.error); else { setLiked(!liked); setNotice(""); }
      } catch { if (epoch.current === started) setNotice(tr("saveFailed")); }
    });
  }
  if (post.moderationStatus !== "published" && user?.id !== post.authorId && !(canModerate && user?.id === serverViewerId)) return <p role="status">{tr("privateContent")}</p>;
  return <div className="community-page community-detail-page" id="main-content" tabIndex={-1}><div className="community-shell">
    <nav className="community-breadcrumb" aria-label={t("breadcrumb")}><Link href="/">{t("home")}</Link><span>/</span><Link href={`/community/${post.section}`}>{t(`sections.${post.section}.name`)}</Link><span>/</span><span>{t(`categories.${post.category}`)}</span></nav>
    <article className="community-panel community-article">
      <div className="community-post-labels"><span className="community-category">{t(`categories.${post.category}`)}</span>{post.isExample && <span className="community-demo-label">{t("realExample")}</span>}</div>
      <h1>{post.title}</h1><div className="community-article-author">{post.authorUsername ? <Link href={`/u/${post.authorUsername}`}>{post.author}</Link> : <strong>{post.author}</strong>}{!post.isExample && <LevelBadge level={post.level} showIcon={false} />}<time dateTime={post.createdAt}>{format.dateTime(new Date(post.createdAt), { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time></div>
      {post.isExample && <p className="community-submit-boundary">{tr("exampleBoundary")}</p>}
      {post.moderationStatus !== "published" && <p role="status" className="community-submit-boundary">{tr(post.moderationStatus === "rejected" ? "rejected" : "pending")}</p>}
      <div className="community-article-body">{post.body?.split("\n\n").map((paragraph, index) => <p key={index} className="whitespace-pre-wrap">{paragraph}</p>)}</div>
      {post.moderationStatus === "published" && <div className="community-detail-actions">{user ? <button type="button" disabled={loading || pending} aria-pressed={liked} onClick={like}>{liked ? "♥" : "♡"} {t("likeCount", { count: post.likes + Number(liked) - Number(initialLiked) })}</button> : <Link href={getSignInHref(pathname, locale)}>{tr("signIn")}</Link>}<a href="#comments">{t("commentCount", { count: post.commentCount })}</a></div>}
      {notice && <p role="alert">{notice}</p>}
    </article>
    {post.moderationStatus === "published" && <CommentSection key={`${user?.id ?? "guest"}:${sessionEpoch}`} submissionId={post.submissionId!} commentCount={post.commentCount} comments={comments.filter(c => c.status === "published" || c.user_id === user?.id)} isLoggedIn={Boolean(user)} canModerate={canModerate && user?.id === serverViewerId} canPin={(canModerate && user?.id === serverViewerId) || user?.id === post.authorId} tagsByUser={{}} />}
  </div></div>;
}
