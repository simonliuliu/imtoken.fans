// Isolated browser experiment for the real WalletConnect IndexedDB backend.
// All pages, profiles, scopes and values are synthetic; no wallet or service is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const root = fileURLToPath(new URL("../../", import.meta.url));
const backendPackage = require.resolve("@walletconnect/keyvaluestorage/package.json");
const browserBackend = path.join(path.dirname(backendPackage), "dist", "index.es.js");
const origin = "http://wallet-storage-fixture.invalid";
const secondOrigin = "http://wallet-storage-other.invalid";
const migrationOrigin = "http://wallet-storage-migration.invalid";
const failureOrigin = "http://wallet-storage-failure.invalid";
const origins = [origin, secondOrigin, migrationOrigin, failureOrigin];
const temp = await mkdtemp(path.join(os.tmpdir(), "imtoken-wc-browser-storage-"));
const profile = path.join(temp, "profile");
const results = [];
let context;

async function bundleFixture() {
  const source = await readFile(path.join(root, "src/lib/walletconnect-scoped-storage.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  await writeFile(path.join(temp, "scoped-storage.mjs"), output.outputText);
  await writeFile(path.join(temp, "fixture.mjs"), `
import { KeyValueStorage } from ${JSON.stringify(browserBackend)};
import { createWalletConnectStorageScope, scopeWalletConnectStorage } from "./scoped-storage.mjs";
window.makeScope = createWalletConnectStorageScope;
window.openScopedView = (scope, withGate = false) => {
  const actual = new KeyValueStorage();
  const gate = { started: false, release: undefined };
  const wait = new Promise((resolve) => { gate.release = resolve; });
  const backend = {
    getKeys: () => actual.getKeys(),
    getEntries: () => actual.getEntries(),
    getItem: (key) => actual.getItem(key),
    async setItem(key, value) {
      if (withGate && value && value.marker === "synthetic-delayed-write") {
        gate.started = true;
        await wait;
      }
      return actual.setItem(key, value);
    },
    removeItem: (key) => actual.removeItem(key),
  };
  window.backend = actual;
  window.view = scopeWalletConnectStorage(backend, scope);
  window.gate = gate;
};
window.readIndexedDbKeys = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("WALLET_CONNECT_V2_INDEXED_DB");
  request.onerror = () => reject(request.error);
  request.onupgradeneeded = () => reject(new Error("Expected real WalletConnect database to exist"));
  request.onsuccess = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("keyvaluestorage")) {
      database.close();
      reject(new Error("Expected real WalletConnect object store to exist"));
      return;
    }
    const transaction = database.transaction("keyvaluestorage", "readonly");
    const keys = transaction.objectStore("keyvaluestorage").getAllKeys();
    keys.onerror = () => reject(keys.error);
    keys.onsuccess = () => resolve(keys.result);
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  };
});
`);
  const config = {
    mode: "production",
    target: "web",
    context: root,
    entry: path.join(temp, "fixture.mjs"),
    output: { path: temp, filename: "fixture-bundle.js" },
    optimization: { minimize: false },
    devtool: false,
  };
  await new Promise((resolve, reject) => webpack(config, (error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    resolve();
  }));
  return readFile(path.join(temp, "fixture-bundle.js"));
}

async function openContext(bundle) {
  const browserContext = await webkit.launchPersistentContext(profile, { headless: true });
  await browserContext.route("**/*", async (route) => {
    const url = route.request().url();
    if (origins.some((current) => url === `${current}/`)) {
      await route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><script src="/fixture-bundle.js"></script></head><body>synthetic storage test</body></html>' });
      return;
    }
    if (origins.some((current) => url === `${current}/fixture-bundle.js`)) {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: bundle });
      return;
    }
    await route.abort();
  });
  return browserContext;
}

async function pageAt(browserContext, url = origin) {
  const page = await browserContext.newPage();
  await page.goto(`${url}/`);
  await page.waitForFunction(() => typeof window.openScopedView === "function");
  return page;
}

