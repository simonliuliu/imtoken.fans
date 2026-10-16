"use client";

import { useRef } from "react";
import NextLink from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth-context";
import { UserMenu } from "@/components/user-menu";
import { NotificationBell } from "@/components/notification-bell";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ComposeDemoButton } from "@/components/community-elements";
import { BrandLogo } from "@/components/brand-logo";
import { AuthLoading } from "@/components/auth-loading";
import { getSignInHref } from "@/lib/auth-navigation";

export function SiteHeader() {
  const t = useTranslations("nav");
  const { user, isAdmin, signOut, loading } = useAuth();
  const locale = useLocale();
  const pathname = usePathname();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const signInHref = getSignInHref(pathname || "/", locale);
  const sections = ["safety", "feedback", "discussion", "activities"] as const;
  const closeMenu = () => { if (menuRef.current) menuRef.current.open = false; };

  return (
    <header className="fans-header">
      {(pathname === "/" || pathname.startsWith("/community/")) && <a className="fans-skip-link" href="#main-content">{t("skipContent")}</a>}
      <div className="fans-container fans-header-inner">
        <Link href="/" className="fans-brand"><BrandLogo /></Link>
        <nav className="fans-desktop-nav" aria-label={t("mainNavigation")}>
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>{t("home")}</Link>
          {sections.map((section) => <Link href={`/community/${section}`} key={section} aria-current={pathname.startsWith(`/community/${section}`) || (section === "feedback" && pathname.startsWith("/products/")) ? "page" : undefined}>{t(section)}</Link>)}
        </nav>
        <div className="fans-header-tools">
          <LanguageSwitcher />
          <ComposeDemoButton compact />
          <div className="fans-desktop-account">
            {loading ? <AuthLoading compact /> : user ? <><NotificationBell /><UserMenu name={user.name} avatarUrl={user.avatarUrl} isAdmin={isAdmin} onSignOut={signOut} /></> : <Link href={signInHref} className="fans-signin">{t("signIn")}</Link>}
          </div>
          <details className="fans-mobile-menu" ref={menuRef} onKeyDown={(event) => {
            if (event.key === "Escape") { closeMenu(); menuRef.current?.querySelector("summary")?.focus(); }
          }}>
            <summary aria-label={t("menu")}><span aria-hidden>☰</span></summary>
            <nav aria-label={t("mainNavigation")} onClick={(event) => {
              if ((event.target as HTMLElement).closest("a")) closeMenu();
            }}>
              <Link href="/">{t("home")}</Link>
              {sections.map((section) => <Link href={`/community/${section}`} key={section}>{t(section)}<span aria-hidden>↗</span></Link>)}
              {loading ? <AuthLoading compact /> : user ? <><Link href="/profile">{t("profile")}</Link>{isAdmin && <NextLink href="/admin">{t("admin")}</NextLink>}<button type="button" onClick={() => { closeMenu(); void signOut(); }}>{t("signOut")}</button></> : <Link href={signInHref}>{t("signIn")}</Link>}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
