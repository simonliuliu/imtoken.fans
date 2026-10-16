import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { createClient } from "@/lib/supabase/server";
import { getAuthLocale, getAuthReturnPath, getSignInHref } from "@/lib/auth-navigation";
import { mirrorExternalAvatar } from "@/lib/avatar-mirror";

// Google OAuth 和邮箱确认链接都会跳回这里，带一个 `code` 参数用来换取真实 session。
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  const locale = getAuthLocale(searchParams.get("redirect"), cookieLocale ?? routing.defaultLocale);
  const redirectTo = getAuthReturnPath(searchParams.get("redirect"), locale);

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // 第一次登录（onboarded_at 还是 null）的先送去引导页完善资料，之后再回原来要去的地方。
      // Google 登录尤其需要：它带过来的用户名是 full_name 自动 slug 化的结果，头像也未必有。
      if (data.user) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("onboarded_at, avatar_url")
          .eq("id", data.user.id)
          .maybeSingle();
        // Google 的头像是外链，浏览器直连不一定拉得到，登录时顺手镜像到自己的 Storage。
        // 只有第一次（avatar_url 还指向站外）会真的走网络，之后就直接跳过了。
        await mirrorExternalAvatar(data.user.id, profile?.avatar_url);
        if (profile && profile.onboarded_at === null) {
          return NextResponse.redirect(`${origin}${getAuthReturnPath(`/welcome?redirect=${encodeURIComponent(redirectTo)}`, locale)}`);
        }
      }
      return NextResponse.redirect(`${origin}${redirectTo}`);
    }
  }

  // 回调不挂在 [locale] 段下，优先沿用安全回跳地址中的语言，再回退语言 cookie。
  const t = await getTranslations({ locale, namespace: "errors" });

  return NextResponse.redirect(
    `${origin}${getAuthReturnPath(getSignInHref(redirectTo, locale), locale)}&error=${encodeURIComponent(t("signInVerifyFailed"))}`
  );
}
