// Compare the real SDK browser backend with the candidate value codec using synthetic data.
// The browser profile, origin and values are isolated; no wallet or network service is used.
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
const packagePath = require.resolve("@walletconnect/keyvaluestorage/package.json");
const browserBackend = path.join(path.dirname(packagePath), "dist", "index.es.js");
const temp = await mkdtemp(path.join(os.tmpdir(), "imtoken-wc-value-compat-"));
const origin = "http://wallet-value-fixture.invalid";
let context;

async function bundleFixture() {
  const version = JSON.parse(await readFile(packagePath, "utf8")).version;
  assert.equal(version, "1.1.1");
  for (const [source, target] of [
    ["src/lib/walletconnect-scoped-storage.ts", "scoped.mjs"],
    ["src/lib/walletconnect-indexeddb-storage.ts", "indexeddb.mjs"],
    ["src/lib/walletconnect-storage-codec.ts", "codec.mjs"],
    ["src/lib/walletconnect-ephemeral-storage.ts", "ephemeral.mjs"],
  ]) {
    const input = await readFile(path.join(root, source), "utf8");
    await writeFile(path.join(temp, target), ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  await writeFile(path.join(temp, "fixture.mjs"), `
import { KeyValueStorage } from ${JSON.stringify(browserBackend)};
import { scopeWalletConnectStorage } from "./scoped.mjs";
import { createWalletConnectAttemptStorage } from "./indexeddb.mjs";
import { walletConnectValueStorage } from "./codec.mjs";
import { createWalletConnectEphemeralStorage } from "./ephemeral.mjs";
window.makeLegacy = () => new KeyValueStorage();
window.makeCandidate = (scopeId) => {
  const scoped = scopeWalletConnectStorage(createWalletConnectAttemptStorage(), scopeId);
  return { scoped, storage: walletConnectValueStorage(scoped) };
};
window.wrapScoped = walletConnectValueStorage;
window.makeMemory = () => {
  const scoped = createWalletConnectEphemeralStorage();
  return { scoped, storage: walletConnectValueStorage(scoped) };
};
`);
  const config = {
    mode: "production", target: "web", context: root, entry: path.join(temp, "fixture.mjs"),
    output: { path: temp, filename: "fixture-bundle.js" }, optimization: { minimize: false }, devtool: false,
    resolve: { modules: ["node_modules", path.join(root, "node_modules")] },
  };
  await new Promise((resolve, reject) => webpack(config, (error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    resolve();
  }));
  return readFile(path.join(temp, "fixture-bundle.js"));
}

try {
  const bundle = await bundleFixture();
  context = await webkit.launchPersistentContext(path.join(temp, "profile"), { headless: true });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === `${origin}/`) {
      await route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><script src="/fixture-bundle.js"></script></head><body>synthetic value fixture</body></html>' }); return;
    }
    if (url === `${origin}/fixture-bundle.js`) {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: bundle }); return;
    }
    await route.abort();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => typeof window.makeCandidate === "function");
  const result = await page.evaluate(async () => {
    const legacy = window.makeLegacy();
    const { scoped, storage: candidate } = window.makeCandidate("a".repeat(32));
    const { scoped: memoryScoped, storage: memory } = window.makeMemory();
    await scoped.setItem("numeric-string", { format: "synthetic-raw-v0" });
    function shape(value, seen = new WeakSet()) {
      if (value === undefined) return { type: "undefined" };
      if (value === null) return { type: "null" };
      if (typeof value === "number") return { type: "number", value: Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : String(value) };
      if (typeof value === "bigint") return { type: "bigint", value: String(value) };
      if (typeof value !== "object") return { type: typeof value, value: String(value) };
      if (seen.has(value)) return { type: "circular-reference" };
      seen.add(value);
      if (value instanceof Date) return { type: "Date", value: Number.isNaN(value.valueOf()) ? "invalid" : value.toISOString() };
      if (value instanceof Uint8Array) return { type: "Uint8Array", value: Array.from(value) };
      if (value instanceof Map) return { type: "Map", value: [...value].map(([key, item]) => [shape(key, seen), shape(item, seen)]) };
      if (value instanceof Set) return { type: "Set", value: [...value].map((item) => shape(item, seen)) };
      if (value instanceof RegExp) return { type: "RegExp", value: String(value) };
      if (Array.isArray(value)) return { type: "array", value: value.map((item) => shape(item, seen)) };
      return { type: "object", value: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, seen)])) };
    }
    const cases = [
      ["null", () => null], ["undefined", () => undefined], ["bigint", () => 123n],
      ["date", () => new Date("2026-01-02T03:04:05Z")], ["numeric-string", () => "123"],
      ["leading-zero-string", () => "001"], ["exponent-string", () => "1e3"], ["boolean-string", () => "true"],
      ["null-string", () => "null"], ["undefined-string", () => "undefined"], ["json-object-string", () => '{"example":1}'], ["quoted-string", () => '"hello"'],
      ["ordinary-string", () => "synthetic-text"], ["NaN", () => NaN], ["Infinity", () => Infinity],
      ["negative-zero", () => -0], ["typed-array", () => new Uint8Array([1, 2, 3])],
      ["map", () => new Map([["a", 1]])], ["set", () => new Set([1, 2])], ["regexp", () => /synthetic/i],
      ["function", () => () => {}], ["circular", () => { const value = { example: true }; value.self = value; return value; }],
      ["sdk-session-shape", () => [{ topic: "synthetic", expiry: 123456789, namespaces: { eip155: { accounts: ["synthetic"], methods: ["personal_sign"] } }, acknowledged: true }]],
      ["array-with-undefined", () => [undefined, "synthetic"]], ["nested-bigint", () => ({ amount: 987n })],
      ["malformed-json-string", () => '{"bad":}'], ["empty-string", () => ""],
      ["prototype-json-string", () => '{"__proto__":{"admin":true},"safe":1}'],
      ["throwing-toJSON", () => ({ toJSON() { throw new Error("synthetic-toJSON-error"); } })],
      ["symbol", () => Symbol("synthetic")], ["object-with-undefined", () => ({ missing: undefined, kept: true })],
    ];
    const comparisons = [];
    for (const [key, create] of cases) {
      const row = { key };
      for (const [label, backend] of [["legacy", legacy], ["candidate", candidate], ["memory", memory]]) {
        try { await backend.setItem(key, create()); row[label] = { ok: true, value: shape(await backend.getItem(key)) }; }
        catch (error) { row[label] = { ok: false, errorName: error.name }; }
      }
      row.same = JSON.stringify(row.legacy) === JSON.stringify(row.candidate) && JSON.stringify(row.legacy) === JSON.stringify(row.memory);
      comparisons.push(row);
    }
    const entriesShape = async (backend) => (await backend.getEntries()).map(([key, value]) => [key, shape(value)]).sort((a, b) => a[0].localeCompare(b[0]));
    const legacyEntries = await entriesShape(legacy);
    const candidateEntries = await entriesShape(candidate);
    const memoryEntries = await entriesShape(memory);
    const objectCopies = [];
    for (const backend of [legacy, candidate, memory]) {
      const original = { nested: { count: 1 } };
      await backend.setItem("object-copy", original);
      original.nested.count = 2;
      const firstRead = await backend.getItem("object-copy");
      firstRead.nested.count = 3;
      objectCopies.push((await backend.getItem("object-copy")).nested.count);
    }
    const rawPreserved = await scoped.getItem("numeric-string");
    await candidate.setItem("a/b", "slash");
    await candidate.setItem("a:b", "colon");
    await candidate.setItem("a\\b", "backslash");
    const distinctKeys = [await candidate.getItem("a/b"), await candidate.getItem("a:b"), await candidate.getItem("a\\b")];
    await candidate.removeItem("numeric-string");
    const rawAfterCodecRemove = await scoped.getItem("numeric-string");

    await legacy.setItem("deleted-during-entries", "synthetic-value");
    const indexed = legacy.storage.indexedDb;
    const originalGetKeys = indexed.getKeys.bind(indexed);
    indexed.getKeys = async () => {
      const keys = await originalGetKeys();
      await legacy.removeItem("deleted-during-entries");
      return keys;
    };
    const defaultDeletedEntry = (await legacy.getEntries()).find(([key]) => key === "deleted-during-entries");
    indexed.getKeys = originalGetKeys;
    const deletedView = {
      closed: false,
      async getKeys() { return ["imtoken-fans:walletconnect-value:v1:deleted-during-entries"]; },
      async getEntries() { return []; }, async getItem() { return undefined; }, async setItem() {}, async removeItem() {}, async close() {},
    };
    const candidateDeletedEntry = (await window.wrapScoped(deletedView).getEntries())[0];
    const unhandled = [];
    window.addEventListener("unhandledrejection", (event) => { unhandled.push(event.reason?.name || "Error"); event.preventDefault(); });
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { started = resolve; });
    let writes = 0;
    const fake = {
      closed: false,
      async getKeys() { return ["imtoken-fans:walletconnect-value:v1:synthetic-key"]; },
      async getEntries() { throw new Error("must not use unfiltered backend entries"); },
      async getItem() { started(); await gate; return '"synthetic-value"'; },
      async setItem() { writes += 1; },
      async removeItem() {},
      async close() { this.closed = true; },
    };
    const guarded = window.wrapScoped(fake);
    const pendingEntries = guarded.getEntries();
    await ready;
    await fake.close();
    release();
    const retiredEntries = await pendingEntries;
    const circular = {}; circular.self = circular;
    await guarded.setItem("late", circular);
    const reentrant = { closed: false, async getKeys() { return []; }, async getEntries() { return []; }, async getItem() {}, async setItem() { writes += 1; }, async removeItem() {}, async close() { this.closed = true; } };
    const reentrantCodec = window.wrapScoped(reentrant);
    await reentrantCodec.setItem("late", { toJSON() { reentrant.closed = true; return "synthetic"; } });
    const retiredThrow = { ...reentrant, closed: false };
    await window.wrapScoped(retiredThrow).setItem("late", { toJSON() { retiredThrow.closed = true; throw new Error("synthetic-retired-error"); } });
    const activeThrow = { ...reentrant, closed: false };
    let activeError;
    try { await window.wrapScoped(activeThrow).setItem("active", { toJSON() { throw new Error("synthetic-active-error"); } }); }
    catch (error) { activeError = error.message; }
    const failingBackend = { ...reentrant, closed: false, async setItem() { throw new Error("synthetic-backend-error"); } };
    let backendError;
    try { await window.wrapScoped(failingBackend).setItem("active", "synthetic"); }
    catch (error) { backendError = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 30));
    await scoped.close();
    await memoryScoped.close();
    return { comparisons, legacyEntries, candidateEntries, memoryEntries, objectCopies, rawPreserved, rawAfterCodecRemove, distinctKeys, defaultDeletedEntry: shape(defaultDeletedEntry), candidateDeletedEntry: shape(candidateDeletedEntry), retiredEntries, activeError, backendError, writes, unhandled };
  });
  const different = result.comparisons.filter((item) => !item.same);
  assert.deepEqual(different, [], `Value behavior differs for: ${different.map((item) => item.key).join(", ")}`);
  assert.deepEqual(result.candidateEntries, result.legacyEntries);
  assert.deepEqual(result.memoryEntries, result.legacyEntries);
  assert.deepEqual(result.objectCopies, [1, 1, 1]);
  assert.deepEqual(result.rawPreserved, { format: "synthetic-raw-v0" });
  assert.deepEqual(result.rawAfterCodecRemove, { format: "synthetic-raw-v0" });
  assert.deepEqual(result.distinctKeys, ["slash", "colon", "backslash"]);
  assert.deepEqual(result.candidateDeletedEntry, result.defaultDeletedEntry);
  assert.deepEqual(result.retiredEntries, []);
  assert.equal(result.activeError, "synthetic-active-error");
  assert.equal(result.backendError, "synthetic-backend-error");
  assert.equal(result.writes, 0);
  assert.deepEqual(result.unhandled, []);
  assert.deepEqual(pageErrors, []);
  await context.close();
  context = undefined;
  process.stdout.write(JSON.stringify({ status: "passed", backend: "@walletconnect/keyvaluestorage@1.1.1", browser: "isolated WebKit", valueCases: result.comparisons.length, entries: result.legacyEntries.length, checks: ["persistent and memory codec set/get comparison", "getEntries value comparison", "object mutation isolation", "concurrent deletion", "raw-format isolation", "distinct logical keys", "retired enumeration", "retired cyclic value", "reentrant retirement"] }) + "\n");
} finally {
  if (context) await context.close();
  await rm(temp, { recursive: true, force: true });
}
