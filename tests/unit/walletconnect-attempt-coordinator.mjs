// Exercise the real lifecycle barrier with synthetic owners and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../../src/lib/walletconnect-attempt-coordinator.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { exports: {} };
vm.runInNewContext(compiled, { module: target, exports: target.exports, Promise, Error }, { filename: "walletconnect-attempt-coordinator.ts" });
const { createWalletConnectAttemptCoordinator } = target.exports;
const lockSource = readFileSync(new URL("../../src/lib/wallet-sign-in-lock.ts", import.meta.url), "utf8");
const lockCompiled = ts.transpileModule(lockSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const lockTarget = { exports: {} };
vm.runInNewContext(lockCompiled, { module: lockTarget, exports: lockTarget.exports, Promise, Error }, { filename: "wallet-sign-in-lock.ts" });
const { withWalletSignInLock } = lockTarget.exports;
const rejected = (promise, name) => assert.rejects(promise, { name });
const busy = (coordinator) => assert.throws(() => coordinator.start({ create: () => owner() }), { name: "WalletConnectAttemptBusy" });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function owner(run = async () => "value", close = async () => {}) { return { run, close }; }

test("a successful result waits for owned cleanup and holds the slot", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const gate = deferred();
  let context;
  const handle = coordinator.start({ create: () => owner(async (value) => { context = value; return "signed"; }, () => gate.promise) });
  await tick();
  assert.equal(handle.state, "cleaning");
  assert.equal(context.publish(() => { throw new Error("must not publish during cleanup"); }), false);
  assert.throws(() => context.assertActive(), { name: "WalletConnectAttemptCancelled" });
  busy(coordinator);
  let settled = false;
  handle.result.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  gate.resolve();
  assert.equal(await handle.result, "signed");
  await handle.released;
  assert.equal(handle.state, "finished");
  assert.equal(context.publish(() => { throw new Error("stale"); }), false);
  assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
});

test("cancelled in-flight work keeps the slot and cannot publish or return a late result", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const work = deferred();
  const cleanup = deferred();
  let context, calls = 0, closes = 0;
  const handle = coordinator.start({ create: () => owner((value) => { context = value; return work.promise; }, () => { closes++; return cleanup.promise; }) });
  assert.equal(context.publish(() => { calls++; }), true);
  assert.equal(handle.cancel(), true);
  assert.equal(handle.cancel(), false);
  assert.equal(context.publish(() => { calls++; }), false);
  busy(coordinator);
  const failed = rejected(handle.result, "WalletConnectAttemptCancelled");
  work.resolve("late signature");
  await tick();
  assert.equal(closes, 1);
  assert.equal(handle.state, "cleaning");
  busy(coordinator);
  cleanup.resolve();
  await failed;
  assert.equal(calls, 1);
  const newer = coordinator.start({ create: () => owner() });
  assert.equal(handle.cancel(), false);
  assert.equal(context.publish(() => { calls++; }), false);
  assert.equal(await newer.result, "value");
});

test("an already aborted signal prevents factory work and releases the slot", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const controller = new AbortController(); controller.abort();
  let factories = 0;
  const handle = coordinator.start({ signal: controller.signal, create() { factories++; return owner(); } });
  await rejected(handle.result, "WalletConnectAttemptCancelled");
  assert.equal(factories, 0);
  assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
});

test("aborting during cleanup suppresses an otherwise successful result", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const controller = new AbortController();
  const cleanup = deferred();
  const handle = coordinator.start({ signal: controller.signal, create: () => owner(async () => "signed", () => cleanup.promise) });
  await tick();
  const failed = rejected(handle.result, "WalletConnectAttemptCancelled");
  controller.abort();
  cleanup.resolve();
  await failed;
});

test("the current callback cannot start another attempt and synchronous cancellation wins", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const work = deferred();
  let context;
  const handle = coordinator.start({ create: () => owner((value) => { context = value; return work.promise; }) });
  assert.equal(context.publish(() => { busy(coordinator); handle.cancel(); }), false);
  const failed = rejected(handle.result, "WalletConnectAttemptCancelled");
  work.resolve("ignored");
  await failed;
});

