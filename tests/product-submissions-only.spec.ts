import { expect, test, type BrowserContext } from "@playwright/test";
import { READER_ID, sessionFor } from "./helpers/auth-fixtures.mjs";

async function seedSession(context: BrowserContext) {
  await context.addCookies([{
    name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(sessionFor())).toString("base64url")}`,
    domain: "127.0.0.1", path: "/", sameSite: "Lax",
  }]);
}

for (const locale of ["zh", "en"]) {
  test(`${locale} 旧点子链接仅展示产品表单，桌面与手机没有类型切换`, async ({ page, context }) => {
    await seedSession(context);
    await page.goto(`/${locale}/submit?type=idea`);
    await expect(page.getByRole("heading", { name: locale === "zh" ? "提交产品" : "Submit a product", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /提交点子|Submit an idea/ })).toHaveCount(0);
    await expect(page.getByPlaceholder(locale === "zh" ? "给它起个好记的名字" : "Give it a memorable name")).toHaveAttribute("maxlength", "60");
    await expect(page.getByPlaceholder("https://...", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: locale === "zh" ? "提交审核" : "Submit for review", exact: true })).toBeDisabled();
    await page.screenshot({ path: `test-results/product-only-${locale}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { name: locale === "zh" ? "提交产品" : "Submit a product", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/product-only-${locale}-mobile.png`, fullPage: false });
  });

  test(`${locale} 历史点子列表不再号召投稿`, async ({ page }) => {
    await page.goto(`/${locale}/ideas`);
    await expect(page.getByRole("heading", { name: locale === "zh" ? "历史点子" : "Idea archive", exact: true })).toBeVisible();
    await expect(page.getByText(locale === "zh" ? "暂无已发布的历史点子。" : "No published ideas in the archive.", { exact: true })).toBeVisible();
    await expect(page.locator('main a[href*="/submit"]')).toHaveCount(0);
  });
}

test("恢复产品草稿时不混入或删除历史点子草稿", async ({ page, context }) => {
  await seedSession(context);
  const key = `imtoken-fans-submission-drafts-v2:${READER_ID}`;
  const idea = { title: "Legacy idea draft", description: "Keep this unpublished historical draft" };
  await context.addInitScript(({ key, idea }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ product: { title: "Saved product" }, idea }));
  }, { key, idea });
  await page.goto("/zh/submit?type=idea");
  const title = page.getByPlaceholder("给它起个好记的名字");
  await expect(title).toHaveValue("Saved product");
  await title.fill("Edited product");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).product.title, key)).toBe("Edited product");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).idea, key)).toEqual(idea);
  await page.reload();
  await expect(title).toHaveValue("Edited product");
});
