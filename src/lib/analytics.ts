// 埋点的纯逻辑部分：路径归一化、设备判断、机器人识别。
// 客户端（analytics-tracker）和服务端（/api/analytics/track）都会 import 这个文件，
// 所以这里不能碰 next/headers、supabase 之类只有一端能用的东西。

/** 访客标识 cookie。httpOnly，服务端下发，客户端读不到（也就没法被篡改成别人的 id）。 */
export const VISITOR_COOKIE = "ih_vid";

/** 访客 cookie 有效期 1 年：跨天回访要能被认成同一个人，UV 才有意义。 */
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** 原始访问记录的保留期，和迁移里 purge_expired_page_views 的默认值保持一致。 */
export const PAGE_VIEW_RETENTION_DAYS = 180;

/** 天/小时的切分时区。和迁移里聚合函数的默认值保持一致，改的时候两边一起改。 */
export const ANALYTICS_TZ = "Asia/Shanghai";

export type DeviceKind = "desktop" | "mobile" | "tablet";

export const DEVICE_LABEL: Record<string, string> = {
  desktop: "桌面端",
  mobile: "手机",
  tablet: "平板",
};

// 不进统计的路径。前三个是"不是页面"（接口、静态资源、带 token 的回调），
// /admin 是"自己人"——运营天天在后台点，算进访问量会把真实用户的曲线冲淡。
const IGNORED_PREFIXES = ["/api", "/_next", "/auth/callback", "/admin"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTrackablePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const canonical = withoutLocale(stripQuery(path));
  return !IGNORED_PREFIXES.some((prefix) => canonical === prefix || canonical.startsWith(`${prefix}/`));
}

export interface NormalizedPath {
  /** 真实路径，查询串和 hash 已经去掉（可能带隐私，也会让聚合结果碎掉）。 */
  path: string;
  /** 动态段折叠后的模板，例如 /products/[id]。看板按这个聚合"哪类页面流量大"。 */
  route: string;
  /** 内容页对应的 submission id，非内容页为 null。 */
  contentId: string | null;
}

/**
 * 把浏览器给的路径拆成 path / route / contentId。
 *
 * 两层归一：
 *   1. uuid 段折叠成 [id]、用户名折叠成 [username]，否则每个产品/每个人各占一行
 *   2. 折叠后如果不是站点真有的路由（见 ROUTE_LABEL），归到 OTHER_ROUTE 这一桶
 *
 * 第 2 条是被真实数据教出来的：404 页面同样会渲染根 layout，埋点照样上报，
 * 于是爬虫和外部失效链接探的那些路径全挤进了"热门页面"。而且埋点接口是公开的，
 * 不设上限的话，随便刷随机 URL 就能把 route 的基数撑爆。
 * 原始 path 仍然照存，「失效链接」面板就是从这一桶里按 path 反查出来的。
 */
export function normalizePath(rawPath: string): NormalizedPath {
  const path = stripQuery(rawPath);
  const segments = withoutLocale(path).split("/").filter(Boolean);
  const communityTarget = communityAnalyticsTarget(path);

  let contentId: string | null = null;
  const routeSegments = segments.map((segment, index) => {
    if (UUID_RE.test(segment)) {
      // 仅已识别的内容详情路由携带内容 UUID；社区目标仍由接收端核验公开性和归属。
      if ((index === 1 && (segments[0] === "products" || segments[0] === "ideas")) || (index === 2 && communityTarget)) {
        contentId = segment.toLowerCase();
      }
      return "[id]";
    }
    if (index === 2 && communityTarget) return "[id]";
    // 个人主页的用户名不是 uuid，得单独认一下，否则每个人的主页都会占一行。
    if (index === 1 && segments[0] === "u") return "[username]";
    return segment;
  });

  const route = routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
  if (route in ROUTE_LABEL) return { path, route, contentId };
  // 未收录的路由：内容 id 也不认（不是真的内容页），避免污染"热门内容"。
  return { path, route: OTHER_ROUTE, contentId: null };
}

const COMMUNITY_SECTIONS = ["safety", "feedback", "discussion", "activities"] as const;

