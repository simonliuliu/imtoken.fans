// Exercise the real wallet client and session guard with synthetic providers only.
// No real wallet, credentials, database, or network service is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
const address = "0x1111111111111111111111111111111111111111";
const otherAddress = "0x2222222222222222222222222222222222222222";
const message = "Synthetic wallet sign-in challenge";
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
const sessionModule = loadModule("src/lib/walletconnect-session.ts");
const { walletConnectSessionAllowsSignIn } = sessionModule;

function approvedSession() {
  return {
    expiry: Math.floor(Date.now() / 1000) + 3600,
    namespaces: {
      eip155: {
        accounts: [`eip155:1:${address}`],
        chains: ["eip155:1"],
        methods: ["personal_sign"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function response(payload) {
  return { ok: true, json: async () => payload };
}
function fixture(options = {}) {
  const { selected = address, nonceWait, signWait, disconnectWait } = options;
  const session = Object.prototype.hasOwnProperty.call(options, "session") ? options.session : approvedSession();
  const calls = { fetches: [], requests: [], disconnects: 0, init: 0 };
  const provider = {
    session,
    chainId: 1,
    accounts: selected ? [selected] : [],
    async connect() {},
    async disconnect() {
      calls.disconnects += 1;
      if (disconnectWait) await disconnectWait.promise;
    },
    async request(args) {
      calls.requests.push(args);
      if (signWait) return signWait.promise;
      return "synthetic signature";
    },
  };
  const globals = {
    process: { env: { NEXT_PUBLIC_REOWN_PROJECT_ID: "synthetic-project" } },
    document: { documentElement: { lang: "en" } },
    window: { location: { origin: "https://synthetic.invalid" } },
    fetch: async (url, options) => {
      calls.fetches.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("/nonce")) {
        if (nonceWait) return nonceWait.promise;
        return response({ message });
      }
      if (url.endsWith("/verify")) return response({ ok: true });
      throw new Error("Unexpected network request");
    },
  };
  const client = loadModule("src/lib/wallet-client.ts", {
    "@/lib/walletconnect-session": sessionModule,
    "@/lib/wallet-sign-in-lock": loadModule("src/lib/wallet-sign-in-lock.ts", {}, globals),
    "@walletconnect/ethereum-provider": {
      EthereumProvider: {
        async init() { calls.init += 1; return provider; },
      },
    },
  }, globals);
  return { client, provider, calls, globals };
}
async function waitUntil(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected synthetic operation did not start");
}

for (const key of ["eip155", "eip155:1"]) {
  test(`accepts an unexpired approved Ethereum session under ${key}`, () => {
    const session = approvedSession();
    session.namespaces = { [key]: session.namespaces.eip155 };
    assert.equal(walletConnectSessionAllowsSignIn(session, address), true);
    delete session.namespaces[key].chains;
    assert.equal(walletConnectSessionAllowsSignIn(session, address), true);
  });
}
const rejected = [
  ["missing session", () => undefined],
  ["missing expiry", () => { const s = approvedSession(); delete s.expiry; return s; }],
  ["expired session", () => { const s = approvedSession(); s.expiry = 1; return s; }],
  ["non-finite expiry", () => { const s = approvedSession(); s.expiry = Infinity; return s; }],
  ["missing personal_sign", () => { const s = approvedSession(); s.namespaces.eip155.methods = []; return s; }],
  ["wrong account", () => { const s = approvedSession(); s.namespaces.eip155.accounts = [`eip155:1:${otherAddress}`]; return s; }],
  ["wrong account chain", () => { const s = approvedSession(); s.namespaces.eip155.accounts = [`eip155:137:${address}`]; return s; }],
  ["inconsistent chains", () => { const s = approvedSession(); s.namespaces.eip155.chains = ["eip155:137"]; return s; }],
  ["wrong namespace key", () => { const s = approvedSession(); s.namespaces = { "eip155:137": s.namespaces.eip155 }; return s; }],
  ["too many accounts", () => { const s = approvedSession(); s.namespaces.eip155.accounts = Array(257).fill(`eip155:1:${address}`); return s; }],
  ["too many methods", () => { const s = approvedSession(); s.namespaces.eip155.methods = Array(129).fill("personal_sign"); return s; }],
  ["too many chains", () => { const s = approvedSession(); s.namespaces.eip155.chains = Array(129).fill("eip155:1"); return s; }],
  ["inherited namespace", () => { const s = approvedSession(); s.namespaces = Object.create({ eip155: s.namespaces.eip155 }); return s; }],
];
for (const [label, makeSession] of rejected) {
  test(`rejects ${label} before nonce, signature, or verification`, async () => {
    const instance = fixture({ session: makeSession() });
    await assert.rejects(instance.client.connectWalletConnectAndSignIn(messages), /session not authorized/);
    assert.equal(instance.calls.fetches.length, 0);
    assert.equal(instance.calls.requests.length, 0);
    assert.equal(instance.calls.disconnects, 1);
  });
}

test("authorized session proceeds through nonce, signature and verification", async () => {
  const instance = fixture();
  const result = await instance.client.connectWalletConnectAndSignIn(messages);
  assert.equal(result.address, address);
  assert.deepEqual(instance.calls.fetches.map((call) => call.url), ["/api/auth/wallet/nonce", "/api/auth/wallet/verify"]);
  assert.equal(instance.calls.requests.length, 1);
  assert.equal(instance.calls.requests[0].method, "personal_sign");
  assert.equal(instance.calls.disconnects, 1);
});

test("a provider on another chain is rejected before nonce or signing", async () => {
  const instance = fixture();
  instance.provider.chainId = 137;
  await assert.rejects(instance.client.connectWalletConnectAndSignIn(messages), /session not authorized/);
  assert.equal(instance.calls.fetches.length, 0);
  assert.equal(instance.calls.requests.length, 0);
  assert.equal(instance.calls.disconnects, 1);
});

test("revocation while nonce is pending prevents signing and verification", async () => {
  const nonceWait = deferred();
  const instance = fixture({ nonceWait });
  const attempt = instance.client.connectWalletConnectAndSignIn(messages);
  await waitUntil(() => instance.calls.fetches.length === 1);
  instance.provider.session.namespaces.eip155.methods = [];
  nonceWait.resolve(response({ message }));
  await assert.rejects(attempt, /session not authorized/);
  assert.equal(instance.calls.requests.length, 0);
  assert.equal(instance.calls.fetches.length, 1);
  assert.equal(instance.calls.disconnects, 1);
});

test("chain change while nonce is pending prevents signing and verification", async () => {
  const nonceWait = deferred();
  const instance = fixture({ nonceWait });
  const attempt = instance.client.connectWalletConnectAndSignIn(messages);
  await waitUntil(() => instance.calls.fetches.length === 1);
  instance.provider.chainId = 137;
  nonceWait.resolve(response({ message }));
  await assert.rejects(attempt, /session not authorized/);
  assert.equal(instance.calls.requests.length, 0);
  assert.equal(instance.calls.fetches.length, 1);
  assert.equal(instance.calls.disconnects, 1);
});

test("account switch while signature is pending prevents verification", async () => {
  const signWait = deferred();
  const instance = fixture({ signWait });
  const attempt = instance.client.connectWalletConnectAndSignIn(messages);
  await waitUntil(() => instance.calls.requests.length === 1);
  instance.provider.accounts = [otherAddress];
  signWait.resolve("synthetic signature");
  await assert.rejects(attempt, /session not authorized/);
  assert.equal(instance.calls.fetches.length, 1);
  assert.equal(instance.calls.disconnects, 1);
});

test("revocation while signature is pending prevents verification", async () => {
  const signWait = deferred();
  const instance = fixture({ signWait });
  const attempt = instance.client.connectWalletConnectAndSignIn(messages);
  await waitUntil(() => instance.calls.requests.length === 1);
  instance.provider.session.namespaces.eip155.methods = [];
  signWait.resolve("synthetic signature");
  await assert.rejects(attempt, /session not authorized/);
  assert.equal(instance.calls.fetches.length, 1);
  assert.equal(instance.calls.disconnects, 1);
});

test("chain change while signature is pending prevents verification", async () => {
  const signWait = deferred();
  const instance = fixture({ signWait });
  const attempt = instance.client.connectWalletConnectAndSignIn(messages);
  await waitUntil(() => instance.calls.requests.length === 1);
  instance.provider.chainId = 137;
  signWait.resolve("synthetic signature");
  await assert.rejects(attempt, /session not authorized/);
  assert.equal(instance.calls.fetches.length, 1);
  assert.equal(instance.calls.disconnects, 1);
});

test("injected wallet login does not require a WalletConnect session", async () => {
  const instance = fixture();
  instance.globals.window.ethereum = {
    async request(args) {
      if (args.method === "eth_requestAccounts") return [address];
      assert.equal(args.method, "personal_sign");
      return "synthetic signature";
    },
  };
  const result = await instance.client.connectWalletAndSignIn(messages);
  assert.equal(result.address, address);
  assert.equal(instance.calls.fetches.length, 2);
  assert.equal(instance.calls.init, 0);
});

test("an injected sign-in cannot overlap a pending WalletConnect sign-in in the same tab", async () => {
  const nonceWait = deferred();
  const instance = fixture({ nonceWait });
  const first = instance.client.connectWalletConnectAndSignIn(messages);
  await waitUntil(() => instance.calls.fetches.length === 1);
  await assert.rejects(instance.client.connectWalletAndSignIn(messages), /sign-in in progress/);
  assert.equal(instance.calls.fetches.length, 1);
  nonceWait.resolve(response({ message }));
  assert.equal((await first).address, address);
  assert.equal(instance.calls.fetches.length, 2);
  assert.equal(instance.calls.disconnects, 1);
});

test("the lock remains held until WalletConnect disconnect cleanup finishes", async () => {
  const disconnectWait = deferred();
  const instance = fixture({ disconnectWait });
  const first = instance.client.connectWalletConnectAndSignIn(messages);
  await waitUntil(() => instance.calls.disconnects === 1);
  await assert.rejects(instance.client.connectWalletAndSignIn(messages), /sign-in in progress/);
  assert.equal(instance.calls.fetches.length, 2);
  disconnectWait.resolve();
  assert.equal((await first).address, address);
});

test("a failed wallet signature releases the lock for a later attempt", async () => {
  const instance = fixture();
  instance.provider.request = async () => { throw new Error("synthetic rejection"); };
  await assert.rejects(instance.client.connectWalletConnectAndSignIn(messages), /synthetic rejection/);
  instance.provider.request = async () => "synthetic signature";
  assert.equal((await instance.client.connectWalletConnectAndSignIn(messages)).address, address);
  assert.equal(instance.calls.disconnects, 2);
});
