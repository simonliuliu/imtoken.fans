import { expect, test, type BrowserContext } from "@playwright/test";
import { ADMIN_ID, READER_ID, CREATOR_ID, sessionFor } from "./helpers/auth-fixtures.mjs";
import { ACTIVITY_ID, QUIZ_ID, POST_ID } from "./helpers/activity-api.mjs";

async function seedSession(context: BrowserContext, id = READER_ID) {
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(sessionFor(id))).toString("base64url")}`, domain: "127.0.0.1", path: "/", sameSite: "Lax" }]);
}
test.beforeEach(async ({ request }) => { await request.get("http://127.0.0.1:54329/test/activity-reset?mode=seeded"); });

for (const locale of ["zh", "en"]) {
  test(`${locale} 390px categories, empty and unavailable states`, async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${locale}/community/activities`);
    await expect(page.getByRole("link", { name: "Local contribution fixture" })).toBeVisible();
    await page.screenshot({ path: `docs/reviews/screenshots/activity-center/${locale}-mobile-local-fixture.png`, fullPage: true });
    await page.getByRole("button", { name: locale === "zh" ? "新手任务" : "Newcomer tasks", exact: true }).click();
    await expect(page.getByRole("link", { name: "Local safety quiz fixture" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Local contribution fixture" })).toHaveCount(0);
    await page.getByRole("button", { name: locale === "zh" ? "即将开始" : "Upcoming", exact: true }).click();
    await expect(page.getByText(locale === "zh" ? "当前分类和状态下还没有已发布活动。" : "No published activities match this category and status yet.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await request.get("http://127.0.0.1:54329/test/activity-reset?mode=fail");
    await page.reload();
    await expect(page.getByRole("alert").filter({ hasText: locale === "zh" ? "暂时无法加载活动" : "Activities are temporarily unavailable" })).toBeVisible();
    await page.screenshot({ path: `test-results/activities-${locale}-mobile.png`, fullPage: true });
  });
}
test("guest detail and my participation preserve language and destination", async ({ page }) => {
  await page.goto(`/en/community/activities/${ACTIVITY_ID}`);
  await expect(page.getByRole("heading", { name: "Local contribution fixture" })).toBeVisible();
  const href = await page.getByRole("link", { name: "Sign in to participate", exact: true }).getAttribute("href");
  expect(new URL(href!, "http://127.0.0.1:3000").searchParams.get("redirect")).toBe(`/en/community/activities/${ACTIVITY_ID}`);
  for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: "instant" }); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.screenshot({ path: `docs/reviews/screenshots/activity-center/en-detail-${viewport.name}-local-fixture.png`, fullPage: true });
  }
  await page.goto("/en/community/activities?category=mine");
  await expect(page.getByText("Sign in with your community account to see your participation, reviews and rewards.")).toBeVisible();
});
test("legacy activities URL lands in the check-in category", async ({ page }) => {
  await page.goto("/en/activities");
  await expect(page).toHaveURL(/\/en\/community\/activities\?category=checkin$/);
  await expect(page.getByRole("button", { name: "Check-in & lottery", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Daily check-in", exact: true })).toBeVisible();
  const links = page.locator('a[href*="auth/sign-in"]').filter({ hasText: /check in|draw/i });
  await expect(links).toHaveCount(2);
  for (const href of await links.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")))) expect(new URL(href!, "http://127.0.0.1:3000").searchParams.get("redirect")).toBe("/en/community/activities?category=checkin");
});
test("a new activity center is empty and contains no demonstration campaigns", async ({ page, request }) => {
  await request.get("http://127.0.0.1:54329/test/activity-reset?mode=empty");
  await page.goto("/en/community/activities");
  await expect(page.getByText("No published activities match this category and status yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Local .*fixture/ })).toHaveCount(0);
});
test("local participation, evidence submission and account switch isolate personal state", async ({ page, context, request }) => {
  await seedSession(context);
  await page.goto(`/en/community/activities/${ACTIVITY_ID}`);
  await page.getByRole("button", { name: "Record participation", exact: true }).click();
  await expect(page.getByText("Joined", { exact: true })).toBeVisible();
  await page.getByLabel("Contribution or experience note", { exact: true }).fill("A private local contribution note for the first account only.");
  await seedSession(context, CREATOR_ID);
  await page.evaluate((session) => { const channel = new BroadcastChannel("sb-127-auth-token"); channel.postMessage({ event: "SIGNED_IN", session }); channel.close(); }, sessionFor(CREATOR_ID));
  await expect(page.getByLabel("Contribution or experience note", { exact: true })).toHaveValue("");
  await expect(page.getByText("Joined", { exact: true })).toHaveCount(0);
  await page.getByLabel("Contribution or experience note", { exact: true }).fill("The second account submits its own isolated test contribution.");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();
  const calls = await (await request.get("http://127.0.0.1:54329/test/activity-calls")).json();
  const submission = calls.find((call: { input: { p_action: string } }) => call.input.p_action === "submit");
  expect(submission.viewer).toBe(CREATOR_ID);
  expect(submission.input.p_expected_user_id).toBe(CREATOR_ID);
});
test("quiz wrong answer uses an attempt; correct answer shows reward receipt", async ({ page, context }) => {
  await seedSession(context);
  await page.goto(`/en/community/activities/${QUIZ_ID}`);
  await page.getByRole("radio", { name: "Yes, share it" }).check();
  await page.getByRole("button", { name: "Submit answer and complete", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This attempt has been counted" })).toBeVisible();
  await expect(page.getByText("1 of 2 attempts used", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "No, keep it private" }).check();
  await page.getByRole("button", { name: "Submit answer and complete", exact: true }).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Reward receipt:", { exact: false })).toBeVisible();
});
test("check-in and lottery refresh inventory, ticker and authoritative child state", async ({ page, context, request }) => {
  await request.get("http://127.0.0.1:54329/test/activity-reset?mode=legacy");
  await seedSession(context);
  await page.goto("/en/community/activities?category=checkin");
  await page.getByRole("button", { name: "Check in for +1 XP", exact: true }).click();
  await expect(page.getByText("✅ Checked in today — come back tomorrow", { exact: true })).toBeVisible();
  await expect(page.getByText("Limited to 2 · 2 left", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Draw", exact: false }).filter({ hasText: "Draw" }).first().click();
  await expect(page.getByText("Tickets left 🎟️ 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  // These require the parent read to run again; optimistic ticket updates alone
  // cannot update prize stock or add a row to the recent-winner ticker.
  await expect(page.getByText("Limited to 2 · 1 left", { exact: true })).toBeVisible();
  await expect(page.locator(".marquee").getByText("Local lottery fixture prize").first()).toBeVisible();
  await request.get("http://127.0.0.1:54329/test/legacy-refresh");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "Check in for +1 XP", exact: true })).toBeVisible();
  await expect(page.locator(".confetti-piece")).toHaveCount(0);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: "instant" }); });
  await page.screenshot({ path: "docs/reviews/screenshots/activity-center/checkin-lottery-local-fixture.png", fullPage: true });
});
test("admin creates and publishes a draft, reviews a contribution and retains one reward on reload", async ({ page, context, browser, request }) => {
  await request.get("http://127.0.0.1:54329/test/activity-reset?mode=admin");
  await seedSession(context, ADMIN_ID);
  await page.goto("/admin/campaigns");
  await page.getByRole("button", { name: "新建草稿", exact: true }).click();
  await page.getByLabel("活动标题", { exact: true }).fill("Local admin activity fixture");
  await page.getByLabel("主办方", { exact: true }).fill("Local fictional organizer");
  const beijing = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 16);
  await page.getByLabel("开始时间（北京时间）", { exact: true }).fill(beijing(Date.now() - 3600000));
  await page.getByLabel("结束时间（北京时间）", { exact: true }).fill(beijing(Date.now() + 86400000));
  await page.getByLabel(/完整规则/).fill("Local test fixture rules: a meaningful contribution is manually reviewed; no real rewards are issued by this mock API.");
  await page.getByLabel("奖励 XP", { exact: true }).fill("12");
  await page.getByLabel("奖励抽奖券", { exact: true }).fill("2");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("Local admin activity fixture", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByText(/已发布（规则冻结）/)).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:54329/test/activity-state")).json();
  const reader = await browser.newContext();
  try {
    await seedSession(reader);
    const participationPage = await reader.newPage();
    await participationPage.goto(`http://127.0.0.1:3000/zh/community/activities/${state.items[0].id}`);
    await participationPage.getByLabel("贡献或体验说明", { exact: true }).fill("这是一段仅供本地测试的真实表单提交说明，用于核验人工审核界面与奖励记录。并非线上运营数据。");
    await participationPage.getByRole("button", { name: "提交审核", exact: true }).click();
    await expect(participationPage.getByText("待审核", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "通过并发奖", exact: true }).click();
    await expect(page.getByRole("button", { name: "通过并发奖", exact: true })).toHaveCount(0);
    for (let i = 0; i < 2; i++) { await page.reload(); await expect(page.getByText(/Local admin activity fixture · 已完成/)).toBeVisible(); }
    const rewarded = await (await request.get("http://127.0.0.1:54329/test/activity-state")).json();
    expect(rewarded.rewards).toHaveLength(1);
    expect(rewarded.rewards[0]).toMatchObject({ user_id: READER_ID, xp: 12, tickets: 2 });
    await page.locator("section").filter({ has: page.getByRole("heading", { name: "社区活动与任务", exact: true }) }).screenshot({ path: "docs/reviews/screenshots/activity-center/admin-local-fixture.png" });
  } finally { await reader.close(); }
});
test("activity community posts retain filters, real UUID interactions and migrated slugs", async ({ page, context, request }) => {
  await request.get("http://127.0.0.1:54329/test/activity-reset?mode=posts");
  await seedSession(context);
  await page.goto("/en/community/activities?category=community");
  await expect(page.getByRole("button", { name: "Community posts", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: /Local real community post fixture/ })).toBeVisible();
  await page.getByRole("link", { name: /Local real community post fixture/ }).click();
  await expect(page).toHaveURL(new RegExp(`/community/activities/${POST_ID}$`));
  await expect(page.getByRole("heading", { name: "Local real community post fixture", exact: true })).toBeVisible();
  await expect(page.locator("#comments")).toBeVisible();
  await page.locator(".community-detail-actions button").first().click();
  await expect(page.locator(".community-detail-actions button").first()).toHaveAttribute("aria-pressed", "true");
  await page.goto("/en/community/activities/weekend-conversation");
  await expect(page.getByRole("heading", { name: "Local migrated activity post fixture", exact: true })).toBeVisible();
  await expect(page.locator("#comments")).toBeVisible();
  await page.screenshot({ path: "docs/reviews/screenshots/activity-center/migrated-post-local-fixture.png", fullPage: true });
});