for (const [label, callback] of [
  ["throwing", () => { throw new Error("private SDK detail"); }],
  ["asynchronous", () => Promise.reject(new Error("private SDK detail"))],
]) {
  test(`${label} UI callback retires the attempt without leaking its error`, async () => {
    const coordinator = createWalletConnectAttemptCoordinator();
    const work = deferred();
    let context;
    const handle = coordinator.start({ create: () => owner((value) => { context = value; return work.promise; }) });
    assert.equal(context.publish(callback), false);
    const failed = rejected(handle.result, "WalletConnectAttemptCancelled");
    work.resolve("ignored");
    await failed;
    await tick();
  });
}

test("an asynchronous current predicate is rejected and its rejection consumed", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  let called = false;
  const handle = coordinator.start({ isCurrent: () => Promise.reject(new Error("private")), create() { called = true; return owner(); } });
  await rejected(handle.result, "WalletConnectAttemptCancelled");
  await tick();
  assert.equal(called, false);
});

test("multiple rejected asynchronous options are all consumed", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  assert.throws(() => coordinator.start({
    signal: Promise.reject(new Error("synthetic signal")),
    isCurrent: Promise.reject(new Error("synthetic current")),
    create: Promise.reject(new Error("synthetic factory")),
  }), { name: "WalletConnectAttemptFailed" });
  await tick();
  assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
});

test("accessed rejected options are consumed even if a later getter throws", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  assert.throws(() => coordinator.start({
    signal: Promise.reject(new Error("synthetic signal")),
    isCurrent: Promise.reject(new Error("synthetic current")),
    get create() { throw new Error("synthetic getter"); },
  }), { name: "WalletConnectAttemptFailed" });
  await tick();
  assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
});

test("a rejected asynchronous aborted property is consumed and prevents work", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  let factories = 0;
  const handle = coordinator.start({
    signal: { get aborted() { return Promise.reject(new Error("synthetic aborted")); } },
    create() { factories++; return owner(); },
  });
  await rejected(handle.result, "WalletConnectAttemptCancelled");
  await tick();
  assert.equal(factories, 0);
});

test("synchronous abort inside the current predicate is detected", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const controller = new AbortController();
  let called = false;
  const handle = coordinator.start({ signal: controller.signal, isCurrent: () => { controller.abort(); return true; }, create() { called = true; return owner(); } });
  await rejected(handle.result, "WalletConnectAttemptCancelled");
  assert.equal(called, false);
});

for (const [label, operation] of [
  ["rejected", async () => { throw new Error("private SDK detail"); }],
  ["undefined rejection", async () => { throw undefined; }],
  ["hostile rejection", async () => { throw new Proxy({}, { getPrototypeOf() { throw new Error("private"); } }); }],
  ["non-promise", () => "not asynchronous"],
]) {
  test(`${label} work fails closed after cleanup`, async () => {
    const coordinator = createWalletConnectAttemptCoordinator();
    let closes = 0;
    const handle = coordinator.start({ create: () => owner(operation, async () => { closes++; }) });
    await rejected(handle.result, "WalletConnectAttemptFailed");
    assert.equal(closes, 1);
    assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
  });
}

