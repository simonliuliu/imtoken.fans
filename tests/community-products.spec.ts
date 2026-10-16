import { expect, test } from "@playwright/test";
import { PRODUCT_ID } from "./helpers/auth-fixtures.mjs";

test.use({ reducedMotion: "reduce" });

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: 社区产品原位替换列表，切回分类保留产品筛选`, async ({ page, context }) => {
    await page.goto(`/${locale}/community/feedback`);
    const builds = page.getByRole("button", { name: locale === "zh" ? "社区产品" : "Community builds", exact: true });
    const feedback = page.getByRole("button", { name: locale === "zh" ? "产品反馈" : "Feedback", exact: true });
    const updates = page.getByRole("button", { name: locale === "zh" ? "产品公告" : "Product updates", exact: true });
    const explorer = page.locator("[data-community-products]");
    const navigations: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() || request.headers().rsc === "1") navigations.push(request.url());
    });

    await builds.click();
    await expect(builds).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(new RegExp(`/${locale}/community/feedback\\?category=builds$`));
    await expect(explorer.getByRole("link", { name: "Local auth test product", exact: true })).toBeVisible();
    expect(context.pages()).toHaveLength(1);
    expect(navigations).toEqual([]);
    await expect(page.locator('.community-board-heading > button')).toHaveCount(0);
    await expect(page.getByRole("link", { name: /进入产品猎手|Open Product Hunter/ })).toHaveCount(0);

    const search = explorer.getByRole("searchbox");
    await search.fill("not-a-matching-product");
    await expect(explorer.getByRole("link", { name: "Local auth test product", exact: true })).toHaveCount(0);
    await feedback.click();
    await expect(explorer).toBeHidden();
    await expect(page.locator('a[href$="/clearer-transaction"]')).toBeVisible();
    await expect(page.locator('.community-board-heading > button')).toBeVisible();
    await updates.click();
    await expect(page.locator('a[href$="/reading-release-notes"]')).toBeVisible();
    await builds.click();
    await expect(search).toHaveValue("not-a-matching-product");
    await explorer.getByRole("button", { name: /清除 1 项筛选|Clear 1 filters/ }).click();
    await expect(explorer.getByRole("link", { name: "Local auth test product", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.screenshot({ path: `test-results/community-products-${locale}-desktop.png`, fullPage: true });
    await page.reload();
    await expect(builds).toHaveAttribute("aria-pressed", "true");
  });

  test(`${locale}: 历史产品列表链接统一进入社区产品`, async ({ page }) => {
    await page.goto(`/${locale}/products`);
    await expect(page).toHaveURL(new RegExp(`/${locale}/community/feedback\\?category=builds$`));
    await expect(page.locator("[data-community-products]")).toBeVisible();
    await expect(page.getByRole("button", { name: locale === "zh" ? "社区产品" : "Community builds", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.screenshot({ path: `test-results/community-products-${locale}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("[data-community-products]").getByRole("link", { name: "Local auth test product", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/community-products-${locale}-mobile.png`, fullPage: true });
  });
}

test("产品详情的社区产品链接回到同一分类，投稿沿用社区登录", async ({ page }) => {
  await page.goto(`/en/products/${PRODUCT_ID}`);
  await expect(page.locator('.fans-desktop-nav a[aria-current="page"]')).toHaveText("Co-create");
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Community builds", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/community\/feedback\?category=builds$/);
  await page.locator("[data-community-products]").getByRole("link", { name: "Submit a product", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/auth\/sign-in\?/);
  expect(new URL(page.url()).searchParams.get("redirect")).toBe("/en/submit?type=product");
});

test("社区产品在语言切换和浏览器返回后保持选中", async ({ page }) => {
  await page.goto("/zh/community/feedback");
  await page.getByRole("button", { name: "社区产品", exact: true }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/community\/feedback\?category=builds$/);
  const builds = page.getByRole("button", { name: "Community builds", exact: true });
  await expect(builds).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: "Local auth test product", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/products/${PRODUCT_ID}$`));
  await page.goBack();
  await expect(builds).toHaveAttribute("aria-pressed", "true");
  await page.locator(".fans-desktop-nav").getByRole("link", { name: "Discussion", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/community\/discussion$/);
  await page.goBack();
  await expect(builds).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-community-products]")).toBeVisible();
});

test("产品查询失败时仅产品区域报错，其他分类仍可用", async ({ page, request }) => {
  await request.get("http://127.0.0.1:54329/test/product-list-availability?fail=true");
  try {
    await page.goto("/zh/community/feedback?category=wallet");
    await expect(page.locator('a[href$="/clearer-transaction"]')).toBeVisible();
    await page.getByRole("button", { name: "社区产品", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "社区产品暂时无法加载" })).toBeVisible();
    await page.getByRole("button", { name: "产品公告", exact: true }).click();
    await expect(page.locator('a[href$="/reading-release-notes"]')).toBeVisible();
  } finally {
    await request.get("http://127.0.0.1:54329/test/product-list-availability?fail=false");
  }
});
