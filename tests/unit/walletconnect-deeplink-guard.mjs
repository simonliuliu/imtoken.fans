// Real guard and session authorization with synthetic sessions and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
function load(file, imports = {}) {
  const target = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(file, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module: target, exports: target.exports, Promise, Object, JSON, Array,
    require: (id) => id in imports ? imports[id] : require(id) }, { filename: file });
  return target.exports;
}
const session = load("src/lib/walletconnect-session.ts");
const { withWalletConnectDeepLinkDisabled } = load("src/lib/walletconnect-deeplink-guard.ts", { "@/lib/walletconnect-session": session });
const address = "0x1111111111111111111111111111111111111111";
const topic = "synthetic-topic";
const error = (value) => value?.name === "WalletConnectDeepLinkGuardError" && value.message === "";
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeSession() {
  return { topic, expiry: Math.floor(Date.now() / 1000) + 3600, controller: "synthetic-peer",
    self: { publicKey: "synthetic-self" }, peer: { publicKey: "synthetic-peer" },
    namespaces: { eip155: { chains: ["eip155:1"], accounts: [`eip155:1:${address}`], methods: ["personal_sign"] } },
    sessionConfig: { anotherFlag: "preserve" } };
}
function fixture() {
  let stored = makeSession();
  let providerSession = stored;
  let active = true;
  let updates = 0;
  let signs = 0;
  const provider = {};
  const client = {};
  const store = {
    get(key) { assert.equal(key, topic); return stored; },
    async update(key, patch) { assert.equal(key, topic); updates++; stored = { ...stored, ...patch }; },
  };
  let binding = { provider, client, store, chainId: 1, account: address };
  const options = { topic, address, challenge: "synthetic-challenge", isCurrent: () => active,
    getBinding: () => ({ ...binding, providerSession }) };
  const sign = async (request) => { assert.equal(request.method, "personal_sign"); assert.equal(request.params[0], "synthetic-challenge"); assert.equal(request.params[1], address); signs++; return "synthetic-signature"; };
  return { options, store, sign, get stored() { return stored; }, set stored(value) { stored = value; },
    get providerSession() { return providerSession; }, set providerSession(value) { providerSession = value; },
    set active(value) { active = value; }, set binding(value) { binding = value; }, get binding() { return binding; },
    get updates() { return updates; }, get signs() { return signs; } };
}

test("prepares the authoritative store and preserves provider view and config", async () => {
  const f = fixture();
  const result = await withWalletConnectDeepLinkDisabled(f.options, async (request) => {
    assert.equal(f.stored.sessionConfig.disableDeepLink, true);
    assert.equal(f.stored.sessionConfig.anotherFlag, "preserve");
    assert.equal(f.providerSession.sessionConfig.disableDeepLink, undefined);
    return f.sign(request);
  });
  assert.equal(result, "synthetic-signature");
  assert.equal(f.updates, 1);
  assert.equal(f.signs, 1);
});

test("an already disabled session does not need a store write", async () => {
  const f = fixture();
  f.stored.sessionConfig.disableDeepLink = true;
  assert.equal(await withWalletConnectDeepLinkDisabled(f.options, f.sign), "synthetic-signature");
  assert.equal(f.updates, 0);
});

test("bounded nested JSON-shaped config survives the update", async () => {
  const f = fixture();
  f.stored.sessionConfig.extra = { nested: [true, "synthetic", null, 3] };
  assert.equal(await withWalletConnectDeepLinkDisabled(f.options, f.sign), "synthetic-signature");
  assert.deepEqual(f.stored.sessionConfig.extra, { nested: [true, "synthetic", null, 3] });
});

test("cyclic, excessive or accessor config fails before the update", async () => {
  const cyclic = {}; cyclic.self = cyclic;
  const accessor = {}; Object.defineProperty(accessor, "secret", { enumerable: true, get() { throw new Error("must not run"); } });
  for (const extra of [cyclic, Array.from({ length: 300 }, () => true), accessor, "x".repeat(32769)]) {
    const f = fixture();
    f.stored.sessionConfig.extra = extra;
    await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
    assert.equal(f.updates, 0);
    assert.equal(f.signs, 0);
  }
});

