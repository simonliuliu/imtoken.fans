import { requireAdmin, hasPermission } from "@/lib/admin-guard";
import { getAdminStats, getPendingQueueItems, getSubmissionsForAdmin } from "@/lib/admin-data";
import { ModerationQueuePanel } from "@/components/admin/moderation-queue-panel";
import { SubmissionTable } from "@/components/admin/submission-table";
import { FilterTabs, Pagination, SearchInput } from "@/components/admin/list-controls";
import { AdminPanel, NoPermissionNotice } from "@/components/admin/ui";
import type { SubmissionStatus, SubmissionType } from "@/lib/types";

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待审核" },
  { value: "published", label: "已发布" },
  { value: "rejected", label: "已驳回" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "全部类型" },
  { value: "post", label: "社区帖子" },
  { value: "product", label: "产品" },
  { value: "idea", label: "点子" },
];

// 内容审核完整页：上面是待审核队列，下面是可筛选、可搜索、分页的全部内容记录。
export default async function AdminContentPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string; q?: string; page?: string }>;
}) {
  const profile = await requireAdmin();
  const canModerateSubmissions = hasPermission(profile, "moderate_submissions");
  const canModerateComments = hasPermission(profile, "moderate_comments");

  if (!canModerateSubmissions && !canModerateComments) return <NoPermissionNotice what="内容审核" />;

  const params = await searchParams;
  const status = (params.status ?? "all") as SubmissionStatus | "all";
  const type = (params.type ?? "all") as SubmissionType | "all";
  const q = params.q ?? "";
  const page = Number(params.page ?? "1") || 1;

  const [stats, queueItems, submissions] = await Promise.all([
    getAdminStats(),
    getPendingQueueItems(),
    canModerateSubmissions
      ? getSubmissionsForAdmin({ status, type, q, page, pageSize: PAGE_SIZE })
      : Promise.resolve(null),
  ]);

  const visibleQueueItems = queueItems.filter((item) =>
    item.target_type === "submission" ? canModerateSubmissions : canModerateComments
  );

  return (
    <div className="flex flex-col gap-6">
      <AdminPanel
        title="审核队列"
        count={visibleQueueItems.length}
        description="待人工判定的提交与评论，处理后会从这里消失"
      >
        <ModerationQueuePanel items={visibleQueueItems} />
      </AdminPanel>

      {submissions && (
        <AdminPanel title="全部内容" count={submissions.total} description="已发布 / 待审核 / 已驳回的社区帖子、产品与点子">
          <div className="flex flex-col gap-3">
            <SearchInput placeholder="搜索标题或一句话简介…" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <FilterTabs paramKey="status" options={STATUS_OPTIONS} defaultValue="all" />
              <FilterTabs paramKey="type" options={TYPE_OPTIONS} defaultValue="all" />
            </div>
          </div>

          <div className="mt-4">
            <SubmissionTable submissions={submissions.rows} />
            <Pagination page={submissions.page} pageSize={submissions.pageSize} total={submissions.total} />
          </div>
        </AdminPanel>
      )}

      <p className="text-center font-mono text-[11px] text-faint">
        待审核 {stats.pendingQueue} · 已发布 {stats.publishedSubmissions} · 回收站 {stats.trashItems}
      </p>
    </div>
  );
}
