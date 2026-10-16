"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";

const LOCALE_LABEL: Record<AppLocale, string> = {
  zh: "中",
  en: "EN",
};

export function LanguageSwitcher() {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="flex shrink-0 items-center rounded-full border border-line bg-surface-2 p-0.5 text-xs font-semibold">
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => router.replace(`${pathname}${window.location.search}${window.location.hash}`, { locale: l })}
          aria-current={locale === l}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            locale === l ? "bg-brand text-white" : "text-muted hover:text-ink"
          }`}
        >
          {LOCALE_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