test("excessive or cyclic namespace data fails before the update", async () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const extra of [cyclic, Array.from({ length: 300 }, () => "synthetic")]) {
    const f = fixture();
    f.stored.namespaces.other = { extra };
    await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
    assert.equal(f.updates, 0);
    assert.equal(f.signs, 0);
  }
});

for (const [label, change] of [
  ["wrong topic", (f) => { f.stored = { ...f.stored, topic: "other" }; }],
  ["different provider identity", (f) => { f.providerSession = { ...f.providerSession, controller: "other" }; }],
  ["different provider namespace", (f) => { f.providerSession = { ...f.providerSession, namespaces: { eip155: { accounts: [`eip155:1:${address}`], methods: [] } } }; }],
  ["expired session", (f) => { f.stored = { ...f.stored, expiry: 1 }; }],
  ["malformed config", (f) => { f.stored = { ...f.stored, sessionConfig: null }; }],
  ["missing peer", (f) => { f.stored = { ...f.stored, peer: {} }; }],
  ["controller is not the wallet peer", (f) => { f.stored = { ...f.stored, controller: "other" }; }],
]) {
  test(`${label} fails before a store write or signature`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
    assert.equal(f.updates, 0);
    assert.equal(f.signs, 0);
  });
}

test("a rejected persist fails even if the SDK has already changed its map", async () => {
  const f = fixture();
  f.store.update = async (_key, patch) => { f.stored = { ...f.stored, ...patch }; throw new Error("synthetic-storage-error"); };
  await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
  assert.equal(f.stored.sessionConfig.disableDeepLink, true);
  assert.equal(f.signs, 0);
});

test("a non-Promise store update fails before signing", async () => {
  const f = fixture();
  f.store.update = (_key, patch) => { f.stored = { ...f.stored, ...patch }; };
  await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
  assert.equal(f.signs, 0);
});

test("retirement while reading the binding prevents the store update", async () => {
  const f = fixture();
  const getBinding = f.options.getBinding;
  f.options.getBinding = () => { f.active = false; return getBinding(); };
  await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
  assert.equal(f.updates, 0);
  assert.equal(f.signs, 0);
});

test("reentrant lifecycle or delayed mutation cannot replace the sign-in challenge", async () => {
  const first = fixture();
  first.options.isCurrent = () => { first.options.challenge = "different"; return true; };
  await assert.rejects(withWalletConnectDeepLinkDisabled(first.options, first.sign), error);
  assert.equal(first.updates, 0);
  assert.equal(first.signs, 0);
  const second = fixture();
  const gate = deferred();
  second.store.update = async (_key, patch) => { second.stored = { ...second.stored, ...patch }; await gate.promise; };
  const pending = withWalletConnectDeepLinkDisabled(second.options, second.sign);
  second.options.challenge = "different";
  gate.resolve();
  await assert.rejects(pending, error);
  assert.equal(second.signs, 0);
});

test("cancellation while writing prevents the signature and does not roll back the store", async () => {
  const f = fixture();
  const gate = deferred();
  f.store.update = async (_key, patch) => { f.stored = { ...f.stored, ...patch }; await gate.promise; };
  const pending = withWalletConnectDeepLinkDisabled(f.options, f.sign);
  f.active = false;
  gate.resolve();
  await assert.rejects(pending, error);
  assert.equal(f.stored.sessionConfig.disableDeepLink, true);
  assert.equal(f.signs, 0);
});

test("a session update during persistence is not overwritten and stops signing", async () => {
  const f = fixture();
  const gate = deferred();
  f.store.update = async (_key, patch) => { f.stored = { ...f.stored, ...patch }; await gate.promise; };
  const pending = withWalletConnectDeepLinkDisabled(f.options, f.sign);
  f.stored = { ...f.stored, namespaces: { eip155: { accounts: [`eip155:1:${address}`], methods: ["personal_sign", "eth_sendTransaction"] } } };
  gate.resolve();
  await assert.rejects(pending, error);
  assert.deepEqual(f.stored.namespaces.eip155.methods, ["personal_sign", "eth_sendTransaction"]);
  assert.equal(f.signs, 0);
});

test("a swapped client or store while preparing cannot sign", async () => {
  const f = fixture();
  const gate = deferred();
  f.store.update = async (_key, patch) => { f.stored = { ...f.stored, ...patch }; await gate.promise; };
  const pending = withWalletConnectDeepLinkDisabled(f.options, f.sign);
  f.binding = { ...f.binding, client: {} };
  gate.resolve();
  await assert.rejects(pending, error);
  assert.equal(f.signs, 0);
});