test("cleanup failure blocks new work until a single retry succeeds", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const retryGate = deferred();
  let closes = 0, context;
  const handle = coordinator.start({ create: () => owner(async (value) => { context = value; return "not delivered"; }, () => {
    closes++;
    return closes === 1 ? Promise.reject(new Error("private cleanup")) : retryGate.promise;
  }) });
  await rejected(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(context.publish(() => { throw new Error("must not publish after failure"); }), false);
  assert.throws(() => context.assertActive(), { name: "WalletConnectAttemptCancelled" });
  let released = false;
  handle.released.then(() => { released = true; });
  await tick();
  assert.equal(released, false);
  assert.equal(handle.state, "cleanup-failed");
  busy(coordinator);
  const retry = handle.retryCleanup();
  await rejected(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
  busy(coordinator);
  retryGate.resolve();
  await retry;
  await handle.released;
  assert.equal(closes, 2);
  assert.equal(handle.state, "finished");
  await rejected(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
  assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
});

test("the shared wallet lock stays held across failed cleanup when awaiting the release barrier", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const messages = { inProgress: "busy", unavailable: "unavailable" };
  let closes = 0, handle;
  const first = withWalletSignInLock(messages, async () => {
    handle = coordinator.start({ create: () => owner(async () => "value", async () => { if (++closes === 1) throw new Error("private"); }) });
    try { return await handle.result; } finally { await handle.released; }
  });
  first.catch(() => {});
  for (let index = 0; index < 100 && (!handle || handle.state !== "cleanup-failed"); index++) await tick();
  assert.equal(handle?.state, "cleanup-failed");
  await assert.rejects(withWalletSignInLock(messages, async () => "must not run"), { message: "busy" });
  await handle.retryCleanup();
  await rejected(first, "WalletConnectAttemptCleanupFailed");
  assert.equal(await withWalletSignInLock(messages, async () => "released"), "released");
});

test("a failed retry continues to block the slot", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  let closes = 0;
  const handle = coordinator.start({ create: () => owner(async () => "value", async () => { closes++; if (closes < 3) throw new Error("no"); }) });
  await rejected(handle.result, "WalletConnectAttemptCleanupFailed");
  await rejected(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
  assert.equal(handle.state, "cleanup-failed");
  busy(coordinator);
  await handle.retryCleanup();
  assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
});

test("a non-promise cleanup does not release the slot", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  let closes = 0;
  const handle = coordinator.start({ create: () => owner(async () => "value", () => ++closes === 1 ? undefined : Promise.resolve()) });
  await rejected(handle.result, "WalletConnectAttemptCleanupFailed");
  busy(coordinator);
  await handle.retryCleanup();
});

for (const [label, factory] of [
  ["throwing factory", () => { throw new Error("private"); }],
  ["missing owner", () => null],
  ["missing close", () => ({ run: async () => "value" })],
  ["asynchronous factory", () => Promise.reject(new Error("private"))],
  ["asynchronous close getter", () => ({ run: async () => "value", close: Promise.reject(new Error("private")) })],
]) {
  test(`${label} leaves the coordinator blocked because ownership is unknown`, async () => {
    const coordinator = createWalletConnectAttemptCoordinator();
    const handle = coordinator.start({ create: factory });
    await rejected(handle.result, "WalletConnectAttemptOwnershipFailed");
    await tick();
    assert.equal(handle.state, "ownership-failed");
    busy(coordinator);
    await rejected(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
  });
}

test("a broken run getter is cleaned up when close ownership is known", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  let closes = 0;
  const handle = coordinator.start({ create: () => ({ get run() { throw new Error("private"); }, async close() { closes++; } }) });
  await rejected(handle.result, "WalletConnectAttemptFailed");
  assert.equal(closes, 1);
  assert.equal(await coordinator.start({ create: () => owner() }).result, "value");
});

test("an asynchronous run property is consumed and its known owner is cleaned up", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  let closes = 0;
  const handle = coordinator.start({ create: () => ({ run: Promise.reject(new Error("private")), async close() { closes++; } }) });
  await rejected(handle.result, "WalletConnectAttemptFailed");
  await tick();
  assert.equal(closes, 1);
});

test("an old handle cannot retry or cancel a newer attempt", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const first = coordinator.start({ create: () => owner() });
  await first.result;
  const work = deferred();
  let closes = 0;
  const second = coordinator.start({ create: () => owner(() => work.promise, async () => { closes++; }) });
  assert.equal(first.cancel(), false);
  await rejected(first.retryCleanup(), "WalletConnectAttemptCleanupFailed");
  assert.equal(closes, 0);
  work.resolve("new result");
  assert.equal(await second.result, "new result");
});

test("external retirement during pending work blocks its result", async () => {
  const coordinator = createWalletConnectAttemptCoordinator();
  const work = deferred();
  let current = true;
  const handle = coordinator.start({ isCurrent: () => current, create: () => owner(() => work.promise) });
  const failed = rejected(handle.result, "WalletConnectAttemptCancelled");
  current = false;
  work.resolve("ignored");
  await failed;
});

test("independent coordinator instances are explicitly not a global lock", async () => {
  const first = createWalletConnectAttemptCoordinator();
  const second = createWalletConnectAttemptCoordinator();
  const gate = deferred();
  const handle = first.start({ create: () => owner(() => gate.promise) });
  assert.equal(await second.start({ create: () => owner() }).result, "value");
  gate.resolve("done");
  assert.equal(await handle.result, "done");
});
