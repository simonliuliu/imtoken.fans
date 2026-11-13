// Render the real sign-in page and wallet client in a disposable WebKit page.
// Wallets, sessions, HTTP responses and navigation are synthetic and network is blocked.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), "imtoken-wallet-page-"));
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const address = "0x1111111111111111111111111111111111111111";
let browser;
let passed = 0;
let blocked = 0;
const browserErrors = [];

async function source(input, output, jsx = false) {
  const text = await readFile(path.join(root, input), "utf8");
  const result = ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
    ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  } });
  await writeFile(path.join(temp, output), result.outputText);
}

async function fixture() {
  await source("src/app/[locale]/auth/sign-in/page.tsx", "page.js", true);
  await source("src/lib/wallet-client.ts", "wallet-client.js");
  await source("src/lib/wallet-sign-in-lock.ts", "lock.js");
  await source("src/lib/walletconnect-session.ts", "session.js");
  await writeFile(path.join(temp, "external.js"), `
import React, { useSyncExternalStore } from "react";
let auth = { user: null, loading: false };
const listeners = new Set();
window.fixtureSetAuth = (value) => { auth = value; listeners.forEach((listener) => listener()); };
export const useAuth = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => auth, () => auth);
export const useTranslations = () => Object.assign((key) => key, { rich: (key) => key });
export const useLocale = () => "en";
const router = { replace: (href) => window.fixture.replaces.push(href) };
export const useRouter = () => router;
export const useSearchParams = () => new URLSearchParams("redirect=%2Fen%2Fcommunity");
export const Link = ({ children, ...props }) => React.createElement("a", props, children);
export const isSupabaseConfigured = () => true;
export const getAuthReturnPath = (value) => value || "/en";
export const BrandLogo = () => React.createElement("span", null, "fixture-logo");
export const AuthLoading = () => React.createElement("div", { id: "fixture-loading" }, "loading");
export const signInWithGoogle = async (path) => { window.fixture.other.push("google:" + path); };
export const signInWithPassword = async () => { window.fixture.other.push("password"); return { error: "synthetic-password-error" }; };
export const signInWithUsername = signInWithPassword;
export const signUpWithPassword = signInWithPassword;
export const signUpWithUsername = signInWithPassword;
`);
  await writeFile(path.join(temp, "provider.js"), `
const address = ${JSON.stringify(address)};
export const EthereumProvider = { async init() {
  await window.fixtureBoundary("init");
  return {
    chainId: 1, accounts: [address],
    session: { expiry: Math.floor(Date.now() / 1000) + 3600, namespaces: { eip155: {
      chains: ["eip155:1"], accounts: ["eip155:1:" + address], methods: ["personal_sign"]
    } } },
    async connect() { await window.fixtureBoundary("connect"); },
    async disconnect() { await window.fixtureBoundary("disconnect"); },
    async request({ method }) { if (method !== "personal_sign") throw new Error("Unexpected method"); await window.fixtureBoundary("sign"); return "synthetic-signature"; }
  };
} };
`);
  await writeFile(path.join(temp, "entry.js"), `
import React from "react";
import { createRoot } from "react-dom/client";
import SignInPage from "./page.js";
const address = ${JSON.stringify(address)};
window.fixture = { calls: [], gates: {}, holds: [], replaces: [], other: [], serverWrites: 0, lockFinishes: 0, errors: [] };
window.addEventListener("error", (event) => { const message = "error:" + event.message; window.fixture.errors.push(message); void window.fixtureReport(message); });
window.addEventListener("unhandledrejection", (event) => { const message = "rejection:" + String(event.reason); window.fixture.errors.push(message); void window.fixtureReport(message); });
Object.defineProperty(navigator, "locks", { configurable: true, value: {
  async request(name, options, callback) {
    if (name !== "imtoken-fans-wallet-sign-in" || !options.ifAvailable) throw new Error("Unexpected lock");
    try { return await callback({ name }); } finally { window.fixture.lockFinishes++; }
  }
} });
window.fixtureBoundary = async (name) => {
  window.fixture.calls.push(name);
  if (window.fixture.holds.includes(name)) await new Promise((resolve, reject) => { window.fixture.gates[name] = { resolve, reject }; });
};
window.fixtureRelease = (name, reject) => {
  const gate = window.fixture.gates[name];
  if (!gate) throw new Error("Gate was not reached: " + name);
  delete window.fixture.gates[name];
  window.fixture.holds = window.fixture.holds.filter((item) => item !== name);
  if (reject) gate.reject(new Error("synthetic-" + name + "-error")); else gate.resolve();
};
window.ethereum = { async request({ method }) {
  if (method === "eth_requestAccounts") { await window.fixtureBoundary("accounts"); return [address]; }
  if (method === "personal_sign") { await window.fixtureBoundary("sign"); return "synthetic-signature"; }
  throw new Error("Unexpected injected method");
} };
window.fetch = async (url) => {
  if (url === "/api/auth/wallet/nonce") { await window.fixtureBoundary("nonce"); return { ok: true, async json() { await window.fixtureBoundary("nonceJson"); return { message: "synthetic-challenge" }; } }; }
  if (url === "/api/auth/wallet/verify") { window.fixture.serverWrites++; await window.fixtureBoundary("verify"); return { ok: true, async json() { await window.fixtureBoundary("verifyJson"); return {}; } }; }
  throw new Error("Unexpected fixture fetch");
};
let reactRoot;
window.fixtureMount = () => { reactRoot = createRoot(document.getElementById("app")); reactRoot.render(React.createElement(SignInPage)); };
window.fixtureUnmount = () => { reactRoot.unmount(); reactRoot = undefined; };
window.fixtureMount();
`);
  const mock = path.join(temp, "external.js");
  const alias = Object.fromEntries([
    "next-intl", "next/navigation", "@/i18n/navigation", "@/app/[locale]/auth/actions",
    "@/lib/supabase/config", "@/lib/auth-navigation", "@/lib/auth-context",
    "@/components/brand-logo", "@/components/auth-loading",
  ].map((name) => [name + "$", mock]));
  Object.assign(alias, {
    "@/lib/wallet-client$": path.join(temp, "wallet-client.js"),
    "@/lib/wallet-sign-in-lock$": path.join(temp, "lock.js"),
    "@/lib/walletconnect-session$": path.join(temp, "session.js"),
    "@walletconnect/ethereum-provider$": path.join(temp, "provider.js"),
  });
  await new Promise((resolve, reject) => webpack({
    mode: "development", target: "web", context: root, entry: path.join(temp, "entry.js"),
    output: { path: temp, filename: "bundle.js" }, devtool: false,
    resolve: { alias, modules: [path.join(root, "node_modules"), "node_modules"] },
    plugins: [
      new webpack.DefinePlugin({ "process.env.NEXT_PUBLIC_REOWN_PROJECT_ID": JSON.stringify("synthetic-project") }),
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ],
  }, (error, stats) => {
    if (error) reject(error);
    else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
    else resolve();
  }));
  return await readFile(path.join(temp, "bundle.js"));
}

