// Synthetic SDK resources; no wallet, service, real account or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
function load(file, imports = {}) {
  const target = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(file, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module: target, exports: target.exports, Promise, Error, Object, Array, Map, Set,
    Uint8Array, setTimeout, crypto: webcrypto, require: (id) => id in imports ? imports[id] : require(id) }, { filename: file });
  return target.exports;
}
const scoped = load("src/lib/walletconnect-scoped-storage.ts");
const ephemeral = load("src/lib/walletconnect-ephemeral-storage.ts");
const codec = load("src/lib/walletconnect-storage-codec.ts");
const coordinatorModule = load("src/lib/walletconnect-attempt-coordinator.ts");
const ownerModule = load("src/lib/walletconnect-attempt-owner.ts", {
  "@/lib/walletconnect-scoped-storage": scoped,
  "@/lib/walletconnect-ephemeral-storage": ephemeral,
  "@/lib/walletconnect-storage-codec": codec,
});
const { createWalletConnectAttemptOwner } = ownerModule;
const { createWalletConnectAttemptCoordinator } = coordinatorModule;
const sessionTopic = "a".repeat(64), selfKey = "b".repeat(64);
const pairingKey = "d".repeat(64);
const pairingTopic = createHash("sha256").update(Buffer.from(pairingKey, "hex")).digest("hex");
const pairingExpiry = Math.floor(Date.now() / 1000) + 300;
const uriFor = (topic = pairingTopic, key = pairingKey, expiry = pairingExpiry) => `wc:${topic}@2?expiryTimestamp=${expiry}&relay-protocol=irn&symKey=${key}`;
const uri = uriFor();
const reject = (promise, name) => assert.rejects(promise, { name });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls = [], keys = new Set(), expiry = new Set(), known = new Set();
  const state = { session: undefined, sessions: [], pairings: [], listener: undefined, uriCount: 0, authCount: 0, storage: undefined };
  const session = { topic: sessionTopic, self: { publicKey: selfKey }, pairingTopic };
  const core = {
    storage: undefined,
    customStoragePrefix: "",
    crypto: { keychain: { has: (key) => keys.has(key), get: (key) => keys.has(key) ? pairingKey : undefined } },
    expirer: { has: (key) => expiry.has(key) },
    heartbeat: { stop() { calls.push("heartbeat"); } },
    relayer: { subscriber: { isKnownTopic: async (key) => known.has(key) }, async transportClose() { calls.push("transport"); } },
  };
  const clearPairing = () => { state.pairings = []; keys.delete(pairingTopic); expiry.delete(pairingTopic); known.delete(pairingTopic); };
  const clearSession = () => { state.session = undefined; state.sessions = []; keys.delete(sessionTopic); keys.delete(selfKey); expiry.delete(sessionTopic); known.delete(sessionTopic); };
  const provider = {
    client: { core, session: { getAll: () => state.sessions }, pairing: { getAll: () => state.pairings } },
    get session() { return state.session; },
    on(event, listener) { assert.equal(event, "display_uri"); calls.push("on"); state.listener = listener; },
    removeListener(event, listener) { assert.equal(event, "display_uri"); assert.equal(listener, state.listener); calls.push("off"); state.listener = undefined; },
    async disconnect() { calls.push("disconnect"); clearSession(); },
    async cleanupPendingPairings(input) { assert.equal(input.deletePairings, true); calls.push("pairing"); clearPairing(); },
  };
  const setConnected = () => {
    state.session = session; state.sessions = [session];
    state.pairings = [{ topic: pairingTopic, expiry: pairingExpiry, relay: { protocol: "irn" }, active: false }];
    for (const key of [sessionTopic, selfKey, pairingTopic]) keys.add(key);
    for (const key of [sessionTopic, pairingTopic]) { expiry.add(key); known.add(key); }
  };
  const options = {
    createCore(storage, prefix) { calls.push("core"); state.storage = storage; core.storage = storage; core.customStoragePrefix = `:${prefix}`; return core; },
    async createProvider(value) { assert.equal(value, core); calls.push("provider"); return provider; },
    async connect(value) { assert.equal(value, provider); calls.push("connect"); setConnected(); state.listener(uri); return session; },
    onUri(value) { assert.equal(value, uri); state.uriCount++; },
    async onConnected(value, result, context) { assert.equal(value, provider); assert.equal(result, session); context.assertActive(); state.authCount++; return "synthetic result"; },
  };
  return { calls, keys, expiry, known, state, session, core, provider, options, setConnected, clearSession, clearPairing };
}
function begin(f) {
  const coordinator = createWalletConnectAttemptCoordinator();
  const owner = createWalletConnectAttemptOwner(f.options);
  const handle = coordinator.start({ create: () => owner });
  return { coordinator, owner, handle };
}
const busy = (coordinator) => assert.throws(() => coordinator.start({ create: () => ({ run: async () => {}, close: async () => {} }) }), { name: "WalletConnectAttemptBusy" });

