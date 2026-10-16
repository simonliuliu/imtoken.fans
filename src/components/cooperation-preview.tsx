"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth-context";
import { saveFeedbackDraft, takeFeedbackDraft } from "@/lib/feedback-drafts";
import { Link } from "@/i18n/navigation";
import { readFeedback, writeFeedback } from "@/app/actions/feedback";
import { FEEDBACK_MODULES, FEEDBACK_STATES, FEEDBACK_MARKS, FEEDBACK_CHANGED, FEEDBACK_COMPOSE, type FeedbackPost, type FeedbackComment, type FeedbackData, type FeedbackEdit, type FeedbackMark, type FeedbackModule, type FeedbackState } from "@/lib/feedback";
import styles from "./cooperation-preview.module.css";

function IdeaEditor({ idea, busy, onSave, onCancel }: { idea: FeedbackPost; busy: boolean; onSave: (change: FeedbackEdit, version: number) => Promise<void>; onCancel: () => void }) {
  const c = useTranslations("cooperation"); const t = useTranslations("feedbackLive");
  const version = useRef(idea.version);
  const [draft, setDraft] = useState<FeedbackEdit>({ title: idea.title, description: idea.description, module: idea.module, status: idea.status, mark: idea.mark, visibility: idea.visibility });
  return <form className={styles.editor} onSubmit={(event) => { event.preventDefault(); void onSave(draft, version.current); }}>
    <h3>{c("editIdea")}</h3><label>{c("titleLabel")}<input required minLength={2} maxLength={120} disabled={busy} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label>{c("descriptionLabel")}<textarea required minLength={2} maxLength={5000} disabled={busy} rows={5} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
    <div className={styles.fields}><label>{c("moduleLabel")}<select disabled={busy} value={draft.module} onChange={(event) => setDraft({ ...draft, module: event.target.value as FeedbackModule })}>{FEEDBACK_MODULES.map((value) => <option key={value} value={value}>{c(`modules.${value}`)}</option>)}</select></label><label>{c("statusLabel")}<select disabled={busy} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as FeedbackState })}>{FEEDBACK_STATES.map((value) => <option key={value} value={value}>{c(`states.${value}`)}</option>)}</select></label><label>{c("markLabel")}<select disabled={busy} value={draft.mark} onChange={(event) => setDraft({ ...draft, mark: event.target.value as FeedbackMark })}>{FEEDBACK_MARKS.map((value) => <option key={value} value={value}>{c(`marks.${value}`)}</option>)}</select></label></div>
    <label>{t("visibility")}<select disabled={busy} value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value as "published" | "hidden" })}><option value="published">{t("public")}</option><option value="hidden">{t("hidden")}</option></select></label>
    <div className={styles.actions}><button className={styles.primary} disabled={busy || draft.title.trim().length < 2 || draft.description.trim().length < 2}>{busy ? t("saving") : c("save")}</button><button type="button" disabled={busy} onClick={onCancel}>{c("cancel")}</button></div>
  </form>;
}

