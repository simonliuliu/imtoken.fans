// Exercise real wallet-client boundaries using synthetic providers and local promises.
// No wallet, account, credential, database, or network service is contacted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
const address = "0x1111111111111111111111111111111111111111";
const messages = {
  noInjectedWallet: "no injected wallet",
  noAddress: "no address",
  noAddressShort: "no address",
  walletConnectUnavailable: "not configured",
  walletConnectUnauthorized: "session not authorized",
  walletSignInInProgress: "sign-in in progress",
  walletSignInCoordinationUnavailable: "coordination unavailable",
  nonceFailed: "nonce failed",
  verifyFailed: "verification failed",
  metadataDescription: "synthetic metadata",
};

function loadModule(path, imports = {}, globals = {}) {
  const target = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module: target,
    exports: target.exports,
    require: (id) => id in imports ? imports[id] : require(id),
    ...globals,
  }, { filename: path });
  return target.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Synthetic operation did not reach the expected boundary");
}

function fixture(gates = {}, options = {}) {
  const calls = {
    init: 0, connect: 0, disconnect: 0, accounts: 0, sign: 0,
    nonce: 0, nonceJson: 0, verify: 0, verifyJson: 0, serverWrites: 0,
  };
  async function boundary(key) {
    calls[key] += 1;
    if (gates[key]) await gates[key].promise;
  }
  const provider = {
    chainId: 1,
    accounts: [address],
    session: {
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: { eip155: { accounts: [`eip155:1:${address}`], chains: ["eip155:1"], methods: ["personal_sign"] } },
    },
    async connect() { await boundary("connect"); },
    async disconnect() { await boundary("disconnect"); },
    async request({ method }) {
      assert.equal(method, "personal_sign");
      await boundary("sign");
      return "synthetic-signature";
    },
  };
  const globals = {
    process: { env: { NEXT_PUBLIC_REOWN_PROJECT_ID: "synthetic-project" } },
    document: { documentElement: { lang: "en" } },
    window: {
      location: { origin: "https://synthetic.invalid" },
      ethereum: {
        async request({ method }) {
          if (method === "eth_requestAccounts") {
            await boundary("accounts");
            return [address];
          }
          assert.equal(method, "personal_sign");
          await boundary("sign");
          return "synthetic-signature";
        },
      },
    },
    fetch: async (url) => {
      if (url.endsWith("/nonce")) {
        await boundary("nonce");
        return { ok: true, async json() { await boundary("nonceJson"); return { message: "synthetic-challenge" }; } };
      }
      if (url.endsWith("/verify")) {
        // This represents an already-dispatched server-side effect, not a real server.
        calls.serverWrites += 1;
        await boundary("verify");
        return { ok: true, async json() { await boundary("verifyJson"); return { ok: true }; } };
      }
      throw new Error("Unexpected network request");
    },
    ...(options.navigator ? { navigator: options.navigator } : {}),
  };
  const session = loadModule("src/lib/walletconnect-session.ts");
  const lock = loadModule("src/lib/wallet-sign-in-lock.ts", {}, globals);
  const client = loadModule("src/lib/wallet-client.ts", {
    "@/lib/walletconnect-session": session,
    "@/lib/wallet-sign-in-lock": lock,
    "@walletconnect/ethereum-provider": {
      EthereumProvider: { async init() { await boundary("init"); return provider; } },
    },
  }, globals);
  return { client, calls, provider };
}

const canceled = (error) => error?.name === "WalletSignInCancelled" && error.message === "";
function observe(promise) {
  // Attach immediately so a deliberate rejection is never unhandled while a gate is open.
  promise.catch(() => {});
  return promise;
}

for (const method of ["connectWalletAndSignIn", "connectWalletConnectAndSignIn"]) {
  test(`${method}: a pre-canceled attempt performs no wallet or HTTP work`, async () => {
    const instance = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(instance.client[method](messages, { signal: controller.signal }), canceled);
    assert.equal(instance.calls.init + instance.calls.accounts + instance.calls.nonce, 0);
  });
}

