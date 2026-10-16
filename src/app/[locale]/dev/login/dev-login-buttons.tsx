"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { signInLocalDev } from "./actions";
import type { LocalDevAccountKey } from "@/lib/local-dev-auth";

export function DevLoginButtons({ returnTo, ready, accounts }: {
  returnTo: string;
  ready: boolean;
  accounts: { key: LocalDevAccountKey; label: string }[];
}) {
  const t = useTranslations("devAuth");
  const [busy, setBusy] = useState<LocalDevAccountKey | null>(null);
  const [failed, setFailed] = useState(false);

  async function login(key: LocalDevAccountKey) {
    setFailed(false);
    setBusy(key);
    try {
      const result = await signInLocalDev(key, returnTo);
      if (result.redirectTo) {
        // A full navigation refreshes the browser client and server components from the new SSR cookie.
        window.location.assign(result.redirectTo);
        return;
      }
    } catch {
      // Never serialize provider errors or server credentials into the development UI.
    }
    setFailed(true);
    setBusy(null);
  }

  return <div className="space-y-3">
    {accounts.map(({ key, label }) => <button key={key} type="button"
      disabled={!ready || busy !== null} onClick={() => login(key)}
      className="block w-full rounded-xl border border-line bg-surface px-5 py-3 text-left font-semibold text-ink hover:border-brand disabled:opacity-50">
      {busy === key ? t("busy") : label}
    </button>)}
    {!ready && <p role="status" className="text-sm text-muted">{t("setup")}</p>}
    {failed && <p role="alert" className="text-sm text-risk">{t("failed")}</p>}
  </div>;
}
