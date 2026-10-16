// 用户等级体系：阈值、进度计算、等级配色。
// 这个文件不带 "server-only"，客户端组件（等级徽章、进度条、活动页）也要 import。

export const MAX_LEVEL = 10;

// 升到下一级需要多少经验值（LEVEL_STEPS[n] = 从 Lv(n) 升到 Lv(n+1) 需要的量）。
export const LEVEL_STEPS = [100, 500, 1000, 2000, 4000, 7000, 10000, 20000, 30000, 50000] as const;

// 累计阈值：LEVEL_THRESHOLDS[n] = 达到 Lv(n) 所需的累计经验值。
// ⚠️ 和 supabase/migrations/0016 里的 level_for_xp() 是同一份数字，改一边必须改另一边。
// 那边算等级（写进 profiles.level），这边画进度条。
export const LEVEL_THRESHOLDS: number[] = LEVEL_STEPS.reduce<number[]>(
  (acc, step) => [...acc, acc[acc.length - 1] + step],
  [0]
);
// => [0, 100, 600, 1600, 3600, 7600, 14600, 24600, 44600, 74600, 124600]

export interface LevelTier {
  name: string;
  icon: string;
  // 徽章底色用渐变而不是单色：等级是"想被看见"的东西，纯色药丸在一堆标签里会糊掉。
  // 直接写 CSS 值（不是 Tailwind 类名）——类名是动态拼的话会被 Tailwind 的扫描器漏掉。
  gradient: string;
  // 光晕颜色，用在个人中心的大号等级卡上。
  glow: string;
}

// 0-10 共 11 档。冷色起步（新手绿/蓝）→ 紫（进阶）→ 橙金（高阶）→ 满级彩虹。
export const LEVEL_TIERS: LevelTier[] = [
  { name: "新苗", icon: "🌱", gradient: "linear-gradient(135deg,#94a3b8,#64748b)", glow: "#94a3b8" },
  { name: "探索者", icon: "🧭", gradient: "linear-gradient(135deg,#34d399,#059669)", glow: "#34d399" },
  { name: "贡献者", icon: "🌿", gradient: "linear-gradient(135deg,#4ade80,#15803d)", glow: "#4ade80" },
  { name: "猎手", icon: "🎯", gradient: "linear-gradient(135deg,#38bdf8,#0284c7)", glow: "#38bdf8" },
  { name: "行家", icon: "⚡", gradient: "linear-gradient(135deg,#60a5fa,#2563eb)", glow: "#60a5fa" },
  { name: "精英", icon: "💠", gradient: "linear-gradient(135deg,#a78bfa,#7c3aed)", glow: "#a78bfa" },
  { name: "大师", icon: "🔮", gradient: "linear-gradient(135deg,#c084fc,#9333ea)", glow: "#c084fc" },
  { name: "宗师", icon: "🔥", gradient: "linear-gradient(135deg,#fb923c,#ea580c)", glow: "#fb923c" },
  { name: "传奇", icon: "🌟", gradient: "linear-gradient(135deg,#fbbf24,#d97706)", glow: "#fbbf24" },
  { name: "神话", icon: "💫", gradient: "linear-gradient(135deg,#f472b6,#db2777)", glow: "#f472b6" },
  {
    name: "巅峰",
    icon: "👑",
    gradient: "linear-gradient(120deg,#f43f5e,#f59e0b,#22c55e,#3b82f6,#a855f7)",
    glow: "#a855f7",
  },
];

// 称号的英文版。和上面的 LEVEL_TIERS 一一对应（按 index 对齐）。
// 为什么英文不放 messages/*.json：管理后台是纯中文、不挂在 [locale] 段下（见 src/proxy.ts），
// 拿不到 next-intl 的 Provider，只能直接读 LEVEL_TIERS[].name。中文留在这里给后台用，
// 英文放在旁边给前台用，两边共用一份数据，不会出现"改了一处忘了另一处"。
const TIER_NAMES_EN = [
  "Sprout",
  "Explorer",
  "Contributor",
  "Hunter",
  "Expert",
  "Elite",
  "Master",
  "Grandmaster",
  "Legend",
  "Mythic",
  "Apex",
];

export function clampLevel(level: number | null | undefined): number {
  if (!level || level < 0) return 0;
  return Math.min(MAX_LEVEL, Math.floor(level));
}

export function levelTier(level: number | null | undefined): LevelTier {
  return LEVEL_TIERS[clampLevel(level)];
}

/** 面向用户的称号。前台一律走这个（传 useLocale() 的结果），后台直接用 LEVEL_TIERS[].name。 */
export function levelTierName(level: number | null | undefined, locale: string): string {
  const lv = clampLevel(level);
  return locale === "en" ? TIER_NAMES_EN[lv] : LEVEL_TIERS[lv].name;
}

// 由经验值反推等级。服务端已经把 level 物化在 profiles 上，这个函数主要给
// 「本地乐观更新」用（签到/抽奖拿到经验后立刻更新进度条，不等服务端往返）。
export function levelForXp(xp: number): number {
  let level = 0;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i += 1) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i;
  }
  return level;
}

