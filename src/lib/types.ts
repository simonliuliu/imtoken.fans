// 对应 supabase/migrations/0003_moderation_and_cards.sql 里 submission_cards 视图的真实列。
// 取代 mock-data.ts 里的 Submission 类型。

export type SubmissionType = "product" | "idea";
export type SubmissionStatus = "pending" | "published" | "rejected";
export type ProductPlatform = "web" | "ios" | "android" | "browser_extension" | "telegram" | "hardware" | "other";
export type ProductPricing = "free" | "freemium" | "paid" | "open_source";
export type ProductLaunchStage = "live" | "public_beta" | "private_beta" | "coming_soon";
export type MakerRelationship = "creator" | "team_member";
export type UserRole = "user" | "member" | "admin";
export type PermissionKey =
  | "auto_publish_submissions"
  | "moderate_submissions"
  | "moderate_comments"
  | "grant_badges"
  | "manage_user_tags"
  | "manage_campaigns"
  | "view_analytics";
export type Permissions = Partial<Record<PermissionKey, boolean>>;
export type UserTagKey = "vip" | "verified" | "blacklisted";

// 后台「用户管理」里逐项勾选的权限开关。顺序就是面板里的展示顺序，
// 前三项（免审 / 审核内容 / 删评论禁言）是日常最常授予的，放最前面。
export const PERMISSION_INFO: Record<PermissionKey, { label: string; description: string }> = {
  auto_publish_submissions: { label: "免审发布", description: "自己提交的产品/点子不进审核队列" },
  moderate_submissions: { label: "审核内容", description: "通过/驳回产品与点子，管理已发布内容" },
  moderate_comments: { label: "删除评论 / 禁言", description: "删除评论、处理举报、禁言用户" },
  grant_badges: { label: "授予徽章", description: "给用户颁发或撤销荣誉徽章" },
  manage_user_tags: { label: "管理标签", description: "设置 VIP / 官方认证 / 黑名单标签" },
  manage_campaigns: { label: "管理活动", description: "签到规则、抽奖奖品、经验值配置" },
  view_analytics: { label: "数据看板", description: "查看访问量、增长与内容热度数据" },
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_INFO) as PermissionKey[];

export const ROLE_LABEL: Record<UserRole, string> = { user: "普通用户", member: "成员", admin: "管理员" };

// 面向用户的英文版。管理后台是纯中文、不挂在 [locale] 段下（见 src/proxy.ts），拿不到
// next-intl 的 Provider，只能直接读上面这些中文表；所以中英两份都留在代码里挨着放，
// 前台通过下面的 xxxLabel(key, locale) 取，不在 messages/*.json 里再抄一遍中文。
const ROLE_LABEL_EN: Record<UserRole, string> = { user: "Member", member: "Team member", admin: "Admin" };

/** 前台用：按当前语言取角色名。 */
export function roleLabel(role: UserRole, locale: string): string {
  return locale === "en" ? ROLE_LABEL_EN[role] : ROLE_LABEL[role];
}



// 后台列表里用英文角色名（和权限体系的叫法对齐：Admin / Manager），
// 公开页面上名字旁边的角色标签仍然用中文的 ROLE_LABEL，两边不混用。
export const ROLE_ADMIN_LABEL: Record<UserRole, string> = { user: "User", member: "Manager", admin: "Admin" };

// 禁言时长，1 天 / 3 天 / 7 天 / 永久。永久用 9999 年当哨兵值，
// 这样「是否在禁言中」的判断（muted_until > now()）不用为永久开特例。
export const PERMANENT_MUTE_UNTIL = "9999-12-31T00:00:00.000Z";
export type MuteDuration = 1 | 3 | 7 | "permanent";
export const MUTE_PRESETS: { value: MuteDuration; label: string }[] = [
  { value: 1, label: "1 天" },
  { value: 3, label: "3 天" },
  { value: 7, label: "7 天" },
  { value: "permanent", label: "永久" },
];

export function muteDurationLabel(duration: MuteDuration): string {
  return MUTE_PRESETS.find((preset) => preset.value === duration)?.label ?? String(duration);
}

// 回收站保留期：删除后 7 天内可恢复，之后由 purge_expired_deleted_content() 彻底清除。
export const TRASH_RETENTION_DAYS = 7;

export const USER_TAG_INFO: Record<UserTagKey, { icon: string; label: string }> = {
  vip: { icon: "⭐", label: "VIP" },
  verified: { icon: "✔️", label: "已认证" },
  blacklisted: { icon: "⛔", label: "黑名单" },
};

const USER_TAG_LABEL_EN: Record<UserTagKey, string> = {
  vip: "VIP",
  verified: "Verified",
  blacklisted: "Blacklisted",
};

