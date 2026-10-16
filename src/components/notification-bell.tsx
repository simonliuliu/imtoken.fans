"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { createClient } from "@/lib/supabase/client";
import { mutateNotifications } from "@/app/actions/notifications";
import { badgeInfo, type NotificationDetail, type NotificationItem } from "@/lib/types";
import { useAuth } from "@/lib/auth-context";
import { Link } from "@/i18n/navigation";
import { getSignInHref } from "@/lib/auth-navigation";
import { AuthLoading } from "@/components/auth-loading";
import { Avatar } from "@/components/avatar";
import { LevelBadge } from "@/components/level-badge";
import { levelTierName } from "@/lib/level";

type NotificationT = ReturnType<typeof useTranslations<"notifications">>;

const POLL_INTERVAL_MS = 30_000;

// 「谁 + 做了什么」模板，只有这两种有触发人。
// 其余类型走下面 systemNotification() 的「图标 + 一句话」渲染。
const TYPE_TEXT_KEY: Partial<Record<NotificationItem["type"], "reply" | "mention">> = {
  reply: "reply",
  mention: "mention",
};

// 系统通知（没有触发人的那几种）：各自给一个图标、一句话和点进去的落地页。
// 集中在这里而不是散成一堆 if：以后加新类型只用在这个 switch 里补一条。
function systemNotification(
  type: NotificationItem["type"],
  detail: NotificationDetail | null,
  t: NotificationT,
  locale: string
): { icon: ReactNode; text: ReactNode; href: string } | null {
  switch (type) {
    case "level_up": {
      const level = detail?.level ?? 0;
      return {
        icon: <LevelBadge level={level} size="sm" className="mt-0.5" />,
        text: (
          <>
            <span className="font-semibold">{t("levelUpStrong")}</span>{" "}
            {t("levelUpBody", { level, tier: levelTierName(level, locale) })}
          </>
        ),
        href: "/profile",
      };
    }
    case "lottery_ticket": {
      const amount = detail?.amount ?? 0;
      const gained = amount > 0;
      return {
        icon: <SystemIcon emoji="🎟️" tone={gained ? "warn" : "muted"} />,
        text: (
          <>
            <span className="font-semibold">
              {gained
                ? t("ticketGained", { amount })
                : t("ticketRevoked", { amount: Math.abs(amount) })}
            </span>{" "}
            {detail?.source === "lottery_prize" ? t("ticketFromLottery") : t("ticketFromAdmin")}
            {typeof detail?.balance === "number" && t("ticketBalance", { balance: detail.balance })}
          </>
        ),
        href: "/activities",
      };
    }
    case "badge": {
      const badge = detail?.badge_key ? badgeInfo(detail.badge_key, locale) : null;
      return {
        icon: <SystemIcon emoji={badge?.icon ?? "🏅"} tone="brand" />,
        text: (
          <>
            <span className="font-semibold">{t("badgeStrong")}</span>{" "}
            {badge?.name ?? detail?.badge_key ?? t("badgeFallback")}
          </>
        ),
        href: "/profile",
      };
    }
    case "xp_adjust": {
      const amount = detail?.amount ?? 0;
      return {
        icon: <SystemIcon emoji={amount > 0 ? "✨" : "⚠️"} tone={amount > 0 ? "good" : "muted"} />,
        text: (
          <>
            <span className="font-semibold">
              {amount > 0
                ? t("xpAdded", { amount })
                : t("xpRemoved", { amount: Math.abs(amount) })}
            </span>
            {typeof detail?.xp === "number" && t("xpBalance", { xp: detail.xp.toLocaleString() })}
          </>
        ),
        href: "/profile",
      };
    }
    default:
      return null;
  }
}

