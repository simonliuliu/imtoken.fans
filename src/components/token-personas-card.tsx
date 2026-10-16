"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

const PERSONAS = ["btc", "eth", "near", "zec", "niulai"] as const;
type Persona = (typeof PERSONAS)[number];

export function TokenPersonasCard({ external = false }: { external?: boolean }) {
  const t = useTranslations("tokenPersonas");
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<Persona | null>(null);

  useEffect(() => {
    if (selected && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [selected]);

  function close() { dialog.current?.close(); }

  return (
    <section className="community-panel token-personas-card">
      <h2>{t("title")}</h2>
      <div className="token-personas-grid">
        {PERSONAS.map((persona) => (
          external ? <a key={persona} href="https://bman.buidl4.top/c/general" aria-label={t("visitPersona", { name: t(`characters.${persona}.name`) })}>
            <Image src={`/images/token-personas/${persona}.png`} width={72} height={72} sizes="64px" alt="" />
            <span>{t(`characters.${persona}.name`)}</span>
          </a> : <button type="button" key={persona} aria-haspopup="dialog" aria-label={t("openPersona", { name: t(`characters.${persona}.name`) })} onClick={(event) => { trigger.current = event.currentTarget; setSelected(persona); }}>
            <Image src={`/images/token-personas/${persona}.png`} width={72} height={72} sizes="64px" alt="" />
            <span>{t(`characters.${persona}.name`)}</span>
          </button>
        ))}
      </div>
      <p className="token-personas-footnote">{t(external ? "externalNotice" : "previewLabel")}</p>
      <dialog ref={dialog} className="token-persona-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onClose={() => { setSelected(null); trigger.current?.focus(); }} onClick={(event) => { if (event.target === dialog.current) close(); }}>
        {selected && <div className="token-persona-dialog-content">
          <button type="button" className="community-icon-button token-persona-close" aria-label={t("close")} onClick={close} autoFocus>×</button>
          <Image src={`/images/token-personas/${selected}.png`} width={120} height={120} sizes="120px" alt="" />
          <h2 id={titleId}>{t("circleTitle", { name: t(`characters.${selected}.name`) })}</h2>
          <p className="token-persona-character">{t(`characters.${selected}.personality`)}</p>
          <span className="community-demo-label">{t("previewLabel")}</span>
          <p id={descriptionId} className="token-persona-description">{t("placeholderNotice")}</p>
          <Link href="/community/discussion" className="community-button community-button-outline" onClick={close}>{t("visitDiscussion")} <span aria-hidden>↗</span></Link>
        </div>}
      </dialog>
    </section>
  );
}
