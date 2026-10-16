import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { COMMUNITY_EVENTS, getCommunityEvent, type CommunityEventKey } from "@/lib/community-events";
import { EventArt } from "@/components/event-art";

export function generateStaticParams() {
  return COMMUNITY_EVENTS.map((event) => ({ slug: event.slug }));
}

async function eventCopy(key: CommunityEventKey) {
  const t = await getTranslations("events");
  const copy = {
    spark: {
      kind: t("spark.kind"),
      name: t("spark.name"),
      hook: t("spark.hook"),
      lede: t("spark.lede"),
      body: t("spark.body"),
      cta: t("spark.cta"),
    },
    studio: {
      kind: t("studio.kind"),
      name: t("studio.name"),
      hook: t("studio.hook"),
      lede: t("studio.lede"),
      body: t("studio.body"),
      cta: t("studio.cta"),
    },
    notes: {
      kind: t("notes.kind"),
      name: t("notes.name"),
      hook: t("notes.hook"),
      lede: t("notes.lede"),
      body: t("notes.body"),
      cta: t("notes.cta"),
    },
    hearth: {
      kind: t("hearth.kind"),
      name: t("hearth.name"),
      hook: t("hearth.hook"),
      lede: t("hearth.lede"),
      body: t("hearth.body"),
      cta: t("hearth.cta"),
    },
  } as const;
  return copy[key];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const event = getCommunityEvent(slug);
  if (!event) return {};
  const copy = await eventCopy(event.key);
  return { title: `${copy.name} — imToken Fans`, description: copy.hook };
}

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const event = getCommunityEvent(slug);
  if (!event) notFound();
  const copy = await eventCopy(event.key);
  const th = await getTranslations("home");

  return (
    <div className="overflow-hidden pb-20">
      <section className={`event-hero event-card-${event.tone} mx-4 mt-4 overflow-hidden rounded-[2rem] px-6 py-16 sm:mx-6 sm:px-12 sm:py-20 lg:mx-auto lg:max-w-6xl`}>
        <EventArt tone={event.tone} />
        <p className="event-kind">{copy.kind}</p>
        <h1 className="event-name font-display mt-6 max-w-3xl text-5xl sm:text-7xl">{copy.name}</h1>
        <p className="event-hook mt-5 max-w-xl text-lg leading-8">{copy.hook}</p>
      </section>
      <article className="mx-auto mt-12 max-w-3xl px-4 sm:px-6">
        <p className="text-lg leading-8 text-ink">{copy.lede}</p>
        <p className="mt-6 text-base leading-8 text-muted">{copy.body}</p>
        <Link
          href={event.href}
          className="mt-10 inline-flex rounded-full bg-ink px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-ink"
        >
          {copy.cta}
        </Link>
        <p className="mt-8">
          <Link href="/" className="text-sm font-semibold text-brand-ink hover:underline">
            {th("backHome")}
          </Link>
        </p>
      </article>
    </div>
  );
}
