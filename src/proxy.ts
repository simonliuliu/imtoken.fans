import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 把 middleware.ts 改名成了 proxy.ts（文件必须放在 src/ 下，和 app/ 同级）。
const handleI18nRouting = createIntlMiddleware(routing);

// 管理后台 / API / OAuth 回调 / 生成的 metadata 图片不挂在 [locale] 段下（后台只做中文，回调是纯跳转、没有 UI），
// 这几类路径要跳过 next-intl 的语言重定向，否则会被错误地重定向成 /zh/admin 这种不存在的路由。
function isExcludedFromI18nRouting(pathname: string): boolean {
  return pathname.startsWith("/admin") || pathname.startsWith("/api") || pathname.startsWith("/auth/callback")
    || ["/icon", "/apple-icon", "/opengraph-image"].includes(pathname);
}

// next-intl 的 Link 会给所有 href 加上当前语言前缀，菜单里的 /admin 会变成 /zh/admin。
// [locale] 下面没有 admin 页面，必须在进路由之前剥掉前缀，否则直接 404。
function stripLocalePrefixFromAdmin(pathname: string): string | null {
  for (const locale of routing.locales) {
    const prefix = `/${locale}/admin`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return pathname.slice(`/${locale}`.length);
    }
  }
  return null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const unprefixedAdmin = stripLocalePrefixFromAdmin(pathname);
  if (unprefixedAdmin) {
    const url = request.nextUrl.clone();
    url.pathname = unprefixedAdmin;
    return updateSession(request, NextResponse.redirect(url));
  }

  const response = isExcludedFromI18nRouting(pathname)
    ? NextResponse.next({ request })
    : handleI18nRouting(request);

  // 无论走哪条分支，Supabase 的 session 刷新都要做——不然后台/回调页面登录状态刷新不到。
  return updateSession(request, response);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
