import { expect, test } from "@playwright/test";

const presentations = [
  { locale: "zh", width: 1440, height: 900 },
  { locale: "zh", width: 320, height: 760 },
  { locale: "en", width: 1440, height: 900 },
  { locale: "en", width: 390, height: 844 },
] as const;

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
});

for (const { locale, width, height } of presentations) {
  test(`${locale} ${width}px keeps the sign-in and registration controls usable`, async ({ page }, testInfo) => {
    const zh = locale === "zh";
    await page.setViewportSize({ width, height });
    await page.goto(`/${locale}/auth/sign-in?redirect=${encodeURIComponent(`/${locale}/community/activities`)}`);

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("button", { name: zh ? "使用 Google 继续" : "Continue with Google" })).toBeVisible();
    const emailTab = page.getByRole("button", { name: zh ? "邮箱" : "Email", exact: true });
    const usernameTab = page.getByRole("button", { name: zh ? "用户名" : "Username", exact: true });
    await expect(emailTab).toHaveAttribute("aria-pressed", "true");
    await usernameTab.click();
    await expect(usernameTab).toHaveAttribute("aria-pressed", "true");
    await expect(emailTab).toHaveAttribute("aria-pressed", "false");
    await page.locator('input[type="password"]').first().fill("fictional-password");
    await page.getByRole("button", { name: zh ? "显示" : "Show", exact: true }).click();
    await expect(page.locator('input[aria-describedby="account-safety"]')).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: zh ? "隐藏" : "Hide", exact: true }).click();
    await expect(page.locator('input[aria-describedby="account-safety"]')).toHaveAttribute("type", "password");
    await expect(page.locator("#account-safety")).toContainText(zh ? "助记词或私钥" : "recovery phrase, or private key");

    await page.locator("main summary").click();
    await expect(page.getByRole("button", { name: zh ? "连接钱包（MetaMask / imToken）" : "Connect wallet (MetaMask / imToken)" })).toBeVisible();
    const scan = page.getByRole("button", { name: zh ? "扫码连接钱包（WalletConnect）" : "Scan to connect (WalletConnect)" });
    const scanUnavailable = page.getByText(zh ? "暂不支持扫码连接钱包" : "WalletConnect QR sign-in is currently unavailable");
    await expect(process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ? scan : scanUnavailable).toBeVisible();
    await page.locator("main summary").click();
    await page.getByRole("button", { name: zh ? "立即注册" : "Sign up", exact: true }).click();
    await emailTab.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(zh ? "创建 imToken Fans 账号" : "Create an imToken Fans account");
    await expect(page.getByLabel(zh ? "昵称" : "Display name")).toBeVisible();
    await expect(page.getByLabel(zh ? "确认密码" : "Confirm password")).toBeVisible();
    await page.getByRole("button", { name: zh ? "去登录" : "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: zh ? "登录" : "Sign in", exact: true })).toBeVisible();
    if (width < 640) {
      const menu = page.locator("header .fans-mobile-menu");
      await menu.locator("summary").click();
      await expect(menu.locator("nav")).toBeVisible();
      await menu.locator("summary").click();
    }
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowing: Array.from(document.querySelectorAll("body *"))
        .map((node) => ({ tag: node.tagName, className: node.getAttribute("class"), right: node.getBoundingClientRect().right }))
        .filter((node) => node.right > window.innerWidth)
        .slice(0, 12),
    }));
    expect(viewport.documentWidth, JSON.stringify(viewport.overflowing)).toBeLessThanOrEqual(viewport.width);
    await page.locator('input[aria-describedby="account-safety"]').fill("");
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.screenshot({ path: testInfo.outputPath(`${locale}-${width}.png`) });
    if (width < 640) {
      await page.locator('main button[type="submit"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${width}-lower.png`) });
    }
  });
}

for (const credential of ["email", "username"] as const) {
  test(`${credential} sign-in retains the requested return path with the local auth fixture`, async ({ page }) => {
    const target = "/zh/community/activities";
    await page.goto(`/zh/auth/sign-in?redirect=${encodeURIComponent(target)}`);
    if (credential === "username") {
      await page.getByRole("button", { name: "用户名", exact: true }).click();
      await page.getByLabel("用户名").fill("test_reader");
    } else {
      await page.getByLabel("邮箱").fill("reader@example.test");
    }
    await page.locator('input[type="password"]').first().fill("local-test-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(`http://127.0.0.1:3000${target}`);
  });
}

test("the 320px authenticated header keeps its controls on screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/zh/auth/sign-in?redirect=%2Fzh%2Fcommunity%2Factivities");
  await page.getByLabel("邮箱").fill("reader@example.test");
  await page.locator('input[type="password"]').first().fill("local-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/zh/community/activities");
  const header = page.locator("header.fans-header");
  const notification = header.getByRole("button", { name: "通知" });
  const publish = header.getByRole("link", { name: "发布" });
  const menu = header.locator(".fans-mobile-menu");
  await expect(notification).toBeVisible();
  await expect(publish).toBeVisible();
  await expect(menu.locator("summary")).toBeVisible();
  for (const control of [notification, publish, menu.locator("summary")]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  }
  await menu.locator("summary").click();
  await expect(menu.locator("nav")).toBeVisible();
});

test("Google sign-in keeps its local callback and requested return path", async ({ page }) => {
  const target = "/en/community/activities";
  await page.route("http://127.0.0.1:54329/auth/v1/authorize**", (route) => route.fulfill({ contentType: "text/html", body: "Local OAuth fixture" }));
  await page.goto(`/en/auth/sign-in?redirect=${encodeURIComponent(target)}`);
  const request = page.waitForRequest((candidate) => candidate.url().startsWith("http://127.0.0.1:54329/auth/v1/authorize"));
  await page.getByRole("button", { name: "Continue with Google" }).click();
  const authorize = new URL((await request).url());
  expect(authorize.searchParams.get("provider")).toBe("google");
  const callback = new URL(authorize.searchParams.get("redirect_to")!);
  expect(callback.origin).toBe("http://127.0.0.1:3000");
  expect(callback.pathname).toBe("/auth/callback");
  expect(callback.searchParams.get("redirect")).toBe(target);
});

test("validation errors are announced without navigating away", async ({ page }) => {
  await page.goto("/en/auth/sign-in");
  await page.getByRole("button", { name: "Username", exact: true }).click();
  await page.getByLabel("Username").fill("x");
  await page.locator('input[type="password"]').first().fill("local-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Invalid username");
  await expect(page).toHaveURL(/\/en\/auth\/sign-in/);
});
