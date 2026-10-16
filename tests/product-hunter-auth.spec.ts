import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { CREATOR_ID, PRODUCT_ID, READER_ID, sessionFor } from "./helpers/auth-fixtures.mjs";

async function seedSession(context: BrowserContext, id = READER_ID) {
  await context.addCookies([{
    name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(sessionFor(id))).toString("base64url")}`,
    domain: "127.0.0.1", path: "/", sameSite: "Lax",
  }]);
}

async function signIn(page: Page) {
  await page.getByRole("textbox", { name: /邮箱|Email/i, exact: false }).fill("reader@example.test");
  await page.locator('input[type="password"]').first().fill("local-test-password");
  await page.getByRole("button", { name: /^(Sign in|登录)$/ }).click();
}

test("游客进入英文投稿后使用社区登录，并返回原类型", async ({ page }) => {
  await page.goto("/en/submit?type=idea");
  await expect(page).toHaveURL(/\/en\/auth\/sign-in\?/);
  expect(new URL(page.url()).searchParams.get("redirect")).toBe("/en/submit?type=idea");
  await signIn(page);
  await expect(page).toHaveURL(/\/en\/submit\?type=idea$/);
  await expect(page.getByRole("button", { name: /idea/i, pressed: true })).toBeVisible();
  await expect(page.getByText(/Test Reader/).filter({ visible: true }).first()).toBeVisible();
});

test("已有社区会话，延迟加载期间不误显示登录或跳转", async ({ page, context }) => {
  await seedSession(context);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("http://127.0.0.1:54329/rest/v1/profiles**", async (route) => { await gate; await route.continue(); });
  await page.goto("/zh/submit?type=product");
  await expect(page.getByRole("status").first()).toHaveText("加载中…");
  await expect(page.getByText("登录后才能提交", { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href*="auth/sign-in"]')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/zh/submit");
  release();
  await expect(page.getByRole("heading", { name: "提交社区产品或共创想法" })).toBeVisible();
  await expect(page.getByText(/Test Reader/).filter({ visible: true }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/auth-submit-desktop.png", fullPage: false });
});

test("支持、评分和评论共享登录入口并保留英文操作位置", async ({ page }) => {
  await page.goto(`/en/products/${PRODUCT_ID}`);
  const support = page.getByRole("link", { name: "Sign in to support", exact: true });
  await expect(support).toBeVisible();
  for (const name of ["Sign in to support", "Sign in to rate and share a genuine product experience", "Sign in to comment"]) {
    const href = await page.getByRole("link", { name, exact: true }).getAttribute("href");
    const link = new URL(href!, "http://127.0.0.1:3000");
    expect(link.pathname).toBe("/en/auth/sign-in");
    expect(link.searchParams.get("redirect")).toBe(`/en/products/${PRODUCT_ID}#${name.endsWith("comment") ? "comments" : "product-rating"}`);
  }
  await support.click();
  await signIn(page);
  await expect(page).toHaveURL(new RegExp(`/en/products/${PRODUCT_ID}#product-rating$`));
  await expect(page.locator('#product-rating button[aria-pressed="true"]').first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in to support", exact: true })).toHaveCount(0);
});

test("新账号资料慢返回时，旧账号结果不能覆盖共享会话", async ({ page, context }) => {
  await seedSession(context);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route("http://127.0.0.1:54329/rest/v1/profiles**", async (route) => { entered(); await gate; await route.continue(); });
  await page.goto("/zh/submit?type=product");
  await started;
  // 模拟另一标签页退出：只删除此本地测试会话并广播 SDK 的退出事件。
  await context.clearCookies({ name: "sb-127-auth-token" });
  await page.evaluate(() => {
    const channel = new BroadcastChannel("sb-127-auth-token");
    channel.postMessage({ event: "SIGNED_OUT", session: null });
    channel.close();
  });
  await expect(page).toHaveURL(/\/zh\/auth\/sign-in\?/);
  release();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByText("Test Reader", { exact: true })).toHaveCount(0);
});

