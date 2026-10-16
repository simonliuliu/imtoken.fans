"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getAuthReturnPath, getSignInHref } from "@/lib/auth-navigation";
import { normalizeUsername, usernameSyntheticEmail } from "@/lib/username";

export interface AuthActionState {
  error?: string;
  needsEmailConfirmation?: boolean;
}

async function getOrigin(): Promise<string> {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  // 本地 `next dev` 没有反向代理，不会带 x-forwarded-proto，这里如果照旧默认成 https
  // 会拼出 https://localhost:3000，浏览器根本连不上，Google 登录回跳后会卡住没反应。
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const protocol = h.get("x-forwarded-proto") ?? (isLocalHost ? "http" : "https");
  return `${protocol}://${host}`;
}

export async function signUpWithPassword(input: {
  email: string;
  password: string;
  nickname: string;
  redirectTo?: string;
}): Promise<AuthActionState> {
  const t = await getTranslations("errors");
  if (!isSupabaseConfigured()) {
    return { error: t("supabaseNotConfiguredSignUp") };
  }

  const supabase = await createClient();
  const origin = await getOrigin();
  const redirectTo = getAuthReturnPath(input.redirectTo, await getLocale());
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: { username: input.nickname },
      emailRedirectTo: `${origin}/auth/callback?redirect=${encodeURIComponent(redirectTo)}`,
    },
  });

  if (error) return { error: error.message };
  if (!data.session) return { needsEmailConfirmation: true };
  return {};
}

export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<AuthActionState> {
  const t = await getTranslations("errors");
  if (!isSupabaseConfigured()) {
    return { error: t("supabaseNotConfiguredSignIn") };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(input);
  if (error) return { error: error.message };
  return {};
}

export async function signUpWithUsername(input: {
  username: string;
  password: string;
}): Promise<AuthActionState> {
  const t = await getTranslations("errors");
  if (!isSupabaseConfigured()) {
    return { error: t("supabaseNotConfiguredSignUp") };
  }

  const username = normalizeUsername(input.username);
  if (!username) {
    return { error: t("usernameFormat") };
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    return { error: err instanceof Error ? err.message : t("adminKeyMissing") };
  }

  const syntheticEmail = usernameSyntheticEmail(username);
  const { error: createError } = await admin.auth.admin.createUser({
    email: syntheticEmail,
    password: input.password,
    email_confirm: true,
    user_metadata: { username, auth_method: "username" },
  });

  if (createError) {
    if (createError.status === 422 || createError.message.toLowerCase().includes("already")) {
      return { error: t("usernameTaken") };
    }
    return { error: createError.message };
  }

  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: syntheticEmail,
    password: input.password,
  });
  if (signInError) return { error: signInError.message };
  return {};
}

export async function signInWithUsername(input: {
  username: string;
  password: string;
}): Promise<AuthActionState> {
  const t = await getTranslations("errors");
  if (!isSupabaseConfigured()) {
    return { error: t("supabaseNotConfiguredSignIn") };
  }

  const username = normalizeUsername(input.username);
  if (!username) {
    return { error: t("usernameFormat") };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: usernameSyntheticEmail(username),
    password: input.password,
  });
  // 统一用一个模糊的错误提示，不透露到底是用户名不存在还是密码错了
  if (error) return { error: t("badCredentials") };
  return {};
}

export async function signInWithGoogle(redirectTo: string): Promise<void> {
  const t = await getTranslations("errors");
  const locale = await getLocale();
  const safeRedirect = getAuthReturnPath(redirectTo, locale);
  const signInHref = getAuthReturnPath(getSignInHref(safeRedirect, locale), locale);

  if (!isSupabaseConfigured()) {
    redirect(`${signInHref}&error=${encodeURIComponent(t("supabaseNotConfigured"))}`);
  }

  const supabase = await createClient();
  const origin = await getOrigin();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?redirect=${encodeURIComponent(safeRedirect)}`,
    },
  });

  if (error || !data.url) {
    redirect(`${signInHref}&error=${encodeURIComponent(error?.message ?? t("googleSignInFailed"))}`);
  }

  redirect(data.url);
}