test("owned session and pairing are checked before stopping the core and storage", async () => {
  const f = fixture();
  const { handle } = begin(f);
  assert.equal(await handle.result, "synthetic result");
  await handle.released;
  assert.deepEqual(f.calls, ["core", "provider", "on", "connect", "off", "disconnect", "pairing", "heartbeat", "transport"]);
  assert.equal(f.state.uriCount, 1);
  assert.equal(f.state.authCount, 1);
  await f.state.storage.setItem("late", "ignored");
  assert.equal(await f.state.storage.getItem("late"), undefined);
  assert.equal(f.keys.size, 0);
  assert.equal(f.expiry.size, 0);
  assert.equal(f.known.size, 0);
});

test("cancellation during init waits for the provider and skips connect", async () => {
  const f = fixture(), gate = deferred();
  f.options.createProvider = () => gate.promise;
  const { coordinator, handle } = begin(f);
  const failed = reject(handle.result, "WalletConnectAttemptCancelled");
  handle.cancel();
  busy(coordinator);
  gate.resolve(f.provider);
  await failed;
  await handle.released;
  assert.equal(f.calls.includes("connect"), false);
  assert.equal(f.calls.includes("heartbeat"), true);
  assert.equal(f.calls.includes("transport"), true);
});

test("late connection after cancellation is captured and cleaned without authentication", async () => {
  const f = fixture(), gate = deferred();
  f.options.connect = async () => { f.setConnected(); f.state.listener(uri); await gate.promise; return f.session; };
  const { coordinator, handle } = begin(f);
  await tick();
  const failed = reject(handle.result, "WalletConnectAttemptCancelled");
  handle.cancel();
  busy(coordinator);
  gate.resolve();
  await failed;
  await handle.released;
  assert.equal(f.state.authCount, 0);
  assert.equal(f.keys.size, 0);
  assert.equal(f.known.size, 0);
});

test("repeated run and concurrent close do not repeat SDK work", async () => {
  const f = fixture(), gate = deferred();
  f.options.connect = async () => { f.setConnected(); await gate.promise; return f.session; };
  const owner = createWalletConnectAttemptOwner(f.options);
  const context = { assertActive() {}, publish(callback) { callback(); return true; } };
  const result = owner.run(context);
  await tick();
  await reject(owner.run(context), "WalletConnectOwnerFailed");
  await reject(owner.close(), "WalletConnectOwnerCleanupFailed");
  gate.resolve();
  assert.equal(await result, "synthetic result");
  const first = owner.close(), second = owner.close();
  await Promise.all([first, second]);
  await owner.close();
  assert.equal(f.calls.filter((value) => value === "core").length, 1);
  assert.equal(f.calls.filter((value) => value === "disconnect").length, 1);
});

