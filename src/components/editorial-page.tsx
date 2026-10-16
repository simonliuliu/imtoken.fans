import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { DocLink } from "@/components/doc-link";

export async function DocsShell({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  const t = await getTranslations("docs");
  const nav = [
    { href: "/about", label: t("about") },
    { href: "/how-it-works", label: t("how") },
    { href: "/for-makers", label: t("makers") },
    { href: "/for-testers", label: t("testers") },
    { href: "/faq", label: t("faq") },
    { href: "/community-guidelines", label: t("guidelines") },
  ];

  return (
    <EditorialPage eyebrow={eyebrow} title={title} intro={intro} nav={nav}>
      {children}
    </EditorialPage>
  );
}

export async function EditorialPage({
  eyebrow,
  title,
  intro,
  nav,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  nav: { href: string; label: string }[];
  children: ReactNode;
}) {
  const t = await getTranslations("docs");
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[13rem_1fr] lg:py-16">
      <aside className="lg:sticky lg:top-28 lg:h-fit">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[.18em] text-brand-ink">{t("brand")}</p>
        <nav className="mt-5 flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
          {nav.map((item) => (
            <DocLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
      </aside>
      <article className="min-w-0">
        <header className="border-b border-line pb-10">
          <p className="font-mono text-xs font-bold uppercase tracking-[.18em] text-brand-ink">{eyebrow}</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-extrabold tracking-[-.035em] text-ink sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-3xl text-base leading-8 text-muted">{intro}</p>
        </header>
        <div className="editorial-content">{children}</div>
      </article>
    </div>
  );
}

export function EditorialSection({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 border-b border-line py-9 last:border-0">
      <h2 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-7 text-muted">{children}</div>
    </section>
  );
}


export async function CommunityGuideEntrances() {
  const t = await getTranslations("docs");
  const sections = ["safety", "feedback", "discussion", "activities"] as const;
  return (
    <EditorialSection title={t("sectionsTitle")}>
      <p>{t("sectionsIntro")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section} href={`/community/${section}`} className="rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">
            <h3 className="font-bold text-ink">{t(section)} <span aria-hidden="true">→</span></h3>
            <p className="mt-2 text-sm leading-6 text-muted">{t(`${section}Body`)}</p>
          </Link>
        ))}
      </div>
    </EditorialSection>
  );
}
