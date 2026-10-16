// Run the actual Server Action with dependency doubles: no real accounts or database writes.
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
  const testModule = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module: testModule, exports: testModule.exports, console,
    require: (id) => id in imports ? imports[id] : require(id),
    URL, Date, Set,
  }, { filename: path });
  return testModule.exports;
}

function setup({ signedIn = true, blacklisted = false, duplicate = false } = {}) {
  const calls = { auth: 0, clients: 0, inserts: [], moderation: [], xp: [], adminTables: [] };
  const builder = (admin) => {
    const query = {
      select() { return query; }, eq() { return query; }, is() { return query; }, limit() { return query; },
      insert(value) { calls.inserts.push(value); return query; },
      async single() { return { data: { id: "new-product-id" }, error: null }; },
      async maybeSingle() { return { data: admin ? (duplicate ? { id: "existing-product" } : null) : { status: "pending" }, error: null }; },
    };
    return query;
  };
  const { createSubmission } = loadModule("src/app/actions/submissions.ts", {
    "next/cache": { revalidatePath() {} },
    "next/server": { after: (work) => work() },
    "next-intl/server": { getTranslations: async () => (key) => key },
    "@/lib/supabase/server": { createClient: async () => { calls.clients++; return { from: () => builder(false) }; } },
    "@/lib/supabase/admin": { createAdminClient: () => ({ from: (table) => { calls.adminTables.push(table); return builder(true); } }) },
    "@/lib/profile": { getCurrentProfile: async () => { calls.auth++; return signedIn ? { id: userId, role: "admin" } : null; } },
    "@/lib/user-tags": { isBlacklisted: async () => blacklisted },
    "@/lib/tag-taxonomy": loadModule("src/lib/tag-taxonomy.ts"),
    "@/lib/moderation/pipeline": { runModerationPipeline: async (input) => { calls.moderation.push(input); } },
    "@/lib/media": { MAX_SCREENSHOTS: 8, MAX_TEAM_MEMBERS: 8, MAX_SOCIAL_LINKS: 8 },
    "@/lib/xp": { awardXpByRule: async (input) => { calls.xp.push(input); } },
    "@/lib/product-hunter": loadModule("src/lib/product-hunter.ts"),
  });
  return { createSubmission, calls };
}

function product(patch = {}) {
  return {
    type: "product", title: "Test product", tagline: "A useful community product", description: "A sufficiently detailed product description.",
    tags: ["Web App"], websiteUrl: "https://example.test/product", logoPath: `${userId}/logo.png`,
    screenshotPaths: [`${userId}/screenshot.png`], productPlatforms: ["web"], pricingType: "free",
    launchStage: "live", makerRelationship: "creator", ...patch,
  };
}

test("old or forged idea requests are rejected before auth, database, moderation or XP", async () => {
  for (const type of ["idea", "feedback", "", null, undefined]) {
    const { createSubmission, calls } = setup();
    assert.equal((await createSubmission(product({ type }))).error, "productSubmissionsOnly");
    assert.equal(calls.auth, 0);
    assert.equal(calls.clients, 0);
    assert.equal(calls.inserts.length + calls.moderation.length + calls.xp.length + calls.adminTables.length, 0);
  }
});

test("valid product is persisted only as product and always requires manual moderation, even for admin", async () => {
  const { createSubmission, calls } = setup();
  const result = await createSubmission(product());
  assert.equal(result.submissionId, "new-product-id");
  assert.equal(result.published, false);
  assert.equal(calls.inserts.length, 1);
  assert.equal(calls.inserts[0].type, "product");
  assert.equal(calls.moderation[0].requireManual, true);
  assert.equal(calls.adminTables.includes("profiles"), false);
  assert.equal(calls.xp.length, 0);
});

test("required product details still fail validation without writes", async () => {
  for (const [patch, expected] of [
    [{ websiteUrl: "" }, "productWebsiteRequired"], [{ logoPath: "" }, "productLogoRequired"],
    [{ screenshotPaths: [] }, "productScreenshotRequired"], [{ productPlatforms: [] }, "productPlatformRequired"],
    [{ pricingType: undefined }, "productDetailsRequired"], [{ tags: [] }, "productTagRequired"],
    [{ title: "x".repeat(61) }, "productTitleLength"], [{ tagline: "x".repeat(61) }, "productTaglineLength"],
  ]) {
    const { createSubmission, calls } = setup();
    assert.equal((await createSubmission(product(patch))).error, expected);
    assert.equal(calls.inserts.length, 0);
  }
});

test("community authentication, blacklist and duplicate checks remain enforced", async () => {
  for (const [config, expected] of [
    [{ signedIn: false }, "notSignedIn"], [{ blacklisted: true }, "blacklistedSubmit"], [{ duplicate: true }, "productAlreadySubmitted"],
  ]) {
    const { createSubmission, calls } = setup(config);
    assert.equal((await createSubmission(product())).error, expected);
    assert.equal(calls.inserts.length, 0);
  }
});
