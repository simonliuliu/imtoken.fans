import { redirect } from "@/i18n/navigation";

// 兼容历史产品列表链接，统一落在现有社区产品分类。
export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/community/feedback?category=builds", locale });
}
