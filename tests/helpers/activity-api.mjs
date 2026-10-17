// Explicitly seeded local fixtures only. Never connects to a real Supabase.
import { ADMIN_ID, PRODUCT_ID, READER_ID, CREATOR_ID, product, profileFor } from "./auth-fixtures.mjs";
import { randomUUID } from "node:crypto";
export const ACTIVITY_ID = "55555555-5555-4555-8555-555555555555";
export const QUIZ_ID = "66666666-6666-4666-8666-666666666666";
export const UPCOMING_ID = "77777777-7777-4777-8777-777777777777";
export const POST_ID = "99999999-9999-4999-8999-999999999999";
let mode = "empty";
let participations = [];
let follows = [];
let calls = [];
let adminItems = [];
let rewards = [];
let legacyUsers = {};
let lotteryDraws = [];
let liked = false;
function forumPosts() {
  const base = { ...product, type: "post", community_section: "activities", community_category: "community", community_like_count: Number(liked), comment_count: 0, is_example: false, legacy_slug: null, example_content: null, description: "A fictional local community post that keeps the real forum comment, session and like flow.", submitted_by: READER_ID, submitted_by_username: "test_reader" };
  return [
    { ...base, id: POST_ID, title: "Local real community post fixture", tagline: "A fictional fixture for the forum path" },
    { ...base, id: "abababab-abab-4bab-8bab-abababababab", legacy_slug: "weekend-conversation", title: "Local migrated activity post fixture", tagline: "A fictional migrated slug fixture", is_example: true, example_author: "local_example", submitted_by: null },
  ];
}
function legacyUser(id) {
  return legacyUsers[id] ??= { lottery_tickets: 2, checkin_streak: 0, last_checkin_date: null };
}
function allActivities() { return mode === "admin" ? adminItems : [...fixtures(), ...adminItems]; }
function legacyPrize() { return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", position: 0, name: "Local lottery fixture prize", icon: "🎁", kind: "xp", xp_amount: 1, ticket_amount: 0, badge_key: null, weight: 1, stock: 2, awarded_count: lotteryDraws.length, is_thanks: false, active: true }; }
function fixtures() {
  const now = Date.now();
  const base = { summary: "Local fixture only — not an operational activity", body: "This fictional local test activity checks the interface. Submit a genuine contribution note for manual review.", organizer: "Local test organizer", starts_at: new Date(now - 86400000).toISOString(), ends_at: new Date(now + 86400000).toISOString(), status: "published", cancel_reason: null, reward_xp: 10, reward_tickets: 1, reward_badge: null, reward_limit: 10, rewarded_count: 0, checkin_days: 1, quiz_question: null, quiz_options: [], quiz_max_attempts: 2, product_id: null };
  return [
    { ...base, id: ACTIVITY_ID, title: "Local contribution fixture", type: "event", task_kind: "manual" },
    { ...base, id: QUIZ_ID, title: "Local safety quiz fixture", type: "newcomer", task_kind: "quiz", quiz_question: "Should you share your seed phrase?", quiz_options: ["No, keep it private", "Yes, share it"] },
    { ...base, id: UPCOMING_ID, title: "Local weekly fixture", type: "weekly", task_kind: "product_review", product_id: PRODUCT_ID, starts_at: new Date(now + 3600000).toISOString() },
  ];
}
export async function handleActivityApi(request, url, viewer, send) {
  if (url.pathname === "/test/activity-reset") {
    mode = url.searchParams.get("mode") ?? "empty"; participations = []; follows = []; calls = []; adminItems = []; rewards = []; legacyUsers = {}; lotteryDraws = []; liked = false;
    send({ ok: true }); return true;
  }
  if (url.pathname === "/test/activity-calls") { send(calls); return true; }
  if (url.pathname === "/test/activity-state") { send({ items: adminItems, participations, rewards }); return true; }
  if (url.pathname === "/rest/v1/submission_cards" && url.searchParams.get("type") === "eq.post") {
    const rows = mode === "posts" ? forumPosts() : [];
    const id = url.searchParams.get("id")?.replace(/^eq\./, ""); const slug = url.searchParams.get("legacy_slug")?.replace(/^eq\./, "");
    send(id || slug ? rows.find((p) => id ? p.id === id : p.legacy_slug === slug) ?? null : rows); return true;
  }
  if (url.pathname === "/rest/v1/community_likes") { send(liked ? { user_id: viewer } : null); return true; }
  if (url.pathname === "/rest/v1/rpc/community_like_write") {
    let body = ""; for await (const part of request) body += part;
    const input = JSON.parse(body); calls.push({ rpc: "community_like_write", viewer, input });
    if (input.p_expected !== viewer) { send({ message: "community_session" }, 400); return true; }
    liked = input.p_liked; send(liked); return true;
  }
  if (url.pathname === "/test/legacy-refresh") {
    const user = legacyUser(READER_ID);
    user.last_checkin_date = null; user.checkin_streak = 0; user.lottery_tickets = 3;
    send({ ok: true }); return true;
  }
  if (url.pathname === "/rest/v1/rpc/notification_read") { send({ items: [], unread: 0, total: 0 }); return true; }
  if (url.pathname === "/rest/v1/checkin_settings") {
    send({ id: true, enabled: mode === "legacy", cycle_length: 7, day_rewards: [1, 1, 1, 1, 1, 1, 2] }); return true;
  }
  if (url.pathname === "/rest/v1/lottery_settings") {
    send({ id: true, enabled: mode === "legacy", cost_tickets: 1, starts_at: null, ends_at: null, draws_per_day: 0, cost_xp: 0 }); return true;
  }
  if (mode === "legacy") {
    if (url.pathname === "/rest/v1/profiles") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "") ?? viewer ?? READER_ID;
      send({ ...profileFor(id), ...legacyUser(id) }); return true;
    }
    if (url.pathname === "/rest/v1/checkins") {
      const u = legacyUser(viewer);
      send(u.last_checkin_date ? [{ checkin_date: u.last_checkin_date, day_index: 1 }] : []); return true;
    }
    if (url.pathname === "/rest/v1/lottery_prizes") { send([legacyPrize()]); return true; }
    if (url.pathname === "/rest/v1/lottery_draws") { send(lotteryDraws); return true; }
    if (url.pathname === "/rest/v1/rpc/perform_checkin" || url.pathname === "/rest/v1/rpc/perform_lottery_draw") {
      let body = ""; for await (const part of request) body += part;
      const input = JSON.parse(body); const id = input.p_user_id;
      calls.push({ rpc: url.pathname.split("/").at(-1), input });
      if (![READER_ID, CREATOR_ID].includes(id)) { send({ message: "Unknown local fixture user" }, 400); return true; }
      const u = legacyUser(id);
      if (url.pathname.endsWith("perform_checkin")) {
        u.last_checkin_date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); u.checkin_streak = 1;
        send([{ ok: true, message: "", day_index: 1, streak: 1, xp_awarded: 1, new_xp: 1, old_level: 0, new_level: 0 }]); return true;
      }
      u.lottery_tickets--;
      const prize = legacyPrize();
      lotteryDraws.unshift({ id: randomUUID(), user_id: id, prize_name: prize.name, prize_icon: prize.icon, created_at: new Date().toISOString(), profiles: { username: profileFor(id).username, display_name: profileFor(id).display_name, level: 0 } });
      send([{ ok: true, message: "", prize_id: prize.id, prize_name: prize.name, prize_icon: prize.icon, prize_kind: "xp", prize_position: 0, xp_awarded: 1, tickets_awarded: 0, ticket_balance: u.lottery_tickets, new_xp: 2, old_level: 0, new_level: 0, draws_left: -1 }]); return true;
    }
  }
  if (!url.pathname.startsWith("/rest/v1/rpc/activity_")) return false;
  let text = ""; for await (const part of request) text += part;
  const input = JSON.parse(text || "{}"); const rpc = url.pathname.split("/").at(-1);
  calls.push({ rpc, viewer, input });
  if (input.p_expected_user_id !== viewer) { send({ message: "activity_session" }, 400); return true; }
  if (mode === "fail") { send({ message: "function activity_read does not exist" }, 404); return true; }
  if (rpc === "activity_admin_read" || rpc === "activity_admin_write") {
    if (viewer !== ADMIN_ID) { send({ message: "activity_forbidden" }, 403); return true; }
    if (rpc === "activity_admin_read") { send({ items: allActivities(), participations, rewards, products: [{ id: PRODUCT_ID, title: "Local auth test product" }] }); return true; }
    if (input.p_action === "save") {
      const id = input.p_activity_id ?? randomUUID();
      const previous = adminItems.find((a) => a.id === id);
      if (previous && previous.status !== "draft") { send({ message: "activity_frozen" }, 400); return true; }
      const item = { ...input.p_payload, id, status: "draft", rewarded_count: 0, cancel_reason: null };
      adminItems = [...adminItems.filter((a) => a.id !== id), item];
      send({ ok: true, id }); return true;
    }
    const a = adminItems.find((a) => a.id === input.p_activity_id);
    if (!a) { send({ message: "activity_unavailable" }, 400); return true; }
    if (input.p_action === "publish") a.status = "published";
    if (input.p_action === "approve") {
      const p = participations.find((p) => p.activity_id === a.id && p.user_id === input.p_payload.user_id);
      if (!p) { send({ message: "activity_invalid" }, 400); return true; }
      if (p.status !== "approved") {
        p.status = "approved";
        const reward = { activity_id: a.id, user_id: p.user_id, xp: a.reward_xp, tickets: a.reward_tickets, badge: a.reward_badge, created_at: new Date().toISOString() };
        rewards.push(reward); p.reward = reward; a.rewarded_count++;
      }
    }
    send({ ok: true, id: a.id }); return true;
  }
  if (rpc === "activity_read") {
    send({ items: mode === "empty" ? [] : allActivities().filter((a) => a.status !== "draft" && (!input.p_activity_id || a.id === input.p_activity_id)).map((a) => Object.fromEntries(Object.entries(a).filter(([key]) => key !== "quiz_answer"))), mine: participations.filter((p) => p.user_id === viewer), following: follows.filter((f) => f.user_id === viewer).map((f) => f.activity_id) }); return true;
  }
  if (rpc === "activity_write") {
    if (!viewer) { send({ message: "activity_session" }, 400); return true; }
    const id = input.p_activity_id; const a = allActivities().find((a) => a.id === id);
    if (!a) { send({ message: "activity_unavailable" }, 400); return true; }
    if (input.p_action === "follow") { follows.push({ user_id: viewer, activity_id: id }); send({ ok: true }); return true; }
    if (input.p_action === "unfollow") { follows = follows.filter((f) => f.user_id !== viewer || f.activity_id !== id); send({ ok: true }); return true; }
    let p = participations.find((p) => p.activity_id === id && p.user_id === viewer);
    if (!p) { p = { activity_id: id, user_id: viewer, status: "joined", attempts: 0, evidence: null, review_note: null, reward: null }; participations.push(p); }
    if (input.p_action === "submit") { p.status = "submitted"; p.evidence = input.p_payload.evidence; p.submitted_at = new Date().toISOString(); }
    if (input.p_action === "quiz") {
      p.attempts++;
      if (input.p_payload.answer !== 0) { send({ ok: false, error: "activity_quiz_wrong" }); return true; }
      p.status = "approved"; p.reward = { xp: a.reward_xp, tickets: a.reward_tickets, badge: null, created_at: new Date().toISOString() };
    }
    send({ ok: true }); return true;
  }
  send({ message: "Unimplemented local activity fixture" }, 400); return true;
}
