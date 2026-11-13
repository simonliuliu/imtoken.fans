// Browser-only fixture: an isolated synthetic profile and origin, never a real wallet.
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
const origin = "http://wallet-isolated-fixture.invalid";
const failureOrigin = "http://wallet-isolated-failure.invalid";
const versionOrigin = "http://wallet-isolated-version.invalid";
const closedOrigin = "http://wallet-isolated-closed.invalid";
const temp = await mkdtemp(path.join(os.tmpdir(), "imtoken-wc-isolated-browser-"));
const profile = path.join(temp, "profile");
let context;
const results = [];

async function bundleFixture() {
  for (const [input, output] of [
    ["src/lib/walletconnect-scoped-storage.ts", "scoped.mjs"],
    ["src/lib/walletconnect-indexeddb-storage.ts", "indexeddb.mjs"],
  ]) {
    const source = await readFile(path.join(root, input), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    await writeFile(path.join(temp, output), compiled.outputText);
  }
  await writeFile(path.join(temp, "fixture.mjs"), `
import { scopeWalletConnectStorage, createWalletConnectStorageScope } from "./scoped.mjs";
import { createWalletConnectAttemptStorage } from "./indexeddb.mjs";
window.makeScope = createWalletConnectStorageScope;
window.makeBackend = createWalletConnectAttemptStorage;
window.openScopedView = (scope, withGate = false) => {
  const actual = createWalletConnectAttemptStorage();
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
  window.actual = actual;
  window.view = scopeWalletConnectStorage(backend, scope);
  window.gate = gate;
};
window.rawKeys = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("imtoken-fans-walletconnect-attempts", 1);
  request.onerror = () => reject(request.error);
  request.onupgradeneeded = () => reject(new Error("Expected attempt database to exist"));
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("attempts")) {
      db.close();
      reject(new Error("Expected attempt object store to exist"));
      return;
    }
    const tx = db.transaction("attempts", "readonly");
    const keys = tx.objectStore("attempts").getAllKeys();
    keys.onerror = () => reject(keys.error);
    keys.onsuccess = () => resolve(keys.result);
    tx.oncomplete = () => db.close();
    tx.onabort = () => { db.close(); reject(tx.error); };
  };
});
`);
  const config = {
    mode: "production", target: "web", context: root,
    entry: path.join(temp, "fixture.mjs"), output: { path: temp, filename: "fixture-bundle.js" },
    optimization: { minimize: false }, devtool: false,
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
    if ([`${origin}/`, `${failureOrigin}/`, `${versionOrigin}/`, `${closedOrigin}/`].includes(url)) {
      await route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><script src="/fixture-bundle.js"></script></head><body>synthetic storage test</body></html>' });
      return;
    }
    if ([`${origin}/fixture-bundle.js`, `${failureOrigin}/fixture-bundle.js`, `${versionOrigin}/fixture-bundle.js`, `${closedOrigin}/fixture-bundle.js`].includes(url)) {
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
  const bundle = await bundleFixture();
  context = await openContext(bundle);
  const a = await pageAt(context);
  const b = await pageAt(context);
  const scopeA = await a.evaluate(() => window.makeScope());
  const scopeB = await b.evaluate(() => window.makeScope());
  assert.match(scopeA, /^[0-9a-f]{32}$/);
  assert.match(scopeB, /^[0-9a-f]{32}$/);
  assert.notEqual(scopeA, scopeB);
  const legacy = "wc@2:client:0.3//session";
  await a.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ legacy: "synthetic-existing-session" }));
    localStorage.setItem("unrelated-synthetic-key", JSON.stringify("keep"));
    const original = indexedDB.open.bind(indexedDB);
    window.openedDatabases = [];
    Object.defineProperty(indexedDB, "open", { configurable: true, value(name, version) {
      window.openedDatabases.push(name);
      return original(name, version);
    } });
  }, legacy);
  const keys = ["", "a/b", "a:b", "a\\b", "a?b", "a", "中文", "😀", "\ud800", "\udc00"];
  await a.evaluate(async ({ scope, logicalKeys }) => {
    window.openScopedView(scope, true);
    for (let i = 0; i < logicalKeys.length; i += 1) await window.view.setItem(logicalKeys[i], { index: i });
  }, { scope: scopeA, logicalKeys: keys });
  await b.evaluate(async (scope) => {
    window.openScopedView(scope);
    await window.view.setItem("a/b", { owner: "synthetic-B" });
  }, scopeB);
  const roundTrip = await a.evaluate(async (logicalKeys) => {
    const values = [];
    for (const key of logicalKeys) values.push(await window.view.getItem(key));
    return { keys: await window.view.getKeys(), entries: await window.view.getEntries(), values };
  }, keys);
  assert.deepEqual(roundTrip.keys.sort(), [...keys].sort());
  for (let i = 0; i < keys.length; i += 1) {
    assert.deepEqual(roundTrip.values[i], { index: i });
    assert(roundTrip.entries.some(([key, value]) => key === keys[i] && value.index === i));
  }
  const rawKeys = await a.evaluate(() => window.rawKeys());
  assert(rawKeys.some((key) => typeof key === "string" && key.includes(scopeA)));
  assert(rawKeys.some((key) => typeof key === "string" && key.includes(scopeB)));
  assert.deepEqual(await a.evaluate(() => window.openedDatabases), ["imtoken-fans-walletconnect-attempts", "imtoken-fans-walletconnect-attempts"]);
  assert.equal(await a.evaluate((key) => localStorage.getItem(key), legacy), '{"legacy":"synthetic-existing-session"}');
  assert.equal(await a.evaluate(() => localStorage.getItem("unrelated-synthetic-key")), '"keep"');
  results.push("two tabs use distinct scopes and preserve existing localStorage records");
  results.push("empty, punctuation, Unicode and lone-surrogate keys round-trip through IndexedDB");

  const failedWrite = await a.evaluate(async () => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      this.transaction.abort();
      return request;
    };
    let rejected = false;
    try { await window.view.setItem("aborted-put", "must-not-persist"); } catch { rejected = true; }
    IDBObjectStore.prototype.put = original;
    return { rejected, value: (await window.view.getItem("aborted-put")) ?? null, closed: window.view.closed };
  });
  assert.deepEqual(failedWrite, { rejected: true, value: null, closed: false });
  results.push("an aborted write fails and does not persist");

  const thrownAfterWrite = await a.evaluate(async () => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      original.apply(this, args);
      throw new Error("synthetic-error-after-enqueue");
    };
    let rejected = false;
    try { await window.view.setItem("thrown-put", "must-not-persist"); } catch { rejected = true; }
    IDBObjectStore.prototype.put = original;
    return { rejected, value: (await window.view.getItem("thrown-put")) ?? null };
  });
  assert.deepEqual(thrownAfterWrite, { rejected: true, value: null });
  results.push("a synchronous error after enqueue aborts the transaction");

  const nullResult = await a.evaluate(async () => {
    await window.view.setItem("explicit-null", null);
    return { isNull: (await window.view.getItem("explicit-null")) === null, isMissing: (await window.view.getItem("absent-key")) === undefined };
  });
  assert.deepEqual(nullResult, { isNull: true, isMissing: true });
  results.push("stored null stays distinct from a missing key");

  await a.evaluate(() => { window.pending = window.view.setItem("delayed", { marker: "synthetic-delayed-write" }); });
  await a.waitForFunction(() => window.gate.started);
  assert.equal(await a.evaluate(() => { window.closing = window.view.close(); return window.view.closed; }), true);
  await a.evaluate(() => window.view.setItem("after-close", "must-not-persist"));
  await b.evaluate(() => window.view.setItem("while-closing", "synthetic-B-live"));
  await a.evaluate(async () => { window.gate.release(); await window.pending; await window.closing; });
  assert.equal(await b.evaluate(() => window.view.getItem("while-closing")), "synthetic-B-live");
  const afterClose = await b.evaluate(() => window.rawKeys());
  assert.equal(afterClose.some((key) => typeof key === "string" && key.includes(scopeA)), false);
  assert(afterClose.some((key) => typeof key === "string" && key.includes(scopeB)));
  results.push("close waits for the delayed write and only removes the retired scope");

  await b.evaluate(() => window.view.setItem("must-survive-abort", "synthetic-B"));
  const failedDelete = await b.evaluate(async () => {
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args) {
      const request = original.apply(this, args);
      this.transaction.abort();
      return request;
    };
    let rejected = false;
    try { await window.view.close(); } catch { rejected = true; }
    IDBObjectStore.prototype.delete = original;
    return { rejected, closed: window.view.closed };
  });
  assert.deepEqual(failedDelete, { rejected: true, closed: true });
  assert((await b.evaluate(() => window.rawKeys())).some((key) => typeof key === "string" && key.includes(scopeB)));
  await b.evaluate(() => window.view.close());
  assert.equal((await b.evaluate(() => window.rawKeys())).some((key) => typeof key === "string" && key.includes(scopeB)), false);
  results.push("aborted delete rejects close and cleanup can be retried");

  const scopeC = await b.evaluate(() => window.makeScope());
  await b.evaluate(async (scope) => { window.openScopedView(scope); await window.view.setItem("orphan", "synthetic-C"); }, scopeC);
  await context.close();
  context = undefined;
  context = await openContext(bundle);
  const reopened = await pageAt(context);
  await reopened.evaluate((scope) => window.openScopedView(scope), scopeC);
  assert.equal(await reopened.evaluate(() => window.view.getItem("orphan")), "synthetic-C");
  assert.equal(await reopened.evaluate((key) => localStorage.getItem(key), legacy), '{"legacy":"synthetic-existing-session"}');
  const scopeD = await reopened.evaluate(() => window.makeScope());
  assert.notEqual(scopeC, scopeD);
  const fresh = await pageAt(context);
  await fresh.evaluate((scope) => window.openScopedView(scope), scopeD);
  assert.equal(await fresh.evaluate(() => window.view.getItem("orphan")), undefined);
  results.push("an unclosed scope survives browser restart but a fresh scope cannot see it");

  const same = await pageAt(context);
  await same.evaluate((scope) => window.openScopedView(scope), scopeC);
  await same.evaluate(() => window.view.close());
  assert.equal(await reopened.evaluate(() => window.view.closed), false);
  await reopened.evaluate(() => window.view.setItem("resurrected", "synthetic"));
  assert.equal(await reopened.evaluate(() => window.view.getItem("resurrected")), "synthetic");
  results.push("reusing a scope across tabs does not share retirement state");
  await reopened.evaluate(() => window.view.close());
  await fresh.evaluate(() => window.view.close());

  const failure = await pageAt(context, failureOrigin);
  const failureResult = await failure.evaluate(async () => {
    const original = indexedDB.open.bind(indexedDB);
    const errors = [];
    window.addEventListener("unhandledrejection", (event) => { errors.push(String(event.reason)); event.preventDefault(); });
    Object.defineProperty(indexedDB, "open", { configurable: true, value() {
      const request = { error: new Error("synthetic-indexeddb-open-failure") };
      setTimeout(() => request.onerror?.(), 0);
      return request;
    } });
    window.openScopedView("8".repeat(32));
    let readRejected = false;
    let closeRejected = false;
    try { await window.view.getItem("key"); } catch { readRejected = true; }
    try { await window.view.close(); } catch { closeRejected = true; }
    Object.defineProperty(indexedDB, "open", { configurable: true, value: original });
    await window.view.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { readRejected, closeRejected, closed: window.view.closed, errors };
  });
  assert.deepEqual(failureResult, { readRejected: true, closeRejected: true, closed: true, errors: [] });
  results.push("asynchronous IndexedDB open failure rejects and cleanup remains retryable");

  const blockedResult = await failure.evaluate(async () => {
    let request;
    let lateAborts = 0;
    let lateCloses = 0;
    const factory = { open() {
      request = {};
      setTimeout(() => request.onblocked(), 0);
      return request;
    } };
    const backend = window.makeBackend(factory);
    let rejected = false;
    try { await backend.getKeys(); } catch { rejected = true; }
    request.transaction = { abort() { lateAborts += 1; } };
    request.onupgradeneeded();
    request.result = { close() { lateCloses += 1; } };
    request.onsuccess();
    return { rejected, lateAborts, lateCloses };
  });
  assert.deepEqual(blockedResult, { rejected: true, lateAborts: 1, lateCloses: 1 });
  results.push("a blocked open rejects and a late upgrade or connection is retired");

  const closed = await pageAt(context, closedOrigin);
  const closedResult = await closed.evaluate(async () => {
    const original = indexedDB.open.bind(indexedDB);
    Object.defineProperty(indexedDB, "open", { configurable: true, value(...args) {
      const request = original(...args);
      request.addEventListener("success", () => { window.lastConnection = request.result; });
      return request;
    } });
    window.openScopedView("6".repeat(32));
    await window.view.setItem("key", "synthetic-persisted");
    window.lastConnection.close();
    let firstError;
    try { await window.view.getItem("key"); } catch (error) { firstError = error.name; }
    const reopenedValue = await window.view.getItem("key");
    window.lastConnection.close();
    window.lastConnection.dispatchEvent(new Event("close"));
    const eventReopenedValue = await window.view.getItem("key");
    await window.view.close();
    return { firstError, reopenedValue, eventReopenedValue };
  });
  assert.deepEqual(closedResult, { firstError: "InvalidStateError", reopenedValue: "synthetic-persisted", eventReopenedValue: "synthetic-persisted" });
  results.push("a closed connection is invalidated and a later operation can reopen it");

  const newerVersion = await pageAt(context, versionOrigin);
  const versionResult = await newerVersion.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("imtoken-fans-walletconnect-attempts", 2);
      request.onupgradeneeded = () => request.result.createObjectStore("attempts").put("preserve", "synthetic-key");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    window.openScopedView("9".repeat(32));
    let errorName;
    try { await window.view.getItem("any"); } catch (error) { errorName = error.name; }
    const existing = await new Promise((resolve, reject) => {
      const request = indexedDB.open("imtoken-fans-walletconnect-attempts", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("attempts", "readonly");
        const get = transaction.objectStore("attempts").get("synthetic-key");
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve({ version: database.version, value: get.result });
        transaction.oncomplete = () => database.close();
      };
    });
    return { errorName, existing };
  });
  assert.deepEqual(versionResult, { errorName: "VersionError", existing: { version: 2, value: "preserve" } });
  results.push("a newer database version fails without deleting its existing data");

  const versionScope = await reopened.evaluate(() => window.makeScope());
  await reopened.evaluate(async (scope) => {
    window.openScopedView(scope);
    await window.view.setItem("preserve-on-upgrade", "synthetic-upgrade-value");
  }, versionScope);
  const upgrader = await pageAt(context);
  const upgradedVersion = await upgrader.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Existing connections did not release for upgrade")), 3000);
    const request = indexedDB.open("imtoken-fans-walletconnect-attempts", 2);
    request.onupgradeneeded = () => request.result.createObjectStore("synthetic-other-store");
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); const database = request.result; resolve(database.version); database.close(); };
  }));
  assert.equal(upgradedVersion, 2);
  const postUpgrade = await reopened.evaluate(async (scope) => {
    let errorName;
    try { await window.view.getItem("preserve-on-upgrade"); } catch (error) { errorName = error.name; }
    const encoded = Array.from("preserve-on-upgrade", (character) => character.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    const key = `imtoken-fans:walletconnect-attempt:v1:${scope}:k${encoded}`;
    const value = await new Promise((resolve, reject) => {
      const request = indexedDB.open("imtoken-fans-walletconnect-attempts", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("attempts", "readonly");
        const get = transaction.objectStore("attempts").get(key);
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
        transaction.oncomplete = () => database.close();
      };
    });
    return { errorName, value };
  }, versionScope);
  assert.deepEqual(postUpgrade, { errorName: "VersionError", value: "synthetic-upgrade-value" });
  results.push("versionchange releases active connections and preserves existing data");

  await context.close();
  context = undefined;
  process.stdout.write(JSON.stringify({ status: "passed", browser: "isolated WebKit", checks: results }) + "\n");
} finally {
  if (context) await context.close();
  await rm(temp, { recursive: true, force: true });
}
