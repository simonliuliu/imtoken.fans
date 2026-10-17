"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { readAdminCommunityActivities, writeAdminCommunityActivity } from "@/app/admin/community-activity-actions";
import type { AdminActivityRead, CommunityActivity } from "@/lib/community-activity-types";
import { BADGE_INFO, GRANTABLE_BADGE_KEYS } from "@/lib/types";

const inputClass = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";
const buttonClass = "rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
const outlineClass = "rounded-full border border-line px-4 py-2 text-sm text-muted disabled:opacity-50";
const types = { event: "社区活动", newcomer: "新手任务", weekly: "每周挑战" };
const tasks = { checkin: "签到核验", quiz: "安全单选小测", manual: "人工贡献审核", product_review: "产品体验评价审核" };
const states = { draft: "草稿", published: "已发布（规则冻结）", cancelled: "已取消" };
const participationStates = { joined: "已参与", submitted: "待审核", approved: "已完成", rejected: "已拒绝／可修正" };
type Form = {
  title: string; summary: string; body: string; organizer: string; type: CommunityActivity["type"]; task_kind: CommunityActivity["task_kind"];
  starts_at: string; ends_at: string; reward_xp: string; reward_tickets: string; reward_badge: string; reward_limit: string;
  checkin_days: string; quiz_question: string; quiz_options: string; quiz_answer: string; quiz_max_attempts: string; product_id: string;
};
const emptyForm: Form = { title: "", summary: "", body: "", organizer: "", type: "event", task_kind: "manual", starts_at: "", ends_at: "", reward_xp: "0", reward_tickets: "0", reward_badge: "", reward_limit: "", checkin_days: "1", quiz_question: "", quiz_options: "", quiz_answer: "0", quiz_max_attempts: "3", product_id: "" };
function beijingInput(iso: string) { return new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().slice(0, 16); }
function toForm(a: CommunityActivity): Form {
  return { title: a.title, summary: a.summary, body: a.body, organizer: a.organizer, type: a.type, task_kind: a.task_kind, starts_at: beijingInput(a.starts_at), ends_at: beijingInput(a.ends_at), reward_xp: String(a.reward_xp), reward_tickets: String(a.reward_tickets), reward_badge: a.reward_badge ?? "", reward_limit: a.reward_limit === null ? "" : String(a.reward_limit), checkin_days: String(a.checkin_days), quiz_question: a.quiz_question ?? "", quiz_options: a.quiz_options.join("\n"), quiz_answer: String(a.quiz_answer ?? 0), quiz_max_attempts: String(a.quiz_max_attempts), product_id: a.product_id ?? "" };
}
export function CommunityActivityPanel() {
  return <AuthProvider><ActivityAdminAuthenticated /></AuthProvider>;
}
function ActivityAdminAuthenticated() {
  const { user, loading, sessionEpoch } = useAuth();
  if (loading) return <p className="text-sm text-muted" role="status">正在确认管理会话…</p>;
  if (!user) return <p className="text-sm text-risk">请先登录管理员账号。</p>;
  return <ActivityAdminSession key={`${user.id}:${sessionEpoch}`} userId={user.id} />;
}
function ActivityAdminSession({ userId }: { userId: string }) {
  const [data, setData] = useState<AdminActivityRead | null>(null); const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0); const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [form, setForm] = useState<Form>(emptyForm); const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    readAdminCommunityActivities(userId).then((r) => { if (!cancelled) { setData(r.data ?? null); setError(r.error ?? null); } });
    return () => { cancelled = true; };
  }, [userId, revision]);
  function act(action: Parameters<typeof writeAdminCommunityActivity>[1], id: string | null, payload: Record<string, unknown> = {}) {
    setError(null);
    startTransition(async () => {
      const r = await writeAdminCommunityActivity(userId, action, id, payload);
      if (!live.current) return;
      setError(r.error ?? null);
      if (!r.error) { setEditing(undefined); setRevision((n) => n + 1); setNotes({}); }
    });
  }
  function save() {
    if (!form.starts_at || !form.ends_at) { setError("请填写北京时间的开始与结束时间。"); return; }
    const { starts_at, ends_at, ...rest } = form;
    act("save", editing ?? null, { ...rest, starts_at: `${starts_at}:00+08:00`, ends_at: `${ends_at}:00+08:00`, reward_xp: Number(form.reward_xp), reward_tickets: Number(form.reward_tickets), reward_badge: form.reward_badge || null, reward_limit: form.reward_limit === "" ? null : Number(form.reward_limit), checkin_days: Number(form.checkin_days), quiz_options: form.quiz_options.split("\n").map((s) => s.trim()).filter(Boolean), quiz_answer: form.task_kind === "quiz" ? Number(form.quiz_answer) : null, quiz_max_attempts: Number(form.quiz_max_attempts), product_id: form.product_id || null });
  }
  const patch = (key: keyof Form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  return <section className="rounded-2xl border border-line bg-surface p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-ink">社区活动与任务</h2><button className={buttonClass} disabled={pending} onClick={() => { setEditing(null); setForm(emptyForm); }}>新建草稿</button></div>
    <p className="mt-2 text-xs leading-6 text-muted">一个活动一项任务；发布后规则、任务、起止和奖励冻结。参与不限名额，奖励名额不为参与者预留。被拒的提交可在活动结束前修正；结束后仍可审核此前有效提交。取消不自动追回已发奖励。</p>
    {error && <p role="alert" className="mt-3 text-sm text-risk">{error} <button className="underline" onClick={() => setRevision((n) => n + 1)}>重新加载</button></p>}
    {!data && !error && <p role="status" className="mt-4 text-sm text-muted">正在加载活动配置…</p>}
    {editing !== undefined && <form className="mt-5 grid gap-4 border-y border-line py-5 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <h3 className="font-semibold text-ink sm:col-span-2">{editing ? "编辑草稿" : "新建草稿"}</h3>
      <label className="text-xs text-muted">活动标题<input required maxLength={120} value={form.title} onChange={(e) => patch("title", e.target.value)} className={inputClass} /></label>
      <label className="text-xs text-muted">主办方<input required maxLength={120} value={form.organizer} onChange={(e) => patch("organizer", e.target.value)} className={inputClass} /></label>
      <label className="text-xs text-muted">活动分类<select value={form.type} onChange={(e) => patch("type", e.target.value)} className={inputClass}>{Object.entries(types).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label className="text-xs text-muted">唯一任务<select value={form.task_kind} onChange={(e) => patch("task_kind", e.target.value)} className={inputClass}>{Object.entries(tasks).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label className="text-xs text-muted">开始时间（北京时间）<input type="datetime-local" required value={form.starts_at} onChange={(e) => patch("starts_at", e.target.value)} className={inputClass} /></label>
      <label className="text-xs text-muted">结束时间（北京时间）<input type="datetime-local" required value={form.ends_at} onChange={(e) => patch("ends_at", e.target.value)} className={inputClass} /></label>
      <label className="text-xs text-muted sm:col-span-2">列表摘要（最多300字）<input maxLength={300} value={form.summary} onChange={(e) => patch("summary", e.target.value)} className={inputClass} /></label>
      <label className="text-xs text-muted sm:col-span-2">完整规则（20–20000字；应写明审核标准）<textarea required minLength={20} maxLength={20000} rows={5} value={form.body} onChange={(e) => patch("body", e.target.value)} className={inputClass} /></label>
      {([['reward_xp', '奖励 XP', 0, 100000], ['reward_tickets', '奖励抽奖券', 0, 10000], ['reward_limit', '总获奖人数上限（空＝不限）', 1, 1000000]] as const).map(([key, label, min, max]) => <label key={key} className="text-xs text-muted">{label}<input type="number" min={min} max={max} value={form[key]} onChange={(e) => patch(key, e.target.value)} className={inputClass} /></label>)}
      <label className="text-xs text-muted">可选既有徽章<select className={inputClass} value={form.reward_badge} onChange={(e) => patch("reward_badge", e.target.value)}><option value="">无</option>{GRANTABLE_BADGE_KEYS.map((key) => <option key={key} value={key}>{BADGE_INFO[key].name}</option>)}</select></label>
      {form.task_kind === "checkin" && <label className="text-xs text-muted">活动期间签到天数<input type="number" min={1} max={366} value={form.checkin_days} onChange={(e) => patch("checkin_days", e.target.value)} className={inputClass} /></label>}
      {form.task_kind === "product_review" && <label className="text-xs text-muted sm:col-span-2">指定已发布产品<select required value={form.product_id} onChange={(e) => patch("product_id", e.target.value)} className={inputClass}><option value="">请选择产品</option>{data?.products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select><span className="mt-1 block">核验本人活动期间创建的真实体验评价，人工审核；不以高分作为奖励条件。</span></label>}
      {form.task_kind === "quiz" && <>
        <label className="text-xs text-muted sm:col-span-2">题目<input required maxLength={1000} value={form.quiz_question} onChange={(e) => patch("quiz_question", e.target.value)} className={inputClass} /></label>
        <label className="text-xs text-muted sm:col-span-2">选项（每行一个，2–6项，每项最多300字）<textarea required rows={4} value={form.quiz_options} onChange={(e) => patch("quiz_options", e.target.value)} className={inputClass} /></label>
        <label className="text-xs text-muted">正确答案序号（从0开始，仅管理员可见）<input type="number" min={0} max={5} required value={form.quiz_answer} onChange={(e) => patch("quiz_answer", e.target.value)} className={inputClass} /></label>
        <label className="text-xs text-muted">最多答题次数<input type="number" min={1} max={10} required value={form.quiz_max_attempts} onChange={(e) => patch("quiz_max_attempts", e.target.value)} className={inputClass} /></label>
      </>}
      <div className="flex gap-3 sm:col-span-2"><button className={buttonClass} disabled={pending} type="submit">{pending ? "保存中…" : "保存草稿"}</button><button type="button" className={outlineClass} onClick={() => setEditing(undefined)}>收起</button></div>
    </form>}
    {data && <>
      <div className="mt-5 space-y-3">{data.items.length === 0 && <p className="text-sm text-muted">尚无真实活动。创建草稿并完成发布后才会公开。</p>}{data.items.map((a) => <article key={a.id} className="rounded-xl bg-surface-2 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-words font-semibold text-ink">{a.title}</p><p className="mt-1 text-xs text-muted">{types[a.type]} · {tasks[a.task_kind]} · {states[a.status]}</p><p className="mt-2 text-xs text-muted">奖励 {a.reward_xp} XP / {a.reward_tickets} 券{a.reward_badge ? ` / ${BADGE_INFO[a.reward_badge]?.name ?? a.reward_badge}` : ""} · 已发 {a.rewarded_count} / {a.reward_limit ?? "不限"} 人</p></div><div className="flex flex-wrap gap-2">{a.status === "draft" && <><button className={outlineClass} disabled={pending} onClick={() => { setForm(toForm(a)); setEditing(a.id); }}>编辑</button><button className={buttonClass} disabled={pending} onClick={() => { if (window.confirm("发布后规则、任务、奖励与起止不可修改，确认发布？")) act("publish", a.id); }}>发布</button></>}{a.status === "published" && <button className={outlineClass} disabled={pending} onClick={() => { const note = window.prompt("请输入取消原因（5–1000字），已发奖励不追回"); if (note !== null) act("cancel", a.id, { note }); }}>取消活动</button>}</div></div>{a.cancel_reason && <p className="mt-2 text-sm text-risk">取消原因：{a.cancel_reason}</p>}</article>)}</div>
      <h3 className="mt-7 font-semibold text-ink">参与与审核记录</h3><p className="mt-1 text-xs text-muted">用户标识仅用于核对社区账号；证据仅本人和有活动管理权限者可见。审核通过时奖励同一事务到账，重复审核不会重发。</p>
      <div className="mt-4 space-y-3">{data.participations.length === 0 && <p className="text-sm text-muted">暂无参与记录。</p>}{data.participations.map((p) => { const a = data.items.find((item) => item.id === p.activity_id); const key = `${p.activity_id}:${p.user_id}`; return <article key={key} className="rounded-xl border border-line p-4"><p className="font-semibold text-ink">{a?.title} · {participationStates[p.status]}</p><p className="mt-1 break-all font-mono text-xs text-muted">用户：{p.user_id}</p>{p.evidence && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted">{p.evidence}</p>}{p.product_review && <div className="mt-3 rounded-lg bg-surface-2 p-3 text-sm text-muted"><p>真实体验评价（{p.product_review.rating} / 5；评分不决定奖励资格）</p><p className="mt-2 whitespace-pre-wrap break-words">{p.product_review.body}</p><a href={"/zh/products/" + p.product_review.submission_id + "#product-rating"} className="mt-2 inline-block text-brand-ink underline">查看产品评价</a></div>}{a?.task_kind === "product_review" && p.submitted_at && (!p.product_review || !a.product_id || a.product_available === false) && <p className="mt-3 text-sm text-risk">关联产品或体验评价已删除／不可访问。历史参与与已发奖励保留，当前提交不能通过发奖；可拒绝并说明原因。</p>}{p.review_note && <p className="mt-2 text-xs text-muted">审核说明：{p.review_note}</p>}{p.status === "submitted" && a?.status === "published" && <div className="mt-3 space-y-3"><label className="block text-xs text-muted">审核说明（拒绝必填至少5字）<input value={notes[key] ?? ""} maxLength={1000} onChange={(e) => setNotes((n) => ({ ...n, [key]: e.target.value }))} className={inputClass} /></label><div className="flex gap-2"><button className={buttonClass} disabled={pending || (a.task_kind === "product_review" && (!p.product_review || !a.product_id || a.product_available === false))} onClick={() => act("approve", p.activity_id, { user_id: p.user_id, note: notes[key] ?? "" })}>通过并发奖</button><button className={outlineClass} disabled={pending || (notes[key]?.trim().length ?? 0) < 5} onClick={() => act("reject", p.activity_id, { user_id: p.user_id, note: notes[key] })}>拒绝并说明</button></div></div>}</article>; })}</div>
      <h3 className="mt-7 font-semibold text-ink">奖励流水</h3><div className="mt-3 space-y-2">{data.rewards.length === 0 && <p className="text-sm text-muted">暂无发奖记录。</p>}{data.rewards.map((r) => <p key={`${r.activity_id}:${r.user_id}`} className="break-all rounded-xl bg-surface-2 p-3 text-xs leading-6 text-muted">{data.items.find((a) => a.id === r.activity_id)?.title} · {r.user_id} · {r.xp} XP / {r.tickets} 券{r.badge ? ` / ${BADGE_INFO[r.badge]?.name ?? r.badge}` : ""} · {r.created_at}</p>)}</div>
    </>}
  </section>;
}
