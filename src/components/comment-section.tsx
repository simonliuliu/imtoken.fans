"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useTranslations } from "next-intl";
import { CommentForm, CommentItem } from "@/components/comment-form";
import type { CommentWithAuthor, UserTagKey } from "@/lib/types";

type SortMode = "top" | "newest";

const SORT_OPTIONS: { key: SortMode; labelKey: "sortTop" | "sortNewest" }[] = [
  { key: "top", labelKey: "sortTop" },
  { key: "newest", labelKey: "sortNewest" },
];

export function CommentSection(props: Parameters<typeof CommentSectionBody>[0]) {
  const { user, sessionEpoch } = useAuth();
  return <CommentSectionBody key={`${user?.id ?? "guest"}:${sessionEpoch}`} {...props} comments={props.comments.filter(c => c.status === "published" || c.user_id === user?.id)} isLoggedIn={Boolean(user)} />;
}

function CommentSectionBody({
  submissionId,
  commentCount,
  comments,
  isLoggedIn,
  canModerate,
  canPin,
  tagsByUser,
}: {
  submissionId: string;
  commentCount: number;
  comments: CommentWithAuthor[];
  isLoggedIn: boolean;
  canModerate: boolean;
  canPin: boolean;
  tagsByUser: Record<string, UserTagKey[]>;
}) {
  const t = useTranslations("comments");
  const [sort, setSort] = useState<SortMode>("top");
  // 本轮页面里刚发出去的评论：先插到这里让用户立刻看到，不用等服务端 revalidate 往返回来。
  // 和服务端数据按 id 合并，服务端追上之后重复的那条会被去掉。
  const [localComments, setLocalComments] = useState<CommentWithAuthor[]>([]);
  // 置顶的本地覆盖值（id -> pinned_at），同理：点了置顶要立刻看到它浮上去。
  const [pinOverrides, setPinOverrides] = useState<Record<string, string | null>>({});
  // 刚发完的评论 id。用 ref 而不是 state：它只是"下一次渲染完成后要滚到哪"的一次性标记，
  // 放进 state 会让 effect 里为了清空它再触发一轮渲染。
  const pendingScrollRef = useRef<string | null>(null);

  const serverIds = new Set(comments.map((c) => c.id));
  const merged = [
    ...comments,
    ...localComments.filter((c) => !serverIds.has(c.id)),
  ].map((c) => (c.id in pinOverrides ? { ...c, pinned_at: pinOverrides[c.id] } : c));

  const byId = new Map(merged.map(c => [c.id, c]));
  function rootOf(comment: CommentWithAuthor): string | null {
    let parent = comment.parent_id;
    const visited = new Set([comment.id]);
    while (parent && byId.get(parent)?.parent_id) {
      if (visited.has(parent)) return null;
      visited.add(parent);
      parent = byId.get(parent)!.parent_id;
    }
    return parent;
  }
  const repliesByParent = new Map<string, CommentWithAuthor[]>();
  for (const comment of merged) {
    if (!comment.parent_id) continue;
    const root = rootOf(comment);
    if (!root) continue;
    const list = repliesByParent.get(root) ?? [];
    list.push(comment);
    repliesByParent.set(root, list);
  }
  // 回复恒按时间正序（对话要按顺序读），不受 Top/Newest 影响。
  for (const list of repliesByParent.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  // 置顶永远在最前（不受 Top/Newest 影响），多条置顶按置顶时间倒序。
  // 剩下的：Top = 点赞多的在前，同赞数则新的在前；Newest = 纯按时间倒序。
  const topLevelComments = merged
    .filter((c) => !c.parent_id)
    .sort((a, b) => {
      if (a.pinned_at !== b.pinned_at) {
        if (a.pinned_at === null) return 1;
        if (b.pinned_at === null) return -1;
        return b.pinned_at.localeCompare(a.pinned_at);
      }
      if (sort === "top" && a.vote_count !== b.vote_count) return b.vote_count - a.vote_count;
      return b.created_at.localeCompare(a.created_at);
    });

  // 发完评论后定位到自己刚发的那条：热度排序下 0 赞的新评论会排到很后面，
  // 不滚过去的话看起来就像"没发出去"。等服务端 revalidate 的新数据渲染出来后才找得到这个节点。
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id) return;
    const el = document.getElementById(`comment-${id}`);
    if (!el) return;

    pendingScrollRef.current = null;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("comment-flash");
    const timer = setTimeout(() => el.classList.remove("comment-flash"), 1600);
    return () => clearTimeout(timer);
  }, [merged.length]);

  function handlePosted(comment?: CommentWithAuthor) {
    if (!comment) return;
    setLocalComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
    pendingScrollRef.current = comment.id;
  }

  function handlePinned(commentId: string, pinnedAt: string | null) {
    setPinOverrides((prev) => ({ ...prev, [commentId]: pinnedAt }));
  }

  return (
    <section id="comments" className="mt-12 scroll-mt-20">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-ink">{t("title", { count: commentCount })}</h2>
        {topLevelComments.length > 1 && (
          <div className="flex items-center gap-1 rounded-full border border-line p-0.5">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setSort(option.key)}
                className={`rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${
                  sort === option.key ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 参照 Product Hunt：整个评论区只有这一圈边框，里面每条评论都不再套卡片，
          层级靠 CommentItem 里的竖线和曲线表达。 */}
      <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <CommentForm submissionId={submissionId} isLoggedIn={isLoggedIn} onPosted={handlePosted} />

        {topLevelComments.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t("empty")}</p>
        ) : (
          <div className="mt-4 border-t border-line pt-4">
            {topLevelComments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                replies={repliesByParent.get(comment.id) ?? []}
                submissionId={submissionId}
                isLoggedIn={isLoggedIn}
                canModerate={canModerate}
                canPin={canPin}
                tagsByUser={tagsByUser}
                onPosted={handlePosted}
                onPinned={handlePinned}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
