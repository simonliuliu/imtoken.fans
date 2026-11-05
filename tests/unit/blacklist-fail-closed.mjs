// Exercise the real restriction helper and Server Actions with isolated clients.
// No real database, account, or external service is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
const userId = "22222222-2222-4222-8222-222222222222";

function loadModule(path, imports = {}) {
  const target = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module: target, exports: target.exports, console, URL, Date, Set,
    require: (id) => id in imports ? imports[id] : require(id),
  }, { filename: path });
  return target.exports;
}

function setup(initialReply) {
  let reply = initialReply;
  const calls = { tagQueries: 0, filters: [], adminClients: 0, rpc: [], ordinaryClients: 0 };
  const tagClient = {
    from(table) {
      assert.equal(table, "user_tags");
      const query = {
        select(value) { assert.equal(value, "tag_key"); return query; },
        eq(column, value) { calls.filters.push([column, value]); return query; },
        async maybeSingle() {
          calls.tagQueries += 1;
          if (reply === "throws") throw new Error("private transport failure");
          return reply;
        },
      };
      return query;
    },
  };
  const userTags = loadModule("src/lib/user-tags.ts", {
    "@/lib/supabase/server": { createClient: async () => tagClient },
  });
  const ordinaryClient = async () => {
    calls.ordinaryClients += 1;
    throw new Error("unexpected ordinary client after failed restriction check");
  };
  const profile = { id: userId, username: "tester", role: "user", mutedUntil: null, level: 1 };
  const imports = {
    "next/cache": { revalidatePath() {} },
    "next/server": { after() {} },
    "next-intl/server": { getTranslations: async () => (key) => key, getLocale: async () => "en" },
    "@/lib/supabase/server": { createClient: ordinaryClient },
    "@/lib/supabase/admin": { createAdminClient: () => {
      calls.adminClients += 1;
      return { rpc: async (name, args) => {
        calls.rpc.push({ name, args });
        const row = name === "perform_checkin"
          ? { ok: true, day_index: 1, streak: 1, xp_awarded: 1, new_xp: 1, old_level: 1, new_level: 1 }
          : { ok: true, prize_id: "prize", prize_name: "Prize", prize_icon: "", prize_kind: "other", prize_position: 1, xp_awarded: 0, tickets_awarded: 0, ticket_balance: 1, new_xp: 1, old_level: 1, new_level: 1, draws_left: 1 };
        return { data: [row], error: null };
      } };
    } },
    "@/lib/profile": { getCurrentProfile: async () => profile },
    "@/lib/user-tags": userTags,
    "@/lib/notify": { createLevelUpNotification: async () => {}, notifyBadgeAwarded: async () => {}, notifyTicketChange: async () => {} },
    "@/lib/moderation/pipeline": { runModerationPipeline: async () => {}, scheduleCommentAiModeration() {} },
    "@/lib/admin-guard": {},
    "@/lib/admin-moderation": {},
    "@/lib/xp": { awardXpByRule: async () => {}, deterministicUuid: () => "id" },
    "@/lib/tag-taxonomy": { normalizeTags: (tags) => tags },
    "@/lib/media": { MAX_SCREENSHOTS: 8, MAX_SOCIAL_LINKS: 8, MAX_TEAM_MEMBERS: 8 },
    "@/lib/product-hunter": loadModule("src/lib/product-hunter.ts"),
  };
  return {
    calls,
    userTags,
    activity: loadModule("src/app/actions/activities.ts", imports),
    comments: loadModule("src/app/actions/comments.ts", imports),
    products: loadModule("src/app/actions/product-hunter.ts", imports),
    submissions: loadModule("src/app/actions/submissions.ts", imports),
    setReply(value) { reply = value; },
  };
}

const product = {
  type: "product", expectedUser: userId, title: "Test product", tagline: "A useful product",
  description: "A sufficiently detailed description of the product.", tags: ["Web App"],
  websiteUrl: "https://example.test", logoPath: `${userId}/logo.png`,
  screenshotPaths: [`${userId}/screen.png`], productPlatforms: ["web"],
  pricingType: "free", launchStage: "live", makerRelationship: "creator",
};

