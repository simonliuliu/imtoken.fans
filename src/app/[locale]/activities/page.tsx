import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: t("activitiesTitle"),
    description: t("activitiesDescription"),
  };
}

// Preserve the historical entry while sharing the forum activity navigation.
export default async function ActivitiesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/community/activities?category=checkin", locale });
}