/** Historical filename retained; the active component uses only authenticated real RPCs. */
export function CooperationPreview(props: { embedded?: boolean; initialId?: string | null }) {
  const { user, isAdmin, loading, sessionEpoch } = useAuth();
  const t = useTranslations("feedbackLive");
  if (loading) return <p role="status">{t("loading")}</p>;
  // Identity keys synchronously unmount private data/editors before a new account renders.
  return <LiveFeedback key={`${user?.id ?? "anonymous"}:${isAdmin}:${sessionEpoch}`} initialId={props.initialId ?? null} owner={user?.id ?? null} />;
}
function LiveFeedback({ initialId, owner }: { initialId: string | null; owner: string | null }) {
  const c = useTranslations("cooperation"); const t = useTranslations("feedbackLive"); const format = useFormatter();
  const [data, setData] = useState<FeedbackData | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [errorCode, setErrorCode] = useState(""); const [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""); const [module, setModule] = useState("all"); const [status, setStatus] = useState("all"); const [sort, setSort] = useState("latest");
  const [offset, setOffset] = useState(0); const [commentOffset, setCommentOffset] = useState(0); const [reload, setReload] = useState(0);
  const [view, setView] = useState<"list" | "progress">("list"); const [editing, setEditing] = useState(false);
  const [commentBody, setCommentBody] = useState(""); const [replyTo, setReplyTo] = useState<FeedbackComment | null>(null);
  const [commentEdit, setCommentEdit] = useState<{ comment: FeedbackComment; body: string; mark: FeedbackMark; visibility: "published" | "hidden" } | null>(null);
  const [mergeQuery, setMergeQuery] = useState(""); const [mergeChoices, setMergeChoices] = useState<FeedbackPost[]>([]); const [mergeChoice, setMergeChoice] = useState<FeedbackPost | null>(null);
  const [mergePreview, setMergePreview] = useState<{ id: string; support_count: number } | null>(null);
  const commentRequest = useRef<string | null>(null); const commentInput = useRef<HTMLTextAreaElement>(null);
  const active = data?.selected; const admin = data?.viewer.can_manage === true;
  const clearEditor = useCallback(() => { setEditing(false); setCommentEdit(null); setReplyTo(null); setCommentBody(""); commentRequest.current = null; setMergeChoice(null); setMergePreview(null); }, []);
  const openIdea = useCallback((id: string | null) => {
    setSelected(id); setCommentOffset(0); clearEditor(); setNotice("");
    const url = new URL(window.location.href); url.searchParams.set("category", "wallet"); if (id) url.searchParams.set("idea", id); else url.searchParams.delete("idea"); window.history.replaceState(window.history.state, "", url);
  }, [clearEditor]);
  useEffect(() => {
    const timer = setTimeout(() => { if (initialId) setSelected(initialId); }, 0);
    return () => clearTimeout(timer);
  }, [initialId]);
  useEffect(() => {
    const changed = (event: Event) => { const id = (event as CustomEvent<{ id?: string }>).detail?.id; if (id) { setSelected(id); setCommentOffset(0); clearEditor(); } setReload((value) => value + 1); };
    window.addEventListener(FEEDBACK_CHANGED, changed); return () => window.removeEventListener(FEEDBACK_CHANGED, changed);
  }, [clearEditor]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true); setError(""); setErrorCode("");
      try {
        const result = await readFeedback({ id: selected, query, module, status, sort, offset, commentOffset });
        if (cancelled) return;
        if (result.ok && result.data.viewer.user_id === owner) setData(result.data); else if (result.ok) { setData(null); setError(t("sessionChanged")); setErrorCode("session_changed"); } else { setData(null); setError(result.error); setErrorCode(result.code); }
      } catch { if (!cancelled) { setData(null); setError(t("unexpected")); } }
      finally { if (!cancelled) setLoading(false); }
    }, query ? 300 : 0);
    return () => { clearTimeout(timer); cancelled = true; };
  }, [selected, query, module, status, sort, offset, commentOffset, reload, t, owner]);
  useEffect(() => {
    let stale = false;
    if (!active || !admin || active.merge_id) return;
    const timer = setTimeout(async () => { const result = await readFeedback({ query: mergeQuery, sort: "oldest" }); if (!stale && result.ok && result.data.viewer.user_id === owner) setMergeChoices(result.data.posts.filter((post) => post.id !== active.id && !post.merge_id && post.visibility === "published")); }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [active, admin, mergeQuery, owner]);
  const mutate = async (action: Parameters<typeof writeFeedback>[0], payload: Record<string, unknown>): Promise<boolean> => {
    if (busy) return false; setBusy(true); setError(""); setErrorCode(""); setNotice("");
    try {
      const result = await writeFeedback(action, { ...payload, expected_user_id: owner });
      if (!result.ok) { setError(result.error); setErrorCode(result.code); return false; }
      if (selected || ["merge", "unmerge"].includes(action)) setSelected(result.data.id); setReload((value) => value + 1); setNotice(t("saved")); return true;
    } catch { setError(t("unexpected")); return false; } finally { setBusy(false); }
  };
  async function submitComment(event: FormEvent) {
    event.preventDefault(); if (!active || commentBody.trim().length < 2) return;
    commentRequest.current ??= crypto.randomUUID();
    if (await mutate("comment", { id: active.id, body: commentBody, parent_id: replyTo?.id ?? null, request_id: commentRequest.current })) { setCommentBody(""); setReplyTo(null); commentRequest.current = null; setCommentOffset(Math.floor((data?.comment_total ?? 0) / 50) * 50); }
  }
  async function previewMerge() {
    if (!active || !mergeChoice || busy) return; setBusy(true); setError("");
    try { const result = await writeFeedback("preview_merge", { id: active.id, version: active.version, other_id: mergeChoice.id, other_version: mergeChoice.version, expected_user_id: owner }); if (result.ok) setMergePreview({ id: result.data.id, support_count: result.data.support_count ?? 0 }); else { setError(result.error); setErrorCode(result.code); } } catch { setError(t("unexpected")); } finally { setBusy(false); }
  }
  const author = (name: string | null) => name || t("member");
  const resetFilters = () => { setQuery(""); setModule("all"); setStatus("all"); setOffset(0); };
  const compose = () => window.dispatchEvent(new Event(FEEDBACK_COMPOSE));
  const signInHref = `/auth/sign-in?redirect=${encodeURIComponent(`/community/feedback?category=wallet${selected ? `&idea=${selected}&resumeComment=1` : ""}`)}`;
  function renderRow(post: FeedbackPost) {
    return <article key={post.id} className={styles.row}><button type="button" className={styles.vote} disabled={busy} aria-pressed={post.supported} aria-label={c("ideaVote", { title: post.title, count: post.support_count })} onClick={() => void mutate("vote", { id: post.id, supported: !post.supported })}><span aria-hidden>△</span><strong>{format.number(post.support_count)}</strong></button><div className={styles.rowMain}><div className={styles.tags}><span className={styles.status}>{c(`states.${post.status}`)}</span><span>{c(`modules.${post.module}`)}</span>{post.mark !== "none" && <span className={styles.tag}>{c(`marks.${post.mark}`)}</span>}{post.visibility === "hidden" && <span>{t("hidden")}</span>}</div><button type="button" className={styles.ideaTitle} onClick={() => openIdea(post.id)}>{post.title}</button><p className={styles.excerpt}>{post.description}</p><div className={styles.meta}><span>{author(post.author_name)}</span><time dateTime={post.created_at}>{format.dateTime(new Date(post.created_at), { month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time><span>{c("commentCount", { count: post.comment_count })}</span>{post.merge_id && <span>{c("mergedBadge")}</span>}</div></div></article>;
  }
  return <section className={`${styles.page} ${styles.embedded}`} aria-label={t("heading")} aria-busy={loading || busy}>
    <header className={styles.heading}><div><h2>{t("heading")}</h2><p>{t("intro")}</p></div><button type="button" className={styles.primary} onClick={compose}>{t("publish")}</button></header>
    {admin && <p className={styles.adminNotice}>{t("adminNotice")}</p>}
    {error && <div className={styles.error} role="alert"><p>{error}</p>{errorCode === "sign_in" && <Link href={signInHref} onClick={() => { if (!active || !commentBody) return; try { saveFeedbackDraft(`comment:${active.id}`, owner, { body: commentBody, parent: replyTo, request: commentRequest.current }); } catch { setError(t("draftUnavailable")); } }}>{t("signInContinue")}</Link>}<button type="button" onClick={() => setReload((value) => value + 1)}>{t("retry")}</button></div>}
    {notice && <p className={styles.success} role="status">{notice}</p>}
    {loading && <p className={styles.muted} role="status">{t("loading")}</p>}
    {data && <>
      <div className={styles.toolbar}><div className={styles.actions}><button type="button" aria-pressed={!active && view === "list"} onClick={() => { openIdea(null); setView("list"); }}>{c("listView")}</button><button type="button" aria-pressed={!active && view === "progress"} onClick={() => { openIdea(null); setView("progress"); }}>{c("progressView")}</button></div><button type="button" onClick={() => setReload((value) => value + 1)}>{t("refresh")}</button></div>
      {active ? <article className={styles.panel}>
        <button type="button" disabled={busy} className={styles.back} onClick={() => openIdea(null)}>{c("back")}</button><div className={styles.tags}><span className={styles.status}>{c(`states.${active.status}`)}</span><span>{c(`modules.${active.module}`)}</span>{active.mark !== "none" && <span className={styles.tag}>{c(`marks.${active.mark}`)}</span>}{active.visibility === "hidden" && <span>{t("hidden")}</span>}</div><h2 className={styles.detailTitle}>{active.title}</h2><div className={styles.meta}><span>{author(active.author_name)}</span><time dateTime={active.created_at}>{format.dateTime(new Date(active.created_at), { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time>{active.version > 1 && <span>{t("revision", { version: active.version })}</span>}</div><p className={styles.description}>{active.description}</p>
        <div className={styles.actions}><button type="button" disabled={busy} className={styles.support} aria-pressed={active.supported} onClick={() => void mutate("vote", { id: active.id, supported: !active.supported })}>△ {c(active.supported ? "supported" : "support")} · {format.number(active.support_count)}</button>{admin && <button type="button" disabled={busy} onClick={() => setEditing(!editing)}>{c("editIdea")}</button>}</div>
        {admin && editing && <IdeaEditor key={active.id} idea={active} busy={busy} onCancel={() => setEditing(false)} onSave={async (change, version) => { if (await mutate("edit", { id: active.id, version, ...change })) setEditing(false); }} />}
        {data.sources.length > 0 && <section className={styles.mergeBox}><h3>{c("mergeSources")}</h3><p>{t("mergedExplanation")}</p>{data.sources.map((source) => <details key={source.id}><summary>{source.title}</summary><p className={styles.meta}>{author(source.author_name)} · {format.dateTime(new Date(source.created_at), { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</p><p className={styles.body}>{source.description}</p></details>)}{admin && active.merge_id && <button type="button" disabled={busy} onClick={async () => { if (await mutate("unmerge", { id: active.merge_id, version: active.version })) clearEditor(); }}>{c("undoMerge")}</button>}</section>}
        {admin && !active.merge_id && active.visibility === "published" && <section className={styles.mergeBox}><h3>{c("mergeHeading")}</h3><p>{t("mergeLimit")}</p><label>{t("findMerge")}<input maxLength={120} value={mergeQuery} onChange={(event) => { setMergeQuery(event.target.value); setMergeChoice(null); setMergePreview(null); }} /></label><label>{c("mergeSelect")}<select value={mergeChoice?.id ?? ""} disabled={busy} onChange={(event) => { setMergeChoice(mergeChoices.find((post) => post.id === event.target.value) ?? null); setMergePreview(null); }}><option value="">{c("chooseIdea")}</option>{mergeChoices.map((post) => <option key={post.id} value={post.id}>{post.title}</option>)}</select></label><button type="button" disabled={busy || !mergeChoice} onClick={() => void previewMerge()}>{c("previewMerge")}</button>{mergePreview && mergeChoice && <div className={styles.mergePreview}><h4>{c("mergePreviewTitle")}</h4><p>{c("mergeTarget", { title: mergePreview.id === active.id ? active.title : mergeChoice.title })}</p><p>{c("mergeCounts", { before: active.support_count + mergeChoice.support_count, after: mergePreview.support_count })}</p><p>{c("mergeUndoNote")}</p><div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={async () => { if (await mutate("merge", { id: active.id, version: active.version, other_id: mergeChoice.id, other_version: mergeChoice.version })) clearEditor(); }}>{c("confirmMerge")}</button><button type="button" disabled={busy} onClick={() => setMergePreview(null)}>{c("cancel")}</button></div></div>}</section>}
        {admin && data.history.length > 0 && <details className={styles.history}><summary>{t("history")}</summary><p>{t("historyLimit")}</p>{data.history.map((entry) => <div key={entry.id}><strong>{t(`audit.${entry.action}`)}</strong> · <time dateTime={entry.created_at}>{format.dateTime(new Date(entry.created_at), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}</time>{entry.before_data && <p className={styles.body}>{t("previous")} {String(entry.before_data.title ?? entry.before_data.body ?? "")} {typeof entry.before_data.status === "string" && c(`states.${entry.before_data.status}`)} {typeof entry.before_data.mark === "string" && c(`marks.${entry.before_data.mark}`)}{typeof entry.before_data.description === "string" && `\n${entry.before_data.description}`}</p>}</div>)}</details>}
        <section className={styles.discussion}><h3>{c("discussion", { count: data.comment_total })}</h3><form className={styles.form} onSubmit={submitComment}>{replyTo && <div className={styles.replyTarget}><p>{c("replyingTo", { name: author(replyTo.author_name) })}</p><button type="button" disabled={busy} onClick={() => { setReplyTo(null); commentRequest.current = null; }}>{c("cancelReply")}</button></div>}<label>{c("commentLabel")}<textarea ref={commentInput} required minLength={2} disabled={busy} maxLength={2000} rows={3} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder={c("commentPlaceholder")} /></label><div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || commentBody.trim().length < 2}>{busy ? t("saving") : c(replyTo ? "sendReply" : "sendComment")}</button><button type="button" disabled={busy} onClick={() => { try { const stored = takeFeedbackDraft<{ body: string; parent: FeedbackComment | null; request: string | null }>(`comment:${active.id}`, owner, Boolean(owner && new URLSearchParams(window.location.search).get("resumeComment") === "1")); if (stored?.body) { setCommentBody(stored.body); setReplyTo(stored.parent ?? null); commentRequest.current = stored.request ?? null; } else setNotice(t("noDraft")); } catch { setError(t("draftUnavailable")); } }}>{t("restoreDraft")}</button></div></form>
          <ul className={styles.comments}>{data.comments.map((comment) => <li key={comment.id} className={`${styles.comment} ${comment.parent_id ? styles.reply : ""}`}><div className={styles.meta}><strong>{author(comment.author_name)}</strong><time dateTime={comment.created_at}>{format.dateTime(new Date(comment.created_at), { month: "short", day: "numeric", timeZone: "Asia/Shanghai" })}</time>{comment.version > 1 && <span>{t("revision", { version: comment.version })}</span>}{comment.mark !== "none" && <span className={styles.tag}>{c(`marks.${comment.mark}`)}</span>}{comment.visibility === "hidden" && <span>{t("hidden")}</span>}</div>{comment.parent_id && <p className={styles.origin}>{c("replyingTo", { name: author(comment.parent_author_name) })}</p>}{data.sources.length > 0 && <p className={styles.origin}>{c("origin", { title: comment.source_title })}</p>}<p className={styles.body}>{comment.body}</p><div className={styles.actions}><button type="button" disabled={busy} aria-pressed={comment.supported} aria-label={c("commentVote", { count: comment.support_count })} onClick={() => void mutate("comment_vote", { id: comment.id, supported: !comment.supported })}>△ {format.number(comment.support_count)}</button><button type="button" disabled={busy || comment.visibility !== "published"} onClick={() => { setReplyTo(comment); commentRequest.current = null; commentInput.current?.focus(); }}>{c("reply")}</button>{admin && <button type="button" disabled={busy} onClick={() => setCommentEdit({ comment, body: comment.body, mark: comment.mark, visibility: comment.visibility })}>{c("editComment")}</button>}</div>
            {admin && commentEdit?.comment.id === comment.id && <form className={styles.editor} onSubmit={async (event) => { event.preventDefault(); if (await mutate("edit_comment", { id: comment.id, version: commentEdit.comment.version, body: commentEdit.body, mark: commentEdit.mark, visibility: commentEdit.visibility })) setCommentEdit(null); }}><label>{c("commentLabel")}<textarea required minLength={2} disabled={busy} maxLength={2000} value={commentEdit.body} onChange={(event) => setCommentEdit({ ...commentEdit, body: event.target.value })} /></label><label>{c("markLabel")}<select disabled={busy} value={commentEdit.mark} onChange={(event) => setCommentEdit({ ...commentEdit, mark: event.target.value as FeedbackMark })}>{FEEDBACK_MARKS.map((mark) => <option key={mark} value={mark}>{c(`marks.${mark}`)}</option>)}</select></label><label>{t("visibility")}<select disabled={busy} value={commentEdit.visibility} onChange={(event) => setCommentEdit({ ...commentEdit, visibility: event.target.value as "published" | "hidden" })}><option value="published">{t("public")}</option><option value="hidden">{t("hidden")}</option></select></label><div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || commentEdit.body.trim().length < 2}>{c("save")}</button><button type="button" disabled={busy} onClick={() => setCommentEdit(null)}>{c("cancel")}</button></div></form>}
          </li>)}</ul>{data.comment_total === 0 && <p className={styles.muted}>{c("noComments")}</p>}<div className={styles.pagination}><button type="button" disabled={loading || commentOffset === 0} onClick={() => setCommentOffset(Math.max(0, commentOffset - 50))}>{t("previousPage")}</button><span>{t("commentPage", { count: data.comment_total, start: data.comment_total ? commentOffset + 1 : 0, end: Math.min(commentOffset + 50, data.comment_total) })}</span><button type="button" disabled={loading || commentOffset + 50 >= data.comment_total} onClick={() => setCommentOffset(commentOffset + 50)}>{t("nextPage")}</button></div>
        </section>
      </article> : <>
        <div className={styles.filters}><label className={styles.search}>{c("search")}<input type="search" maxLength={120} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder={c("searchPlaceholder")} /></label><label>{c("moduleLabel")}<select value={module} onChange={(event) => { setModule(event.target.value); setOffset(0); }}><option value="all">{c("allModules")}</option>{FEEDBACK_MODULES.map((value) => <option key={value} value={value}>{c(`modules.${value}`)}</option>)}</select></label><label>{c("statusLabel")}<select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="all">{c("allStates")}</option>{FEEDBACK_STATES.map((value) => <option key={value} value={value}>{c(`states.${value}`)}</option>)}</select></label><label>{c("sortLabel")}<select value={sort} onChange={(event) => { setSort(event.target.value); setOffset(0); }}>{["latest", "popular", "oldest"].map((value) => <option key={value} value={value}>{c(`sorts.${value}`)}</option>)}</select></label></div><p className={styles.resultCount} role="status">{t("resultCount", { count: data.total })}</p>
        {data.posts.length === 0 ? <section className={styles.panel}><h2>{c("empty")}</h2><p>{t("emptyHint")}</p><div className={styles.actions}><button type="button" onClick={resetFilters}>{c("clearFilters")}</button><button type="button" className={styles.primary} onClick={compose}>{t("publish")}</button></div></section> : view === "list" ? <div className={styles.list}>{data.posts.map(renderRow)}</div> : <><p className={styles.muted}>{t("progressNotice")}</p><div className={styles.board}>{FEEDBACK_STATES.filter((value) => status === "all" || status === value).map((value) => <section key={value} className={styles.column}><h2>{c(`states.${value}`)}</h2>{data.posts.filter((post) => post.status === value).map(renderRow)}{!data.posts.some((post) => post.status === value) && <p className={styles.muted}>{t("emptyColumn")}</p>}</section>)}</div></>}
        <div className={styles.pagination}><button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{t("previousPage")}</button><span>{t("pageCount", { page: Math.floor(offset / 20) + 1, pages: Math.max(1, Math.ceil(data.total / 20)) })}</span><button type="button" disabled={loading || offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>{t("nextPage")}</button></div>
      </>}
    </>}
  </section>;
}
