import { routing, type AppLocale } from "@/i18n/routing";
import { sanitizeRedirect } from "@/lib/redirect";

export function getAuthLocale(returnTo: string | null | undefined, fallback: string): string {
  const path = sanitizeRedirect(returnTo);
  return routing.locales.find((value) => path === `/${value}` || path.startsWith(`/${value}/`) || path.startsWith(`/${value}?`) || path.startsWith(`/${value}#`))
    ?? (routing.locales.includes(fallback as AppLocale) ? fallback : routing.defaultLocale);
}

// 回跳地址用于 OAuth 回调和整页跳转，必须自带语言，避免重新按浏览器语言选站点。
export function getAuthReturnPath(returnTo: string | null | undefined, locale: string): string {
  const path = sanitizeRedirect(returnTo);
  const language = getAuthLocale(path, locale);
  if (routing.locales.some((value) => path === `/${value}` || path.startsWith(`/${value}/`) || path.startsWith(`/${value}?`) || path.startsWith(`/${value}#`))) {
    return path;
  }
  return `/${language}${path === "/" ? "" : path}`;
}

// 外层交给全站 next-intl Link/router 添加语言；redirect 本身保留完整的站内地址。
export function getSignInHref(returnTo: string, locale: string): string {
  return `/auth/sign-in?redirect=${encodeURIComponent(getAuthReturnPath(returnTo, locale))}`;
}
