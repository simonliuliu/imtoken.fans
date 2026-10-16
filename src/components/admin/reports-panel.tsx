"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { resolveCommentReport } from "@/app/admin/actions";
import { EmptyState, TimeAgo } from "@/components/admin/ui";
import type { CommentReportRow } from "@/lib/admin-data";
import {
  COMMENT_REPORT_REASON_LABEL,
  COMMENT_REPORT_STATUS_LABEL,
  MUTE_PRESETS,
  type MuteDuration,
} from "@/lib/types";

const STATUS_STYLE: Record<string, string> = {
  open: "bg-warn-soft text-warn",
  resolved: "bg-good-soft text-good",
  dismissed: "bg-surface text-muted",
};

export function ReportsPanel({ reports: initialReports }: { reports: CommentReportRow[] }) {
  const router = useRouter();
  const [handledIds, setHandledIds] = useState<string[]>([]);
  const [openFormId, setOpenFormId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const reports = initialReports.filter((report) => !handledIds.includes(report.id));

  function submit(reportId: string, input: Parameters<typeof resolveCommentReport>[1]) {
    setError(null);
    setPendingId(reportId);
    startTransition(async () => {
      const result = await resolveCommentReport(reportId, input);
      setPendingId(null);
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpenFormId(null);
      setHandledIds((prev) => [...prev, reportId]);
      router.refresh();
    });
  }

  if (reports.length === 0) return <EmptyState>这里没有举报记录。</EmptyState>;

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-xs text-risk">{error}</p>}

      {reports.map((report) => {
        const busy = isPending && pendingId === report.id;
        return (
          <div key={report.id} className="rounded-xl bg-surface-2 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-risk-soft px-2 py-0.5 font-mono text-[10px] font-medium text-risk">
                    {COMMENT_REPORT_REASON_LABEL[report.reason]}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${STATUS_STYLE[report.status]}`}
                  >
                    {COMMENT_REPORT_STATUS_LABEL[report.status]}
                  </span>
                  {report.comment_deleted && (
                    <span className="rounded-full bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
                      {report.comment_id === null ? "评论已彻底清除" : "评论已删除"}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-faint">
                    举报人 {report.reporter_username ?? "未知用户"} · <TimeAgo iso={report.created_at} />
                  </span>
                </div>

                {report.submission_id && report.submission_type && (
                  <Link
                    href={report.submission_href ?? "#"}
                    className="mt-1 block truncate text-xs text-muted transition-colors hover:text-brand-ink"
                  >
                    来自：{report.submission_title ?? "（内容已删除）"}
                  </Link>
                )}

                <p className="mt-1 line-clamp-3 text-sm text-ink" title={report.comment_body}>
                  {report.comment_body}
                </p>
                <p className="mt-0.5 text-xs text-faint">
                  评论作者：{report.comment_author_username ?? "已注销用户"}
                  {report.comment_author_muted_until &&
                  new Date(report.comment_author_muted_until) > new Date() ? (
                    <span className="ml-1.5 text-risk">（已被禁言）</span>
                  ) : null}
                </p>

                {report.status !== "open" && (
                  <p className="mt-1.5 rounded-lg bg-surface px-2.5 py-1.5 text-xs text-muted">
                    {report.resolution ?? "已处理"}
                    {report.reviewer_username && ` · 处理人 ${report.reviewer_username}`}
                    {report.reviewed_at && (
                      <>
                        {" · "}
                        <TimeAgo iso={report.reviewed_at} />
                      </>
                    )}
                  </p>
                )}
              </div>

              {report.status === "open" && (
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => submit(report.id, { decision: "dismiss" })}
                    className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-brand hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    驳回举报
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setOpenFormId(openFormId === report.id ? null : report.id)}
                    className="rounded-full bg-risk px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {openFormId === report.id ? "取消" : "通过并处置"}
                  </button>
                </div>
              )}
            </div>

            {openFormId === report.id && (
              <ResolveForm
                busy={busy}
                commentAlreadyDeleted={report.comment_deleted}
                commentMissing={report.comment_id === null}
                onSubmit={(input) => submit(report.id, { decision: "accept", ...input })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// 「通过」之后具体怎么处置：删评论、禁言、或者两者都做。两个开关互相独立——
// 有的举报只需要删掉内容，有的（反复刷屏）还要顺手禁言作者。
function ResolveForm({
  busy,
  commentAlreadyDeleted,
  commentMissing,
  onSubmit,
}: {
  busy: boolean;
  commentAlreadyDeleted: boolean;
  // 评论已经被回收站清理程序彻底删掉了：没有删除对象，也查不到作者，只能记个结论。
  commentMissing: boolean;
  onSubmit: (input: { deleteComment: boolean; muteDuration: MuteDuration | null; note?: string }) => void;
}) {
  const [deleteComment, setDeleteComment] = useState(!commentAlreadyDeleted && !commentMissing);
  const [muteDuration, setMuteDuration] = useState<string>("");
  const [note, setNote] = useState("");

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
      {commentMissing && (
        <p className="text-xs text-muted">这条评论已经被彻底清除，无法再删除或禁言作者，只能记录处理结论。</p>
      )}

      <label className={`flex items-center gap-2 text-xs text-ink ${commentMissing ? "hidden" : ""}`}>
        <input
          type="checkbox"
          checked={deleteComment}
          disabled={busy || commentAlreadyDeleted}
          onChange={(event) => setDeleteComment(event.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--brand)]"
        />
        删除这条评论（进回收站，7 天内可恢复）
        {commentAlreadyDeleted && <span className="text-faint">— 已经删除过了</span>}
      </label>

      <div className={`flex flex-wrap items-center gap-2 ${commentMissing ? "hidden" : ""}`}>
        <span className="text-xs text-ink">禁言作者</span>
        <select
          value={muteDuration}
          disabled={busy}
          onChange={(event) => setMuteDuration(event.target.value)}
          className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink"
        >
          <option value="">不禁言</option>
          {MUTE_PRESETS.map((preset) => (
            <option key={String(preset.value)} value={String(preset.value)}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <input
        value={note}
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
        placeholder="处理备注（可留空，会记在处理结果里）"
        className="rounded-xl border border-line bg-surface px-3 py-1.5 text-xs text-ink placeholder:text-faint focus:border-brand focus:outline-none"
      />

      <button
        type="button"
        disabled={busy}
        onClick={() =>
          onSubmit({
            deleteComment,
            // select 的 value 是字符串，"permanent" 之外的都是天数，转回 MuteDuration。
            muteDuration: muteDuration === "" ? null : muteDuration === "permanent" ? "permanent" : (Number(muteDuration) as MuteDuration),
            note,
          })
        }
        className="self-start rounded-full bg-risk px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        确认处置
      </button>
    </div>
  );
}
