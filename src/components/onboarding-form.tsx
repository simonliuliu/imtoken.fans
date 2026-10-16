"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { completeOnboarding, skipOnboarding } from "@/app/actions/profile";
import { useAuth } from "@/lib/auth-context";
import { ProfileFields, type ProfileFieldsValue } from "@/components/profile-fields";

export function OnboardingForm({
  redirectTo,
  initialDisplayName,
  initialUsername,
  initialBio,
  initialExpertise,
  initialAvatarUrl,
}: {
  redirectTo: string;
  initialDisplayName: string;
  initialUsername: string;
  initialBio: string;
  initialExpertise: string[];
  initialAvatarUrl: string | null;
}) {
  const t = useTranslations("welcome");
  const tc = useTranslations("common");
  const router = useRouter();
  const { refreshProfile } = useAuth();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<ProfileFieldsValue>({
    displayName: initialDisplayName,
    username: initialUsername,
    bio: initialBio,
    expertise: initialExpertise,
    avatarPath: null,
    avatarPreview: initialAvatarUrl,
  });
  const [intents, setIntents] = useState<string[]>([]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await completeOnboarding({
        displayName: fields.displayName,
        username: fields.username,
        bio: fields.bio,
        expertise: fields.expertise,
        intents,
        avatarPath: fields.avatarPath ?? undefined,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      await refreshProfile();
      router.replace(redirectTo);
    });
  }

  function handleSkip() {
    setError(null);
    startTransition(async () => {
      const result = await skipOnboarding();
      if (result.error) {
        setError(result.error);
        return;
      }
      router.replace(redirectTo);
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <fieldset className="mb-6">
        <legend className="text-sm font-semibold text-ink">{t("intentLabel")}</legend>
        <p className="mt-1 text-xs text-muted">{t("intentHint")}</p>
        <div className="mt-3 flex flex-col gap-2">
          {([
            { id: "maker", label: t("intentMaker") },
            { id: "tester", label: t("intentTester") },
            { id: "idea", label: t("intentIdea") },
          ] as const).map((option) => {
            const active = intents.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                disabled={isPending}
                onClick={() =>
                  setIntents((current) =>
                    current.includes(option.id) ? current.filter((item) => item !== option.id) : [...current, option.id],
                  )
                }
                className={`rounded-2xl border px-4 py-3 text-left text-sm font-semibold transition ${
                  active ? "border-brand bg-brand-soft text-brand-ink" : "border-line bg-surface-2/60 text-ink hover:border-brand/40"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <ProfileFields value={fields} onChange={setFields} disabled={isPending} />

      {error && <p className="mt-4 text-sm text-risk">{error}</p>}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleSkip}
          disabled={isPending}
          className="rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-60"
        >
          {t("skip")}
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-full bg-brand px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? tc("saving") : t("finish")}
        </button>
      </div>
    </form>
  );
}
