// Real WalletConnect SDKs, synthetic local relay/wallet and an isolated WebKit profile.
// No production service, real wallet, user browser profile or credentials are used.
// Run through walletconnect-browser-protocol-runner.mjs for bounded cleanup on failure.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";
import ts from "typescript";

if (process.env.IMTOKEN_BROWSER_PROTOCOL_WORKER !== "1") throw new Error("Use the browser protocol runner");
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = process.env.WALLETCONNECT_TEST_DEPS_ROOT;
if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) throw new Error("An absolute isolated SDK fixture directory is required");
const require = createRequire(import.meta.url);
const fixtureRequire = createRequire(path.join(fixtureRoot, "package.json"));
const { webpack } = require("next/dist/compiled/webpack/webpack");
const { WebSocketServer } = fixtureRequire("ws");
const temp = await mkdtemp(path.join(os.tmpdir(), "imtoken-wc-browser-protocol-"));
const profile = path.join(temp, "profile");
const origin = "http://localhost:3000";
const syntheticMessage = "synthetic-offline-browser-wallet-signature";
const ephemeralDeepLinkMode = process.env.IMTOKEN_EPHEMERAL_DEEPLINK_MODE || "default";
if (!["wallet-disabled", "local-disabled", "default"].includes(ephemeralDeepLinkMode)) throw new Error("Invalid synthetic deep-link mode");
let allowedPort = 0;
let phase = "startup";
let nodeBlockedRequests = 0;
let browserBlockedFetch = 0;
let browserBlockedSockets = 0;
let browserBlockedXhr = 0;
let browserBlockedBeacon = 0;
let browserBlockedRoutes = 0;
const browserBlockedRouteKinds = {};
let browserUnhandled = 0;
let browserWindowErrors = 0;
let browserPageErrors = 0;
let server;
let context;
let wallet;
let signatureRequests = 0;
let challengeVisibleOnRelay = false;
let passed = false;
let verifiedSdkPackages = [];
const unexpected = [];
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const arg = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof arg === "object" ? arg.host || arg.hostname : args[1];
  const port = Number(typeof arg === "object" ? arg.port : arg);
  if ((host !== "127.0.0.1" && host !== "localhost") || port !== allowedPort) {
    nodeBlockedRequests += 1;
    throw new Error("External socket disabled in fixture");
  }
  return originalConnect.apply(this, args);
};
tls.connect = function () { nodeBlockedRequests += 1; throw new Error("TLS disabled in fixture"); };
dgram.createSocket = function () { nodeBlockedRequests += 1; throw new Error("UDP disabled in fixture"); };
const originalLookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (host !== "localhost" && host !== "127.0.0.1") { nodeBlockedRequests += 1; throw new Error("DNS disabled in fixture"); }
  return originalLookup.call(this, host, ...args);
};
globalThis.fetch = async function () { nodeBlockedRequests += 1; throw new Error("External HTTP disabled in fixture"); };
process.env.DISABLE_GLOBAL_CORE = "true";
process.env.WALLETCONNECT_DISABLE_LOGGER = "true";
process.on("unhandledRejection", (error) => { unexpected.push(error); process.exitCode = 1; });
const eventOnce = (source, event) => new Promise((resolve) => source.once(event, resolve));
function waitFor(promise, name, duration = 12000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${name}`)), duration).unref())]);
}
class MemoryStorage {
  constructor() { this.data = new Map(); }
  async getKeys() { return [...this.data.keys()]; }
  async getEntries() { return [...this.data.entries()]; }
  async getItem(key) { return this.data.get(key); }
  async setItem(key, value) { this.data.set(key, value); }
  async removeItem(key) { this.data.delete(key); }
}

const subscriptions = new Map();
const backlog = new Map();
let messageId = Date.now();
let relayedMessages = 0;
function handleRelay(socket, message) {
  const wire = message.toString();
  if (wire.includes(syntheticMessage) || wire.toLowerCase().includes(Buffer.from(syntheticMessage).toString("hex"))) challengeVisibleOnRelay = true;
  let data;
  try { data = JSON.parse(wire); } catch { return; }
  if (!data.method) return;
  const { method, params = {}, id } = data;
  const respond = (result) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const deliver = (recipient, subscriptionId, item) => {
    if (recipient.readyState === recipient.OPEN) recipient.send(JSON.stringify({ jsonrpc: "2.0", id: ++messageId, method: "irn_subscription", params: { id: subscriptionId, data: item } }));
  };
  const subscribe = (topic) => {
    const subscriptionId = crypto.createHash("sha256").update(topic + String(socket.fixtureClientId || "missing")).digest("hex");
    if (!subscriptions.has(topic)) subscriptions.set(topic, new Map());
    subscriptions.get(topic).set(socket, subscriptionId);
    const pending = backlog.get(topic) || [];
    backlog.delete(topic);
    setImmediate(() => { for (const item of pending) deliver(socket, subscriptionId, item); });
    return subscriptionId;
  };
  if (method === "wc_proposeSession") {
    subscribe(params.pairingTopic);
    const item = { topic: params.pairingTopic, message: params.sessionProposal, publishedAt: Date.now(), tag: 1100 };
    const pending = backlog.get(params.pairingTopic) || []; pending.push(item); backlog.set(params.pairingTopic, pending); relayedMessages += 1;
    respond(true); return;
  }
  if (method === "wc_approveSession") {
    subscribe(params.sessionTopic);
    const items = [
      { topic: params.pairingTopic, message: params.sessionProposalResponse, publishedAt: Date.now(), tag: 1101 },
      { topic: params.sessionTopic, message: params.sessionSettlementRequest, publishedAt: Date.now(), tag: 1102 },
    ];
    relayedMessages += 2; respond(true);
    setImmediate(() => {
      for (const item of items) {
        const recipients = [...(subscriptions.get(item.topic) || new Map())].filter(([peer]) => peer !== socket);
        if (!recipients.length) { const pending = backlog.get(item.topic) || []; pending.push(item); backlog.set(item.topic, pending); }
        else for (const [peer, subscriptionId] of recipients) deliver(peer, subscriptionId, item);
      }
    });
    return;
  }
  if (method === "irn_subscribe") { respond(subscribe(params.topic)); return; }
  if (method === "irn_batchSubscribe") { respond(params.topics.map(subscribe)); return; }
  if (method === "irn_unsubscribe") { subscriptions.get(params.topic)?.delete(socket); respond(true); return; }
  if (method === "irn_batchUnsubscribe") { for (const item of params.subscriptions) subscriptions.get(item.topic)?.delete(socket); respond(true); return; }
  if (method === "irn_publish") {
    relayedMessages += 1;
    const item = { topic: params.topic, message: params.message, publishedAt: Date.now(), tag: params.tag };
    const recipients = [...(subscriptions.get(params.topic) || new Map())].filter(([peer]) => peer !== socket);
    if (!recipients.length) { const pending = backlog.get(params.topic) || []; pending.push(item); backlog.set(params.topic, pending); }
    respond(true);
    setImmediate(() => { for (const [peer, subscriptionId] of recipients) deliver(peer, subscriptionId, item); });
    return;
  }
  if (method === "irn_fetchMessages") { respond({ messages: [], hasMore: false }); return; }
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported fixture method" } }));
}

async function bundleFixture() {
  const version = (name) => {
    let current = path.dirname(fixtureRequire.resolve(name));
    while (current !== path.dirname(current)) {
      try {
        const value = JSON.parse(readFileSync(path.join(current, "package.json"), "utf8"));
        if (value.name === name) return value.version;
      } catch {}
      current = path.dirname(current);
    }
    throw new Error("SDK version unavailable");
  };
  assert.equal(version("@walletconnect/universal-provider"), "2.26.0");
  assert.equal(version("@walletconnect/sign-client"), "2.26.0");
  assert.equal(version("@walletconnect/core"), "2.26.0");
  const projectSafeJson = path.join(root, "node_modules/@walletconnect/safe-json/dist/esm/index.js");
  const fixtureSafeJson = path.join(fixtureRoot, "node_modules/@walletconnect/safe-json/dist/esm/index.js");
  assert.equal(readFileSync(projectSafeJson).equals(readFileSync(fixtureSafeJson)), true);
  for (const [source, target] of [
    ["src/lib/walletconnect-scoped-storage.ts", "scoped.mjs"],
    ["src/lib/walletconnect-indexeddb-storage.ts", "indexeddb.mjs"],
    ["src/lib/walletconnect-storage-codec.ts", "codec.mjs"],
    ["src/lib/walletconnect-ephemeral-storage.ts", "ephemeral.mjs"],
    ["src/lib/walletconnect-session.ts", "session.mjs"],
    ["src/lib/walletconnect-deeplink-guard.ts", "deeplink-guard.mjs"],
  ]) {
    const input = await readFile(path.join(root, source), "utf8");
    await writeFile(path.join(temp, target), ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  const providerEntry = path.join(fixtureRoot, "node_modules/@walletconnect/universal-provider/dist/index.js");
  const coreEntry = path.join(fixtureRoot, "node_modules/@walletconnect/core/dist/index.js");
  await writeFile(path.join(temp, "fixture.mjs"), `
import { UniversalProvider } from ${JSON.stringify(providerEntry)};
import { Core } from ${JSON.stringify(coreEntry)};
import { createWalletConnectStorageScope, scopeWalletConnectStorage } from "./scoped.mjs";
import { createWalletConnectAttemptStorage } from "./indexeddb.mjs";
import { walletConnectValueStorage } from "./codec.mjs";
import { createWalletConnectEphemeralStorage } from "./ephemeral.mjs";
import { walletConnectSessionAllowsSignIn } from "./session.mjs";
import { withWalletConnectDeepLinkDisabled } from "./deeplink-guard.mjs";
window.makeScope = createWalletConnectStorageScope;
window.openEphemeralProvider = async (scope, port) => {
  window.ephemeralStorage = createWalletConnectEphemeralStorage();
  window.ephemeralCodec = walletConnectValueStorage(window.ephemeralStorage);
  window.ephemeralCore = new Core({
    projectId: "00000000000000000000000000000000", relayUrl: "ws://127.0.0.1:" + port,
    storage: window.ephemeralCodec, customStoragePrefix: "ephemeral-" + scope,
    telemetryEnabled: false, logger: "silent",
  });
  window.provider = await UniversalProvider.init({
    core: window.ephemeralCore, projectId: "00000000000000000000000000000000",
    relayUrl: "ws://127.0.0.1:" + port, disableProviderPing: true, telemetryEnabled: false,
    logger: "silent", metadata: { name: "Synthetic app", description: "Offline fixture", url: "https://fixture.invalid", icons: [] },
  });
};
window.openProvider = async (scope, port) => {
  window.scopeStorage = scopeWalletConnectStorage(createWalletConnectAttemptStorage(), scope);
  window.storage = walletConnectValueStorage(window.scopeStorage);
  window.provider = await UniversalProvider.init({
    projectId: "00000000000000000000000000000000", relayUrl: "ws://127.0.0.1:" + port,
    storage: window.storage, customStoragePrefix: "browser-" + scope,
    disableProviderPing: true, telemetryEnabled: false, logger: "silent",
    metadata: { name: "Synthetic app", description: "Offline fixture", url: "https://fixture.invalid", icons: [] },
  });
};
window.startConnect = () => {
  window.fixtureUri = null;
  window.provider.on("display_uri", (uri) => { window.fixtureUri = uri; });
  window.sessionPromise = window.provider.connect({ namespaces: { eip155: {
    chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"], rpcMap: { "1": "http://127.0.0.1:1" },
  } } });
  window.sessionPromise.catch(() => {});
};
window.sessionAllowed = (address) => walletConnectSessionAllowsSignIn(window.provider.session, address);
window.signSynthetic = (hexMessage, address) => window.provider.request({method: "personal_sign", params: [hexMessage, address]}, "eip155:1");
window.startGuardedSignature = (topic, hexMessage, address) => {
  const provider = window.provider;
  const client = provider.client;
  const store = client.session;
  window.guardSignInvoked = 0;
  const originalUpdate = store.update;
  store.update = async (key, patch) => {
    if (patch.sessionConfig?.disableDeepLink === true) {
      await originalUpdate.call(store, key, patch);
      window.guardUpdateApplied = true;
      await new Promise((resolve) => { window.releaseGuardUpdate = resolve; });
      return;
    }
    return originalUpdate.call(store, key, patch);
  };
  window.guardedSignature = withWalletConnectDeepLinkDisabled({
    topic, address, challenge: hexMessage, isCurrent: () => true,
    getBinding: () => ({ provider: window.provider, client: window.provider.client, store: window.provider.client.session, providerSession: window.provider.session,
      chainId: window.provider.rpcProviders.eip155.chainId, account: window.provider.rpcProviders.eip155.requestAccounts()[0] }),
  }, (request) => { window.guardSignInvoked++; return provider.request(request, "eip155:1"); });
  window.guardedSignature.catch(() => {});
};
window.rawScopeCount = (scope) => new Promise((resolve, reject) => {
  const request = indexedDB.open("imtoken-fans-walletconnect-attempts", 1);
  request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("Expected attempt database")); };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result;
    const transaction = database.transaction("attempts", "readonly");
    const keys = transaction.objectStore("attempts").getAllKeys();
    keys.onerror = () => reject(keys.error);
    keys.onsuccess = () => resolve(keys.result.filter((key) => typeof key === "string" && key.includes(scope)).length);
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  };
});
`);
  const config = {
    mode: "development", target: "web", context: root, entry: path.join(temp, "fixture.mjs"),
    output: { path: temp, filename: "fixture-bundle.js" }, devtool: false,
    resolve: { alias: { "@/lib/walletconnect-session": path.join(temp, "session.mjs") }, modules: ["node_modules", path.join(root, "node_modules")], fallback: { crypto: false, stream: false, buffer: false, process: false } },
    plugins: [new webpack.DefinePlugin({ "process.env.DISABLE_GLOBAL_CORE": JSON.stringify("true") })],
  };
  await new Promise((resolve, reject) => webpack(config, (error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    const modules = stats.toJson({ all: false, modules: true, reasons: true }).modules || [];
    const identifiers = modules.map((module) => module.identifier || "");
    for (const name of ["universal-provider", "sign-client", "core"]) {
      const expected = path.join(fixtureRoot, "node_modules", "@walletconnect", name, "dist", "index.js");
      if (!identifiers.some((identifier) => identifier.includes(expected))) return reject(new Error(`Missing isolated ${name} SDK module`));
    }
    const walletModules = identifiers.filter((identifier) => identifier.includes(`${path.sep}node_modules${path.sep}@walletconnect${path.sep}`));
    const projectWalletModules = modules.filter((module) => {
      const identifier = module.identifier || "";
      return identifier.includes(`${path.sep}node_modules${path.sep}@walletconnect${path.sep}`) && !identifier.includes(`${fixtureRoot}${path.sep}`);
    });
    if (projectWalletModules.length !== 1 || !projectWalletModules[0].identifier?.includes(projectSafeJson)) return reject(new Error("Mixed WalletConnect SDK fixture modules"));
    const safeJsonReasons = projectWalletModules[0].reasons || [];
    if (!safeJsonReasons.length || safeJsonReasons.some((reason) => !reason.moduleIdentifier?.includes(path.join(temp, "codec.mjs")))) return reject(new Error("SDK imported the project safe-json module"));
    const expectedNames = new Set(["@walletconnect/universal-provider", "@walletconnect/sign-client", "@walletconnect/core", "@walletconnect/utils", "@walletconnect/types"]);
    const found = new Set();
    const checked = new Set();
    for (const identifier of walletModules.filter((value) => value.includes(`${fixtureRoot}${path.sep}`))) {
      const start = identifier.indexOf(`${fixtureRoot}${path.sep}`);
      let directory = path.dirname(identifier.slice(start).split("|")[0].split("?")[0]);
      while (directory.startsWith(`${fixtureRoot}${path.sep}`)) {
        if (checked.has(directory)) break;
        const manifest = path.join(directory, "package.json");
        try {
          const item = JSON.parse(readFileSync(manifest, "utf8"));
          if (expectedNames.has(item.name)) {
            if (item.version !== "2.26.0") return reject(new Error(`Unexpected ${item.name} SDK version`));
            found.add(`${item.name}@${item.version}`);
            checked.add(directory);
            break;
          }
        } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return reject(error);
        }
        directory = path.dirname(directory);
      }
    }
    if (found.size !== expectedNames.size) return reject(new Error("Incomplete WalletConnect SDK version closure"));
    verifiedSdkPackages = [...found].sort();
    resolve();
  }));
  return readFile(path.join(temp, "fixture-bundle.js"));
}

async function openContext(bundle) {
  const browserContext = await webkit.launchPersistentContext(profile, { headless: true });
  browserContext.on("page", (page) => page.on("pageerror", () => { browserPageErrors += 1; }));
  await browserContext.exposeBinding("__imtokenFixtureEvent", (_source, kind) => {
    if (kind === "unhandled") browserUnhandled += 1;
    else if (kind === "window-error") browserWindowErrors += 1;
    else if (kind === "blocked-fetch") browserBlockedFetch += 1;
    else if (kind === "blocked-socket") browserBlockedSockets += 1;
    else if (kind === "blocked-xhr") browserBlockedXhr += 1;
    else if (kind === "blocked-beacon") browserBlockedBeacon += 1;
  });
  await browserContext.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === `${origin}/`) {
      await route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><script src="/fixture-bundle.js"></script></head><body>synthetic protocol fixture</body></html>' }); return;
    }
    if (url === `${origin}/fixture-bundle.js`) {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: bundle }); return;
    }
    browserBlockedRoutes += 1;
    let kind = "other";
    try {
      const target = new URL(url);
      if (target.origin === origin) kind = "fixture-origin-other";
      else if (target.hostname === "verify.walletconnect.org") kind = "walletconnect-verify";
      else kind = "non-fixture-origin";
    } catch {}
    browserBlockedRouteKinds[kind] = (browserBlockedRouteKinds[kind] || 0) + 1;
    await route.abort();
  });
  await browserContext.addInitScript(({ port }) => {
    window.fixtureNetwork = { unhandled: 0, windowErrors: 0 };
    function report(kind) {
      try { void window.__imtokenFixtureEvent(kind).catch(() => {}); } catch {}
    }
    window.addEventListener("unhandledrejection", () => { window.fixtureNetwork.unhandled += 1; report("unhandled"); });
    window.addEventListener("error", () => { window.fixtureNetwork.windowErrors += 1; report("window-error"); });
    window.fetch = async () => { report("blocked-fetch"); throw new Error("HTTP disabled in fixture"); };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        const target = new URL(url);
        if (target.protocol !== "ws:" || target.hostname !== "127.0.0.1" || Number(target.port) !== port) {
          report("blocked-socket");
          throw new Error("Unexpected WebSocket target");
        }
        if (protocols === undefined) super(url); else super(url, protocols);
      }
    };
    XMLHttpRequest.prototype.open = function () { report("blocked-xhr"); throw new Error("XHR disabled in fixture"); };
    navigator.sendBeacon = () => { report("blocked-beacon"); return false; };
  }, { port: allowedPort });
  return browserContext;
}
async function pageAt(browserContext) {
  const page = await browserContext.newPage();
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => typeof window.openProvider === "function");
  return page;
}
async function recordBrowserNetwork(page) {
  const stats = await page.evaluate(() => window.fixtureNetwork);
  assert.equal(stats.unhandled, 0);
  assert.equal(stats.windowErrors, 0);
}

try {
  phase = "bundle";
  const bundle = await bundleFixture();
  phase = "relay";
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await eventOnce(server, "listening");
  allowedPort = server.address().port;
  server.on("connection", (socket, request) => {
    try {
      const token = new URL(request.url, "http://127.0.0.1").searchParams.get("auth");
      socket.fixtureClientId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).iss;
    } catch { socket.fixtureClientId = "missing"; }
    socket.on("message", (message) => handleRelay(socket, message));
    socket.on("close", () => { for (const peers of subscriptions.values()) peers.delete(socket); });
  });
  const { SignClient } = fixtureRequire("@walletconnect/sign-client");
  const { privateKeyToAccount, generatePrivateKey } = fixtureRequire("viem/accounts");
  const { verifyMessage, stringToHex } = fixtureRequire("viem");
  const account = privateKeyToAccount(generatePrivateKey());
  phase = "synthetic wallet init";
  wallet = await waitFor(SignClient.init({
    projectId: "00000000000000000000000000000000", relayUrl: `ws://127.0.0.1:${allowedPort}`,
    logger: "silent", telemetryEnabled: false, storage: new MemoryStorage(), customStoragePrefix: "synthetic-wallet",
    metadata: { name: "Synthetic wallet", description: "Offline fixture", url: "https://fixture.invalid", icons: [] },
  }), "wallet init");
  wallet.on("session_request", async (event) => {
    signatureRequests += 1;
    try {
      assert.equal(event.params.request.method, "personal_sign");
      assert.equal(event.params.chainId, "eip155:1");
      assert.equal(event.params.request.params[0], stringToHex(syntheticMessage));
      assert.equal(event.params.request.params[1].toLowerCase(), account.address.toLowerCase());
      const signature = await account.signMessage({ message: { raw: event.params.request.params[0] } });
      await wallet.respond({ topic: event.topic, response: { id: event.id, jsonrpc: "2.0", result: signature } });
    } catch (error) { unexpected.push(error); }
  });
  phase = "first browser init";
  context = await openContext(bundle);
  const oldKey = "wc@2:client:0.3//session";
  phase = "ephemeral browser session";
  const ephemeralPage = await pageAt(context);
  const ephemeralScope = await ephemeralPage.evaluate(() => window.makeScope());
  await ephemeralPage.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify([{ topic: "synthetic-old-session" }]));
    localStorage.setItem("WALLETCONNECT_DEEPLINK_CHOICE", JSON.stringify({ href: "https://stale-wallet.invalid" }));
    window.syntheticOpens = [];
    window.open = (url) => { window.syntheticOpens.push(new URL(url).origin); return null; };
    document.hasFocus = () => true;
    window.persistentAccess = { idbOpen: 0, localReads: 0, localWrites: 0, readKeys: [] };
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { window.persistentAccess.idbOpen++; return open.apply(this, args); };
    for (const method of ["setItem", "removeItem", "clear"]) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) { window.persistentAccess.localWrites++; return original.apply(this, args); };
    }
    for (const method of ["getItem", "key"]) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) { window.persistentAccess.localReads++; window.persistentAccess.readKeys.push(String(args[0])); return original.apply(this, args); };
    }
  }, oldKey);
  await waitFor(ephemeralPage.evaluate(({ scopeId, port }) => window.openEphemeralProvider(scopeId, port), { scopeId: ephemeralScope, port: allowedPort }), "ephemeral provider init");
  assert.equal(await ephemeralPage.evaluate(() => window.provider.client.core === window.ephemeralCore && window.ephemeralCore.storage === window.ephemeralCodec), true);
  const ephemeralProposalPending = eventOnce(wallet, "session_proposal");
  await ephemeralPage.evaluate(() => window.startConnect());
  await ephemeralPage.waitForFunction(() => typeof window.fixtureUri === "string", undefined, { timeout: 12000 });
  await waitFor(wallet.pair({ uri: await ephemeralPage.evaluate(() => window.fixtureUri) }), "ephemeral wallet pair");
  const ephemeralProposal = await waitFor(ephemeralProposalPending, "ephemeral wallet proposal");
  const ephemeralApproval = await waitFor(wallet.approve({ id: ephemeralProposal.id, namespaces: { eip155: {
    accounts: [`eip155:1:${account.address}`], methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"],
  } }, ...(ephemeralDeepLinkMode === "wallet-disabled" ? { sessionConfig: { disableDeepLink: true } } : {}) }), "ephemeral wallet approval");
  const ephemeralTopic = await waitFor(ephemeralPage.evaluate(async () => (await window.sessionPromise).topic), "ephemeral browser session");
  if (ephemeralDeepLinkMode === "wallet-disabled") {
    assert.equal(await ephemeralPage.evaluate((topic) => window.provider.client.session.get(topic).sessionConfig?.disableDeepLink, ephemeralTopic), true);
  }
  await waitFor(ephemeralApproval.acknowledged(), "ephemeral wallet acknowledgement");
  const ephemeralDeadline = Date.now() + 12000;
  while (!wallet.session.get(ephemeralTopic)?.acknowledged && Date.now() < ephemeralDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wallet.session.get(ephemeralTopic)?.acknowledged, true);
  if (ephemeralDeepLinkMode === "local-disabled") {
    await ephemeralPage.evaluate(({ topic, message, address }) => window.startGuardedSignature(topic, message, address), { topic: ephemeralTopic, message: stringToHex(syntheticMessage), address: account.address });
    await ephemeralPage.waitForFunction(() => window.guardUpdateApplied === true);
    assert.equal(signatureRequests, 0);
    assert.equal(await ephemeralPage.evaluate(() => window.guardSignInvoked), 0);
    await ephemeralPage.evaluate(() => {
      window.ephemeralUpdate = new Promise((resolve) => window.provider.once("session_update", (event) => resolve(event.topic)));
    });
    const update = await waitFor(wallet.update({ topic: ephemeralTopic, namespaces: { eip155: {
      accounts: [`eip155:1:${account.address}`], methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"],
    } } }), "ephemeral wallet update");
    await waitFor(update.acknowledged(), "ephemeral wallet update acknowledgement");
    assert.equal(await waitFor(ephemeralPage.evaluate(() => window.ephemeralUpdate), "ephemeral session update"), ephemeralTopic);
    assert.equal(await ephemeralPage.evaluate((topic) => window.provider.client.session.get(topic).sessionConfig?.disableDeepLink, ephemeralTopic), true);
    assert.equal(signatureRequests, 0);
    assert.equal(await ephemeralPage.evaluate(() => window.guardSignInvoked), 0);
    await ephemeralPage.evaluate(() => window.releaseGuardUpdate());
  }
  assert.equal(await ephemeralPage.evaluate((address) => window.sessionAllowed(address), account.address), true);
  assert((await ephemeralPage.evaluate(async () => (await window.ephemeralStorage.getKeys()).length)) > 0);
  const ephemeralSignature = ephemeralDeepLinkMode === "local-disabled"
    ? await waitFor(ephemeralPage.evaluate(() => window.guardedSignature), "guarded ephemeral signature")
    : await waitFor(ephemeralPage.evaluate(({ message, address }) => window.signSynthetic(message, address), { message: stringToHex(syntheticMessage), address: account.address }), "ephemeral signature");
  assert.equal(await verifyMessage({ address: account.address, message: syntheticMessage, signature: ephemeralSignature }), true);
  if (ephemeralDeepLinkMode === "local-disabled") assert.equal(await ephemeralPage.evaluate(() => window.guardSignInvoked), 1);
  const ephemeralRemoved = eventOnce(wallet, "session_delete");
  await waitFor(ephemeralPage.evaluate(() => window.provider.disconnect()), "ephemeral disconnect");
  assert.equal((await waitFor(ephemeralRemoved, "ephemeral wallet deletion")).topic, ephemeralTopic);
  await ephemeralPage.evaluate(async () => {
    window.ephemeralCore.heartbeat.stop();
    await window.ephemeralCore.relayer.transportClose();
    await window.ephemeralStorage.close();
    await window.ephemeralCodec.setItem("late", "synthetic");
  });
  assert.equal(await ephemeralPage.evaluate(async () => window.ephemeralStorage.closed && (await window.ephemeralStorage.getKeys()).length === 0), true);
  const nextEphemeralScope = await ephemeralPage.evaluate(() => window.makeScope());
  assert.notEqual(ephemeralScope, nextEphemeralScope);
  await waitFor(ephemeralPage.evaluate(({ scopeId, port }) => window.openEphemeralProvider(scopeId, port), { scopeId: nextEphemeralScope, port: allowedPort }), "fresh ephemeral provider init");
  assert.equal(await ephemeralPage.evaluate(() => window.provider.session === undefined), true);
  await ephemeralPage.evaluate(async () => {
    window.ephemeralCore.heartbeat.stop();
    await window.ephemeralCore.relayer.transportClose();
    await window.ephemeralStorage.close();
  });
  const ephemeralPersistentAccess = await ephemeralPage.evaluate(() => window.persistentAccess);
  const ephemeralOpened = await ephemeralPage.evaluate(() => window.syntheticOpens);
  if (ephemeralDeepLinkMode === "default" || process.env.IMTOKEN_BROWSER_PROTOCOL_DEBUG === "1") process.stderr.write(JSON.stringify({ phase: "ephemeral persistent access counters", ...ephemeralPersistentAccess, openedOrigins: ephemeralOpened }) + "\n");
  assert.deepEqual(ephemeralPersistentAccess, { idbOpen: 0, localReads: 0, localWrites: 0, readKeys: [] });
  assert.deepEqual(ephemeralOpened, []);
  assert.equal(await ephemeralPage.evaluate((key) => localStorage.getItem(key), oldKey), '[{"topic":"synthetic-old-session"}]');
  await recordBrowserNetwork(ephemeralPage);
  await ephemeralPage.close();
  phase = "first browser init";
  const firstPage = await pageAt(context);
  await firstPage.evaluate(() => localStorage.removeItem("WALLETCONNECT_DEEPLINK_CHOICE"));
  const scope = await firstPage.evaluate(() => window.makeScope());
  assert.match(scope, /^[0-9a-f]{32}$/);
  await firstPage.evaluate((key) => localStorage.setItem(key, JSON.stringify([{ topic: "synthetic-old-session" }])), oldKey);
  await waitFor(firstPage.evaluate(({ scopeId, port }) => window.openProvider(scopeId, port), { scopeId: scope, port: allowedPort }), "browser provider init");
  phase = "synthetic pairing";
  const proposalPending = eventOnce(wallet, "session_proposal");
  await firstPage.evaluate(() => window.startConnect());
  await firstPage.waitForFunction(() => typeof window.fixtureUri === "string", undefined, { timeout: 12000 });
  const uri = await firstPage.evaluate(() => window.fixtureUri);
  await waitFor(wallet.pair({ uri }), "wallet pair");
  const proposal = await waitFor(proposalPending, "wallet proposal");
  const approval = await waitFor(wallet.approve({ id: proposal.id, namespaces: { eip155: {
    accounts: [`eip155:1:${account.address}`], methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"],
  } } }), "wallet approval");
  const topic = await waitFor(firstPage.evaluate(async () => (await window.sessionPromise).topic), "browser session");
  await waitFor(approval.acknowledged(), "wallet acknowledgement");
  const deadline = Date.now() + 12000;
  while (!wallet.session.get(topic)?.acknowledged && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wallet.session.get(topic)?.acknowledged, true);
  assert.equal(await firstPage.evaluate((address) => window.sessionAllowed(address), account.address), true);
  phase = "first signature";
  const signature = await waitFor(firstPage.evaluate(({ message, address }) => window.signSynthetic(message, address), { message: stringToHex(syntheticMessage), address: account.address }), "first signature");
  assert.equal(await verifyMessage({ address: account.address, message: syntheticMessage, signature }), true);
  const oldValue = await firstPage.evaluate((key) => localStorage.getItem(key), oldKey);
  assert.equal(oldValue, '[{"topic":"synthetic-old-session"}]');
  const storedBefore = await firstPage.evaluate(async () => (await window.storage.getKeys()).length);
  assert(storedBefore > 0);
  assert.equal(await firstPage.evaluate(() => window.provider.client.core.storage === window.storage), true);
  assert((await firstPage.evaluate((scopeId) => window.rawScopeCount(scopeId), scope)) > 0);
  phase = "different scope";
  const otherPage = await pageAt(context);
  const otherScope = await otherPage.evaluate(() => window.makeScope());
  assert.notEqual(scope, otherScope);
  await waitFor(otherPage.evaluate(({ scopeId, port }) => window.openProvider(scopeId, port), { scopeId: otherScope, port: allowedPort }), "other provider init");
  assert.equal(await otherPage.evaluate(() => window.provider.client.core.storage === window.storage), true);
  assert.equal(await otherPage.evaluate(() => window.provider.session === undefined), true);
  await otherPage.evaluate(async () => {
    window.provider.client.core.heartbeat.stop();
    await window.provider.client.core.relayer.transportClose();
    await window.scopeStorage.close();
  });
  await recordBrowserNetwork(otherPage);
  await otherPage.close();
  assert.equal(await firstPage.evaluate((address) => window.sessionAllowed(address), account.address), true);
  const afterOtherClose = await waitFor(firstPage.evaluate(({ message, address }) => window.signSynthetic(message, address), { message: stringToHex(syntheticMessage), address: account.address }), "signature after other scope cleanup");
  assert.equal(await verifyMessage({ address: account.address, message: syntheticMessage, signature: afterOtherClose }), true);
  await recordBrowserNetwork(firstPage);
  phase = "browser restart";
  await context.close();
  context = undefined;
  assert(wallet.session.getAll().some((session) => session.topic === topic));
  context = await openContext(bundle);
  const restoredPage = await pageAt(context);
  assert((await restoredPage.evaluate((scopeId) => window.rawScopeCount(scopeId), scope)) > 0);
  await waitFor(restoredPage.evaluate(({ scopeId, port }) => window.openProvider(scopeId, port), { scopeId: scope, port: allowedPort }), "restored provider init");
  phase = "restored session";
  assert.equal(await restoredPage.evaluate(() => window.provider.client.core.storage === window.storage), true);
  assert.equal(await restoredPage.evaluate(() => window.provider.session?.topic), topic);
  assert.equal(await restoredPage.evaluate((address) => window.sessionAllowed(address), account.address), true);
  assert.equal(await restoredPage.evaluate((key) => localStorage.getItem(key), oldKey), oldValue);
  phase = "restored signature";
  const restoredSignature = await waitFor(restoredPage.evaluate(({ message, address }) => window.signSynthetic(message, address), { message: stringToHex(syntheticMessage), address: account.address }), "restored signature");
  assert.equal(await verifyMessage({ address: account.address, message: syntheticMessage, signature: restoredSignature }), true);
  assert.equal(signatureRequests, 4);
  assert.equal(challengeVisibleOnRelay, false);
  phase = "disconnect";
  const removed = eventOnce(wallet, "session_delete");
  await waitFor(restoredPage.evaluate(() => window.provider.disconnect()), "browser disconnect");
  assert.equal((await waitFor(removed, "wallet session deletion")).topic, topic);
  assert.equal(wallet.session.getAll().some((session) => session.topic === topic), false);
  await restoredPage.evaluate(() => window.scopeStorage.close());
  assert.equal(await restoredPage.evaluate((scopeId) => window.rawScopeCount(scopeId), scope), 0);
  await recordBrowserNetwork(restoredPage);
  assert.equal(browserBlockedSockets, 0);
  assert.equal(browserUnhandled, 0);
  assert.equal(browserWindowErrors, 0);
  assert.equal(browserPageErrors, 0);
  assert.equal(unexpected.length, 0);
  passed = true;
} catch (error) {
  if (process.env.IMTOKEN_BROWSER_PROTOCOL_DEBUG === "1" && phase === "bundle") process.stderr.write(String(error?.message) + "\n");
  process.stderr.write(JSON.stringify({ status: "failed", phase, errorName: error?.name || "Error" }) + "\n");
  process.exitCode = 1;
} finally {
  try {
    if (context) await context.close();
    if (wallet) {
      wallet.core.heartbeat.stop();
      await waitFor(wallet.core.relayer.transportClose(), "wallet transport cleanup", 2000);
    }
    if (server) {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(temp, { recursive: true, force: true });
  } catch (error) {
    passed = false;
    process.stderr.write(JSON.stringify({ status: "failed", phase: "cleanup", errorName: error?.name || "Error" }) + "\n");
    process.exitCode = 1;
  }
}
if (passed && (browserPageErrors || browserWindowErrors || browserUnhandled || browserBlockedSockets || unexpected.length)) {
  passed = false;
  process.stderr.write(JSON.stringify({ status: "failed", phase: "late browser or SDK error" }) + "\n");
  process.exitCode = 1;
}
if (passed && !process.exitCode) process.stdout.write(JSON.stringify({ status: "passed", browser: "isolated WebKit", sdk: "2.26.0", ephemeralDeepLinkMode, verifiedSdkPackages, signatureRequests, relayedMessages, browserBlockedFetch, browserBlockedSockets, browserBlockedXhr, browserBlockedBeacon, browserBlockedRoutes, browserBlockedRouteKinds, browserUnhandled, browserWindowErrors, browserPageErrors, nodeBlockedRequests, checks: ["explicit Core and ephemeral signature", "ephemeral persistent storage access", "fresh ephemeral attempt", "temporary signature", "session guard", "old localStorage preserved", "separate scope cleanup", "browser restart and session restore", "signature after restart", "explicit session disconnect"] }) + "\n");
