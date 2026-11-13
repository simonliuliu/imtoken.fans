// Exercise the real storage adapter without a browser, wallet or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../../src/lib/walletconnect-ephemeral-storage.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { exports: {} };
vm.runInNewContext(compiled, { module: target, exports: target.exports, Map, Promise });
const { createWalletConnectEphemeralStorage } = target.exports;

test("separate attempts cannot read or clear each other's keys", async () => {
  const first = createWalletConnectEphemeralStorage();
  const second = createWalletConnectEphemeralStorage();
  await first.setItem("session", "first");
  await second.setItem("session", "second");
  await first.close();
  assert.equal(await first.getItem("session"), undefined);
  assert.equal(await second.getItem("session"), "second");
});

test("special keys, null and undefined remain distinct while active", async () => {
  const store = createWalletConnectEphemeralStorage();
  const pairs = [["", null], ["a:b", undefined], ["a/b", 0], ["__proto__", false], ["😃", "ok"]];
  for (const [key, value] of pairs) await store.setItem(key, value);
  assert.deepEqual(Array.from(await store.getEntries(), (entry) => Array.from(entry)), pairs);
  assert.deepEqual(Array.from(await store.getKeys()), pairs.map(([key]) => key));
  assert.equal(await store.getItem(""), null);
  assert.equal(await store.getItem("a:b"), undefined);
  assert.equal(await store.getItem("missing"), undefined);
});

test("set and remove are visible to subsequent operations", async () => {
  const store = createWalletConnectEphemeralStorage();
  await store.setItem("key", 1);
  await store.setItem("key", 2);
  assert.equal(await store.getItem("key"), 2);
  await store.removeItem("key");
  assert.deepEqual(Array.from(await store.getKeys()), []);
});

test("returned key and entry arrays cannot mutate the map", async () => {
  const store = createWalletConnectEphemeralStorage();
  await store.setItem("key", "value");
  const keys = await store.getKeys();
  const rows = await store.getEntries();
  keys.length = 0;
  rows[0][0] = "changed";
  rows.length = 0;
  assert.equal(await store.getItem("key"), "value");
  assert.deepEqual(Array.from(await store.getKeys()), ["key"]);
});

test("stored objects deliberately keep reference semantics", async () => {
  const store = createWalletConnectEphemeralStorage();
  const value = { count: 1 };
  await store.setItem("key", value);
  value.count = 2;
  assert.equal((await store.getItem("key")).count, 2);
  (await store.getItem("key")).count = 3;
  assert.equal(value.count, 3);
});

test("close retires immediately and late operations cannot recreate entries", async () => {
  const store = createWalletConnectEphemeralStorage();
  await store.setItem("key", "value");
  const closing = store.close();
  assert.equal(store.closed, true);
  await store.setItem("new", "late");
  await store.removeItem("key");
  await closing;
  await store.close();
  assert.deepEqual(Array.from(await store.getKeys()), []);
  assert.deepEqual(Array.from(await store.getEntries()), []);
  assert.equal(await store.getItem("key"), undefined);
  assert.equal(await store.getItem("new"), undefined);
});

test("a result already returned before close cannot be revoked", async () => {
  const store = createWalletConnectEphemeralStorage();
  await store.setItem("key", "earlier");
  const earlier = store.getItem("key");
  await store.close();
  assert.equal(await earlier, "earlier");
  assert.equal(await store.getItem("key"), undefined);
});

test("a new instance does not restore a prior attempt", async () => {
  const first = createWalletConnectEphemeralStorage();
  await first.setItem("session", { topic: "synthetic" });
  const second = createWalletConnectEphemeralStorage();
  assert.equal(await second.getItem("session"), undefined);
  assert.equal(first.closed, false);
});
