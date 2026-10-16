"use client";

import { useTranslations } from "next-intl";

export function CommunityOrbit() {
  const t = useTranslations("home");

  return (
    <div className="community-orbit relative mx-auto aspect-square w-full max-w-[420px] select-none lg:max-w-[460px]" aria-label={t("orbitLabel")}>
      <div className="orbit-glow absolute inset-[12%] rounded-full bg-brand/15 blur-3xl" aria-hidden />
      <div className="orbit-ring orbit-ring-one absolute inset-[8%] rounded-full border border-white/50" aria-hidden />
      <div className="orbit-ring orbit-ring-two absolute inset-[21%] rounded-full border border-dashed border-white/40" aria-hidden />
      <div className="orbit-center absolute left-1/2 top-1/2 flex h-32 w-32 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-[2.2rem] border border-white/90 bg-white/80 text-center shadow-2xl shadow-blue-900/10 backdrop-blur-xl sm:h-36 sm:w-36">
        <span className="text-2xl">✦</span>
        <strong className="mt-2 font-display text-lg text-ink">imToken Fans</strong>
        <span className="mt-1 px-3 text-[11px] font-semibold leading-4 text-brand-ink">{t("orbitCenter")}</span>
      </div>
      <OrbitCard className="left-[0%] top-[16%]" emoji="🧠" label={t("orbitIdea")} tone="blue" />
      <OrbitCard className="right-[-2%] top-[24%]" emoji="🛠️" label={t("orbitMaker")} tone="violet" />
      <OrbitCard className="bottom-[12%] left-[4%]" emoji="💬" label={t("orbitFeedback")} tone="green" />
      <OrbitCard className="bottom-[2%] right-[8%]" emoji="↗" label={t("orbitUpdate")} tone="orange" />
      <div className="orbit-dot orbit-dot-one absolute h-3 w-3 rounded-full bg-brand shadow-[0_0_0_6px_rgba(59,130,246,.12)]" aria-hidden />
      <div className="orbit-dot orbit-dot-two absolute h-2 w-2 rounded-full bg-cyan-500" aria-hidden />
    </div>
  );
}

function OrbitCard({
  className,
  emoji,
  label,
  tone,
}: {
  className: string;
  emoji: string;
  label: string;
  tone: "blue" | "violet" | "green" | "orange";
}) {
  const tones = {
    blue: "border-blue-200 bg-blue-50/90",
    violet: "border-violet-200 bg-violet-50/90",
    green: "border-emerald-200 bg-emerald-50/90",
    orange: "border-orange-200 bg-orange-50/90",
  };
  return (
    <div
      className={`orbit-card absolute flex items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-xs font-bold text-ink shadow-lg shadow-slate-900/10 backdrop-blur ${tones[tone]} ${className}`}
    >
      <span className="text-base">{emoji}</span>
      {label}
    </div>
  );
}