test("cancellation while obtaining the lock is checked inside the callback", async () => {
  const lockGate = deferred();
  let requested = false;
  const instance = fixture({}, { navigator: { locks: { async request(_name, _options, callback) {
    requested = true;
    await lockGate.promise;
    return callback({ name: "synthetic-lock" });
  } } } });
  const controller = new AbortController();
  const pending = observe(instance.client.connectWalletConnectAndSignIn(messages, { signal: controller.signal }));
  await waitUntil(() => requested);
  controller.abort();
  lockGate.resolve();
  await assert.rejects(pending, canceled);
  assert.equal(instance.calls.init + instance.calls.connect + instance.calls.nonce, 0);
});

test("late SDK initialization is disconnected without opening a session or fetching a nonce", async () => {
  const init = deferred();
  const instance = fixture({ init });
  const controller = new AbortController();
  const pending = observe(instance.client.connectWalletConnectAndSignIn(messages, { signal: controller.signal }));
  await waitUntil(() => instance.calls.init === 1);
  controller.abort();
  await assert.rejects(instance.client.connectWalletAndSignIn(messages), /sign-in in progress/);
  init.resolve();
  await assert.rejects(pending, canceled);
  assert.equal(instance.calls.connect, 0);
  assert.equal(instance.calls.nonce, 0);
  assert.equal(instance.calls.disconnect, 1);
});

test("a late connection is cleaned up before another wallet attempt can start", async () => {
  const connect = deferred();
  const disconnect = deferred();
  const instance = fixture({ connect, disconnect });
  const controller = new AbortController();
  const pending = observe(instance.client.connectWalletConnectAndSignIn(messages, { signal: controller.signal }));
  await waitUntil(() => instance.calls.connect === 1);
  controller.abort();
  connect.resolve();
  await waitUntil(() => instance.calls.disconnect === 1);
  await assert.rejects(instance.client.connectWalletAndSignIn(messages), /sign-in in progress/);
  assert.equal(instance.calls.nonce, 0);
  disconnect.resolve();
  await assert.rejects(pending, canceled);
  assert.equal((await instance.client.connectWalletAndSignIn(messages)).address, address);
});

for (const phase of ["nonce", "nonceJson", "sign"]) {
  test(`WalletConnect cancellation during ${phase} waits for the operation and prevents verify`, async () => {
    const gate = deferred();
    const instance = fixture({ [phase]: gate });
    const controller = new AbortController();
    const pending = observe(instance.client.connectWalletConnectAndSignIn(messages, { signal: controller.signal }));
    await waitUntil(() => instance.calls[phase] === 1);
    controller.abort();
    await assert.rejects(instance.client.connectWalletAndSignIn(messages), /sign-in in progress/);
    gate.resolve();
    await assert.rejects(pending, canceled);
    assert.equal(instance.calls.verify, 0);
    if (phase !== "sign") assert.equal(instance.calls.sign, 0);
    assert.equal(instance.calls.disconnect, 1);
  });
}

for (const phase of ["accounts", "sign"]) {
  test(`injected wallet cancellation during ${phase} prevents verify and keeps the lock`, async () => {
    const gate = deferred();
    const instance = fixture({ [phase]: gate });
    const controller = new AbortController();
    const pending = observe(instance.client.connectWalletAndSignIn(messages, { signal: controller.signal }));
    await waitUntil(() => instance.calls[phase] === 1);
    controller.abort();
    await assert.rejects(instance.client.connectWalletConnectAndSignIn(messages), /sign-in in progress/);
    gate.resolve();
    await assert.rejects(pending, canceled);
    assert.equal(instance.calls.verify, 0);
    if (phase === "accounts") assert.equal(instance.calls.nonce, 0);
  });
}

