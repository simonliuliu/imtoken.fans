// Exercise the real lock module with isolated synthetic tabs and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../../src/lib/wallet-sign-in-lock.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const messages = { inProgress: "sign-in in progress", unavailable: "coordination unavailable" };
function load(navigator) {
  const target = { exports: {} };
  const context = { module: target, exports: target.exports };
  if (navigator !== undefined) context.navigator = navigator;
  vm.runInNewContext(source, context);
  return target.exports.withWalletSignInLock;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function sharedLocks() {
  let held = false;
  const calls = [];
  return {
    calls,
    async request(name, options, callback) {
      calls.push({ name, mode: options.mode, ifAvailable: options.ifAvailable });
      if (held) return callback(null);
      held = true;
      try { return await callback({ name }); }
      finally { held = false; }
    },
  };
}

test("fallback prevents overlapping attempts within a tab and permits retry", async () => {
  const run = load();
  const hold = deferred();
  let started = 0;
  const first = run(messages, async () => { started += 1; return await hold.promise; });
  await assert.rejects(run(messages, async () => { started += 1; }), /sign-in in progress/);
  assert.equal(started, 1);
  hold.resolve("completed");
  assert.equal(await first, "completed");
  assert.equal(await run(messages, async () => "retry"), "retry");
});

test("shared Web Locks exclude a different tab until the first completes", async () => {
  const locks = sharedLocks();
  const firstTab = load({ locks });
  const secondTab = load({ locks });
  const hold = deferred();
  let secondRan = false;
  const first = firstTab(messages, async () => await hold.promise);
  await assert.rejects(secondTab(messages, async () => { secondRan = true; }), /sign-in in progress/);
  assert.equal(secondRan, false);
  assert.equal(locks.calls[0].mode, "exclusive");
  assert.equal(locks.calls[0].ifAvailable, true);
  assert.equal(locks.calls[0].name, locks.calls[1].name);
  hold.resolve("completed");
  assert.equal(await first, "completed");
  assert.equal(await secondTab(messages, async () => "retry"), "retry");
});

test("an operation error releases both local and shared locks", async () => {
  const locks = sharedLocks();
  const run = load({ locks });
  await assert.rejects(run(messages, async () => { throw new Error("synthetic wallet failure"); }), /synthetic wallet failure/);
  assert.equal(await run(messages, async () => "retry"), "retry");
});

test("a failing Web Locks getter fails closed and resets the local guard", async () => {
  const navigator = { get locks() { throw new Error("private browser failure"); } };
  const run = load(navigator);
  let started = false;
  await assert.rejects(run(messages, async () => { started = true; }), /coordination unavailable/);
  await assert.rejects(run(messages, async () => { started = true; }), /coordination unavailable/);
  assert.equal(started, false);
});

test("a failing request getter fails closed without exposing the browser error", async () => {
  const locks = { get request() { throw new Error("private browser failure"); } };
  const run = load({ locks });
  let started = false;
  await assert.rejects(run(messages, async () => { started = true; }), /coordination unavailable/);
  assert.equal(started, false);
});

test("a Web Locks request failure before callback fails closed and permits retry", async () => {
  let shouldFail = true;
  const locks = { async request(_name, _options, callback) {
    if (shouldFail) throw new Error("private browser failure");
    return callback({ name: "synthetic" });
  } };
  const run = load({ locks });
  let started = false;
  await assert.rejects(run(messages, async () => { started = true; }), /coordination unavailable/);
  assert.equal(started, false);
  shouldFail = false;
  assert.equal(await run(messages, async () => "retry"), "retry");
});

test("a lock manager that never invokes the callback fails closed", async () => {
  const run = load({ locks: { request: async () => undefined } });
  let started = false;
  await assert.rejects(run(messages, async () => { started = true; }), /coordination unavailable/);
  assert.equal(started, false);
});
