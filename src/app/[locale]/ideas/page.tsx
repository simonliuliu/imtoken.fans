import { getNow, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getPublishedSubmissionCards } from "@/lib/submissions";
import { IdeaListRow } from "@/components/idea-list-row";

// 点子列表故意不长得像产品列表：产品是"已上线的档案"，点子是"还没做出来的想法"。
// 这里用一列卡片（IdeaListRow）而不是紧凑的排行行，把版面让给标题和内容；
// 名次也不放在这一页——想看排名去 /leaderboard，这一页是个创意流。
export default async function IdeasPage() {
  const t = await getTranslations("ideas");
  const ideas = (await getPublishedSubmissionCards("idea")).sort(
    (a, b) => b.votes_paid + b.votes_creative - (a.votes_paid + a.votes_creative)
  );
  // 相对时间（"3 小时前"）的基准时间在服务端取一次，传给每张卡片：
  // 服务端和浏览器各取一次 Date.now() 会算出不同结果，hydration 就对不上了。
  // getNow() 是 next-intl 提供的"这一次渲染的当前时间"，同一次请求里稳定不变。
  const now = (await getNow()).getTime();

  return (
    <div className="mx-auto max-w-6xl px-4 pb-14 pt-8 sm:px-6">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-extrabold text-ink">{t("title")}</h1>
        <p className="mb-5 mt-1.5 text-sm text-muted">{t("subtitle")}</p>

        {ideas.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-surface-2 p-8 text-center text-sm text-muted">
            {t.rich("empty", {
              submitLink: (chunks) => (
                <Link href="/submit/idea" className="font-medium text-brand-ink hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {ideas.map((submission) => (
              <IdeaListRow key={submission.id} submission={submission} now={now} />
            ))}
          </div>
        )}

        <section className="mt-16 rounded-2xl border border-dashed border-line bg-surface-2 p-6 text-center">
          <p className="font-semibold text-ink">{t("ctaTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("ctaSubtitle")}</p>
          <Link
            href="/submit/idea"
            className="mt-4 inline-block rounded-full bg-brand px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-ink"
          >
            {t("ctaButton")}
          </Link>
        </section>
      </div>
    </div>
  );
}