for (const phase of ["verify", "verifyJson", "disconnect"]) {
  test(`cancellation during ${phase} prevents success but cannot undo a dispatched server write`, async () => {
    const gate = deferred();
    const instance = fixture({ [phase]: gate });
    const controller = new AbortController();
    let navigations = 0;
    const attempt = { signal: controller.signal };
    const pending = observe(instance.client.connectWalletConnectAndSignIn(messages, attempt).then(() => {
      instance.client.assertWalletSignInActive(attempt);
      navigations += 1;
    }));
    await waitUntil(() => instance.calls[phase] === 1);
    controller.abort();
    await assert.rejects(instance.client.connectWalletAndSignIn(messages), /sign-in in progress/);
    gate.resolve();
    await assert.rejects(pending, canceled);
    assert.equal(instance.calls.serverWrites, 1);
    assert.equal(navigations, 0);
    assert.equal(instance.calls.disconnect, 1);
  });
}

test("inactive, malformed, asynchronous, or throwing lifecycle checks fail closed", async () => {
  const { client } = fixture();
  const invalid = [
    null, 0, { signal: null }, { signal: {} }, { isActive: null }, { isActive: false },
    { isActive: () => false }, { isActive: async () => true },
    { isActive: async () => { throw new Error("private async detail"); } },
    { isActive: () => { throw new Error("private detail"); } },
    { get signal() { throw new Error("private detail"); } },
    { get isActive() { throw new Error("private detail"); } },
  ];
  for (const attempt of invalid) assert.throws(() => client.assertWalletSignInActive(attempt), canceled);
  assert.doesNotThrow(() => client.assertWalletSignInActive());
  assert.doesNotThrow(() => client.assertWalletSignInActive({ isActive() { return this.ready === true; }, ready: true }));
  await new Promise((resolve) => setImmediate(resolve));
});

test("retiring an attempt while awaiting a signature prevents verification", async () => {
  const sign = deferred();
  const instance = fixture({ sign });
  let active = true;
  const pending = observe(instance.client.connectWalletConnectAndSignIn(messages, { isActive: () => active }));
  await waitUntil(() => instance.calls.sign === 1);
  active = false;
  sign.resolve();
  await assert.rejects(pending, canceled);
  assert.equal(instance.calls.verify, 0);
});

test("the signal is rechecked if the lifecycle callback aborts or replaces it", () => {
  const { client } = fixture();
  const controller = new AbortController();
  const aborting = { signal: controller.signal, isActive() { controller.abort(); return true; } };
  assert.throws(() => client.assertWalletSignInActive(aborting), canceled);
  const first = new AbortController();
  const second = new AbortController();
  const replacing = { signal: first.signal, isActive() { this.signal = second.signal; return true; } };
  assert.throws(() => client.assertWalletSignInActive(replacing), canceled);
});

test("an error arriving after cancellation is normalized and its details are not exposed", async () => {
  const sign = deferred();
  const instance = fixture({ sign });
  const controller = new AbortController();
  const pending = observe(instance.client.connectWalletAndSignIn(messages, { signal: controller.signal }));
  await waitUntil(() => instance.calls.sign === 1);
  controller.abort();
  sign.reject(new Error("synthetic sensitive detail"));
  await assert.rejects(pending, canceled);
  assert.equal(instance.calls.verify, 0);
});

test("ordinary provider errors stay distinguishable when an attempt is still active", async () => {
  const sign = deferred();
  const instance = fixture({ sign });
  const pending = observe(instance.client.connectWalletAndSignIn(messages, { isActive: () => true }));
  await waitUntil(() => instance.calls.sign === 1);
  sign.reject(new Error("synthetic wallet rejection"));
  await assert.rejects(pending, /synthetic wallet rejection/);
});

test("the caller can recheck immediately before navigation after the function resolves", async () => {
  const instance = fixture();
  const controller = new AbortController();
  const attempt = { signal: controller.signal };
  assert.equal((await instance.client.connectWalletAndSignIn(messages, attempt)).address, address);
  controller.abort();
  assert.throws(() => instance.client.assertWalletSignInActive(attempt), canceled);
});
