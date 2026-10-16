import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import "./globals.css";

// 根 layout 也要走 next-intl：/admin 不在 [locale] 段下，那里 getLocale() 会退回
// 默认语言（中文），正好是后台想要的；前台页面拿到的是 URL 上的语言。
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:4000"),
    applicationName: "imToken Fans",
    title: t("homeTitle"),
    description: t("homeDescription"),
    openGraph: { type: "website", siteName: "imToken Fans" },
    twitter: { card: "summary_large_image" },
  };
}

// 真正的根 layout：只负责 <html>/<body> 和字体变量。管理后台（/admin）不挂在 [locale] 段下，
// 也要走这层，所以这里不能放 NextIntlClientProvider / SiteHeader 这些「面向普通用户」的东西
// ——那些放在 app/[locale]/layout.tsx 里，只包住真正需要双语的页面。
export default async function RootLayout({ children }: LayoutProps<"/">) {
  // <html lang> 必须跟着当前语言变：读屏、翻译工具、搜索引擎都靠它。
  const locale = await getLocale();

  return (
    <html lang={locale} className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-bg text-ink">{children}</body>
    </html>
  );
}
