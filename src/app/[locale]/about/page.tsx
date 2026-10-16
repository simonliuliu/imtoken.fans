import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocsShell, EditorialSection, CommunityGuideEntrances } from "@/components/editorial-page";

export async function generateMetadata(): Promise<Metadata> {
  const tMeta = await getTranslations("meta");
  return { title: tMeta("aboutTitle"), description: tMeta("aboutDescription") };
}

export default async function AboutPage() {
  const t = await getTranslations("about");
  return (
    <DocsShell eyebrow={t("eyebrow")} title={t("title")} intro={t("intro")}>
      <CommunityGuideEntrances />
      <EditorialSection title={t("whyTitle")}>
        <p>{t("whyBody1")}</p>
        <p>{t("whyBody2")}</p>
      </EditorialSection>
      <EditorialSection title={t("peopleTitle")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <RoleCard icon="✦" title={t("makersTitle")} body={t("makersBody")} />
          <RoleCard icon="◎" title={t("membersTitle")} body={t("membersBody")} />
        </div>
      </EditorialSection>
      <EditorialSection title={t("relationshipTitle")}>
        <p>{t("relationshipBody1")}</p>
        <p>{t("relationshipBody2")}</p>
        <div className="rounded-2xl border border-brand/20 bg-brand-soft p-5 text-brand-ink">{t("relationshipNote")}</div>
      </EditorialSection>
      <EditorialSection title={t("notTitle")}>
        <ul className="list-disc space-y-2 pl-5">
          <li>{t("not1")}</li>
          <li>{t("not2")}</li>
          <li>{t("not3")}</li>
          <li>{t("not4")}</li>
        </ul>
      </EditorialSection>
      <EditorialSection title={t("promiseTitle")}>
        <p>{t("promiseBody")}</p>
      </EditorialSection>
    </DocsShell>
  );
}

function RoleCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <span className="text-xl">{icon}</span>
      <h3 className="mt-4 font-bold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
    </div>
  );
}