try {
  const version = JSON.parse(await readFile(backendPackage, "utf8")).version;
  assert.equal(version, "1.1.1", "Experiment expects the reviewed WalletConnect storage implementation");
  const bundle = await bundleFixture();
  context = await openContext(bundle);
  const pageA = await pageAt(context);
  const pageB = await pageAt(context);
  const scopeA = await pageA.evaluate(() => window.makeScope());
  const scopeB = await pageB.evaluate(() => window.makeScope());
  assert.match(scopeA, /^[0-9a-f]{32}$/);
  assert.match(scopeB, /^[0-9a-f]{32}$/);
  assert.notEqual(scopeA, scopeB);

  await pageA.evaluate(async (scope) => {
    window.openScopedView(scope, true);
    await window.view.setItem("provider/session", { owner: "synthetic-A" });
    await window.view.setItem("", "synthetic-empty-key");
  }, scopeA);
  await pageB.evaluate(async (scope) => {
    window.openScopedView(scope);
    await window.view.setItem("provider/session", { owner: "synthetic-B" });
    await window.view.setItem("a/b?c", "synthetic-special-key");
  }, scopeB);

  const aKeys = await pageA.evaluate(() => window.view.getKeys());
  const bKeys = await pageB.evaluate(() => window.view.getKeys());
  assert.deepEqual(aKeys.sort(), ["", "provider/session"].sort());
  assert.deepEqual(bKeys.sort(), ["a/b?c", "provider/session"].sort());
  assert.equal((await pageA.evaluate(() => window.view.getItem("provider/session"))).owner, "synthetic-A");
  assert.equal((await pageB.evaluate(() => window.view.getItem("provider/session"))).owner, "synthetic-B");
  const rawKeys = await pageA.evaluate(() => window.readIndexedDbKeys());
  assert(rawKeys.some((key) => typeof key === "string" && key.includes(scopeA)));
  assert(rawKeys.some((key) => typeof key === "string" && key.includes(scopeB)));
  results.push("same-origin tabs use the real IndexedDB store with isolated scoped keys");

  const foreignKey = rawKeys.find((key) => typeof key === "string" && key.includes(scopeB));
  await pageA.evaluate((key) => window.view.removeItem(key), foreignKey);
  assert.equal((await pageB.evaluate(() => window.view.getItem("provider/session"))).owner, "synthetic-B");
  results.push("a foreign physical key passed as a logical key cannot delete another scope");

  await pageA.evaluate(() => {
    window.pending = window.view.setItem("delayed", { marker: "synthetic-delayed-write" });
  });
  await pageA.waitForFunction(() => window.gate.started);
  assert.equal(await pageA.evaluate(() => {
    window.closing = window.view.close();
    return window.view.closed;
  }), true);
  await pageA.evaluate(() => window.view.setItem("retired", "must-not-persist"));
  await pageB.evaluate(() => window.view.setItem("while-other-closes", "synthetic-B-live"));
  await pageA.evaluate(async () => {
    window.gate.release();
    await window.pending;
    await window.closing;
  });
  assert.equal(await pageB.evaluate(() => window.view.getItem("while-other-closes")), "synthetic-B-live");
  const afterClose = await pageB.evaluate(() => window.readIndexedDbKeys());
  assert.equal(afterClose.some((key) => typeof key === "string" && key.includes(scopeA)), false);
  assert(afterClose.some((key) => typeof key === "string" && key.includes(scopeB)));
  results.push("retirement waits for the delayed write and preserves the other active scope");

  await pageB.reload();
  await pageB.waitForFunction(() => typeof window.openScopedView === "function");
  await pageB.evaluate((scope) => window.openScopedView(scope), scopeB);
  assert.equal((await pageB.evaluate(() => window.view.getItem("provider/session"))).owner, "synthetic-B");
  assert.equal(await pageB.evaluate(() => window.view.getItem("a/b?c")), "synthetic-special-key");
  results.push("the remaining scope can be reconstructed after a page reload");

  const otherOriginPage = await pageAt(context, secondOrigin);
  await otherOriginPage.evaluate((scope) => window.openScopedView(scope), scopeB);
  assert.equal(await otherOriginPage.evaluate(() => window.view.getItem("provider/session")), undefined);
  assert.deepEqual(await otherOriginPage.evaluate(() => window.view.getKeys()), []);
  results.push("a different origin does not see this browser storage");

  const broken = await pageAt(context, failureOrigin);
  const failure = await broken.evaluate(async () => {
    window.unhandledSyntheticErrors = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.unhandledSyntheticErrors.push(event.reason?.message || String(event.reason));
      event.preventDefault();
    });
    Object.defineProperty(indexedDB, "open", { configurable: true, value() {
      const request = { error: new Error("synthetic-indexeddb-open-failure") };
      setTimeout(() => request.onerror?.(), 0);
      return request;
    } });
    window.openScopedView("8".repeat(32));
    let readState = "pending";
    let closeState = "pending";
    void window.view.getItem("synthetic-key").then(() => { readState = "resolved"; }, () => { readState = "rejected"; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    void window.view.close().then(() => { closeState = "resolved"; }, () => { closeState = "rejected"; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { readState, closeState, closed: window.view.closed, errors: window.unhandledSyntheticErrors };
  });
  assert.equal(failure.closed, true);
  assert.equal(failure.readState, "pending");
  assert.equal(failure.closeState, "pending");
  assert(failure.errors.some((message) => message.includes("synthetic-indexeddb-open-failure")));
  results.push("synthetic asynchronous IndexedDB open failure leaves initialization and cleanup pending");
  process.stdout.write(JSON.stringify({ status: "observed-known-failure", scenario: "synthetic-indexeddb-open-failure", ...failure }) + "\n");

  const migrationA = await pageAt(context, migrationOrigin);
  const migrationB = await pageAt(context, migrationOrigin);
  const migrationScope = "7".repeat(32);
  // The 2.24.0 SDK Store uses this actual prefix/version/context for sessions.
  const physicalLegacyKey = "wc@2:client:0.3//session";
  const legacyValue = [{ topic: "synthetic-session", owner: "synthetic-legacy" }];
  await migrationA.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify([{ topic: "synthetic-session", owner: "synthetic-legacy" }]));
    localStorage.setItem("unrelated-synthetic-key", JSON.stringify("keep"));
  }, physicalLegacyKey);
  await migrationB.evaluate(({ scope, key }) => {
    const original = Object.keys;
    Object.keys = function (value) {
      const keys = original(value);
      if (value === localStorage && !window.enumerationHeld) {
        window.enumerationHeld = true;
        return { then(resolve) { window.releaseEnumeration = () => resolve(keys); } };
      }
      return keys;
    };
    window.openScopedView(scope);
    window.migrationPending = window.backend.getItem(key);
  }, { scope: migrationScope, key: physicalLegacyKey });
  await migrationB.waitForFunction(() => typeof window.releaseEnumeration === "function");
  const migrated = await migrationA.evaluate(async ({ scope, key }) => {
    window.openScopedView(scope);
    return window.backend.getItem(key);
  }, { scope: migrationScope, key: physicalLegacyKey });
  assert.deepEqual(migrated, legacyValue);
  await migrationA.waitForFunction((key) => localStorage.getItem(key) === null, physicalLegacyKey);
  await migrationB.evaluate(() => window.releaseEnumeration());
  const afterConcurrentMigration = await migrationB.evaluate(() => window.migrationPending);
  assert.deepEqual(afterConcurrentMigration, legacyValue, "Concurrent migration must retain the legacy value");
  assert.deepEqual(await migrationA.evaluate((key) => window.backend.getItem(key), physicalLegacyKey), legacyValue);
  assert.equal(await migrationA.evaluate(() => localStorage.getItem("unrelated-synthetic-key")), '"keep"');
  results.push("concurrent synthetic localStorage migration retains existing wallet session data");

  await context.close();
  context = undefined;

  context = await openContext(bundle);
  const restored = await pageAt(context);
  await restored.evaluate((scope) => window.openScopedView(scope), scopeB);
  assert.equal((await restored.evaluate(() => window.view.getItem("provider/session"))).owner, "synthetic-B");
  const restoredRawKeys = await restored.evaluate(() => window.readIndexedDbKeys());
  assert.equal(restoredRawKeys.some((key) => typeof key === "string" && key.includes(scopeA)), false);
  assert(restoredRawKeys.some((key) => typeof key === "string" && key.includes(scopeB)));
  results.push("the synthetic browser profile retains the live scope after a browser restart");

  const sameScopeOtherTab = await pageAt(context);
  await sameScopeOtherTab.evaluate((scope) => window.openScopedView(scope), scopeB);
  assert.equal((await sameScopeOtherTab.evaluate(() => window.view.getItem("provider/session"))).owner, "synthetic-B");
  await sameScopeOtherTab.evaluate(() => window.view.close());
  assert.equal(await restored.evaluate(() => window.view.closed), false);
  await restored.evaluate(() => window.view.setItem("after-foreign-close", "synthetic-recreated"));
  assert.equal(await restored.evaluate(() => window.view.getItem("after-foreign-close")), "synthetic-recreated");
  results.push("a second view of the same scope is not retired by the first view closing");

  await restored.evaluate(() => window.view.close());
  await context.close();
  context = undefined;
  process.stdout.write(JSON.stringify({ status: "passed", backend: `@walletconnect/keyvaluestorage@${version}`, browser: "isolated WebKit", checks: results }) + "\n");
} finally {
  if (context) await context.close();
  await rm(temp, { recursive: true, force: true });
}