test("作者身份直接继承社区会话，仍禁止自评", async ({ page, context }) => {
  await seedSession(context, CREATOR_ID);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/zh/products/${PRODUCT_ID}`);
  await expect(page.getByText(/产品创作者和团队成员不能给自己的产品评分/)).toBeVisible();
  await expect(page.getByRole("link", { name: "登录后支持", exact: true })).toHaveCount(0);
  await page.locator("#product-rating").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/auth-product-mobile.png", fullPage: false });
});

test("缺少语言 cookie 的邮箱回调失败仍保留英文目标", async ({ page }) => {
  const target = `/en/products/${PRODUCT_ID}#product-rating`;
  await page.goto(`/auth/callback?redirect=${encodeURIComponent(target)}`);
  await expect(page).toHaveURL(/\/en\/auth\/sign-in\?/);
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(target);
});

test("外部回跳地址不能跳离社区", async ({ page }) => {
  await page.goto("/en/auth/sign-in?redirect=" + encodeURIComponent("/\\example.test"));
  await signIn(page);
  await expect(page).toHaveURL("http://127.0.0.1:3000/en");
});

test("个人支持状态刷新完成前保持加载，不能误撤销已有支持", async ({ page, context }) => {
  await page.goto(`/zh/products/${PRODUCT_ID}`);
  await expect(page.getByRole("link", { name: "登录后支持", exact: true })).toBeVisible();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route(`**/zh/products/${PRODUCT_ID}*`, async (route) => {
    if (route.request().headers().rsc === "1") { entered(); await gate; }
    await route.continue();
  });
  await seedSession(context);
  await page.evaluate((session) => {
    const channel = new BroadcastChannel("sb-127-auth-token");
    channel.postMessage({ event: "SIGNED_IN", session });
    channel.close();
  }, sessionFor());
  await started;
  await expect(page.locator("#product-rating").getByRole("status").first()).toHaveText("加载中…");
  await expect(page.locator("#product-rating").getByRole("button", { name: /^支持 ·/ })).toHaveCount(0);
  release();
  await expect(page.locator('#product-rating button[aria-pressed="true"]').first()).toHaveText("已支持 · 1");
});

test("切换社区账号后，慢返回的上一账号资料不会覆盖新账号", async ({ page, context }) => {
  await seedSession(context);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route("http://127.0.0.1:54329/rest/v1/profiles**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("id") === `eq.${READER_ID}`) { entered(); await gate; }
    await route.continue();
  });
  await page.goto("/zh/submit?type=product");
  await started;
  await seedSession(context, CREATOR_ID);
  await page.evaluate((session) => {
    const channel = new BroadcastChannel("sb-127-auth-token");
    channel.postMessage({ event: "SIGNED_IN", session });
    channel.close();
  }, sessionFor(CREATOR_ID));
  await expect(page.getByText(/以 Test Creator 身份提交/)).toBeVisible();
  release();
  await expect(page.getByText(/以 Test Creator 身份提交/)).toBeVisible();
  await expect(page.getByText(/以 Test Reader 身份提交/)).toHaveCount(0);
});

test("有效会话但服务端资料查询缺失时，产品互动不会永久加载", async ({ page, context, request }) => {
  await seedSession(context);
  await request.get("http://127.0.0.1:54329/test/profile-availability?missing=true");
  try {
    await page.goto(`/zh/products/${PRODUCT_ID}`);
    await expect(page.locator('#product-rating button[aria-pressed="true"]').first()).toHaveText("已支持 · 1");
    await expect(page.locator("#product-rating textarea")).toBeVisible();
    await expect(page.locator("#product-rating").getByRole("status")).toHaveCount(0);
  } finally {
    await request.get("http://127.0.0.1:54329/test/profile-availability?missing=false");
  }
});
