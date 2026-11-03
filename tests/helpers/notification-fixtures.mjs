// Optional, in-memory fixtures for the localhost auth API. Never imported by app
// routes, never connected to Supabase, and never enabled in the default auth suite.
import { CREATOR_ID, READER_ID, PRODUCT_ID, product } from "./auth-fixtures.mjs";

export const SAFETY_POST_ID = "66666666-6666-4666-8666-666666666666";
export const DISCUSSION_POST_ID = "77777777-7777-4777-8777-777777777777";
export const SAFETY_COMMENT_ID = "88888888-8888-4888-8888-888888888888";
export const DISCUSSION_COMMENT_ID = "99999999-9999-4999-8999-999999999999";
export const PRODUCT_COMMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREATED = "2026-11-03T08:00:00Z";

function communityCard(id, section, category, legacySlug, title) {
  return {
    ...product, id, type: "post", title, tagline: "Local fixture: no real content or account is used.",
    description: "仅供本地通知跳转验收，帖子、作者和评论均为测试夹具。\n\nLocal notification navigation fixture. The author, post, and comments are fictional.",
    community_section: section, community_category: category, legacy_slug: legacySlug,
    is_example: false, example_author: null, example_content: null, community_like_count: 0,
    comment_count: 1, support_count: 0, created_at: CREATED,
  };
}
const cards = [
  communityCard(SAFETY_POST_ID, "safety", "guides", "approval-checklist", "本地安全帖 / Local safety fixture"),
  communityCard(DISCUSSION_POST_ID, "discussion", "research", null, "本地交流帖 / Local discussion fixture"),
];
const comments = [
  [SAFETY_COMMENT_ID, SAFETY_POST_ID], [DISCUSSION_COMMENT_ID, DISCUSSION_POST_ID], [PRODUCT_COMMENT_ID, PRODUCT_ID],
].map(([id, submissionId]) => ({
  id, submission_id: submissionId, user_id: CREATOR_ID, parent_id: null,
  body: "本地测试回复：点击通知应直接定位到这里。Local fixture reply: the notification should open this exact comment.",
  status: "published", created_at: CREATED, pinned_at: null, deleted_at: null,
  profiles: { username: "test_creator", display_name: "Test Creator", role: "user", level: 0 },
}));

function initialNotifications() {
  return [
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", submission_id: SAFETY_POST_ID, comment_id: SAFETY_COMMENT_ID, submission_title: cards[0].title, href: `/community/safety/approval-checklist#comment-${SAFETY_COMMENT_ID}`, read_at: null, type: "reply", detail: null },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", submission_id: DISCUSSION_POST_ID, comment_id: DISCUSSION_COMMENT_ID, submission_title: cards[1].title, href: `/community/discussion/${DISCUSSION_POST_ID}#comment-${DISCUSSION_COMMENT_ID}`, read_at: CREATED, type: "reply", detail: null },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", submission_id: PRODUCT_ID, comment_id: PRODUCT_COMMENT_ID, submission_title: product.title, href: `/products/${PRODUCT_ID}#comment-${PRODUCT_COMMENT_ID}`, read_at: null, type: "mention", detail: null },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", submission_id: null, comment_id: null, submission_title: null, href: null, read_at: CREATED, type: "level_up", detail: { level: 1 } },
  ].map((item) => ({
    ...item, actor_id: CREATOR_ID, actor_username: "Test Creator", actor_avatar_url: null,
    comment_preview: item.comment_id ? "Local fixture reply — 本地测试回复" : null, created_at: CREATED,
  }));
}

export function createNotificationFixtures() {
  const byViewer = new Map();
  const writes = [];
  function itemsFor(viewer) {
    if (!byViewer.has(viewer)) byViewer.set(viewer, initialNotifications());
    return byViewer.get(viewer);
  }
  return {
    async handle({ request, url, viewer, send }) {
      if (url.pathname === "/test/notifications/reset") {
        if (request.method !== "POST") { send({ message: "Use POST to reset local fixtures" }, 405); return true; }
        byViewer.clear(); writes.length = 0; send({ ok: true }); return true;
      }
      if (url.pathname === "/test/notifications/state") {
        send({ writes, viewers: [...byViewer.entries()].map(([id, items]) => ({ id, total: items.length, unread: items.filter((item) => !item.read_at).length })) });
        return true;
      }
      if (["/rest/v1/rpc/notification_read", "/rest/v1/rpc/notification_write"].includes(url.pathname)) {
        let text = "";
        for await (const part of request) text += part;
        let input;
        try { input = JSON.parse(text || "{}"); }
        catch { send({ message: "Invalid fixture request" }, 400); return true; }
        if (!input || typeof input !== "object" || Array.isArray(input)) { send({ message: "Invalid fixture request" }, 400); return true; }
        if (![READER_ID, CREATOR_ID].includes(viewer) || input.p_expected_user_id !== viewer) {
          send({ message: "Local test session mismatch" }, 401); return true;
        }
        const items = itemsFor(viewer);
        if (url.pathname.endsWith("notification_read")) {
          const offset = Number.isInteger(input.p_offset) && input.p_offset >= 0 ? input.p_offset : 0;
          send({ items: items.slice(offset, offset + 20), total: items.length, unread: items.filter((item) => !item.read_at).length });
          return true;
        }
        if (!["read", "all", "clear"].includes(input.p_action) || input.p_action === "read" && !items.some((item) => item.id === input.p_id)) {
          send({ message: "Invalid local notification mutation" }, 400); return true;
        }
        writes.push({ user_id: viewer, action: input.p_action, id: input.p_id ?? null });
        if (input.p_action === "clear") byViewer.set(viewer, []);
        else for (const item of items) if (input.p_action === "all" || item.id === input.p_id) item.read_at ??= new Date().toISOString();
        send(null); return true;
      }
      // The app reads real community routes through submission_cards, not a
      // community_read RPC. Only the explicitly fictional local cards are served.
      if (url.pathname === "/rest/v1/submission_cards") {
        const identifier = url.searchParams.get("id");
        const slug = url.searchParams.get("legacy_slug");
        if (url.searchParams.get("type") === "eq.post" || cards.some((card) => identifier === `eq.${card.id}` || slug === `eq.${card.legacy_slug}`)) {
          const rows = cards.filter((card) => (!identifier || identifier === `eq.${card.id}`) && (!slug || slug === `eq.${card.legacy_slug}`) && (!url.searchParams.has("community_section") || url.searchParams.get("community_section") === `eq.${card.community_section}`));
          send(identifier || slug ? rows[0] ?? null : rows); return true;
        }
      }
      if (url.pathname === "/rest/v1/comments") {
        const submission = url.searchParams.get("submission_id")?.replace(/^eq\./, "");
        if ([SAFETY_POST_ID, DISCUSSION_POST_ID, PRODUCT_ID].includes(submission)) {
          send(comments.filter((comment) => comment.submission_id === submission)); return true;
        }
      }
      if (url.pathname === "/rest/v1/community_likes") { send(null); return true; }
      return false;
    },
  };
}