/** 前台用：按当前语言取用户标签的文字（图标两边共用）。 */
export function userTagLabel(tag: UserTagKey, locale: string): string {
  return locale === "en" ? USER_TAG_LABEL_EN[tag] : USER_TAG_INFO[tag].label;
}

export interface TeamMember {
  name: string;
  role: string;
  link?: string;
}

export interface SocialLink {
  label: string;
  url: string;
}

export interface SubmissionCard {
  id: string;
  type: SubmissionType;
  title: string;
  tagline: string;
  description: string;
  tags: string[];
  status: SubmissionStatus;
  submitted_by: string;
  stats_users: number | null;
  stats_dau: number | null;
  stats_updated_at: string | null;
  built_from_idea_id: string | null;
  created_at: string;
  updated_at: string;
  website_url: string | null;
  video_url: string | null;
  logo_path: string | null;
  screenshot_paths: string[];
  team: TeamMember[];
  social_links: SocialLink[];
  submitted_by_username: string | null;
  submitted_by_avatar_url: string | null;
  submitted_by_role: UserRole | null;
  // 软删除标记：非 null = 在回收站里，公开列表和后台内容列表都会过滤掉。
  deleted_at: string | null;
  submitted_by_level: number | null;
  votes_paid: number;
  votes_creative: number;
  sim_invest_usd: number;
  comment_count: number;
  product_platforms: ProductPlatform[];
  pricing_type: ProductPricing | null;
  launch_stage: ProductLaunchStage | null;
  maker_relationship: MakerRelationship | null;
  maker_note: string | null;
  feedback_prompt: string | null;
  published_at: string | null;
  support_count: number;
  rating_count: number;
  rating_average: number | null;
}

export type ProductRatingStrength = "useful" | "easy_to_use" | "design" | "innovation" | "security";
export type ProductRatingImprovement = "reliability" | "usability" | "documentation" | "performance" | "support";

export interface ProductRating {
  id: string;
  submission_id: string;
  user_id: string;
  rating: number;
  body: string;
  strengths: ProductRatingStrength[];
  improvements: ProductRatingImprovement[];
  experienced: boolean;
  created_at: string;
  updated_at: string;
  author_username: string | null;
  author_display_name: string | null;
  author_avatar_url: string | null;
  author_level: number | null;
}

export interface CommentWithAuthor {
  id: string;
  submission_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  status: SubmissionStatus;
  created_at: string;
  pinned_at: string | null;
  deleted_at: string | null;
  author_username: string | null;
  author_display_name: string | null;
  author_role: UserRole | null;
  author_level: number | null;
  vote_count: number;
  viewer_has_voted: boolean;
}

export type CommentReportReason =
  | "spam"
  | "duplicate"
  | "harmful"
  | "not_working"
  | "self_promotion"
  | "ai_generated";

export const COMMENT_REPORT_REASON_LABEL: Record<CommentReportReason, string> = {
  spam: "垃圾信息",
  duplicate: "重复内容",
  harmful: "有害内容",
  not_working: "内容有误 / 需要修改",
  self_promotion: "自我推广",
  ai_generated: "疑似 AI 生成",
};

const COMMENT_REPORT_REASON_LABEL_EN: Record<CommentReportReason, string> = {
  spam: "Spam",
  duplicate: "Duplicate",
  harmful: "Harmful content",
  not_working: "Incorrect / needs fixing",
  self_promotion: "Self-promotion",
  ai_generated: "Likely AI-generated",
};

/** 前台用：按当前语言取举报理由。 */
export function commentReportReasonLabel(reason: CommentReportReason, locale: string): string {
  return locale === "en" ? COMMENT_REPORT_REASON_LABEL_EN[reason] : COMMENT_REPORT_REASON_LABEL[reason];
}

export type CommentReportStatus = "open" | "resolved" | "dismissed";

export const COMMENT_REPORT_STATUS_LABEL: Record<CommentReportStatus, string> = {
  open: "待处理",
  resolved: "已处理",
  dismissed: "已驳回",
};

// 通知分两类：
//   mention / reply —— 由别人的动作触发，有"触发人"，渲染成「谁 + 做了什么」
//   其余几种       —— 系统或管理员做的，没有触发人，actor / submission / comment 全为空，
//                     具体数值放在 detail 里（见 0016 / 0018 迁移），按类型各自渲染
// 后一类的共同点是"发生在用户身上、但用户当时不在现场"，所以必须留一条通知。
export type NotificationType = "mention" | "reply" | "level_up" | "lottery_ticket" | "badge" | "xp_adjust";


