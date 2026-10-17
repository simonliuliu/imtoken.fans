"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth-context";
import { AuthLoading } from "@/components/auth-loading";
import { CheckinCard } from "@/components/checkin-card";
import { LotteryWheel } from "@/components/lottery-wheel";
import { readCheckinLottery } from "@/app/actions/community-activities";
import type { CheckinState, LotteryState } from "@/lib/activity-types";
export function CheckinLottery() {
  const { user, loading, sessionEpoch } = useAuth();
  return <CheckinLotterySession key={`${user?.id ?? "guest"}:${sessionEpoch}`} userId={user?.id ?? null} loading={loading} />;
}
function CheckinLotterySession({ userId, loading }: { userId: string | null; loading: boolean }) {
  const t = useTranslations("activityCenter");
  const [data, setData] = useState<{ checkin: CheckinState; lottery: LotteryState; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null); const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    readCheckinLottery(userId).then((r) => {
      if (cancelled) return;
      const snapshot = r.data;
      if (snapshot) setData((previous) => ({ ...snapshot, version: (previous?.version ?? 0) + 1 }));
      setError(r.error ?? null);
    });
    return () => { cancelled = true; };
  }, [userId, loading, revision]);
  useEffect(() => {
    if (loading) return;
    const visibleRefresh = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = setInterval(visibleRefresh, 30_000);
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", visibleRefresh); document.removeEventListener("visibilitychange", visibleRefresh); };
  }, [loading, refresh]);
  if (loading) return <AuthLoading />;
  const errorNotice = error ? <div className="community-panel mt-5 p-5" role="alert"><p className="text-sm text-risk">{error}</p><button className="mt-3 text-sm text-brand-ink underline" onClick={refresh}>{t("retry")}</button></div> : null;
  if (error && !data) return errorNotice;
  if (!data) return <p role="status" className="p-6 text-sm text-muted">{t("loading")}</p>;
  return <div className="mt-5 flex flex-col gap-6">{errorNotice}<CheckinCard state={data.checkin} expectedUserId={userId} onUpdated={refresh} /><LotteryWheel prizes={data.lottery.prizes} settings={data.lottery.settings} tickets={data.lottery.tickets} drawsLeft={data.lottery.drawsLeft} recentWinners={data.lottery.recentWinners} expectedUserId={userId} stateVersion={data.version} onUpdated={refresh} /></div>;
}
