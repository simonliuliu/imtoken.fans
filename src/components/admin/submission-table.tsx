"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteSubmission, setSubmissionStatus } from "@/app/admin/actions";
import { EmptyState, StatusPill, TimeAgo, TypePill } from "@/components/admin/ui";
import type { SubmissionCard, SubmissionStatus } from "@/lib/types";

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  published: "已发布",
  pending: "待审核",
  rejected: "已驳回",
};

export function SubmissionTable({
  submissions: initialSubmissions,
  showActions = true,
}: {
  submissions: SubmissionCard[];
  showActions?: boolean;
}) {
  const router = useRouter();
  // 服务端分页之后每次翻页都会换一批数据，所以不能把整份列表灌进 useState
  // （那样翻页后还显示旧数据）。只把「本地已经改过的部分」记在 state 里，叠在 props 上。
  const [statusPatch, setStatusPatch] = useState<Record<string, SubmissionStatus>>({});
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submissions = initialSubmissions
    .filter((s) => !deletedIds.includes(s.id))
    .map((s) => (statusPatch[s.id] ? { ...s, status: statusPatch[s.id] } : s));

  function handleSetStatus(id: string, status: SubmissionStatus) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await setSubmissionStatus(id, status);
      setPendingId(null);
      if (result.error) {
        setError(result.error);
        return;
      }
      setStatusPatch((prev) => ({ ...prev, [id]: status }));
      router.refresh();
    });
  }

  function handleDelete(submission: SubmissionCard) {
    const reason = window.prompt(`删除「${submission.title}」后进入回收站，7 天内可恢复。\n删除理由（可留空）：`);
    // prompt 返回 null = 点了取消，返回 "" = 确认但没填理由，这两个要区分开。
    if (reason === null) return;

    setError(null);
    setPendingId(submission.id);
    startTransition(async () => {
      const result = await deleteSubmission(submission.id, reason);
      setPendingId(null);
      if (result.error) {
        setError(result.error);
        return;
      }
      setDeletedIds((prev) => [...prev, submission.id]);
      router.refresh();
    });
  }

  if (submissions.length === 0) return <EmptyState>没有符合条件的内容。</EmptyState>;

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-xs text-risk">{error}</p>}
      {submissions.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <TypePill type={s.type} />
              <StatusPill status={s.status} />
              <span className="font-mono text-[11px] text-faint">
                {s.is_example ? "示例作者" : s.submitted_by_username ?? "未知用户"} · <TimeAgo iso={s.created_at} />
              </span>
            </div>
            <Link
              href={`/${s.type === "post" ? `community/${s.community_section}/${s.legacy_slug ?? s.id}` : `${s.type === "product" ? "products" : "ideas"}/${s.id}`}`}
              className="mt-1 block truncate text-sm font-medium text-ink transition-colors hover:text-brand-ink"
              title={s.title}
            >
              {s.title}
            </Link>
            <p className="truncate text-xs text-muted">{s.tagline}</p>
          </div>

          {showActions && (
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {(["published", "pending", "rejected"] as const)
                .filter((status) => status !== s.status)
                .map((status) => (
                  <button
                    key={status}
                    type="button"
                    disabled={isPending && pendingId === s.id}
                    onClick={() => handleSetStatus(s.id, status)}
                    className="rounded-full border border-line px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    设为{STATUS_LABEL[status]}
                  </button>
                ))}
              <button
                type="button"
                disabled={isPending && pendingId === s.id}
                onClick={() => handleDelete(s)}
                className="rounded-full border border-risk px-3 py-1 text-xs font-medium text-risk transition-colors hover:bg-risk hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                删除
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