function SystemIcon({ emoji, tone }: { emoji: string; tone: "brand" | "good" | "warn" | "muted" }) {
  const toneClass =
    tone === "good" ? "bg-good-soft" : tone === "warn" ? "bg-warn-soft" : tone === "brand" ? "bg-brand-soft" : "bg-surface-2";
  return (
    <span
      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base ${toneClass}`}
      aria-hidden
    >
      {emoji}
    </span>
  );
}

export function NotificationBell({ fullPage = false }: { fullPage?: boolean }) {
  const { user, sessionEpoch, loading } = useAuth();
  const identity = `${user?.id ?? ""}:${sessionEpoch}`;
  if (loading) return fullPage ? <AuthLoading /> : null;
  return <NotificationPanel key={identity} fullPage={fullPage} userId={user?.id ?? null} sessionEpoch={sessionEpoch} />;
}

function NotificationPanel({ fullPage, userId, sessionEpoch }: { fullPage: boolean; userId: string | null; sessionEpoch: number }) {
  const t = useTranslations("notifications");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount,setUnreadCount] = useState(0);
  const [total,setTotal] = useState(0);
  const [offset,setOffset] = useState(0);
  const [loaded,setLoaded] = useState(false);
  const [error,setError] = useState(false);
  const [open,setOpen] = useState(fullPage);
  const [isPending,startTransition] = useTransition();
  const rootRef=useRef<HTMLDivElement>(null);
  const alive=useRef(true);
  const request=useRef(0);
  const fetchNotifications=useCallback(async()=>{
   if(!userId)return;
   const version=++request.current;
   try {
    const {data,error}=await createClient().rpc("notification_read",{p_expected_user_id:userId,p_offset:offset});
    if(!alive.current||version!==request.current)return;
    if(error){setError(true);return;}
    if(offset>0 && offset>=data.total){setOffset(Math.floor(Math.max(0,data.total-1)/20)*20);return;}
    setItems(data.items);setUnreadCount(data.unread);setTotal(data.total);setError(false);setLoaded(true);
   }catch{if(alive.current&&version===request.current)setError(true);}
  },[userId,offset]);
  useEffect(()=>{
   alive.current=true;
   // External database synchronization.
   // eslint-disable-next-line react-hooks/set-state-in-effect
   void fetchNotifications();
   const interval=setInterval(()=>void fetchNotifications(),POLL_INTERVAL_MS);
   return()=>{alive.current=false;clearInterval(interval);};
  },[fetchNotifications,sessionEpoch]);
  useEffect(()=>{
   if(!open||fullPage)return;
   function outside(e:MouseEvent){if(rootRef.current&&!rootRef.current.contains(e.target as Node))setOpen(false);}
   function escape(e:KeyboardEvent){if(e.key==="Escape"){setOpen(false);rootRef.current?.querySelector("button")?.focus();}}
   document.addEventListener("mousedown",outside);document.addEventListener("keydown",escape);
   return()=>{document.removeEventListener("mousedown",outside);document.removeEventListener("keydown",escape);};
  },[open,fullPage]);
  function mutate(action:"read"|"all"|"clear",id?:string,href?:string){
   if(!userId)return;
   startTransition(async()=>{
    try{const result=await mutateNotifications(userId,action,id);
     if(!alive.current)return;
     if(result.error){setError(true);return;}
     if(action==="clear")setOffset(0);
     await fetchNotifications();
     if(href&&alive.current){setOpen(fullPage);router.push(href);}
    }catch{if(alive.current)setError(true);}
   });
  }
  function handleClickItem(item:NotificationItem){
   const system=systemNotification(item.type,item.detail,t,locale);
   const href=system?.href ?? safeNotificationHref(item.href);
   if(!item.read_at)mutate("read",item.id,href??undefined);
   else if(href){setOpen(fullPage);router.push(href);}
  }
  function handleMarkAllRead(){mutate("all");}
  function handleClearAll(){if(window.confirm(t("clearConfirm")))mutate("clear");}
  if(!userId)return fullPage?<section><h1 className="mb-4 text-lg font-semibold text-ink">{t("title")}</h1><Link href={getSignInHref("/notifications",locale)} className="text-brand-ink underline">{t("signInRequired")}</Link></section>:null;
  return (
    <div ref={rootRef} className="relative">
      {!fullPage && <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        aria-label={t("aria")}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-risk px-1 font-mono text-[9px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>}

      {open && (
        <div className={fullPage ? "rounded-xl border border-line bg-surface" : "absolute right-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface shadow-lg"}>
          <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2.5">
            {fullPage ? <h1 className="text-lg font-semibold text-ink">{t("title")}</h1> : <p className="text-sm font-semibold text-ink">{t("title")}</p>}
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleMarkAllRead}
                  className="text-xs text-brand-ink transition-colors hover:underline disabled:opacity-60"
                >
                  {t("markAllRead")}
                </button>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleClearAll}
                  aria-label={t("clearAll")}
                  title={t("clearAll")}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-risk-soft hover:text-risk disabled:opacity-60"
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          </div>

          {error && <p role="alert" className="p-3 text-sm text-risk">{t("loadError")} <button type="button" onClick={()=>void fetchNotifications()} className="underline">{t("retry")}</button></p>}
          <div className={fullPage ? "" : "max-h-96 overflow-y-auto"}>
            {items.length === 0 ? (
              loaded && !error ? <p className="px-3 py-6 text-center text-sm text-muted">{t("empty")}</p> : null
            ) : (
              items.map((item) => {
                const system = systemNotification(item.type, item.detail, t, locale);
                const typeKey = item.detail?.kind ?? TYPE_TEXT_KEY[item.type];
                return (
                <button
                  disabled={isPending}
                  key={item.id}
                  type="button"
                  onClick={() => handleClickItem(item)}
                  className={`flex w-full items-start gap-2.5 border-b border-line px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-2 ${
                    item.read_at ? "" : "bg-brand-soft/40"
                  }`}
                >
                  {system ? (
                    system.icon
                  ) : (
                    <Avatar
                      src={item.actor_avatar_url}
                      name={item.actor_username}
                      className="h-8 w-8 rounded-full bg-surface-2 font-display text-xs font-bold text-muted"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink">
                      {system?.text ?? (
                        <>
                          <span className="font-semibold">{item.actor_username ?? tc("deletedUser")}</span>{" "}
                          {typeKey ? t(typeKey) : null}
                        </>
                      )}
                    </p>
                    {item.submission_title && (
                      <p className="truncate text-xs text-muted">「{item.submission_title}」</p>
                    )}
                    {item.comment_preview && <p className="truncate text-xs text-faint">{item.comment_preview}</p>}
                    <p className="mt-0.5 font-mono text-[10px] text-faint">
                      {format.dateTime(new Date(item.created_at), {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </p>
                  </div>
                  {!item.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-hidden />}
                </button>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line p-3 text-xs">
           {fullPage ? <><button disabled={offset===0||isPending} onClick={()=>setOffset(Math.max(0,offset-20))}>{t("previous")}</button><span>{t("range",{start:total?offset+1:0,end:Math.min(offset+20,total),total})}</span><button disabled={offset+20>=total||isPending} onClick={()=>setOffset(offset+20)}>{t("next")}</button></> : <Link href="/notifications" onClick={()=>setOpen(false)} className="text-brand-ink">{t("viewAll")}</Link>}
          </div>
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// Only routes produced by notification_read are accepted; no protocol or arbitrary URL.
function safeNotificationHref(href?: string | null): string | null {
 if(!href)return null;
 return /^\/(?:products|ideas)\/[0-9a-f-]{36}(?:#comment-[0-9a-f-]{36})?$/.test(href)||/^\/community\/feedback\?category=wallet&idea=[0-9a-f-]{36}(?:&commentOffset=[0-9]+)?(?:#comment-[0-9a-f-]{36})?$/.test(href)?href:null;
}