test("restriction lookup distinguishes allowed, blocked, returned errors and thrown errors", async () => {
  const instance = setup({ data: null, error: null });
  assert.equal(await instance.userTags.isBlacklisted(userId), false);
  instance.setReply({ data: { tag_key: "blacklisted" }, error: null });
  assert.equal(await instance.userTags.isBlacklisted(userId), true);
  instance.setReply({ data: null, error: { message: "private detail" } });
  assert.equal(await instance.userTags.isBlacklisted(userId), null);
  instance.setReply({ data: { tag_key: "blacklisted" }, error: { message: "private detail" } });
  assert.equal(await instance.userTags.isBlacklisted(userId), null);
  instance.setReply({ error: null });
  assert.equal(await instance.userTags.isBlacklisted(userId), null);
  instance.setReply("throws");
  assert.equal(await instance.userTags.isBlacklisted(userId), null);
  assert.equal(instance.calls.filters.every((entry, index) => index % 2 === 0
    ? entry[0] === "user_id" && entry[1] === userId
    : entry[0] === "tag_key" && entry[1] === "blacklisted"), true);
});

for (const [name, reply, expected] of [
  ["returned query error", { data: null, error: { message: "private detail" } }, "failed"],
  ["thrown query error", "throws", "failed"],
  ["confirmed blacklist", { data: { tag_key: "blacklisted" }, error: null }, "blocked"],
]) {
  test(`${name} prevents both privileged activity RPCs`, async () => {
    const instance = setup(reply);
    const checkin = await instance.activity.dailyCheckIn();
    const draw = await instance.activity.drawLottery();
    assert.equal(checkin.ok, false);
    assert.equal(draw.ok, false);
    assert.equal(checkin.message, expected === "blocked" ? "blacklistedActivity" : "checkinFailed");
    assert.equal(draw.message, expected === "blocked" ? "blacklistedActivity" : "lotteryFailed");
    assert.equal(instance.calls.adminClients, 0);
    assert.equal(instance.calls.rpc.length, 0);
  });

  test(`${name} prevents comment, product support, rating and submission writes`, async () => {
    const instance = setup(reply);
    const blocked = expected === "blocked";
    const comment = await instance.comments.postComment("post", "A comment", "/", undefined, userId, "request");
    const support = await instance.products.toggleProductSupport("product");
    const rating = await instance.products.upsertProductRating({ submissionId: "product", rating: 5, body: "A useful and sufficiently long review", strengths: [], improvements: [], experienced: true });
    const submission = await instance.submissions.createSubmission(product);
    assert.equal(comment.error, blocked ? "blacklistedComment" : "commentFailed");
    assert.equal(support.error, blocked ? "notAllowed" : "operationFailed");
    assert.equal(rating.error, blocked ? "notAllowed" : "operationFailed");
    assert.equal(submission.error, blocked ? "blacklistedSubmit" : "submitFailed");
    assert.equal(instance.calls.ordinaryClients, 0);
    assert.equal(instance.calls.adminClients, 0);
    assert.equal(instance.calls.rpc.length, 0);
  });
}

test("a successful unrestricted lookup allows the actual activity actions to reach their RPCs", async () => {
  const instance = setup({ data: null, error: null });
  assert.equal((await instance.activity.dailyCheckIn()).ok, true);
  assert.equal((await instance.activity.drawLottery()).ok, true);
  assert.deepEqual(instance.calls.rpc.map((call) => call.name), ["perform_checkin", "perform_lottery_draw"]);
  assert.equal(instance.calls.rpc.every((call) => call.args.p_user_id === userId), true);
});

test("a later successful lookup is retried after a temporary failure", async () => {
  const instance = setup({ data: null, error: { message: "private detail" } });
  assert.equal((await instance.activity.dailyCheckIn()).message, "checkinFailed");
  assert.equal(instance.calls.rpc.length, 0);
  instance.setReply({ data: null, error: null });
  assert.equal((await instance.activity.dailyCheckIn()).ok, true);
  assert.equal(instance.calls.rpc.length, 1);
});
