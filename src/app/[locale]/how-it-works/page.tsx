import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocsShell, EditorialSection, CommunityGuideEntrances } from "@/components/editorial-page";

export async function generateMetadata(): Promise<Metadata> {
  const tMeta = await getTranslations("meta");
  return { title: tMeta("howTitle"), description: tMeta("howDescription") };
}

export default async function HowItWorksPage() {
  const t = await getTranslations("howItWorks");
  return (
    <DocsShell eyebrow={t("eyebrow")} title={t("title")} intro={t("intro")}>
      <CommunityGuideEntrances />
      <EditorialSection title={t("makerTitle")}>
        <Steps items={[t("maker1"), t("maker2"), t("maker3"), t("maker4")]} />
      </EditorialSection>
      <EditorialSection title={t("memberTitle")}>
        <Steps items={[t("member1"), t("member2"), t("member3"), t("member4")]} />
      </EditorialSection>
      <EditorialSection title={t("feedbackTitle")}>
        <p>{t("feedbackBody")}</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>{t("feedback1")}</li>
          <li>{t("feedback2")}</li>
          <li>{t("feedback3")}</li>
          <li>{t("feedback4")}</li>
        </ul>
      </EditorialSection>
      <EditorialSection title={t("followTitle")}>
        <p>{t("followBody")}</p>
      </EditorialSection>
      <EditorialSection title={t("selectionTitle")}>
        <p>{t("selectionBody")}</p>
      </EditorialSection>
    </DocsShell>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="grid gap-3 sm:grid-cols-2">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3 rounded-2xl bg-surface-2 p-4">
          <span className="font-mono text-xs font-bold text-brand-ink">0{index + 1}</span>
          <span className="text-sm leading-6 text-muted">{item}</span>
        </li>
      ))}
    </ol>
  );
}
