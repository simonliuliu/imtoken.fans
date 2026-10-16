"use server";

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthReturnPath } from "@/lib/auth-navigation";
import { isLocalDevAuthRequestAllowed, localDevAccount } from "@/lib/local-dev-auth";

export async function signInLocalDev(accountKey: unknown, returnTo: unknown): Promise<{ redirectTo?: string }> {
  const h = await headers();
  if (!isLocalDevAuthRequestAllowed(process.env, { host: h.get("host"), origin: h.get("origin") }, true)) {
    notFound();
  }
  const account = localDevAccount(accountKey);
  if (!account) return {};
  // Credentials are read only after the server-side gate and fixed identity check.
  const password = process.env.LOCAL_DEV_AUTH_PASSWORD;
  if (!password) return {};
  const client = await createClient();
  const { data, error } = await client.auth.signInWithPassword({ email: account.email, password });
  if (error) return {};
  if (data.user?.id !== account.userId || data.user.app_metadata.local_dev_auth !== true) {
    await client.auth.signOut();
    return {};
  }
  return { redirectTo: account.role === "admin" ? "/admin" :
    getAuthReturnPath(typeof returnTo === "string" ? returnTo : null, await getLocale()) };
}