test("a provider chain or account change while preparing cannot sign", async () => {
  for (const changed of [{ chainId: 5 }, { account: "0x2222222222222222222222222222222222222222" }]) {
    const f = fixture();
    const gate = deferred();
    f.store.update = async (_key, patch) => { f.stored = { ...f.stored, ...patch }; await gate.promise; };
    const pending = withWalletConnectDeepLinkDisabled(f.options, f.sign);
    f.binding = { ...f.binding, ...changed };
    gate.resolve();
    await assert.rejects(pending, error);
    assert.equal(f.signs, 0);
  }
});

test("in-place mutation of nested unknown config is detected", async () => {
  const f = fixture();
  const nested = { child: { enabled: true } };
  f.stored.sessionConfig.extra = nested;
  const gate = deferred();
  f.store.update = async (_key, patch) => { f.stored = { ...f.stored, ...patch }; await gate.promise; };
  const pending = withWalletConnectDeepLinkDisabled(f.options, f.sign);
  nested.child.enabled = false;
  gate.resolve();
  await assert.rejects(pending, error);
  assert.equal(f.signs, 0);
});

test("rejected promises from synchronous SDK reads are consumed and fail closed", async () => {
  for (const change of [
    (f) => { f.options.getBinding = () => Promise.reject(new Error("synthetic-binding")); },
    (f) => { f.store.get = () => Promise.reject(new Error("synthetic-store-read")); },
    (f) => { f.providerSession = Promise.reject(new Error("synthetic-provider-read")); },
    (f) => { f.stored.sessionConfig.extra = Promise.reject(new Error("synthetic-config")); },
    ...["provider", "client", "store", "chainId", "account"].map((key) => (f) => {
      f.binding = { ...f.binding, [key]: Promise.reject(new Error("synthetic-binding-field")) };
    }),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.signs, 0);
  }
});

test("a deleted session while preparing is not recreated", async () => {
  const f = fixture();
  const gate = deferred();
  f.store.update = async (_key, patch) => { f.stored = { ...f.stored, ...patch }; await gate.promise; };
  const pending = withWalletConnectDeepLinkDisabled(f.options, f.sign);
  f.stored = undefined;
  gate.resolve();
  await assert.rejects(pending, error);
  assert.equal(f.stored, undefined);
  assert.equal(f.signs, 0);
});

test("losing the disabled flag or an unrelated config field prevents signing", async () => {
  for (const config of [{ disableDeepLink: false, anotherFlag: "preserve" }, { disableDeepLink: true }]) {
    const f = fixture();
    f.store.update = async () => { f.stored = { ...f.stored, sessionConfig: config }; };
    await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
    assert.equal(f.signs, 0);
  }
});

test("a stale attempt during signing discards the already requested result", async () => {
  const f = fixture();
  const gate = deferred();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = withWalletConnectDeepLinkDisabled(f.options, async (request) => { started(); await gate.promise; return f.sign(request); });
  await ready;
  f.active = false;
  gate.resolve();
  await assert.rejects(pending, error);
  assert.equal(f.signs, 1);
});

test("a changed session or lost flag after signing discards the result", async () => {
  for (const change of [
    (f) => { f.stored = { ...f.stored, sessionConfig: { anotherFlag: "preserve", disableDeepLink: false } }; },
    (f) => { f.stored = { ...f.stored, peer: { publicKey: "other" } }; },
    (f) => { f.binding = { ...f.binding, chainId: 2 }; },
    (f) => { f.binding = { ...f.binding, account: "0x2222222222222222222222222222222222222222" }; },
  ]) {
    const f = fixture();
    await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, async (request) => { change(f); return f.sign(request); }), error);
    assert.equal(f.signs, 1);
  }
});

test("invalid asynchronous lifecycle predicate and non-Promise callbacks fail closed", async () => {
  const f = fixture();
  f.options.isCurrent = () => Promise.reject(new Error("synthetic-rejection"));
  await assert.rejects(withWalletConnectDeepLinkDisabled(f.options, f.sign), error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.signs, 0);
  const g = fixture();
  await assert.rejects(withWalletConnectDeepLinkDisabled(g.options, () => "not-a-promise"), error);
});
