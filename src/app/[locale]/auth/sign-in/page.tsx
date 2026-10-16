"use client";

import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import {
  signInWithGoogle,
  signInWithPassword,
  signInWithUsername,
  signUpWithPassword,
  signUpWithUsername,
} from "@/app/[locale]/auth/actions";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getAuthReturnPath } from "@/lib/auth-navigation";
import { connectWalletAndSignIn, connectWalletConnectAndSignIn, hasWalletConnectProjectId } from "@/lib/wallet-client";
import { useAuth } from "@/lib/auth-context";
import { BrandLogo } from "@/components/brand-logo";
import { AuthLoading } from "@/components/auth-loading";

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInFallback />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInFallback() {
  return <AuthLoading />;
}

function SignInForm() {
  const t = useTranslations("signIn");
  const locale = useLocale();
  const tw = useTranslations("wallet");
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = getAuthReturnPath(searchParams.get("redirect"), locale);
  const configured = isSupabaseConfigured();
  const walletConnectAvailable = hasWalletConnectProjectId();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) {
      router.replace(redirectTo);
    }
  }, [loading, user, redirectTo, router]);

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [credential, setCredential] = useState<"email" | "username">("email");
  const [busy, setBusy] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(searchParams.get("error"));
  const [info, setInfo] = useState<string | null>(null);

  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function handleGoogle() {
    setError(null);
    setInfo(null);
    setBusy("google");
    await signInWithGoogle(redirectTo);
    // signInWithGoogle 内部会 redirect，正常情况下不会走到这里；失败时 redirect 回本页并带上 error 参数。
    setBusy(null);
  }

  async function handleWalletConnect() {
    setError(null);
    setInfo(null);
    setBusy("wallet");
    try {
      await connectWalletAndSignIn({
        noInjectedWallet: tw("noInjectedWallet"),
        noAddress: tw("noAddress"),
        noAddressShort: tw("noAddressShort"),
        walletConnectUnavailable: tw("walletConnectUnavailable"),
        nonceFailed: tw("nonceFailed"),
        verifyFailed: tw("verifyFailed"),
        metadataDescription: tw("metadataDescription"),
      });
      // 登录成功后沿用本页既有的整页跳转（而不是 router.push）：硬重载能确保服务端组件
      // 一定拿到刚写入的 session cookie。钱包登录在客户端分不清新老用户，统一进 /welcome，
      // 引导页自己判断——已经走过引导的会被直接放行到 redirectTo。
      window.location.href = getAuthReturnPath(`/welcome?redirect=${encodeURIComponent(redirectTo)}`, locale);
    } catch (err) {
      setError(err instanceof Error ? err.message : tw("verifyFailed"));
      setBusy(null);
    }
  }

  async function handleWalletConnectScan() {
    setError(null);
    setInfo(null);
    setBusy("walletconnect");
    try {
      await connectWalletConnectAndSignIn({
        noInjectedWallet: tw("noInjectedWallet"),
        noAddress: tw("noAddress"),
        noAddressShort: tw("noAddressShort"),
        walletConnectUnavailable: tw("walletConnectUnavailable"),
        nonceFailed: tw("nonceFailed"),
        verifyFailed: tw("verifyFailed"),
        metadataDescription: tw("metadataDescription"),
      });
      // 同上：整页跳转 + 统一进 /welcome 由服务端判断是否需要引导。
      window.location.href = getAuthReturnPath(`/welcome?redirect=${encodeURIComponent(redirectTo)}`, locale);
    } catch (err) {
      setError(err instanceof Error ? err.message : tw("verifyFailed"));
      setBusy(null);
    }
  }

  async function handleCredentialSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (credential === "email" && !/^\S+@\S+\.\S+$/.test(email)) {
      setError(t("invalidEmail"));
      return;
    }
    if (credential === "username" && !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      setError(t("invalidUsername"));
      return;
    }
    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }
    if (mode === "signup") {
      if (credential === "email" && !nickname.trim()) {
        setError(t("nicknameRequired"));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("passwordMismatch"));
        return;
      }
    }

    setBusy("password");
    const result =
      credential === "email"
        ? mode === "signup"
          ? await signUpWithPassword({ email, password, nickname: nickname.trim(), redirectTo })
          : await signInWithPassword({ email, password })
        : mode === "signup"
          ? await signUpWithUsername({ username, password })
          : await signInWithUsername({ username, password });

    if (result.error) {
      setError(result.error);
      setBusy(null);
      return;
    }
    if (result.needsEmailConfirmation) {
      setInfo(t("needsEmailConfirmation"));
      setBusy(null);
      return;
    }
    // 注册（而不是登录）成功的一定是新用户，直接送去引导页完善昵称/头像；
    // 登录走原来的跳转。OAuth 那条路的判断在 /auth/callback 里做。
    window.location.href =
      mode === "signup" ? getAuthReturnPath(`/welcome?redirect=${encodeURIComponent(redirectTo)}`, locale) : redirectTo;
  }

  if (loading || user) {
    return <AuthLoading />;
  }

  return (
    <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_28rem] lg:py-20">
      <aside className="relative hidden overflow-hidden rounded-[2rem] bg-ink p-10 text-white shadow-2xl shadow-slate-900/15 lg:block">
        <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-brand/40 blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-cyan-400/20 blur-3xl" aria-hidden />
        <div className="relative">
          <p className="font-mono text-xs font-bold uppercase tracking-[.18em] text-blue-300">{t("valueEyebrow")}</p>
          <h1 className="mt-5 text-4xl font-extrabold leading-tight tracking-tight">{t("valueTitle")}</h1>
          <p className="mt-5 max-w-md text-sm leading-7 text-slate-300">{t("valueBody")}</p>
          <div className="mt-10 flex flex-col gap-3">
            <SignInBenefit icon="✦" title={t("makerBenefitTitle")} body={t("makerBenefitBody")} />
            <SignInBenefit icon="◎" title={t("memberBenefitTitle")} body={t("memberBenefitBody")} />
            <SignInBenefit icon="↗" title={t("progressBenefitTitle")} body={t("progressBenefitBody")} />
          </div>
        </div>
      </aside>

      <div className="w-full max-w-md justify-self-center">
      <div className="mb-8 flex flex-col items-center text-center">
        <BrandLogo className="h-12 w-auto" />
        <h1 className="mt-4 text-2xl font-extrabold text-ink">
          {mode === "signin" ? t("titleSignIn") : t("titleSignUp")}
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          {mode === "signin" ? t("subtitleSignIn") : t("subtitleSignUp")}
        </p>
      </div>

      {!configured && (
        <div className="mb-4 rounded-xl bg-risk-soft px-4 py-3 text-xs text-risk">
          {t("notConfigured")}
        </div>
      )}

      <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-7">
        <button
          type="button"
          onClick={handleGoogle}
          disabled={busy !== null || !configured}
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-line bg-surface py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "google" ? <Spinner /> : <GoogleIcon />}
          {busy === "google" ? t("googleBusy") : t("google")}
        </button>

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-line" />
          <span className="font-mono text-[11px] text-faint">
            {mode === "signin" ? t("dividerSignIn") : t("dividerSignUp")}
          </span>
          <div className="h-px flex-1 bg-line" />
        </div>

        <div className="mb-4 flex gap-1.5 rounded-full bg-surface-2 p-1 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setCredential("email")}
            className={`flex-1 rounded-full py-1.5 transition-colors ${
              credential === "email" ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {t("tabEmail")}
          </button>
          <button
            type="button"
            onClick={() => setCredential("username")}
            className={`flex-1 rounded-full py-1.5 transition-colors ${
              credential === "username" ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {t("tabUsername")}
          </button>
        </div>

        <form onSubmit={handleCredentialSubmit} className="flex flex-col gap-4">
          {mode === "signup" && credential === "email" && (
            <FormField label={t("nickname")}>
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder={t("nicknamePlaceholder")}
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
              />
            </FormField>
          )}

          {credential === "email" ? (
            <FormField label={t("email")}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
              />
            </FormField>
          ) : (
            <FormField label={t("username")}>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("usernamePlaceholder")}
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
              />
            </FormField>
          )}

          <FormField label={t("password")}>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("passwordPlaceholder")}
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 pr-14 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[11px] text-faint hover:text-brand-ink"
              >
                {showPassword ? t("hidePassword") : t("showPassword")}
              </button>
            </div>
          </FormField>

          {mode === "signup" && (
            <FormField label={t("confirmPassword")}>
              <input
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t("confirmPasswordPlaceholder")}
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
              />
            </FormField>
          )}

          {error && <p className="rounded-lg bg-risk-soft px-3 py-2 text-xs text-risk">{error}</p>}
          {info && <p className="rounded-lg bg-good-soft px-3 py-2 text-xs text-good">{info}</p>}

          <button
            type="submit"
            disabled={busy !== null || !configured}
            className="mt-1 rounded-full bg-brand py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
          {busy === "password" ? t("busy") : mode === "signin" ? t("submitSignIn") : t("submitSignUp")}
          </button>
        </form>

        <details className="group mt-5 rounded-xl border border-line bg-surface-2/50">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-center text-xs font-semibold text-muted transition hover:text-ink">
            {t("walletOptions")}
          </summary>
          <div className="flex flex-col gap-2.5 border-t border-line p-3">
            <button
              type="button"
              onClick={handleWalletConnect}
              disabled={busy !== null || !configured}
              className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-line bg-surface py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "wallet" ? <Spinner /> : <span className="text-base leading-none">👛</span>}
              {busy === "wallet" ? t("walletBusy") : t("wallet")}
            </button>
            {walletConnectAvailable ? (
              <button
                type="button"
                onClick={handleWalletConnectScan}
                disabled={busy !== null || !configured}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-line bg-surface py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === "walletconnect" ? <Spinner /> : <span className="text-base leading-none">📱</span>}
                {busy === "walletconnect" ? t("walletConnectBusy") : t("walletConnect")}
              </button>
            ) : (
              <p className="text-center font-mono text-[11px] text-faint">{t("walletConnectUnavailable")}</p>
            )}
          </div>
        </details>
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        {mode === "signin" ? t("noAccount") : t("hasAccount")}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setInfo(null);
          }}
          className="ml-1.5 font-semibold text-brand-ink hover:underline"
        >
          {mode === "signin" ? t("switchToSignUp") : t("switchToSignIn")}
        </button>
      </p>
      <p className="mt-4 text-center text-[11px] leading-5 text-faint">{t.rich("terms", { guidelines: (chunks) => <Link href="/community-guidelines" className="underline hover:text-brand-ink">{chunks}</Link> })}</p>
      </div>
    </div>
  );
}

function SignInBenefit({ icon, title, body }: { icon: string; title: string; body: string }) {
  return <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/[.06] p-4 backdrop-blur"><span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 text-blue-300">{icon}</span><div><p className="text-sm font-bold text-white">{title}</p><p className="mt-1 text-xs leading-5 text-slate-400">{body}</p></div></div>;
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-left text-sm">
      <span className="font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}

function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand" aria-hidden />;
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z" />
    </svg>
  );
}