export interface LevelProgress {
  level: number;
  xp: number;
  /** 当前等级的起点经验值 */
  currentLevelXp: number;
  /** 下一级所需的累计经验值；满级时为 null */
  nextLevelXp: number | null;
  /** 还差多少升级；满级时为 0 */
  xpToNext: number;
  /** 当前等级内的进度，0-100。满级恒为 100 */
  percent: number;
}

export function levelProgress(xp: number, level?: number | null): LevelProgress {
  const safeXp = Math.max(0, Math.floor(xp || 0));
  // 传进来的 level 只作为提示，最终以 xp 为准——避免 profiles.level 因为任何原因
  // 和 xp 不同步时，进度条画出负数或超过 100% 的诡异结果。
  const lv = clampLevel(level ?? levelForXp(safeXp));
  const currentLevelXp = LEVEL_THRESHOLDS[lv];
  const nextLevelXp = lv >= MAX_LEVEL ? null : LEVEL_THRESHOLDS[lv + 1];

  if (nextLevelXp === null) {
    return { level: lv, xp: safeXp, currentLevelXp, nextLevelXp: null, xpToNext: 0, percent: 100 };
  }

  const span = nextLevelXp - currentLevelXp;
  const gained = Math.max(0, safeXp - currentLevelXp);
  return {
    level: lv,
    xp: safeXp,
    currentLevelXp,
    nextLevelXp,
    xpToNext: Math.max(0, nextLevelXp - safeXp),
    percent: Math.min(100, Math.round((gained / span) * 100)),
  };
}

// ========== 经验值获取途径（后台可配的那一组） ==========

export type XpActionKey =
  | "comment_posted"
  | "submission_product"
  | "submission_idea"
  | "submission_post"
  | "vote_cast"
  | "simulated_investment"
  | "comment_upvote_received";

// 和 PERMISSION_INFO / BADGE_INFO 同一个套路：数值存数据库（后台可改），
// 文案留在代码里。后台只能改这几个 key 的数值，不能新增代码不认识的 key。
export const XP_ACTION_INFO: Record<XpActionKey, { label: string; description: string }> = {
  comment_posted: { label: "回复消息", description: "在社区内容下发表评论或回复" },
  submission_post: { label: "发布社区帖子", description: "社区帖子通过审核并发布" },
  submission_product: { label: "发布产品", description: "提交的产品通过审核并发布" },
  submission_idea: { label: "发布点子", description: "提交的点子通过审核并发布" },
  vote_cast: { label: "参与投票", description: "给一个作品投票（同一个作品只计一次）" },
  simulated_investment: { label: "模拟投资", description: "模拟投资一个项目（同一个项目只计一次）" },
  comment_upvote_received: { label: "评论被点赞", description: "自己的评论被别人点赞（自己点自己不算）" },
};

export const XP_ACTION_INFO_EN: Record<XpActionKey, { label: string; description: string }> = {
  comment_posted: { label: "Comment", description: "Post a comment or reply on community content" },
  submission_post: { label: "Community post", description: "A community post is approved and published" },
  submission_product: { label: "Publish a product", description: "Your product submission is approved and published" },
  submission_idea: { label: "Publish an idea", description: "Your idea submission is approved and published" },
  vote_cast: { label: "Vote", description: "Vote on a submission (counted once per submission)" },
  simulated_investment: { label: "Simulated investment", description: "Invest in a project (counted once per project)" },
  comment_upvote_received: { label: "Comment upvoted", description: "Someone upvotes your comment (self-votes don't count)" },
};

export const XP_ACTION_KEYS = Object.keys(XP_ACTION_INFO) as XpActionKey[];

/** 前台用：按当前语言取某条经验规则的名称和说明。 */
export function xpActionInfo(action: XpActionKey, locale: string): { label: string; description: string } {
  return locale === "en" ? XP_ACTION_INFO_EN[action] : XP_ACTION_INFO[action];
}

// xp_events.action 里还有几种不由 xp_rules 控制的来源（签到奖励在签到设置里配，
// 抽奖奖品在奖品列表里配，管理员手动调整没有规则），这里统一给个可读名字。
const EXTRA_ACTION_LABEL: Record<string, string> = {
  daily_checkin: "每日签到",
  lottery_prize: "抽奖中奖",
  lottery_cost: "抽奖消耗",
  admin_adjust: "管理员调整",
};

const EXTRA_ACTION_LABEL_EN: Record<string, string> = {
  daily_checkin: "Daily check-in",
  lottery_prize: "Lottery prize",
  lottery_cost: "Lottery cost",
  admin_adjust: "Admin adjustment",
};

// locale 默认中文：管理后台（纯中文）直接调用不传第二个参数，前台一律传 useLocale()。
export function xpActionLabel(action: string, locale = "zh"): string {
  if (locale === "en") {
    if (action in XP_ACTION_INFO_EN) return XP_ACTION_INFO_EN[action as XpActionKey].label;
    return EXTRA_ACTION_LABEL_EN[action] ?? action;
  }
  if (action in XP_ACTION_INFO) return XP_ACTION_INFO[action as XpActionKey].label;
  return EXTRA_ACTION_LABEL[action] ?? action;
}
