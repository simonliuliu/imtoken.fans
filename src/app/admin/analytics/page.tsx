import { requireAdmin, hasPermission } from "@/lib/admin-guard";
import {
  DEFAULT_RANGE_DAYS,
  RANGE_OPTIONS,
  getAnalyticsOverview,
  normalizeRangeDays,
  purgeExpiredPageViews,
} from "@/lib/analytics-data";
import { ANALYTICS_TZ, DEVICE_LABEL, PAGE_VIEW_RETENTION_DAYS, routeLabel } from "@/lib/analytics";
import { LEVEL_TIERS, MAX_LEVEL, xpActionLabel } from "@/lib/level";
import { AdminPanel, NoPermissionNotice, StatCard } from "@/components/admin/ui";
import { FilterTabs } from "@/components/admin/list-controls";
import {
  ActivityChart,
  BarList,
  DeltaStatCard,
  FunnelBars,
  GrowthChart,
  HourChart,
  MetricList,
  SectionTitle,
  TrendChart,
  breakdownRows,
  formatCount,
} from "@/components/admin/analytics-charts";

// 运营数据看板。数据来自两处：
//   * 访问量：自建埋点表 page_views（/api/analytics/track 写入，见 0019 迁移）
//   * 其它一切：业务表本身（profiles / submissions / comments / votes / checkins / lottery_* / xp_events）
// 聚合全部在数据库里做（0019 + 0020 的 analytics_* 函数），这里只负责排版。
//
// 页面不缓存：看板的意义就是看当下，缓存住反而让人怀疑数字对不对。
export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const profile = await requireAdmin();
  if (!hasPermission(profile, "view_analytics")) return <NoPermissionNotice what="数据看板" />;

  const params = await searchParams;
  const rangeDays = normalizeRangeDays(params.range);

  // 原始访问记录的保留期执行点（数据库里不一定开了 pg_cron）。幂等，和看板查询并行跑。
  const [, overview] = await Promise.all([purgeExpiredPageViews(), getAnalyticsOverview(rangeDays)]);

  const { summary, previous, daily, engagement, engagementPrev, contentHealth, checkin, lottery } =
    overview;

  const perVisitor = summary.visitors > 0 ? summary.views / summary.visitors : 0;
  const memberShare = summary.views > 0 ? Math.round((summary.memberViews / summary.views) * 100) : 0;
  const reviewed = contentHealth.approved + contentHealth.rejected;
  const approvalRate = reviewed > 0 ? Math.round((contentHealth.approved / reviewed) * 100) : null;
  const totalUsers = overview.levels.reduce((sum, row) => sum + row.users, 0);
  const retentionTotal = overview.retention.reduce((sum, row) => sum + row.size, 0);
  const retentionReturned = overview.retention.reduce((sum, row) => sum + row.returned, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterTabs
          paramKey="range"
          defaultValue={String(DEFAULT_RANGE_DAYS)}
          options={RANGE_OPTIONS.map((days) => ({ value: String(days), label: `最近 ${days} 天` }))}
        />
        <p className="font-mono text-[11px] text-faint">
          {ANALYTICS_TZ} · 含今天 · 与前 {rangeDays} 天对比
        </p>
      </div>

      {!overview.ready && <MigrationNotice />}

      {/* ==================== 访问 ==================== */}
      <SectionTitle title="访问" hint="来自自建埋点，不含后台页面与已识别的爬虫" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DeltaStatCard label="浏览量 PV" value={summary.views} previous={previous.views} />
        <DeltaStatCard
          label="独立访客 UV"
          value={summary.visitors}
          previous={previous.visitors}
          hint={`人均 ${perVisitor.toFixed(1)} 页`}
        />
        <DeltaStatCard
          label="登录访客"
          value={summary.memberVisitors}
          previous={previous.memberVisitors}
          hint={`占浏览量 ${memberShare}%`}
        />
        <DeltaStatCard
          label="内容页访客"
          value={engagement.contentVisitors}
          previous={engagementPrev.contentVisitors}
          hint="打开过产品/点子详情页"
        />
      </div>

      <AdminPanel title="访问趋势" description="浏览量与独立访客的每日变化，悬停看当天明细">
        <TrendChart daily={daily} />
      </AdminPanel>

      {/* ==================== 增长 ==================== */}
      <SectionTitle title="增长" hint="注册、激活、创作与回访" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DeltaStatCard label="新增用户" value={summary.newUsers} previous={previous.newUsers} />
        <DeltaStatCard
          label="新增内容"
          value={summary.newSubmissions}
          previous={previous.newSubmissions}
        />
        <DeltaStatCard label="新增评论" value={summary.newComments} previous={previous.newComments} />
        <DeltaStatCard label="新增投票" value={summary.newVotes} previous={previous.newVotes} />
      </div>

      <AdminPanel title="社区增长" description="每天新增的用户、内容与评论（堆叠，柱高 = 当天总动作数）">
        <GrowthChart daily={daily} />
      </AdminPanel>

      <div className="grid gap-3 lg:grid-cols-2">
        <AdminPanel
          title="注册转化漏斗"
          description="「激活」= 注册后评论 / 投票 / 模拟投资 / 签到 / 发内容中做过任意一件"
        >
          <FunnelBars
            steps={[
              { label: "独立访客", value: overview.funnel.visitors, note: "浏览器维度" },
              { label: "注册用户", value: overview.funnel.signups, note: "账号维度" },
              { label: "激活用户", value: overview.funnel.activated },
              { label: "发过内容", value: overview.funnel.creators },
            ]}
          />
          <p className="mt-3 text-[11px] text-faint">
            前两级不是同一个维度：访客只有埋点上线之后才有数据，注册数从建站起就是完整的。
            区间跨到埋点上线之前时，第一级会偏小甚至为 0。
          </p>
        </AdminPanel>

        <AdminPanel
          title="新用户回访"
          count={retentionTotal}
          description={
            retentionTotal > 0
              ? `整体回访率 ${Math.round((retentionReturned / retentionTotal) * 100)}%（注册当天之后还来过至少一次）`
              : "按注册日分组"
          }
        >
          <MetricList
            rows={overview.retention.map((row) => ({
              label: row.day,
              value: row.size,
              note: row.size > 0 ? `回访 ${Math.round((row.returned / row.size) * 100)}%` : "—",
              weight: row.size,
            }))}
            unit=" 人注册"
            emptyText="这段时间没有新用户注册"
          />
          <p className="mt-3 text-[11px] text-faint">
            今天和昨天注册的人天然偏低（还没到「第二天」），看趋势时忽略最上面一两行。
          </p>
        </AdminPanel>
      </div>

      <AdminPanel title="等级分布" count={totalUsers} description="全站快照，不随时间区间变化">
        <MetricList
          rows={overview.levels.map((row) => ({
            label: `Lv${row.level} ${LEVEL_TIERS[Math.min(MAX_LEVEL, row.level)]?.name ?? ""}`,
            value: row.users,
            note: totalUsers > 0 ? `${Math.round((row.users / totalUsers) * 100)}%` : undefined,
          }))}
          unit=" 人"
          emptyText="还没有用户"
        />
      </AdminPanel>

      {/* ==================== 内容与审核 ==================== */}
      <SectionTitle title="内容与审核" hint="审核效率与内容健康度" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="待审核积压"
          value={contentHealth.pending}
          hint="当前队列，不分区间"
          href="/admin/content"
          tone={contentHealth.pending > 0 ? "warn" : "neutral"}
        />
        <StatCard
          label="通过率"
          value={approvalRate === null ? "—" : `${approvalRate}%`}
          hint={`通过 ${contentHealth.approved} · 驳回 ${contentHealth.rejected}`}
        />
        <StatCard
          label="审核耗时中位数"
          value={formatMinutes(contentHealth.medianReviewMinutes)}
          hint={`P90 ${formatMinutes(contentHealth.p90ReviewMinutes)}`}
        />
        <StatCard
          label="零评论内容"
          value={contentHealth.zeroComment}
          hint="已发布但没人评论，可去撬动"
          href="/admin/content"
          tone={contentHealth.zeroComment > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="新增举报"
          value={contentHealth.reportsNew}
          hint={`区间内处理 ${contentHealth.reportsResolved} 条`}
          href="/admin/reports"
          tone={contentHealth.reportsNew > 0 ? "risk" : "neutral"}
        />
        <StatCard label="通过内容" value={contentHealth.approved} hint="区间内审核通过" />
        <StatCard label="驳回内容" value={contentHealth.rejected} hint="区间内审核驳回" />
        <StatCard
          label="模拟投资"
          value={`$${formatCount(Math.round(engagement.investUsd))}`}
          hint={`${engagement.investments} 笔`}
        />
      </div>

      {/* ==================== 互动 ==================== */}
      <SectionTitle title="互动" hint="投票、评论、点赞——社区有没有真的在动" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DeltaStatCard
          label="付费票"
          value={engagement.votesPaid}
          previous={engagementPrev.votesPaid}
          hint="「我愿意付费」"
        />
        <DeltaStatCard
          label="创意票"
          value={engagement.votesCreative}
          previous={engagementPrev.votesCreative}
          hint="「有创意」"
        />
        <DeltaStatCard
          label="投票人数"
          value={engagement.voters}
          previous={engagementPrev.voters}
          hint={
            engagement.contentVisitors > 0
              ? `内容页访客的 ${((engagement.voters / engagement.contentVisitors) * 100).toFixed(1)}%`
              : undefined
          }
        />
        <DeltaStatCard
          label="评论人数"
          value={engagement.commenters}
          previous={engagementPrev.commenters}
          hint={`评论点赞 ${formatCount(engagement.commentVotes)}`}
        />
      </div>

      {/* ==================== 活动 ==================== */}
      <SectionTitle title="活动" hint="签到、抽奖、经验值——运营活动的投入与产出" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DeltaStatCard
          label="签到人次"
          value={checkin.totalCheckins}
          previous={overview.checkinPrev.totalCheckins}
          hint={`${checkin.users} 人参与`}
        />
        <DeltaStatCard
          label="签到发出经验"
          value={checkin.xpAwarded}
          previous={overview.checkinPrev.xpAwarded}
        />
        <StatCard
          label="连签 7 天+"
          value={checkin.streak7plus}
          hint={`平均连签 ${checkin.avgStreak.toFixed(1)} 天`}
        />
        <StatCard
          label="最长连签"
          value={`${checkin.longestStreak} 天`}
          hint="全站历史纪录"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DeltaStatCard
          label="抽奖次数"
          value={lottery.draws}
          previous={overview.lotteryPrev.draws}
          hint={`${lottery.drawers} 人参与`}
        />
        <DeltaStatCard
          label="抽奖发出经验"
          value={lottery.xpAwarded}
          previous={overview.lotteryPrev.xpAwarded}
          hint={lottery.xpCost > 0 ? `消耗经验 ${formatCount(lottery.xpCost)}` : undefined}
        />
        <StatCard
          label="抽奖券收支"
          value={`+${formatCount(lottery.ticketsGranted)} / -${formatCount(lottery.ticketsSpent)}`}
          hint="区间内发放 / 消耗"
        />
        <StatCard
          label="未消耗券"
          value={lottery.ticketsOutstanding}
          hint={
            lottery.unfulfilled > 0
              ? `另有 ${lottery.unfulfilled} 份实物待发放`
              : "全站券余额，决定后面还会被抽走多少奖品"
          }
          tone={lottery.unfulfilled > 0 ? "warn" : "neutral"}
        />
      </div>

      <AdminPanel title="活动趋势" description="每天的签到人数与抽奖次数，悬停看当天发出的经验">
        <ActivityChart activity={overview.activityDaily} />
      </AdminPanel>

      <div className="grid gap-3 lg:grid-cols-2">
        <AdminPanel title="奖品发放分布" count={overview.prizes.length} description="按中奖时的奖品名统计">
          <MetricList
            rows={overview.prizes.map((row) => ({
              label: `${row.icon} ${row.name}`,
              value: row.draws,
              note: `${row.winners} 人`,
            }))}
            unit=" 次"
            emptyText="这段时间还没有人抽奖"
          />
        </AdminPanel>

        <AdminPanel
          title="经验值来源"
          description="某一项占比过高就是在被刷，去活动管理里调每日上限"
        >
          <MetricList
            rows={overview.xp.map((row) => ({
              label: xpActionLabel(row.action),
              value: row.amount,
              note: `${formatCount(row.events)} 次 · ${formatCount(row.users)} 人`,
              // 抽奖消耗是负数，按绝对值画条并换成警示色，不然条会消失
              weight: Math.abs(row.amount),
              color: row.amount < 0 ? "var(--warn)" : undefined,
            }))}
            emptyText="这段时间没有经验值变动"
          />
        </AdminPanel>
      </div>

      {/* ==================== 流量明细 ==================== */}
      <SectionTitle title="流量明细" hint="人从哪来、看了哪些页面、什么时候来" />

      <div className="grid gap-3 lg:grid-cols-2">
        <AdminPanel title="热门页面" count={overview.routes.length} description="按页面类型聚合，动态段已折叠">
          <BarList
            rows={overview.routes.map((row) => ({
              label: routeLabel(row.route),
              sublabel: row.route,
              views: row.views,
              visitors: row.visitors,
            }))}
            emptyText="这段时间还没有访问数据"
          />
        </AdminPanel>

        <AdminPanel title="热门内容" count={overview.content.length} description="被打开最多的社区内容详情页">
          <BarList
            rows={overview.content.map((row) => ({
              label: row.title,
              sublabel: row.type === "post" ? "社区帖" : row.type === "product" ? "产品" : "点子",
              href: row.href,
              views: row.views,
              visitors: row.visitors,
            }))}
            emptyText="这段时间还没有内容详情页被访问"
          />
        </AdminPanel>
      </div>

      {/* 有未收录路径才显示：正常情况下这一块应该是空的，出现了就说明有链接指向了不存在的页面 */}
      {overview.unknownPaths.length > 0 && (
        <AdminPanel
          title="未收录路径"
          count={overview.unknownPaths.length}
          description="被访问了但站点上没有这个页面：失效外链、改版前的旧 URL、或者爬虫探路"
        >
          <MetricList
            rows={overview.unknownPaths.map((row) => ({
              label: row.path,
              value: row.views,
              note: `${row.visitors} 人`,
            }))}
            unit=" 次"
            emptyText="没有未收录路径"
          />
        </AdminPanel>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <AdminPanel title="流量来源" description="只统计外部来源，站内跳转不计入">
          <BarList
            rows={breakdownRows(overview.referrers, "直接访问 / 无来源")}
            emptyText="这段时间还没有访问数据"
          />
        </AdminPanel>

        <div className="flex flex-col gap-3">
          <AdminPanel title="设备分布">
            <BarList
              rows={breakdownRows(overview.devices, "未知设备", (name) => DEVICE_LABEL[name] ?? name)}
              emptyText="这段时间还没有访问数据"
            />
          </AdminPanel>

          {/* 地区数据依赖 CDN 注入的国家码，本地开发或自建部署下拿不到，整块隐藏而不是显示空面板 */}
          {overview.countries.length > 0 && (
            <AdminPanel title="地区分布" description="按 CDN 提供的国家码统计">
              <BarList rows={breakdownRows(overview.countries, "未知地区", countryLabel)} emptyText="暂无地区数据" />
            </AdminPanel>
          )}
        </div>
      </div>

      <AdminPanel
        title="活跃时段"
        description={`一天里各小时的浏览量分布（${ANALYTICS_TZ}）。发公告、开活动挑时间参考`}
      >
        <HourChart hourly={overview.hourly} />
      </AdminPanel>

      <p className="text-xs text-muted">
        独立访客按浏览器 cookie 去重，换设备或清缓存会算成新访客；标注「不分区间」「全站快照」的是存量指标，
        不随上面的时间范围变化。原始访问记录保留 {PAGE_VIEW_RETENTION_DAYS} 天，超期自动清除。
      </p>
    </div>
  );
}

/** 审核耗时：分钟数在小时以上就换单位，看板上不该出现「1440.0 分钟」。 */
function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 1) return "<1 分钟";
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)} 小时`;
  return `${(minutes / 60 / 24).toFixed(1)} 天`;
}

function MigrationNotice() {
  return (
    <div className="rounded-2xl border border-dashed border-warn bg-warn-soft p-5">
      <p className="text-sm font-semibold text-warn">还没有查到埋点数据表</p>
      <p className="mt-1 text-xs text-muted">
        请到 Supabase Dashboard → SQL Editor 按顺序执行{" "}
        <code className="font-mono">supabase/migrations/0019_analytics.sql</code> 和{" "}
        <code className="font-mono">0020_analytics_more.sql</code>，然后刷新本页。
        执行前访问量相关的数字都是 0。
      </p>
    </div>
  );
}

// 国家码转中文名。Intl.DisplayNames 是运行时内置的，不用自己维护一张两百行的对照表；
// 遇到它也不认识的码就原样显示。
const REGION_NAMES = new Intl.DisplayNames(["zh-CN"], { type: "region" });

function countryLabel(code: string): string {
  try {
    return REGION_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}
