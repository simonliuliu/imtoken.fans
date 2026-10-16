import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getAuthReturnPath } from "@/lib/auth-navigation";
import { createClient } from "@/lib/supabase/server";
import { LOCAL_DEV_ACCOUNTS, isLocalDevAuthRequestAllowed } from "@/lib/local-dev-auth";
import { DevLoginButtons } from "./dev-login-buttons";

export default async function LocalDevLoginPage({ searchParams }: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const h = await headers();
  if (!isLocalDevAuthRequestAllowed(process.env, { host: h.get("host"), origin: h.get("origin") }, false)) {
    notFound();
  }
  const t = await getTranslations("devAuth");
  const locale = await getLocale();
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  const account = LOCAL_DEV_ACCOUNTS.find(account => account.userId === user?.id);
  const requestedReturnTo = (await searchParams).redirect;
  const returnTo = getAuthReturnPath(typeof requestedReturnTo === "string" ? requestedReturnTo : null, locale);

  return <main className="mx-auto max-w-lg px-5 py-14">
    <p className="font-mono text-xs font-bold text-brand-ink">{t("eyebrow")}</p>
    <h1 className="mt-3 text-3xl font-bold text-ink">{t("title")}</h1>
    <p className="mb-6 mt-3 text-sm leading-6 text-muted">{t("description")}</p>
    <p className="mb-4 text-sm text-muted">{t("current", { name: account ? t(account.key) : user ? t("other") : t("signedOut") })}</p>
    <DevLoginButtons ready={Boolean(process.env.LOCAL_DEV_AUTH_PASSWORD)} returnTo={returnTo}
      accounts={LOCAL_DEV_ACCOUNTS.map(account => ({ key: account.key, label: t(account.key) }))} />
  </main>;
}