async function newPage(bundle) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://fixture.invalid") { blocked++; return route.abort(); }
    if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/auth") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><body><div id="app"></div><script src="/bundle.js"></script></body></html>' });
    if (url.pathname === "/welcome") return route.fulfill({ contentType: "text/html", body: "synthetic-welcome" });
    throw new Error(`Unexpected fixture route: ${url.pathname}`);
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.exposeBinding("fixtureReport", (_source, message) => browserErrors.push(message));
  await page.goto("http://fixture.invalid/auth");
  try {
    await page.locator("summary").waitFor({ state: "attached", timeout: 5000 });
  } catch (error) {
    throw new Error(`Fixture did not render: ${JSON.stringify({ browserErrors, html: await page.content() })}`, { cause: error });
  }
  return { page, context };
}

async function run(bundle, name, scenario) {
  const { page, context } = await newPage(bundle);
  try {
    await scenario(page);
    const errors = await page.evaluate(() => window.fixture?.errors || []);
    assert.deepEqual(errors, []);
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } finally {
    await context.close();
  }
}

async function start(page, kind, hold) {
  await page.evaluate((phase) => { window.fixture.holds = phase ? [phase] : []; }, hold);
  await page.locator("summary").click();
  await page.locator("details button").nth(kind === "wallet" ? 0 : 1).click();
  if (hold) await page.waitForFunction((phase) => Boolean(window.fixture.gates[phase]), hold);
}
async function release(page, phase, reject = false) {
  await page.evaluate(([key, shouldReject]) => window.fixtureRelease(key, shouldReject), [phase, reject]);
}
async function calls(page) { return page.evaluate(() => ({ calls: window.fixture.calls, writes: window.fixture.serverWrites, replaces: window.fixture.replaces })); }
async function waitForLockRelease(page) { await page.waitForFunction(() => window.fixture.lockFinishes === 1); }
async function flushRender(page) { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

try {
  const bundle = await fixture();
  browser = await webkit.launch({ headless: true });
  for (const kind of ["wallet", "walletconnect"]) {
    await run(bundle, `${kind}: authenticated context waits for wallet cleanup and then uses welcome`, async (page) => {
      const phase = kind === "wallet" ? "verify" : "disconnect";
      await start(page, kind, phase);
      await page.evaluate(() => window.fixtureSetAuth({ user: { id: "synthetic-user" }, loading: false }));
      await page.locator("#fixture-loading").waitFor();
      assert.deepEqual((await calls(page)).replaces, []);
      await release(page, phase);
      await page.waitForURL("http://fixture.invalid/welcome?redirect=%2Fen%2Fcommunity");
    });
  }
  for (const [kind, phase, forbidden] of [
    ["wallet", "accounts", "nonce"], ["wallet", "nonce", "sign"],
    ["wallet", "sign", "verify"], ["wallet", "verify", "verifyJson"],
    ["walletconnect", "init", "connect"], ["walletconnect", "connect", "nonce"],
    ["walletconnect", "sign", "verify"], ["walletconnect", "disconnect", null],
  ]) {
    await run(bundle, `${kind}: unmount during ${phase} retires the actual client attempt`, async (page) => {
      await start(page, kind, phase);
      await page.evaluate(() => window.fixtureUnmount());
      await release(page, phase);
      await waitForLockRelease(page);
      const result = await calls(page);
      if (forbidden) assert.equal(result.calls.includes(forbidden), false);
      assert.equal(result.writes, phase === "verify" || phase === "disconnect" ? 1 : 0);
      if (kind === "walletconnect") assert.equal(result.calls.includes("disconnect"), true);
      assert.deepEqual(result.replaces, []);
      assert.equal(new URL(page.url()).pathname, "/auth");
    });
  }
  await run(bundle, "pagehide retires a pending attempt and pageshow restores the controls", async (page) => {
    await start(page, "wallet", "sign");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await release(page, "sign");
    await waitForLockRelease(page);
    assert.equal((await calls(page)).calls.includes("verify"), false);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.locator("details button").first().waitFor({ state: "visible" });
    assert.equal(await page.locator("details button").first().isEnabled(), true);
  });
  await run(bundle, "pageshow does not redirect an authenticated user before old disconnect finishes", async (page) => {
    await start(page, "walletconnect", "disconnect");
    await page.evaluate(() => {
      window.fixtureSetAuth({ user: { id: "synthetic-user" }, loading: false });
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await flushRender(page);
    assert.deepEqual((await calls(page)).replaces, []);
    await release(page, "disconnect");
    await waitForLockRelease(page);
    await page.waitForFunction(() => window.fixture.replaces.length === 1);
    assert.deepEqual((await calls(page)).replaces, ["/en/community"]);
  });
  await run(bundle, "a remounted sign-in page waits for the previous instance to finish cleanup", async (page) => {
    await start(page, "walletconnect", "disconnect");
    await page.evaluate(() => {
      window.fixtureUnmount();
      window.fixtureMount();
      window.fixtureSetAuth({ user: { id: "synthetic-user" }, loading: false });
    });
    await page.locator("#fixture-loading").waitFor();
    await flushRender(page);
    assert.deepEqual((await calls(page)).replaces, []);
    await release(page, "disconnect");
    await waitForLockRelease(page);
    await page.waitForFunction(() => window.fixture.replaces.length === 1);
    assert.deepEqual((await calls(page)).replaces, ["/en/community"]);
  });
  await run(bundle, "a rejected retry does not release the previous attempt's redirect barrier", async (page) => {
    await start(page, "wallet", "sign");
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await page.locator("details button").first().click();
    await page.getByRole("alert").waitFor();
    await page.evaluate(() => window.fixtureSetAuth({ user: { id: "synthetic-user" }, loading: false }));
    await flushRender(page);
    assert.deepEqual((await calls(page)).replaces, []);
    await release(page, "sign");
    await waitForLockRelease(page);
    await page.waitForFunction(() => window.fixture.replaces.length === 1);
  });
  await run(bundle, "stale rejection cannot overwrite a newer lock error after pageshow", async (page) => {
    await start(page, "wallet", "sign");
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await page.locator("details button").first().click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("alert").textContent(), "walletSignInInProgress");
    await release(page, "sign", true);
    await waitForLockRelease(page);
    assert.equal(await page.getByRole("alert").textContent(), "walletSignInInProgress");
    assert.equal((await calls(page)).calls.includes("verify"), false);
  });
  await run(bundle, "two synchronous wallet clicks start only one attempt", async (page) => {
    await page.evaluate(() => { window.fixture.holds = ["accounts"]; });
    await page.evaluate(() => {
      const button = document.querySelector("details button");
      button.click(); button.click();
    });
    await page.waitForFunction(() => Boolean(window.fixture.gates.accounts));
    assert.equal((await calls(page)).calls.filter((name) => name === "accounts").length, 1);
    await page.evaluate(() => window.fixtureUnmount());
    await release(page, "accounts");
    await waitForLockRelease(page);
  });
  await run(bundle, "normal authentication redirects without a wallet attempt", async (page) => {
    await page.evaluate(() => window.fixtureSetAuth({ user: { id: "synthetic-user" }, loading: false }));
    await page.waitForFunction(() => window.fixture.replaces.length === 1);
    assert.deepEqual((await calls(page)).replaces, ["/en/community"]);
  });
  await run(bundle, "live wallet errors are displayed and allow retry", async (page) => {
    await start(page, "wallet", "accounts");
    await release(page, "accounts", true);
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("alert").textContent(), "synthetic-accounts-error");
    assert.equal(await page.locator("details button").first().isEnabled(), true);
  });
  await run(bundle, "password and Google controls retain their existing action paths", async (page) => {
    await page.locator('input[type="email"]').fill("reader@example.invalid");
    await page.locator('input[type="password"]').first().fill("synthetic-password");
    await page.getByRole("button", { name: "submitSignIn", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("alert").textContent(), "synthetic-password-error");
    await page.getByRole("button", { name: "google", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.other), ["password", "google:/en/community"]);
    assert.deepEqual((await calls(page)).calls, []);
  });
  assert.deepEqual(browserErrors, []);
  assert.equal(blocked, 0);
  console.log(`${passed} isolated WebKit page scenarios passed; no production network was used`);
} finally {
  if (browser) await browser.close();
  await rm(temp, { recursive: true, force: true });
}
