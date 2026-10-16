import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

export default async function LegacyIdeaSubmitPage() {
  redirect({ href: "/submit/product", locale: await getLocale() });
}