test("unknown Core after constructor failure blocks release and retires its storage", async () => {
  const f = fixture();
  f.options.createCore = (storage) => { f.state.storage = storage; throw new Error("synthetic constructor"); };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  busy(coordinator);
  await f.state.storage.setItem("late", "ignored");
  assert.equal(await f.state.storage.getItem("late"), undefined);
  await reject(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
});

test("provider init failure cleans known core but keeps unknown ownership blocked", async () => {
  const f = fixture();
  f.options.createProvider = async () => { throw new Error("synthetic init"); };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.deepEqual(f.calls, ["core", "heartbeat", "transport"]);
  busy(coordinator);
  await reject(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
});

test("a Core with wrong storage or prefix is never stopped", async () => {
  for (const kind of ["storage", "prefix"]) {
    const f = fixture();
    const original = f.options.createCore;
    f.options.createCore = (storage, prefix) => { const core = original(storage, prefix); if (kind === "storage") core.storage = {}; else core.customStoragePrefix = ":foreign"; return core; };
    const { coordinator, handle } = begin(f);
    await reject(handle.result, "WalletConnectAttemptCleanupFailed");
    assert.equal(f.calls.includes("heartbeat"), false);
    assert.equal(f.calls.includes("transport"), false);
    busy(coordinator);
  }
});

test("a provider attached to another Core is never modified", async () => {
  const f = fixture();
  const foreign = {};
  f.options.createProvider = async () => { f.provider.client.core = foreign; return f.provider; };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(f.calls.includes("on"), false);
  assert.equal(f.calls.includes("disconnect"), false);
  assert.equal(f.calls.includes("pairing"), false);
  assert.equal(f.calls.includes("heartbeat"), true);
  busy(coordinator);
});

test("a listener that throws after registration is removed by the owner", async () => {
  const f = fixture();
  const add = f.provider.on;
  f.provider.on = function(event, listener) { add.call(this, event, listener); throw new Error("synthetic listener"); };
  const { handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptFailed");
  await handle.released;
  assert.equal(f.calls.filter((value) => value === "off").length, 1);
  assert.equal(f.calls.includes("connect"), false);
});

test("invalid URI retires the attempt and keeps ownership blocked", async () => {
  const f = fixture();
  f.options.connect = async () => { f.setConnected(); f.state.listener("wc:invalid"); return f.session; };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(f.state.authCount, 0);
  assert.equal(f.state.uriCount, 0);
  busy(coordinator);
});

for (const [name, alter] of [
  ["duplicate key", () => ({ value: `${uri}&symKey=${pairingKey}` })],
  ["unknown parameter", () => ({ value: `${uri}&redirect=evil` })],
  ["encoded parameter", () => ({ value: uri.replace("symKey=", "sym%4Bey=") })],
  ["fragment", () => ({ value: `${uri}#fragment` })],
  ["trailing newline", () => ({ value: `${uri}\n` })],
  ["missing expiry", () => ({ value: `wc:${pairingTopic}@2?relay-protocol=irn&symKey=${pairingKey}` })],
  ["incorrect relay", () => ({ value: uri.replace("relay-protocol=irn", "relay-protocol=other") })],
  ["wrong key", () => ({ value: uriFor(pairingTopic, "e".repeat(64)) })],
  ["unowned topic", () => ({ value: uriFor("f".repeat(64)) })],
  ["topic unrelated to matching stored key", (f) => { f.state.pairings[0].topic = "f".repeat(64); f.core.crypto.keychain.get = () => pairingKey; return { value: uriFor("f".repeat(64)) }; }],
  ["expired", (f) => { const value = Math.floor(Date.now() / 1000) - 1; f.state.pairings[0].expiry = value; return { value: uriFor(pairingTopic, pairingKey, value) }; }],
  ["excessive lifetime", (f) => { const value = Math.floor(Date.now() / 1000) + 601; f.state.pairings[0].expiry = value; return { value: uriFor(pairingTopic, pairingKey, value) }; }],
  ["stored expiry mismatch", (f) => { f.state.pairings[0].expiry++; return {}; }],
  ["already active pairing", (f) => { f.state.pairings[0].active = true; return {}; }],
  ["unsupported methods", (f) => { f.state.pairings[0].methods = ["wc_sessionPropose"]; return {}; }],
  ["stored relay mismatch", (f) => { f.state.pairings[0].relay.protocol = "other"; return {}; }],
  ["unexpected relay data", (f) => { f.state.pairings[0].relay.data = "abcd"; return {}; }],
  ["missing stored key", (f) => { f.core.crypto.keychain.get = () => undefined; return {}; }],
  ["asynchronous stored key", (f) => { f.core.crypto.keychain.get = () => Promise.reject(new Error("synthetic key")); return {}; }],
  ["thrown asynchronous pairing read", (f) => { f.provider.client.pairing.getAll = () => { throw Promise.reject(new Error("synthetic thrown pairing")); }; return {}; }],
  ["asynchronous pairing fields", (f) => { f.state.pairings[0].expiry = Promise.reject(new Error("synthetic expiry")); f.state.pairings[0].relay = Promise.reject(new Error("synthetic relay")); return {}; }],
  ["duplicate stored pairing", (f) => { f.state.pairings.push({ ...f.state.pairings[0] }); return {}; }],
]) {
  test(`URI ${name} cannot reach the renderer`, async () => {
    const f = fixture();
    f.options.connect = async () => {
      f.setConnected();
      const result = alter(f);
      f.state.listener(result.value ?? uri);
      return f.session;
    };
    const { coordinator, handle } = begin(f);
    await reject(handle.result, "WalletConnectAttemptCleanupFailed");
    await tick();
    assert.equal(f.state.uriCount, 0);
    assert.equal(f.state.authCount, 0);
    busy(coordinator);
  });
}

test("cancellation while inspecting the stored URI key prevents renderer delivery", async () => {
  const f = fixture();
  let current = true;
  f.core.crypto.keychain.get = () => { current = false; return pairingKey; };
  const coordinator = createWalletConnectAttemptCoordinator();
  const handle = coordinator.start({ isCurrent: () => current, create: () => createWalletConnectAttemptOwner(f.options) });
  await reject(handle.result, "WalletConnectAttemptCancelled");
  await handle.released;
  assert.equal(f.state.uriCount, 0);
  assert.equal(f.state.authCount, 0);
});

test("cancellation during the final stored key lookup prevents renderer delivery", async () => {
  const f = fixture();
  let current = true, calls = 0;
  f.core.crypto.keychain.get = () => { if (++calls === 2) current = false; return pairingKey; };
  const coordinator = createWalletConnectAttemptCoordinator();
  const handle = coordinator.start({ isCurrent: () => current, create: () => createWalletConnectAttemptOwner(f.options) });
  await reject(handle.result, "WalletConnectAttemptCancelled");
  await handle.released;
  assert.equal(calls, 2);
  assert.equal(f.state.uriCount, 0);
  assert.equal(f.state.authCount, 0);
});

test("a lifecycle predicate throwing a rejected Promise is consumed and prevents URI delivery", async () => {
  const f = fixture();
  let inspected = false;
  f.core.crypto.keychain.get = () => { inspected = true; return pairingKey; };
  const coordinator = createWalletConnectAttemptCoordinator();
  const handle = coordinator.start({
    isCurrent: () => { if (inspected) throw Promise.reject(new Error("synthetic lifecycle")); return true; },
    create: () => createWalletConnectAttemptOwner(f.options),
  });
  await reject(handle.result, "WalletConnectAttemptCancelled");
  await handle.released;
  await tick();
  assert.equal(f.state.uriCount, 0);
  assert.equal(f.state.authCount, 0);
});

test("a renderer throwing a rejected Promise is consumed and prevents authentication", async () => {
  const f = fixture();
  f.options.onUri = () => { throw Promise.reject(new Error("synthetic renderer callback")); };
  const { handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCancelled");
  await handle.released;
  await tick();
  assert.equal(f.state.authCount, 0);
});

test("a renderer getter that cancels is read before SDK initialization", async () => {
  const f = fixture();
  let current = true, calls = 0;
  Object.defineProperty(f.options, "onUri", { get() { current = false; return () => { calls++; }; } });
  const coordinator = createWalletConnectAttemptCoordinator();
  const handle = coordinator.start({ isCurrent: () => current, create: () => createWalletConnectAttemptOwner(f.options) });
  await reject(handle.result, "WalletConnectAttemptCancelled");
  await handle.released;
  assert.equal(calls, 0);
  assert.equal(f.calls.includes("core"), false);
});

test("a rejecting renderer getter is consumed before SDK initialization", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "onUri", { get() { return Promise.reject(new Error("synthetic renderer")); } });
  const { handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptFailed");
  await handle.released;
  await tick();
  assert.equal(f.calls.includes("core"), false);
});

test("a renderer getter throwing a rejected Promise is consumed before SDK initialization", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "onUri", { get() { throw Promise.reject(new Error("synthetic thrown renderer")); } });
  const { handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptFailed");
  await handle.released;
  await tick();
  assert.equal(f.calls.includes("core"), false);
});

test("pairing activation during stored key lookup prevents renderer delivery", async () => {
  const f = fixture();
  f.core.crypto.keychain.get = () => { f.state.pairings[0].active = true; return pairingKey; };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(f.state.uriCount, 0);
  assert.equal(f.state.authCount, 0);
  busy(coordinator);
});

test("Core ownership drift during lifecycle check prevents renderer delivery", async () => {
  const f = fixture();
  let checkedStoredKey = false;
  f.core.crypto.keychain.get = () => { checkedStoredKey = true; return pairingKey; };
  const coordinator = createWalletConnectAttemptCoordinator();
  const handle = coordinator.start({
    isCurrent: () => { if (checkedStoredKey) f.provider.client.core = {}; return true; },
    create: () => createWalletConnectAttemptOwner(f.options),
  });
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(f.state.uriCount, 0);
  assert.equal(f.state.authCount, 0);
  busy(coordinator);
});

test("Core ownership drift during the final pairing lookup prevents renderer delivery", async () => {
  const f = fixture();
  const getAll = f.provider.client.pairing.getAll;
  let calls = 0;
  f.provider.client.pairing.getAll = () => { if (++calls === 4) f.provider.client.core = {}; return getAll(); };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(f.state.uriCount, 0);
  assert.equal(f.state.authCount, 0);
  busy(coordinator);
});

test("an asynchronous URI callback is consumed and prevents authentication", async () => {
  const f = fixture();
  f.options.onUri = () => Promise.reject(new Error("synthetic UI"));
  const { handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCancelled");
  await tick();
  assert.equal(f.state.authCount, 0);
});

test("pairing deletion still pending blocks until the same owner verifies it", async () => {
  const f = fixture();
  f.provider.cleanupPendingPairings = async () => { f.calls.push("pairing"); };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  busy(coordinator);
  assert.equal(f.calls.includes("heartbeat"), false);
  f.clearPairing();
  await handle.retryCleanup();
  assert.equal(f.calls.filter((value) => value === "disconnect").length, 1);
  assert.equal(f.calls.filter((value) => value === "pairing").length, 1);
});

for (const [name, retain, clear] of [
  ["session key", (f) => f.keys.add(sessionTopic), (f) => f.keys.delete(sessionTopic)],
  ["self key", (f) => f.keys.add(selfKey), (f) => f.keys.delete(selfKey)],
  ["session expiry", (f) => f.expiry.add(sessionTopic), (f) => f.expiry.delete(sessionTopic)],
  ["session subscription", (f) => f.known.add(sessionTopic), (f) => f.known.delete(sessionTopic)],
  ["pairing key", (f) => f.keys.add(pairingTopic), (f) => f.keys.delete(pairingTopic)],
  ["pairing expiry", (f) => f.expiry.add(pairingTopic), (f) => f.expiry.delete(pairingTopic)],
  ["pairing subscription", (f) => f.known.add(pairingTopic), (f) => f.known.delete(pairingTopic)],
]) {
  test(`remaining ${name} prevents release`, async () => {
    const f = fixture();
    const cleanup = f.provider.cleanupPendingPairings;
    f.provider.cleanupPendingPairings = async (input) => { await cleanup(input); retain(f); };
    const { coordinator, handle } = begin(f);
    await reject(handle.result, "WalletConnectAttemptCleanupFailed");
    busy(coordinator);
    clear(f);
    await handle.retryCleanup();
    assert.equal(f.calls.filter((value) => value === "disconnect").length, 1);
  });
}

test("disconnect rejection after deleting a session stays ambiguous", async () => {
  const f = fixture();
  f.provider.disconnect = async () => { f.calls.push("disconnect"); f.clearSession(); throw new Error("after deletion"); };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  f.clearPairing();
  await reject(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
  assert.equal(f.calls.filter((value) => value === "disconnect").length, 1);
  busy(coordinator);
});

test("disconnect rejection with the same session can be retried", async () => {
  const f = fixture();
  let attempts = 0;
  const disconnect = f.provider.disconnect;
  f.provider.disconnect = async () => { if (++attempts === 1) throw new Error("before deletion"); await disconnect(); };
  const { handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  await handle.retryCleanup();
  assert.equal(attempts, 2);
});

test("an extra session blocks cleanup instead of touching another session", async () => {
  const f = fixture();
  f.options.onConnected = async () => { f.state.sessions.push({ topic: "other", self: { publicKey: "other" }, pairingTopic: "other" }); return "value"; };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(f.calls.includes("disconnect"), false);
  busy(coordinator);
});

test("transport failure retries after another heartbeat stop, without another disconnect", async () => {
  const f = fixture();
  let attempts = 0;
  f.core.relayer.transportClose = async () => { f.calls.push("transport"); if (++attempts === 1) throw new Error("synthetic transport"); };
  const { handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  await handle.retryCleanup();
  assert.equal(f.calls.filter((value) => value === "disconnect").length, 1);
  assert.equal(f.calls.filter((value) => value === "heartbeat").length, 2);
  assert.equal(f.calls.filter((value) => value === "transport").length, 2);
});

for (const [stage, behavior] of [["connect", "throw"], ["connect", "non-promise"], ["onConnected", "throw"], ["onConnected", "non-promise"]]) {
  test(`${stage} ${behavior} after starting hidden work never releases ownership`, async () => {
    const f = fixture(), gate = deferred();
    let hiddenDone = false;
    f.options[stage] = () => {
      gate.promise.then(() => { hiddenDone = true; f.setConnected(); });
      if (behavior === "throw") throw new Error("synthetic hidden work");
      return undefined;
    };
    const { coordinator, handle } = begin(f);
    await reject(handle.result, "WalletConnectAttemptCleanupFailed");
    assert.equal(hiddenDone, false);
    assert.equal(f.calls.includes("disconnect"), false);
    busy(coordinator);
    gate.resolve();
    await tick();
    assert.equal(hiddenDone, true);
    await reject(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
    busy(coordinator);
  });
}

for (const stage of ["disconnect", "pairing", "transport"]) {
  test(`${stage} returning no Promise after starting hidden work stays blocked`, async () => {
    const f = fixture(), gate = deferred();
    let calls = 0;
    const operation = () => { calls++; gate.promise.then(() => {}); return undefined; };
    if (stage === "disconnect") f.provider.disconnect = operation;
    if (stage === "pairing") f.provider.cleanupPendingPairings = operation;
    if (stage === "transport") f.core.relayer.transportClose = operation;
    const { coordinator, handle } = begin(f);
    await reject(handle.result, "WalletConnectAttemptCleanupFailed");
    busy(coordinator);
    await reject(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
    assert.equal(calls, 1);
    gate.resolve();
    await tick();
    busy(coordinator);
  });
}

for (const stage of ["connect", "onConnected", "disconnect", "pairing", "transport"]) {
  test(`${stage} throwing a rejected Promise is consumed and retains ownership`, async () => {
    const f = fixture();
    const fail = () => { throw Promise.reject(new Error("synthetic thrown SDK work")); };
    if (stage === "connect" || stage === "onConnected") f.options[stage] = fail;
    if (stage === "disconnect") f.provider.disconnect = fail;
    if (stage === "pairing") f.provider.cleanupPendingPairings = fail;
    if (stage === "transport") f.core.relayer.transportClose = fail;
    const { coordinator, handle } = begin(f);
    await reject(handle.result, "WalletConnectAttemptCleanupFailed");
    await tick();
    busy(coordinator);
  });
}

test("Core ownership drift while transport closes cannot deliver success", async () => {
  const f = fixture(), gate = deferred(), started = deferred();
  f.core.relayer.transportClose = () => { started.resolve(); return gate.promise; };
  const { coordinator, handle } = begin(f);
  await started.promise;
  const failed = reject(handle.result, "WalletConnectAttemptCleanupFailed");
  f.core.storage = {};
  gate.resolve();
  await failed;
  busy(coordinator);
  await reject(handle.retryCleanup(), "WalletConnectAttemptCleanupFailed");
});

test("too many distinct URI topics retire the attempt and retain ownership", async () => {
  const f = fixture();
  f.options.onUri = () => {};
  f.options.connect = async () => {
    f.setConnected();
    for (let index = 0; index <= 256; index++) {
      const key = index.toString(16).padStart(64, "0");
      const topic = createHash("sha256").update(Buffer.from(key, "hex")).digest("hex");
      f.state.pairings = [{ topic, expiry: pairingExpiry, relay: { protocol: "irn" }, active: false }];
      f.keys.add(topic);
      f.core.crypto.keychain.get = () => key;
      f.state.listener(uriFor(topic, key));
    }
    return f.session;
  };
  const { coordinator, handle } = begin(f);
  await reject(handle.result, "WalletConnectAttemptCleanupFailed");
  assert.equal(f.state.authCount, 0);
  busy(coordinator);
});
