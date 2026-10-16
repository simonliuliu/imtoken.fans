"use client";

import { useTranslations } from "next-intl";

export function AuthLoading({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("common");
  return (
    <div
      role="status"
      aria-live="polite"
      className={compact ? "text-xs text-faint" : "mx-auto max-w-sm px-4 py-24 text-center text-sm text-faint"}
    >
      {t("loading")}
    </div>
  );
}
