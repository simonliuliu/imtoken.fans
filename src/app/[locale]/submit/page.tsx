import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

// Preserve legacy links while using the latest dedicated publishing pages.
export default async function SubmitPage({ searchParams }: { searchParams: Promise<{ type?: string | string[]; composeFeedback?: string; section?: string }> }) {
  const query = await searchParams;
  const target = query.type === "feedback" ? "/submit/feedback" : query.type === "product" || query.type === "idea" ? "/submit/product" : "/submit/post";
  const suffix = target === "/submit/feedback" && query.composeFeedback === "1" ? "?resume=1" : "";
  redirect({ href: `${target}${suffix}`, locale: await getLocale() });
}
