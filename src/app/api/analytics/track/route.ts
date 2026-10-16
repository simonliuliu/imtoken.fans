import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  communityAnalyticsTarget,
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE,
  deviceFromUserAgent,
  isBotUserAgent,
  isTrackablePath,
  normalizePath,
  refererHost,
} from "@/lib/analytics";

// 埋点接收端。客户端每次路由变化 POST 一次（见 components/analytics-tracker.tsx）。
//
// 为什么不在 Server Component 里直接记：那里拿不到"这是一次导航"这个事实——
// App Router 的客户端路由不会重新执行 layout，靠服务端渲染次数数访问量会漏掉大半。
//
// 这个接口是公开的（未登录也要统计），所以刻意只接受最小输入：
// 路径和 referrer。IP、UA 原文一概不入库，device / country 是在这里归一化之后才存的。
// 没有做频率限制——被恶意刷量的话数字会虚高，但因为不涉及任何写业务数据的副作用，
// 影响仅限于看板不准；真出现了再在这里加 visitor 级别的限流。

export async function POST(request: Request) {
  // Supabase 没配好时静默放过：埋点失败不该让页面控制台一片红。
  if (!isSupabaseConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new NextResponse(null, { status: 204 });
  }

  let body: { path?: unknown; referrer?: unknown };
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const rawPath = typeof body.path === "string" ? body.path : "";
  if (!rawPath.startsWith("/")) return new NextResponse(null, { status: 204 });

  const headerList = await headers();
  const userAgent = headerList.get("user-agent");
  if (isBotUserAgent(userAgent)) return new NextResponse(null, { status: 204 });

  const normalized = normalizePath(rawPath);
  const { path, route } = normalized;
  let contentId = normalized.contentId;
  // 客户端也过滤了一遍，这里再挡一次：接口是公开的，不能只信调用方。
  if (!isTrackablePath(path)) return new NextResponse(null, { status: 204 });

  // 访客 cookie 不存在就现在发一个。
  // 竞态说明：首次进站时若有两个请求同时到达，会各自生成一个 id，UV 多算一个。
  // 代价极小（每个访客最多一次），换来的是不用在 proxy.ts 里给每个请求都插一段逻辑。
  const cookieStore = await cookies();
  const existingVisitorId = cookieStore.get(VISITOR_COOKIE)?.value;
  const visitorId = isUuid(existingVisitorId) ? existingVisitorId! : crypto.randomUUID();

  // 当前登录用户。多一次 auth 校验的开销，但这是"登录用户占多少流量"唯一可靠的来源，
  // 而且这些请求本来就在页面渲染完之后、不挡任何东西。
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  const admin = createAdminClient();
  const communityTarget = communityAnalyticsTarget(path);
  if (communityTarget) {
    // Never trust a client-supplied UUID or map a slug across boards. Only public
    // post targets can enter content aggregates; hidden/unknown paths stay page views.
    contentId = null;
    try {
      const { data } = await admin.from("submissions").select("id")
        .eq("type", "post").eq("community_section", communityTarget.section)
        .eq(communityTarget.isUuid ? "id" : "legacy_slug", communityTarget.identifier)
        .eq("status", "published").is("deleted_at", null).maybeSingle();
      contentId = data?.id ?? null;
    } catch { /* Analytics resolution must not interrupt navigation. */ }
  }
  const { error } = await admin.from("page_views").insert({
    path: path.slice(0, 300),
    route: route.slice(0, 300),
    content_id: contentId,
    visitor_id: visitorId,
    user_id: userId,
    referrer_host: refererHost(
      typeof body.referrer === "string" ? body.referrer : null,
      headerList.get("host")
    ),
    device: deviceFromUserAgent(userAgent),
    country: countryFromHeaders(headerList),
  });

  // 迁移还没跑（表不存在）之类的问题只记一行日志，照样回 204：
  // 埋点是旁路功能，任何情况下都不该把错误抛回页面。
  if (error) console.error("[analytics] page_views insert failed:", error.message);

  const response = new NextResponse(null, { status: 204 });
  if (visitorId !== existingVisitorId) {
    response.cookies.set(VISITOR_COOKIE, visitorId, {
      httpOnly: true,
      // 本地开发走 http，secure 一律 true 的话 cookie 存不下来，UV 会等于 PV。
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: VISITOR_COOKIE_MAX_AGE,
    });
  }
  return response;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

// 国家码由 CDN 注入。列了三家常见的（Vercel / Cloudflare / 通用），
// 自建部署或本地开发下三个都没有，country 就是 null，看板会把地区面板整块隐藏。
function countryFromHeaders(headerList: Headers): string | null {
  const raw =
    headerList.get("x-vercel-ip-country") ??
    headerList.get("cf-ipcountry") ??
    headerList.get("x-country-code");
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}
