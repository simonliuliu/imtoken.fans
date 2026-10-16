import Link from "next/link";
import type { ReactNode } from "react";

// 后台各页共用的外壳组件。都是纯展示、无状态，所以留在服务端组件里，
// 不用 "use client"（交互部分在 list-controls.tsx 和各个 panel 里）。

export function AdminPanel({
  title,
  count,
  description,
  action,
  children,
}: {
  title: string;
  count?: number;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-semibold text-ink">
            {title}
            {count !== undefined && <span className="ml-1.5 font-mono text-xs font-normal text-faint">{count}</span>}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ViewAllLink({ href, label = "查看全部" }: { href: string; label?: string }) {
  return (
    <Link href={href} className="shrink-0 text-xs font-semibold text-brand-ink transition-opacity hover:opacity-70">
      {label} →
    </Link>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-surface-2 px-3 py-6 text-center text-sm text-muted">{children}</p>;
}

export function NoPermissionNotice({ what }: { what: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center">
      <p className="text-sm font-semibold text-ink">没有访问「{what}」的权限</p>
      <p className="mt-1 text-xs text-muted">需要管理员给你的账号开启对应权限。</p>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  published: "bg-good-soft text-good",
  pending: "bg-warn-soft text-warn",
  rejected: "bg-risk-soft text-risk",
};

const STATUS_LABEL: Record<string, string> = { published: "已发布", pending: "待审核", rejected: "已驳回" };

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${STATUS_STYLE[status] ?? "bg-surface-2 text-muted"}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function TypePill({ type }: { type: "product" | "idea" | "post" }) {
  return (
    <span className="rounded-full bg-brand-soft px-2 py-0.5 font-mono text-[10px] font-medium text-brand-ink">
      {type === "product" ? "产品" : type === "post" ? "社区帖" : "点子"}
    </span>
  );
}

// 概览页顶部的统计格子。href 有值时整块可点，跳到对应的详情页。
export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
  tone?: "neutral" | "warn" | "risk";
}) {
  const toneClass =
    tone === "risk" ? "text-risk" : tone === "warn" ? "text-warn" : "text-ink";
  const body = (
    <>
      <p className="font-mono text-[11px] uppercase tracking-wide text-faint">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </>
  );

  if (!href) return <div className="rounded-2xl border border-line bg-surface p-4">{body}</div>;
  return (
    <Link
      href={href}
      className="rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-brand"
    >
      {body}
    </Link>
  );
}

// 相对时间：后台列表里「3 小时前」比完整时间戳好扫，鼠标悬停能看到精确时间。
export function TimeAgo({ iso, className = "" }: { iso: string; className?: string }) {
  return (
    <span className={className} title={new Date(iso).toLocaleString("zh-CN")}>
      {formatRelative(iso)}
    </span>
  );
}

export function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
