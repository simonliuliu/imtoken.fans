import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { BrandLogo } from "@/components/brand-logo";

export async function SiteFooter() {
  const t = await getTranslations("footer");
  return (
    <footer className="fans-footer">
      <div className="fans-container">
        <div className="fans-footer-top">
          <div><Link href="/" className="fans-brand"><BrandLogo /></Link><p>{t("description")}</p></div>
          <nav aria-label={t("navigation")}>
            <Link href="/about">{t("about")}</Link>
            <Link href="/how-it-works">{t("howItWorks")}</Link>
            <Link href="/community-guidelines">{t("guidelines")}</Link>
            <Link href="/faq">{t("faq")}</Link>
          </nav>
        </div>
        <div className="fans-footer-bottom"><p>{t("copyright", { year: 2026 })}</p><p>{t("previewVersion")}</p></div>
      </div>
    </footer>
  );
}
