"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth-context";
import { getSignInHref } from "@/lib/auth-navigation";
import { AuthLoading } from "@/components/auth-loading";
import { readCommunityActivities, writeCommunityActivity } from "@/app/actions/community-activities";
import { activityStatus, type ActivityRead, type CommunityActivity, type ActivityParticipation } from "@/lib/community-activity-types";
import { badgeInfo } from "@/lib/types";
import { CheckinLottery } from "@/components/community-checkin-lottery";
import { ActivityCommunityFeed } from "@/components/activity-community-feed";

const categories = ["all", "newcomer", "weekly", "mine", "posts", "checkin"] as const;
type Category = typeof categories[number];
const filters = ["all", "active", "upcoming", "ended", "cancelled"] as const;
const button = "rounded-full bg-brand px-5 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-brand-ink";

export function CommunityActivityCenter({ activityId }: { activityId?: string }) {
  const { user, loading, sessionEpoch } = useAuth();
  return <ActivitySession key={`${user?.id ?? "guest"}:${sessionEpoch}:${activityId ?? "list"}`} activityId={activityId} userId={user?.id ?? null} authLoading={loading} />;
}
function ActivitySession({ activityId, userId, authLoading }: { activityId?: string; userId: string | null; authLoading: boolean }) {
  const t = useTranslations("activityCenter"); const locale = useLocale(); const router = useRouter();
  const search = useSearchParams(); const value = search.get("category");
  const category: Category = value === "announcements" || value === "community" ? "posts" : categories.includes(value as Category) ? value as Category : "all";
  const [filter, setFilter] = useState<typeof filters[number]>("all");
  const [data, setData] = useState<ActivityRead | null>(null);
  const [error, setError] = useState<string | null>(null); const [revision, setRevision] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (authLoading || ((category === "checkin" || category === "posts") && !activityId)) return;
    let cancelled = false;
    readCommunityActivities(userId, activityId).then((result) => {
      if (cancelled) return;
      setError(result.error ?? null);
      if (result.data) setData(result.data);
    });
    return () => { cancelled = true; };
  }, [userId, authLoading, activityId, category, revision]);
  useEffect(() => {
    if (authLoading || ((category === "checkin" || category === "posts") && !activityId)) return;
    const timer = setInterval(() => setRevision((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [authLoading, category, activityId]);
  const refresh = () => { if (live.current) setRevision((n) => n + 1); };
  const returnTo = activityId ? `/community/activities/${activityId}` : `/community/activities?category=${category}`;
  const signIn = <Link className={button} href={getSignInHref(returnTo, locale)}>{t("signIn")}</Link>;
  const items = data?.items.filter((a) => (category === "all" || category === "mine" || a.type === category) && (category !== "mine" || data.mine.some((p) => p.activity_id === a.id)) && (filter === "all" || activityStatus(a) === filter)) ?? [];

  return <div id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
    <nav aria-label={t("breadcrumb")} className="mb-5 flex min-w-0 flex-wrap gap-2 text-sm text-muted"><Link href="/">{t("home")}</Link><span aria-hidden>/</span><Link href="/community/activities">{t("title")}</Link>{activityId && <><span aria-hidden>/</span><span>{t("detail")}</span></>}</nav>
    <h1 className="sr-only">{t("title")}</h1>
    {error && data && <p className="mb-4 rounded-xl bg-risk-soft p-3 text-sm text-risk" role="alert">{error} <button className="underline" onClick={refresh}>{t("retry")}</button></p>}
    {!activityId && <>
      <nav aria-label={t("categories")} className="flex gap-1 overflow-x-auto border-b border-line pb-3">
        {categories.map((c) => <button key={c} aria-current={c === category ? "page" : undefined} className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${c === category ? "bg-brand-soft text-brand-ink" : "text-muted hover:bg-surface-2"}`} onClick={() => { setFilter("all"); router.replace(`/community/activities?category=${c}`); }}>{t(`category.${c}`)}</button>)}
      </nav>
      {category !== "checkin" && category !== "posts" && <div className="my-4 flex flex-wrap gap-2" role="group" aria-label={t("filters")}>{filters.map((f) => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1.5 text-xs ${filter === f ? "bg-ink text-white" : "text-muted hover:bg-surface-2"}`}>{t(`status.${f}`)}</button>)}</div>}
    </>}
    {category === "checkin" && !activityId ? <CheckinLottery /> : category === "posts" && !activityId ? <ActivityCommunityFeed /> : authLoading ? <AuthLoading /> : category === "mine" && !userId ? <div className="community-panel space-y-4 p-6"><p className="text-sm text-muted">{t("mineGuest")}</p>{signIn}</div> : error && !data ? <div className="community-panel space-y-3 p-6" role="alert"><p className="text-sm text-risk">{error}</p><button className={button} onClick={refresh}>{t("retry")}</button></div> : !data ? <p role="status" className="p-6 text-sm text-muted">{t("loading")}</p> : activityId ? data.items[0] ? <ActivityDetail key={data.items[0].id} activity={data.items[0]} participation={data.mine.find((p) => p.activity_id === activityId)} following={data.following.includes(activityId)} userId={userId} refresh={refresh} /> : <p className="community-panel p-6 text-sm text-muted">{t("notFound")}</p> : items.length ? <div className="overflow-hidden rounded-2xl border border-line bg-surface">{items.map((a) => <ActivityRow key={a.id} activity={a} participation={data.mine.find((p) => p.activity_id === a.id)} />)}</div> : <p className="community-panel p-6 text-sm text-muted">{t(category === "mine" ? "mineEmpty" : "empty")}</p>}
  </div>;
}
function Reward({ activity: a, reward }: { activity: CommunityActivity; reward?: ActivityParticipation["reward"] }) {
  const t = useTranslations("activityCenter"); const locale = useLocale();
  const xp = reward ? reward.xp : a.reward_xp; const tickets = reward ? reward.tickets : a.reward_tickets; const badge = reward ? reward.badge : a.reward_badge;
  return <span>{xp > 0 && <span className="mr-3">{t("xp", { count: xp })}</span>}{tickets > 0 && <span className="mr-3">{t("tickets", { count: tickets })}</span>}{badge && <span>{t("badge", { name: badgeInfo(badge, locale)?.name ?? badge })}</span>}{!xp && !tickets && !badge && t("noReward")}</span>;
}
function ActivityRow({ activity: a, participation: p }: { activity: CommunityActivity; participation?: ActivityParticipation }) {
  const t = useTranslations("activityCenter"); const format = useFormatter();
  return <article className="border-b border-line p-5 last:border-b-0">
    <div className="mb-2 flex flex-wrap gap-2 text-xs text-muted"><span>{t(`type.${a.type}`)}</span><span>·</span><span>{t(`status.${activityStatus(a)}`)}</span>{p && <span className="rounded bg-brand-soft px-2 text-brand-ink">{t(`participation.${p.status}`)}</span>}</div>
    <h2 className="text-base font-semibold text-ink"><Link className="hover:text-brand-ink" href={`/community/activities/${a.id}`}>{a.title}</Link></h2>
    <p className="mt-2 break-words text-sm text-muted">{a.summary}</p>
    <p className="mt-3 text-xs text-faint">{a.organizer} · {format.dateTime(new Date(a.starts_at), { dateStyle: "medium", timeZone: "Asia/Shanghai" })}</p>
    <div className="mt-3 text-xs text-brand-ink"><Reward activity={a} reward={p?.reward} /></div>
  </article>;
}
function ActivityDetail({ activity: a, participation: p, following, userId, refresh }: { activity: CommunityActivity; participation?: ActivityParticipation; following: boolean; userId: string | null; refresh: () => void }) {
  const t = useTranslations("activityCenter"); const locale = useLocale(); const format = useFormatter();
  const [pending, startTransition] = useTransition(); const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState(""); const [answer, setAnswer] = useState<number | null>(null);
  const active = activityStatus(a) === "active"; const done = p?.status === "approved"; const submitted = p?.status === "submitted";
  const productUnavailable = a.task_kind === "product_review" && (!a.product_id || a.product_available === false);
  const exhausted = a.reward_limit !== null && a.rewarded_count >= a.reward_limit && (a.reward_xp > 0 || a.reward_tickets > 0 || a.reward_badge !== null);
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  function act(action: Parameters<typeof writeCommunityActivity>[2]) {
    if (!userId) return;
    setError(null);
    startTransition(async () => {
      const result = await writeCommunityActivity(userId, a.id, action, { evidence, ...(answer !== null ? { answer } : {}) });
      if (!live.current) return;
      setError(result.error ?? null); refresh();
      if (!result.error && action === "submit") setEvidence("");
    });
  }
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" });
  return <article className="community-panel p-5 sm:p-7">
    <div className="flex flex-wrap gap-2 text-xs text-muted"><span>{t(`type.${a.type}`)}</span><span>·</span><span>{t(`status.${activityStatus(a)}`)}</span></div>
    <h2 className="mt-3 break-words text-2xl font-bold text-ink">{a.title}</h2>
    <p className="mt-3 text-sm text-muted">{t("organizer", { name: a.organizer })}</p>
    <p className="mt-1 text-xs leading-6 text-muted">{t("timeRange", { start: date(a.starts_at), end: date(a.ends_at) })}</p>
    <div className="mt-5 border-y border-line py-4 text-sm text-brand-ink"><Reward activity={a} /><p className="mt-2 text-xs text-muted">{a.reward_limit !== null ? t("limit", { count: a.reward_limit, remaining: Math.max(0, a.reward_limit - a.rewarded_count) }) : t("unlimited")}</p><p className="mt-1 text-xs text-muted">{t("rewardRules")}</p></div>
    <h3 className="mt-5 font-semibold text-ink">{t("rules")}</h3><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-muted">{a.body}</p>
    {a.status === "cancelled" && <p className="mt-5 rounded-xl bg-risk-soft p-4 text-sm text-risk">{t("cancelReason", { reason: a.cancel_reason ?? "" })}</p>}
    <section className="mt-6 border-t border-line pt-5" aria-label={t("task")}>
      <h3 className="font-semibold text-ink">{t(`taskKind.${a.task_kind}`)}</h3>
      {a.task_kind === "checkin" && <p className="mt-2 text-sm text-muted">{t("checkinTask", { days: a.checkin_days })} <Link className="text-brand-ink underline" href="/community/activities?category=checkin">{t("goCheckin")}</Link></p>}
      {a.task_kind === "product_review" && <p className="mt-2 text-sm text-muted">{productUnavailable ? t("productUnavailable") : <>{t("reviewTask")} <Link className="text-brand-ink underline" href={`/products/${a.product_id}`}>{t("goProduct")}</Link></>}</p>}
      {a.task_kind === "product_review" && p?.submitted_at && p.review_id === null && <p className="mt-3 text-sm text-muted">{t("reviewUnavailable")}</p>}
      {p && <p className="mt-3 text-sm font-semibold text-brand-ink">{t(`participation.${p.status}`)}</p>}
      {p?.review_note && <p className="mt-2 break-words text-sm text-muted">{t("reviewNote", { note: p.review_note })}</p>}
      {p?.evidence && <details className="mt-3 text-sm text-muted"><summary className="cursor-pointer">{t("myEvidence")}</summary><p className="mt-2 whitespace-pre-wrap break-words">{p.evidence}</p></details>}
      {p?.reward && <p className="mt-2 text-sm text-brand-ink">{t("received")} <Reward activity={a} reward={p.reward} /></p>}
      {userId && active && !done && !submitted && <>
        {a.task_kind === "quiz" && <fieldset disabled={pending} className="mt-4"><legend className="text-sm font-medium text-ink">{a.quiz_question}</legend><p className="mt-1 text-xs text-muted">{t("attempts", { used: p?.attempts ?? 0, max: a.quiz_max_attempts })}</p>{a.quiz_options.map((option, i) => <label key={i} className="mt-2 flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-sm text-ink"><input type="radio" name="answer" className="mt-1" checked={answer === i} onChange={() => setAnswer(i)} /><span className="break-words">{option}</span></label>)}</fieldset>}
        {(a.task_kind === "manual" || a.task_kind === "product_review") && <div className="mt-4"><label htmlFor="activity-evidence" className="text-sm font-medium text-ink">{t("evidenceLabel")}</label><p id="evidence-help" className="my-2 text-xs leading-5 text-muted">{t("sensitive")}</p><textarea id="activity-evidence" aria-describedby="evidence-help" value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={2000} rows={5} className="w-full rounded-xl border border-line p-3 text-sm text-ink" /><p className="mt-1 text-xs text-muted">{t("evidenceLength", { count: evidence.trim().length })}</p><p className="mt-2 text-xs text-muted">{t("resubmitRules")}</p></div>}
      </>}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!userId ? <Link className={button} href={getSignInHref(`/community/activities/${a.id}`, locale)}>{t("signIn")}</Link> : <>
          {active && !done && !submitted && <button className={button} disabled={pending || exhausted || productUnavailable || (a.task_kind === "quiz" && (answer === null || (p?.attempts ?? 0) >= a.quiz_max_attempts)) || ((a.task_kind === "manual" || a.task_kind === "product_review") && evidence.trim().length < 20)} onClick={() => act(a.task_kind === "checkin" ? "checkin" : a.task_kind === "quiz" ? "quiz" : "submit")}>{pending ? t("saving") : t(a.task_kind === "checkin" ? "verify" : a.task_kind === "quiz" ? "answer" : "submit")}</button>}
          {!done && !submitted && !p && active && <button className="rounded-full border border-line px-4 py-2 text-sm text-muted" disabled={pending} onClick={() => act("join")}>{t("join")}</button>}
          {(following || activityStatus(a) === "active" || activityStatus(a) === "upcoming") && <button className="rounded-full border border-line px-4 py-2 text-sm text-muted" disabled={pending} onClick={() => act(following ? "unfollow" : "follow")}>{t(following ? "unfollow" : "follow")}</button>}
        </>}
      </div>
      {exhausted && !done && <p className="mt-3 text-sm text-muted">{t("exhausted")}</p>}
      {error && <p className="mt-3 text-sm text-risk" role="alert">{error}</p>}
      <p className="mt-4 text-xs leading-5 text-faint">{t("notificationRules")}</p>
    </section>
  </article>;
}