export interface NotificationDetail {
  kind?: "reply" | "mention" | "follow_post" | "follow_comment";
  /** level_up：新等级 */
  level?: number;
  /** lottery_ticket / xp_adjust：变动量，负数 = 被收回 */
  amount?: number;
  /** lottery_ticket：变动之后的券余额 */
  balance?: number;
  /** xp_adjust：变动之后的经验总量 */
  xp?: number;
  /** lottery_ticket：券是管理员发的还是抽奖抽到的 */
  source?: "admin_grant" | "lottery_prize";
  /** badge：徽章 key，对应 BADGE_INFO */
  badge_key?: string;
}

export interface NotificationItem {
  href?: string | null;
  id: string;
  type: NotificationType;
  read_at: string | null;
  created_at: string;
  actor_username: string | null;
  actor_avatar_url: string | null;
  submission_id: string | null;
  submission_type: SubmissionType | null;
  submission_title: string | null;
  comment_id: string | null;
  comment_preview: string | null;
  detail: NotificationDetail | null;
}

export interface Badge {
  icon: string;
  name: string;
  description: string;
  // true = 管理员在后台手动颁发/撤销；缺省 = 系统按行为自动计算（refreshBadgesForUser）。
  // 自动徽章不能在后台撤销——撤了下次刷新还会回来。
  grantable?: boolean;
}

export const BADGE_INFO: Record<string, Badge> = {
  // —— 自动成就 ——
  genesis_member: { icon: "🏆", name: "Genesis Member", description: "前 50 位注册用户" },
  ideas: { icon: "🧠", name: "点子贡献者", description: "至少发布过 1 篇点子" },
  contributions: { icon: "💬", name: "活跃评论者", description: "至少有 1 条评论通过审核" },
  backed_projects: { icon: "💰", name: "模拟投资人", description: "至少模拟投资过 1 个项目" },

  // —— 人工颁发（后台下拉菜单里的选项）——
  official: { icon: "✅", name: "官方认证", description: "已验证身份的官方 / 品牌账号", grantable: true },
  icoin: { icon: "🪙", name: "iCoin 持有者", description: "持有 iCoin 的社区成员", grantable: true },
  founder: { icon: "🚀", name: "创始团队", description: "imToken Fans 创始与核心团队成员", grantable: true },
  moderator: { icon: "🛡️", name: "社区版主", description: "协助维护社区秩序", grantable: true },
  partner: { icon: "🤝", name: "合作伙伴", description: "官方合作的机构或项目方", grantable: true },
  investor: { icon: "💼", name: "认证投资人", description: "经核实的投资人身份", grantable: true },
  mentor: { icon: "🎓", name: "社区导师", description: "长期为创作者提供指导", grantable: true },
  beta_tester: { icon: "🧪", name: "内测成员", description: "参与过新功能内测", grantable: true },
  top_contributor: { icon: "🌟", name: "年度贡献者", description: "年度贡献最多的成员", grantable: true },
  event_winner: { icon: "🏅", name: "活动获奖者", description: "在官方活动中获奖", grantable: true },
};

const BADGE_INFO_EN: Record<string, { name: string; description: string }> = {
  genesis_member: { name: "Genesis Member", description: "One of the first 50 registered users" },
  ideas: { name: "Idea Contributor", description: "Published at least 1 idea" },
  contributions: { name: "Active Commenter", description: "At least 1 comment approved" },
  backed_projects: { name: "Simulated Investor", description: "Made at least 1 simulated investment" },

  official: { name: "Official", description: "Verified official / brand account" },
  icoin: { name: "iCoin Holder", description: "Community member holding iCoin" },
  founder: { name: "Founding Team", description: "imToken Fans founding and core team" },
  moderator: { name: "Moderator", description: "Helps keep the community in order" },
  partner: { name: "Partner", description: "Official partner organisation or project" },
  investor: { name: "Verified Investor", description: "Verified investor identity" },
  mentor: { name: "Mentor", description: "Provides long-term guidance to creators" },
  beta_tester: { name: "Beta Tester", description: "Took part in a feature beta" },
  top_contributor: { name: "Top Contributor", description: "Contributed the most this year" },
  event_winner: { name: "Event Winner", description: "Won an official event" },
};

/**
 * 前台用：按当前语言取徽章的图标 + 名称 + 说明。
 * 找不到 key（数据库里存了代码不认识的徽章）时返回 null，调用方自己决定怎么兜底。
 */
export function badgeInfo(
  key: string,
  locale: string
): { icon: string; name: string; description: string; grantable?: boolean } | null {
  const base = BADGE_INFO[key];
  if (!base) return null;
  const en = locale === "en" ? BADGE_INFO_EN[key] : undefined;
  return {
    icon: base.icon,
    name: en?.name ?? base.name,
    description: en?.description ?? base.description,
    grantable: base.grantable,
  };
}

// 后台「授予徽章」下拉菜单的选项来源：只列 grantable 的，保持声明顺序。
export const GRANTABLE_BADGE_KEYS = Object.keys(BADGE_INFO).filter((key) => BADGE_INFO[key].grantable);