function withoutLocale(path: string): string {
  // Public pages always carry one of the configured language prefixes.
  return path.replace(/^\/(zh|en)(?=\/|$)/, "") || "/";
}

/** Only recognized board/permalink shapes can be resolved as community content. */
export function communityAnalyticsTarget(rawPath: string): { section: string; identifier: string; isUuid: boolean } | null {
  const segments = withoutLocale(stripQuery(rawPath)).split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "community" || !COMMUNITY_SECTIONS.some(section => section === segments[1])) return null;
  const identifier = segments[2];
  if (identifier.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(identifier)) return null;
  return { section: segments[1], identifier, isUuid: UUID_RE.test(identifier) };
}

function stripQuery(rawPath: string): string {
  const cut = rawPath.search(/[?#]/);
  const path = cut === -1 ? rawPath : rawPath.slice(0, cut);
  if (!path.startsWith("/")) return "/";
  // 去掉结尾斜杠，让 /products 和 /products/ 算同一个页面（根路径除外）。
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** 未收录路由的兜底桶。404、爬虫探路、失效外链都落在这里。 */
export const OTHER_ROUTE = "/[未收录]";

/**
 * 页面路径的中文名，同时兼作 normalizePath 的路由白名单——
 * 新增页面时在这里补一行，看板才会把它单列出来（不补就落进 OTHER_ROUTE）。
 * 这份清单必须和 src/app 下真实存在的公开路由一致（后台 / 接口在 IGNORED_PREFIXES 里已排除）。
 */
export const ROUTE_LABEL: Record<string, string> = {
  "/": "首页",
  "/products": "产品列表",
  "/products/[id]": "产品详情",
  "/ideas": "点子列表",
  "/ideas/[id]": "点子详情",
  "/leaderboard": "排行榜",
  "/activities": "活动中心",
  "/submit": "提交内容",
  "/search": "搜索",
  "/community/safety": "钱包安全",
  "/community/safety/[id]": "钱包安全帖子",
  "/community/feedback": "产品共创",
  "/community/feedback/[id]": "产品共创帖子",
  "/community/discussion": "综合交流",
  "/community/discussion/[id]": "综合交流帖子",
  "/community/activities": "活动区",
  "/community/activities/[id]": "活动区帖子",
  "/submit/post": "发布帖子",
  "/submit/feedback": "提交反馈",
  "/submit/product": "提交产品",
  "/profile": "个人设置",
  "/u/[username]": "用户主页",
  "/faq": "常见问题",
  "/welcome": "新人引导",
  "/auth/sign-in": "登录页",
  [OTHER_ROUTE]: "未收录页面（404 / 失效链接）",
};

export function routeLabel(route: string): string {
  return ROUTE_LABEL[route] ?? route;
}

const BOT_RE =
  /bot|crawler|spider|crawl|slurp|bingpreview|headless|lighthouse|pingdom|monitor|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python-requests|axios|go-http/i;

/** 机器人不算访问量。判断靠 User-Agent，挡得住正规爬虫，挡不住刻意伪装的——够用。 */
export function isBotUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return true; // 正常浏览器一定带 UA，不带的当机器人处理
  return BOT_RE.test(userAgent);
}

export function deviceFromUserAgent(userAgent: string | null): DeviceKind {
  if (!userAgent) return "desktop";
  const ua = userAgent.toLowerCase();
  // 顺序有讲究：Android 平板的 UA 里有 "android" 没有 "mobile"，
  // 所以平板要先判，否则会被下面的 android 规则吃掉。
  if (/ipad|tablet|playbook|silk/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua))) {
    return "tablet";
  }
  if (/mobile|iphone|ipod|android|phone/.test(ua)) return "mobile";
  return "desktop";
}

/**
 * referrer 只留域名。
 * 同域返回 null：站内跳转不是"流量来源"，混进来会让自己的域名永远排第一。
 */
export function refererHost(referrer: string | null, selfHost: string | null): string | null {
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!host) return null;
  const self = selfHost?.toLowerCase().replace(/^www\./, "").split(":")[0];
  if (self && host === self) return null;
  return host.slice(0, 120);
}
