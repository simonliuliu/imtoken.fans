"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth-context";
import { Composer } from "@/components/community-elements";
import { ProductSubmissionForm } from "@/components/product-submission-form";

export function PublishPage() {
  const t = useTranslations("publishPage");
  const tc = useTranslations("community");
  const params = useSearchParams();
  const router = useRouter();
  const { user, sessionEpoch } = useAuth();
  const requested = params.get("type");
  const type = requested === "feedback" || requested === "product" || requested === "idea" ? requested : "post";
  return <main id="main-content" tabIndex={-1} className="community-page">
    <div className="publish-shell">
      <nav className="community-breadcrumb" aria-label={tc("breadcrumb")}><Link href="/">{tc("home")}</Link><span aria-hidden>/</span><span>{t("title")}</span></nav>
      <h1 className="text-3xl font-extrabold text-ink">{t("title")}</h1>
      <label className="publish-category">{t("category")}
        <select value={type} onChange={(event) => router.replace(`/submit?type=${event.target.value}`, { scroll: false })}>
          {["post", "feedback", "product", ...(type === "idea" ? ["idea"] : [])].map((value) => <option key={value} value={value}>{t(value)}</option>)}
        </select>
      </label>
      <div hidden={type !== "post"}><Composer key={`post:${user?.id ?? "anonymous"}:${sessionEpoch}`} pageMode="post" owner={user?.id ?? null} /></div>
      <div hidden={type !== "feedback"}><Composer key={`feedback:${user?.id ?? "anonymous"}:${sessionEpoch}`} pageMode="feedback" owner={user?.id ?? null} /></div>
      {type !== "idea" && <div hidden={type !== "product"}><ProductSubmissionForm fixedType="product" /></div>}
      {type === "idea" && <ProductSubmissionForm fixedType="idea" />}

    </div>
  </main>;
}
