"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Avatar } from "@/components/avatar";
import { usePathname } from "@/i18n/navigation";
import {
  deleteComment,
  postComment,
  reportComment,
  toggleCommentPin,
  toggleCommentVote,
} from "@/app/actions/comments";
import { searchUsersForMention, type MentionCandidate } from "@/app/actions/users";
import { splitCommentBodyByMentions } from "@/lib/mentions";
import {
  COMMENT_REPORT_REASON_LABEL,
  commentReportReasonLabel,
  type CommentReportReason,
  type CommentWithAuthor,
  type UserTagKey,
} from "@/lib/types";
import { UserBadgeInline } from "@/components/user-badge-inline";
import { UserHoverCard } from "@/components/user-hover-card";
import { Modal } from "@/components/modal";
import { getSignInHref } from "@/lib/auth-navigation";
import { useAuth } from "@/lib/auth-context";
import { AuthLoading } from "@/components/auth-loading";

const REPORT_REASONS = Object.keys(COMMENT_REPORT_REASON_LABEL) as CommentReportReason[];
const REPLIES_PER_PAGE = 10;

export function CommentForm({
  submissionId,
  parentId,
  autoFocus,
  initialBody = "",
  onPosted,
}: {
  submissionId: string;
  isLoggedIn: boolean;
  parentId?: string;
  autoFocus?: boolean;
  initialBody?: string;
  onPosted?: (comment?: CommentWithAuthor) => void;
}) {
  const t = useTranslations("comments");
  const locale = useLocale();
  const { user, loading } = useAuth();
  const isLoggedIn = Boolean(user);
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionToken, setMentionToken] = useState<string | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);

  useEffect(() => {
    if (mentionToken === null) return;
    const handle = setTimeout(async () => {
      const results = await searchUsersForMention(mentionToken);
      setMentionCandidates(results);
    }, 200);
    return () => clearTimeout(handle);
  }, [mentionToken]);

  function handleBodyChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setBody(value);

    const cursor = e.target.selectionStart;
    const uptoCursor = value.slice(0, cursor);
    const match = uptoCursor.match(/@([a-z0-9_]{0,20})$/i);
    if (match) {
      setMentionStart(cursor - match[0].length);
      setMentionToken(match[1]);
    } else {
      setMentionStart(null);
      setMentionToken(null);
      setMentionCandidates([]);
    }
  }

  function handleSelectMention(username: string) {
    if (mentionStart === null || !textareaRef.current) return;
    const cursor = textareaRef.current.selectionStart ?? body.length;
    const before = body.slice(0, mentionStart);
    const after = body.slice(cursor);
    const next = `${before}@${username} ${after}`;
    setBody(next);
    setMentionStart(null);
    setMentionToken(null);
    setMentionCandidates([]);

    requestAnimationFrame(() => {
      const pos = before.length + username.length + 2;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await postComment(submissionId, body, pathname, parentId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setBody("");
      // 新评论整行交给 CommentSection 先插进本地列表，用户不用等服务端往返就能看到自己发的内容；
      // 服务端 revalidate 追上后会按 id 去重（见 comment-section.tsx 的 merged）。
      onPosted?.(result.comment);
    });
  }

  if (loading) return <AuthLoading compact />;

  return (
    <form onSubmit={handleSubmit} className="relative">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={handleBodyChange}
        disabled={!isLoggedIn || isPending}
        autoFocus={autoFocus}
        rows={2}
        placeholder={
          isLoggedIn
            ? parentId
              ? t("placeholderReply")
              : t("placeholder")
            : t("placeholderSignedOut")
        }
        className="w-full resize-none rounded-xl border border-line bg-bg px-3.5 py-2.5 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none disabled:opacity-70"
      />

      {mentionCandidates.length > 0 && (
        <div className="absolute z-20 mt-1 w-64 max-w-full overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
          {mentionCandidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelectMention(candidate.username)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2"
            >
              <Avatar
                src={candidate.avatarUrl}
                name={candidate.username}
                className="h-6 w-6 rounded-full bg-surface-2 font-display text-[10px] font-bold text-muted"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">
                  {candidate.displayName || candidate.username}
                </span>
                <span className="block truncate font-mono text-[11px] text-faint">@{candidate.username}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-risk">{error}</p>}
      <div className="mt-2 flex justify-end">
        {!isLoggedIn ? (
          <Link href={getSignInHref(`${pathname}#comments`, locale)} className="rounded-full bg-brand px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink">
            {t("placeholderSignedOut")}
          </Link>
        ) : <button
          type="submit"
          disabled={!isLoggedIn || isPending || body.trim().length < 2}
          className="rounded-full bg-brand px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? t("posting") : parentId ? t("reply") : t("post")}
        </button>}
      </div>
    </form>
  );
}

// 一个话题 = 顶层评论 + 它下面所有回复。参照 Product Hunt：不套卡片边框，
// 层级完全靠头像下方那条竖线和拐向回复的曲线来表达。
export function CommentItem({
  comment,
  replies,
  submissionId,
  isLoggedIn,
  canModerate,
  canPin,
  tagsByUser,
  onPosted,
  onPinned,
}: {
  comment: CommentWithAuthor;
  replies: CommentWithAuthor[];
  submissionId: string;
  isLoggedIn: boolean;
  canModerate: boolean;
  canPin: boolean;
  tagsByUser: Record<string, UserTagKey[]>;
  onPosted?: (comment?: CommentWithAuthor) => void;
  onPinned?: (commentId: string, pinnedAt: string | null) => void;
}) {
  const t = useTranslations("comments");
  // null = 没在回复；否则是被回复者的用户名（空串表示直接回复顶层评论）。
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  // 只把「本地已删掉的 id」放进 state，列表本身始终从 props 派生。
  // 之前这里写的是 useState(replies)——useState 只认第一次的初始值，
  // 发完回复后服务端 revalidate 回来的新数据被这个陈旧 state 挡住了，
  // 必须整页刷新（组件重新挂载）才看得到新回复。
  const [deletedReplyIds, setDeletedReplyIds] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [page, setPage] = useState(1);

  if (deleted) return null;

  const visibleReplies = replies.filter((r) => !deletedReplyIds.has(r.id));
  const hasReplies = visibleReplies.length > 0;
  const totalPages = Math.max(1, Math.ceil(visibleReplies.length / REPLIES_PER_PAGE));
  const pagedReplies = visibleReplies.slice((page - 1) * REPLIES_PER_PAGE, page * REPLIES_PER_PAGE);
  // 竖线要一路贯穿到回复区，所以只要有回复（且没收起）就得画，回复表单本身也挂在这条线上。
  const showRail = hasReplies || replyTo !== null;

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <CommentRow
        comment={comment}
        canModerate={canModerate}
        isLoggedIn={isLoggedIn}
        tags={tagsByUser[comment.user_id]}
        onReplyClick={() => setReplyTo((v) => (v === "" ? null : ""))}
        onDeleted={() => setDeleted(true)}
        canPin={canPin}
        onPinned={onPinned}
        rail={
          showRail ? (
            <>
              {/* flex-1 把线撑到内容底部，开关因此正好落在操作栏（Upvote 那一行）的垂直中心：
                  展开时线从开关继续往下走 → 开关在线中间；收起时线到开关为止 → 开关在线底部。 */}
              <span className="mt-1.5 w-0.5 flex-1 bg-line" aria-hidden />
              {hasReplies && (
                <button
                  type="button"
                  onClick={() => setCollapsed((v) => !v)}
                  aria-label={collapsed ? t("expandReplies") : t("collapseReplies")}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted transition-colors hover:border-brand hover:text-brand-ink"
                >
                  {collapsed ? <PlusIcon /> : <MinusIcon />}
                </button>
              )}
            </>
          ) : null
        }
      />

      {replyTo !== null && (
        <div className="relative pl-9">
          <ThreadElbow />
          <div className="pb-2 pt-1">
            <CommentForm
              key={replyTo}
              submissionId={submissionId}
              isLoggedIn={isLoggedIn}
              parentId={comment.id}
              initialBody={replyTo ? `@${replyTo} ` : ""}
              autoFocus
              onPosted={(newComment) => {
                setReplyTo(null);
                onPosted?.(newComment);
              }}
            />
          </div>
        </div>
      )}

      {!collapsed && hasReplies && (
        // pt-3 给回复区一点呼吸空间（原来回复紧贴在父评论操作栏下面），
        // 同时补一小段竖线把这段留白桥接起来，否则线会断开。
        <div className="relative pt-3">
          <span className="absolute left-[17px] top-0 h-3 w-0.5 bg-line" aria-hidden />
          {pagedReplies.map((reply, i) => {
            const isLast = i === pagedReplies.length - 1 && totalPages === 1;
            return (
              <div key={reply.id} className="relative pl-9 pb-4 last:pb-0">
                {/* 非最后一条：竖线整条贯穿（曲线只是从它身上分叉出去）；
                    最后一条：只画曲线，线到这里就收尾。 */}
                {!isLast && <span className="absolute bottom-0 left-[17px] top-0 w-0.5 bg-line" aria-hidden />}
                <ThreadElbow />
                <CommentRow
                  comment={reply}
                  canModerate={canModerate}
                  isLoggedIn={isLoggedIn}
                  tags={tagsByUser[reply.user_id]}
                  onReplyClick={() => setReplyTo(reply.author_username ?? "")}
                  onDeleted={() => setDeletedReplyIds((prev) => new Set(prev).add(reply.id))}
                />
              </div>
            );
          })}
          {totalPages > 1 && (
            <div className="pl-9">
              <ReplyPagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 从竖线拐向回复头像的那段曲线：左边框接上面的竖线，下边框接到头像左沿，圆角把两者连成一个弯。
function ThreadElbow() {
  return (
    <span
      className="absolute left-[17px] top-0 h-5 w-[19px] rounded-bl-[10px] border-b-2 border-l-2 border-line"
      aria-hidden
    />
  );
}

function ReplyPagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  return (
    <div className="flex items-center gap-1 text-[13px] text-muted">
      <button
        type="button"
        disabled={page === 1}
        onClick={() => onChange(1)}
        className="rounded-md px-2 py-1 transition-colors hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        «
      </button>
      <button
        type="button"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
        className="rounded-md px-2 py-1 transition-colors hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        ‹
      </button>
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
            p === page ? "border border-line bg-surface-2 text-ink" : "hover:text-brand-ink"
          }`}
        >
          {p}
        </button>
      ))}
      <button
        type="button"
        disabled={page === totalPages}
        onClick={() => onChange(page + 1)}
        className="rounded-md px-2 py-1 transition-colors hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        ›
      </button>
    </div>
  );
}

function CommentRow({
  comment,
  canModerate,
  isLoggedIn,
  tags,
  onReplyClick,
  onDeleted,
  rail,
  canPin = false,
  onPinned,
}: {
  comment: CommentWithAuthor;
  canModerate: boolean;
  isLoggedIn: boolean;
  tags?: UserTagKey[];
  onReplyClick?: () => void;
  onDeleted: () => void;
  rail?: ReactNode;
  canPin?: boolean;
  onPinned?: (commentId: string, pinnedAt: string | null) => void;
}) {
  const t = useTranslations("comments");
  const tc = useTranslations("common");
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // 展示用昵称（可重复、可含中文），链接/@提及仍然用唯一的 username。
  const author = comment.author_display_name || comment.author_username || tc("deletedUser");

  const [voteCount, setVoteCount] = useState(comment.vote_count);
  const [voted, setVoted] = useState(comment.viewer_has_voted);
  const pinned = comment.pinned_at !== null;

  function handleDelete() {
    if (!confirm(t("confirmDelete"))) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteComment(comment.id, pathname);
      if (result.error) {
        setError(result.error);
        return;
      }
      onDeleted();
    });
  }

  function handlePin() {
    setError(null);
    startTransition(async () => {
      const result = await toggleCommentPin(comment.id, pathname);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // 同理：父级记下覆盖值，点了置顶立刻重排、立刻显示"置顶"标签，不等服务端往返。
      onPinned?.(comment.id, result.pinned ? new Date().toISOString() : null);
    });
  }

  function handleVote() {
    if (!isLoggedIn) return;
    const nextVoted = !voted;
    setVoted(nextVoted);
    setVoteCount((v) => v + (nextVoted ? 1 : -1));
    startTransition(async () => {
      const result = await toggleCommentVote(comment.id, pathname);
      if ("error" in result) {
        setVoted(!nextVoted);
        setVoteCount((v) => v + (nextVoted ? -1 : 1));
        setError(result.error);
      }
    });
  }

  return (
    <div id={`comment-${comment.id}`} className="flex scroll-mt-24 gap-3">
      <div className="flex w-9 shrink-0 flex-col items-center">
        {comment.author_username ? (
          <UserHoverCard username={comment.author_username}>
            <Link
              href={`/u/${comment.author_username}`}
              aria-label={t("authorHomeAria", { name: author })}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 font-display text-xs font-bold text-muted transition-colors hover:bg-brand-soft hover:text-brand-ink"
            >
              {author.slice(0, 1).toUpperCase()}
            </Link>
          </UserHoverCard>
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 font-display text-xs font-bold text-muted">
            {author.slice(0, 1).toUpperCase()}
          </div>
        )}
        {rail}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {comment.author_username ? (
            <UserHoverCard username={comment.author_username}>
              <Link
                href={`/u/${comment.author_username}`}
                className="text-sm font-bold text-ink transition-colors hover:text-brand-ink"
              >
                {author}
              </Link>
            </UserHoverCard>
          ) : (
            <span className="text-sm font-bold text-ink">{author}</span>
          )}
          <UserBadgeInline role={comment.author_role} tags={tags} level={comment.author_level} roleStyle="icon" />
          {pinned && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand-ink">
              <PinIcon />
              {t("pinned")}
            </span>
          )}
          {comment.status !== "published" && (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] font-medium text-muted">
              {t("pendingOnlyYou")}
            </span>
          )}
        </div>

        <p className="mt-1 whitespace-pre-line text-sm leading-6 text-ink">{renderCommentBody(comment.body)}</p>
        {error && <p className="mt-1 text-xs text-risk">{error}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px] font-medium text-muted">
          <button
            type="button"
            disabled={!isLoggedIn}
            onClick={handleVote}
            className={`inline-flex items-center gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              voted ? "text-brand-ink" : "hover:text-ink"
            }`}
          >
            <UpvoteIcon active={voted} />
            {t("upvote")}
            {voteCount > 0 && ` (${voteCount})`}
          </button>

          {onReplyClick && (
            <button
              type="button"
              onClick={onReplyClick}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              <ReplyIcon />
              {t("reply")}
            </button>
          )}

          <ReportMenu commentId={comment.id} isLoggedIn={isLoggedIn} pathname={pathname} />
          <ShareMenu commentId={comment.id} pathname={pathname} />

          <span
            className="inline-flex items-center gap-1.5 text-faint"
            title={formatFullTime(comment.created_at, t)}
          >
            <ClockIcon />
            {formatCommentTime(comment.created_at, t)}
          </span>

          {canPin && (
            <button
              type="button"
              disabled={isPending}
              onClick={handlePin}
              className={`inline-flex items-center gap-1.5 transition-colors disabled:opacity-60 ${
                pinned ? "text-brand-ink" : "hover:text-ink"
              }`}
            >
              <PinIcon />
              {pinned ? t("unpin") : t("pin")}
            </button>
          )}

          {canModerate && (
            <button
              type="button"
              disabled={isPending}
              onClick={handleDelete}
              className="text-risk transition-colors hover:underline disabled:opacity-60"
            >
              {t("delete")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function renderCommentBody(body: string) {
  const segments = splitCommentBodyByMentions(body);
  return segments.map((segment, i) =>
    segment.type === "mention" ? (
      <Link key={i} href={`/u/${segment.username}`} className="font-semibold text-brand-ink hover:underline">
        @{segment.username}
      </Link>
    ) : (
      <span key={i}>{segment.value}</span>
    )
  );
}

function ReportMenu({
  commentId,
  isLoggedIn,
  pathname,
}: {
  commentId: string;
  isLoggedIn: boolean;
  pathname: string;
}) {
  const t = useTranslations("comments");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function handleReport(reason: CommentReportReason) {
    setFeedback(null);
    startTransition(async () => {
      const result = await reportComment(commentId, reason, pathname);
      setFeedback(result.error ?? t("reportThanks"));
      setTimeout(() => setOpen(false), 900);
    });
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={!isLoggedIn}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        <FlagIcon />
        {t("report")}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-48 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          {feedback ? (
            <p className="px-3 py-2 text-xs text-ink">{feedback}</p>
          ) : (
            REPORT_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                disabled={isPending}
                onClick={() => handleReport(reason)}
                className="block w-full rounded-lg px-3 py-2 text-left text-xs font-normal text-ink transition-colors hover:bg-surface-2 disabled:opacity-60"
              >
                {commentReportReasonLabel(reason, locale)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ShareMenu({ commentId, pathname }: { commentId: string; pathname: string }) {
  const t = useTranslations("comments");
  const [open, setOpen] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function commentUrl() {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}${pathname}#comment-${commentId}`;
  }

  function handleCopyLink() {
    navigator.clipboard
      .writeText(commentUrl())
      .then(() => {
        setCopied(true);
        setTimeout(() => setOpen(false), 700);
      })
      .catch(() => {
        // Safari/权限策略可能拒绝剪贴板写入，静默失败即可，下拉菜单留着方便用户重试或手动复制。
      });
  }

  function handleFacebook() {
    window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(commentUrl())}`,
      "_blank",
      "noopener,noreferrer"
    );
    setOpen(false);
  }

  function handleX() {
    window.open(
      `https://twitter.com/intent/tweet?url=${encodeURIComponent(commentUrl())}`,
      "_blank",
      "noopener,noreferrer"
    );
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
      >
        <ShareIcon />
        {t("share")}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-36 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          <button
            type="button"
            onClick={handleFacebook}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs font-normal text-ink transition-colors hover:bg-surface-2"
          >
            Facebook
          </button>
          <button
            type="button"
            onClick={handleX}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs font-normal text-ink transition-colors hover:bg-surface-2"
          >
            X
          </button>
          <button
            type="button"
            onClick={() => {
              setEmbedOpen(true);
              setOpen(false);
            }}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs font-normal text-ink transition-colors hover:bg-surface-2"
          >
            Embed
          </button>
          <button
            type="button"
            onClick={handleCopyLink}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs font-normal text-ink transition-colors hover:bg-surface-2"
          >
            {copied ? t("copied") : t("copyLink")}
          </button>
        </div>
      )}

      <Modal open={embedOpen} onClose={() => setEmbedOpen(false)} title={t("embedTitle")}>
        <p className="text-xs text-muted">{t("embedHint")}</p>
        <textarea
          readOnly
          rows={3}
          value={`<iframe src="${commentUrl()}" width="100%" height="480" style="border:0"></iframe>`}
          className="mt-3 w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 font-mono text-xs text-ink"
          onFocus={(e) => e.currentTarget.select()}
        />
      </Modal>
    </div>
  );
}

/* ---------- 时间格式 ---------- */

// 固定用 Asia/Shanghai 渲染：服务端（Vercel 跑在 UTC）和浏览器算出来的字符串必须一致，
// 否则 hydration 会对不上。
const TZ = "Asia/Shanghai";
const DAY_MS = 24 * 60 * 60 * 1000;

// 用 en-CA + h23 取"年月日时分"这几个原子部件，再自己拼字符串：
// 一是不同 locale 的默认拼法不一样（"2026/9/1" vs "2026-09-01"），拼装比 replace 可靠；
// 二是 hourCycle 明确写 h23，避免某些环境把午夜格式化成 "24:00"。
const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface TimeParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function tzParts(date: Date): TimeParts {
  const map: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map as unknown as TimeParts;
}

function dayKey(parts: TimeParts): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 今天 / 昨天按「自然日」判断，而不是按 24 小时时间差——差一分钟跨过午夜就该显示
// Yesterday，按时间差算会错。中国没有夏令时，所以 now - 24h 一定落在前一个自然日。
// 文案模板从 messages/*.json 读（comments.today / yesterday / date），但日期本身
// 仍然按 Asia/Shanghai 拆成年月日时分再套模板——服务端和浏览器必须算出同一个字符串。
// 不用 useFormatter：它按浏览器时区渲染，hydration 会对不上。
type CommentsT = ReturnType<typeof useTranslations<"comments">>;

function formatCommentTime(iso: string, t: CommentsT): string {
  const parts = tzParts(new Date(iso));
  const time = `${parts.hour}:${parts.minute}`;

  const now = new Date();
  const today = dayKey(tzParts(now));
  const yesterday = dayKey(tzParts(new Date(now.getTime() - DAY_MS)));
  const target = dayKey(parts);

  if (target === today) return t("today", { time });
  if (target === yesterday) return t("yesterday", { time });
  return t("date", { year: parts.year, month: parts.month, day: parts.day, time });
}

// 悬停 title 里始终给完整时间，哪怕上面显示的是 Today/Yesterday。
function formatFullTime(iso: string, t: CommentsT): string {
  const parts = tzParts(new Date(iso));
  return t("dateTime", {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    time: `${parts.hour}:${parts.minute}`,
  });
}

/* ---------- 图标：统一 16px 描边风格，参照 Product Hunt 操作栏 ---------- */

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 4h6l-1 6 3.5 3H6.5L10 10z" />
      <line x1="12" y1="13" x2="12" y2="20" />
    </svg>
  );
}

function UpvoteIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.8"
        fill={active ? "currentColor" : "none"}
      />
      <path
        d="M8 14.5l4-5 4 5"
        stroke={active ? "var(--color-surface, #fff)" : "currentColor"}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="4" width="18" height="14" rx="5" strokeLinejoin="round" />
      <path d="M8 21l3-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 11h-4m0 0 1.8-1.8M9 11l1.8 1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      <polyline points="16 7 12 3 8 7" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <line x1="2.5" y1="6" x2="9.5" y2="6" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <line x1="2.5" y1="6" x2="9.5" y2="6" strokeLinecap="round" />
      <line x1="6" y1="2.5" x2="6" y2="9.5" strokeLinecap="round" />
    </svg>
  );
}
