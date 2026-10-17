"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth-context";
import { AuthLoading } from "@/components/auth-loading";
import { PostRow, SortTabs } from "@/components/community-preview";
import { compareDemoPopularity, type DemoPost } from "@/lib/community-demo";
import { readActivityCommunityPosts } from "@/app/actions/community-activities";
const postCategories = ["all", "announcements", "community", "checkin"];
export function ActivityCommunityFeed() {
  const { user, loading, sessionEpoch } = useAuth();
  return <ActivityCommunityFeedSession key={`${user?.id ?? "guest"}:${sessionEpoch}`} userId={user?.id ?? null} loading={loading} />;
}
function ActivityCommunityFeedSession({ userId, loading }: { userId: string | null; loading: boolean }) {
  const t = useTranslations("community"); const ta = useTranslations("activityCenter");
  const router = useRouter(); const search = useSearchParams();
  const selected = search.get("postCategory") ?? search.get("category");
  const category = selected && postCategories.includes(selected) ? selected : "all";
  const [sort, setSort] = useState<"latest" | "popular" | "recommended">("latest");
  const [visible, setVisible] = useState(8); const [posts, setPosts] = useState<DemoPost[] | null>(null);
  const [error, setError] = useState<string | null>(null); const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    readActivityCommunityPosts(userId).then((r) => { if (!cancelled) { if (r.data) setPosts(r.data); setError(r.error ?? null); } });
    return () => { cancelled = true; };
  }, [userId, loading, revision]);
  useEffect(() => { if (loading) return; const timer = setInterval(() => setRevision((n) => n + 1), 30_000); return () => clearInterval(timer); }, [loading]);
  if (loading) return <AuthLoading />;
  const filtered = (posts ?? []).filter((p) => (category === "all" || p.category === category) && (sort !== "recommended" || p.featured)).sort((a, b) => sort === "popular" ? compareDemoPopularity(a, b) : b.createdAt.localeCompare(a.createdAt));
  return <section className="community-panel community-feed-panel mt-4" aria-label={ta("category.posts")}>
    <div className="community-filter-row" role="group" aria-label={t("categoryFilter")}>{postCategories.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => { setVisible(8); router.replace(`/community/activities?category=posts&postCategory=${c}`); }}>{c === "all" ? t("all") : t(`categories.${c}`)}</button>)}</div>
    <div className="community-feed-heading"><SortTabs value={sort} onChange={(s) => { setSort(s); setVisible(8); }} /><span>{t("postCount", { count: filtered.length })}</span></div>
    {error && <p className="p-5 text-sm text-risk" role="alert">{error} <button className="underline" onClick={() => setRevision((n) => n + 1)}>{t("retry")}</button></p>}
    {!posts && !error ? <p className="p-5 text-sm text-muted" role="status">{t("loading")}</p> : filtered.length ? filtered.slice(0, visible).map((post) => <PostRow key={post.id} post={post} />) : !error && <p className="community-empty">{t("empty")}</p>}
    {filtered.length > visible && <button type="button" className="community-load-more" onClick={() => setVisible((n) => n + 8)}>{t("loadMore")}</button>}
  </section>;
}
