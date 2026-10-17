import { requireAdmin, hasPermission } from "@/lib/admin-guard";
import {
  getCheckinSettings,
  getLotteryDrawsForAdmin,
  getLotteryPrizesForAdmin,
  getLotterySettings,
} from "@/lib/activities";
import { getXpRules } from "@/lib/xp";
import { CommunityActivityPanel } from "@/components/admin/community-activity-panel";
import { AdminPanel, NoPermissionNotice } from "@/components/admin/ui";
import {
  CheckinSettingsPanel,
  LotteryDrawsPanel,
  LotteryPrizesPanel,
  LotterySettingsPanel,
  TicketGrantPanel,
  XpRulesPanel,
} from "@/components/admin/campaign-panels";

// 活动管理：签到规则、抽奖设置与奖品、社区行为的经验值、抽奖券发放。
// 「给某个用户手动补经验 / 直接设等级」在用户管理页（那里已经有找人和逐个操作的界面）；
// 发券两边都有——这里按用户名直接发，用户管理页在每个用户那一行里发。
export default async function AdminCampaignsPage() {
  const profile = await requireAdmin();
  if (!hasPermission(profile, "manage_campaigns")) return <NoPermissionNotice what="活动管理" />;

  const [checkinSettings, lotterySettings, prizes, draws, xpRules] = await Promise.all([
    getCheckinSettings(),
    getLotterySettings(),
    getLotteryPrizesForAdmin(),
    getLotteryDrawsForAdmin(40),
    getXpRules(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <CommunityActivityPanel />
      <CheckinSettingsPanel settings={checkinSettings} />
      <XpRulesPanel rules={xpRules} />
      <LotterySettingsPanel settings={lotterySettings} />
      <TicketGrantPanel />
      <LotteryPrizesPanel prizes={prizes} />

      <AdminPanel title="中奖记录" count={draws.length} description="最近 40 条。实物奖品发放后在这里标记">
        <LotteryDrawsPanel draws={draws} />
      </AdminPanel>
    </div>
  );
}
