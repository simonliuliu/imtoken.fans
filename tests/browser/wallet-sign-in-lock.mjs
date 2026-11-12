// Run with an isolated Playwright WebKit install; all network requests are intercepted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webkit } from "playwright";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../../src/lib/wallet-sign-in-lock.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const browser = await webkit.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "wallet-lock.invalid" && url.hostname !== "other-origin.invalid") {
      await route.abort();
      return;
    }
    if (url.pathname === "/lock.mjs") {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: source });
    } else {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic wallet lock test</title>" });
    }
  });
  const first = await context.newPage();
  const second = await context.newPage();
  const otherOrigin = await context.newPage();
  await Promise.all([
    first.goto("https://wallet-lock.invalid/"),
    second.goto("https://wallet-lock.invalid/"),
    otherOrigin.goto("https://other-origin.invalid/"),
  ]);
  for (const page of [first, second, otherOrigin]) {
    assert.equal(await page.evaluate(() => typeof navigator.locks?.request), "function", "Web Locks unavailable in isolated WebKit");
  }

  await first.evaluate(async () => {
    const api = await import("/lock.mjs");
    window.firstOperationStarted = false;
    window.firstAttempt = api.withWalletSignInLock({ inProgress: "busy", unavailable: "unavailable" }, async () => {
      window.firstOperationStarted = true;
      await new Promise((resolve) => { window.releaseFirst = resolve; });
      return "first finished";
    });
  });
  await first.waitForFunction(() => window.firstOperationStarted === true);

  const blocked = await second.evaluate(async () => {
    const api = await import("/lock.mjs");
    window.secondOperationStarted = false;
    try {
      await api.withWalletSignInLock({ inProgress: "busy", unavailable: "unavailable" }, async () => {
        window.secondOperationStarted = true;
      });
      return "unexpected success";
    } catch (error) {
      return error.message;
    }
  });
  assert.equal(blocked, "busy");
  assert.equal(await second.evaluate(() => window.secondOperationStarted), false);

  const differentOrigin = await otherOrigin.evaluate(async () => {
    const api = await import("/lock.mjs");
    return api.withWalletSignInLock({ inProgress: "busy", unavailable: "unavailable" }, async () => "separate origin");
  });
  assert.equal(differentOrigin, "separate origin");
  await first.evaluate(() => window.releaseFirst());
  assert.equal(await first.evaluate(() => window.firstAttempt), "first finished");
  const retried = await second.evaluate(async () => {
    const api = await import("/lock.mjs");
    return api.withWalletSignInLock({ inProgress: "busy", unavailable: "unavailable" }, async () => "retry completed");
  });
  assert.equal(retried, "retry completed");
  console.log("PASS: isolated WebKit same-origin exclusion, retry after release and different-origin boundary; no real account or network.");
  await context.close();
} finally {
  await browser.close();
}
