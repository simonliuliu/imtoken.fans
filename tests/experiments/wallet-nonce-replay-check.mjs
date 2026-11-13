// Security diagnostic: exits nonzero while a signed nonce can be replayed.
// All identities, cookies, session writes and database clients are synthetic.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const viem = require('viem');
const deny = () => { throw new Error('Network disabled in the isolated replay diagnostic'); };
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };
http.request = http.get = https.request = https.get = deny;
net.Socket.prototype.connect = tls.connect = deny;

function load(file, imports = {}, globals = {}) {
  const target = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, {
    module: target,
    exports: target.exports,
    require: id => id in imports ? imports[id] : require(id),
    Buffer,
    Date,
    ...globals,
  }, { filename: file });
  return target.exports;
}

const account = privateKeyToAccount(generatePrivateKey());
const walletSecret = randomBytes(32).toString('hex');
const wallet = load('src/lib/wallet.ts', { 'server-only': {} }, {
  process: { env: { WALLET_AUTH_SECRET: walletSecret } },
});
const requests = new AsyncLocalStorage();
const issuedTokens = new Map();
const consumedNonces = new Set();
let links = 0;
let sessions = 0;
let barrier = null;
let nonceStoreMode = 'normal';
let linkMode = 'normal';
const verifySignature = async options => {
  const valid = await viem.verifyMessage(options);
  if (barrier) {
    barrier.arrivals += 1;
    if (barrier.arrivals === 2) barrier.release();
    await barrier.promise;
  }
  return valid;
};
const admin = {
  rpc: async (name, args) => {
    assert.equal(name, 'consume_wallet_sign_in_nonce');
    assert.match(args.p_nonce_key, /^[0-9a-f]{64}$/);
    assert(Number.isSafeInteger(args.p_issued_at_ms));
    if (nonceStoreMode === 'error') return { data: null, error: { message: 'synthetic store error' } };
    if (nonceStoreMode === 'throw') throw new Error('synthetic store exception');
    if (nonceStoreMode === 'invalid') return { data: null, error: null };
    if (nonceStoreMode === 'commit-then-error') {
      consumedNonces.add(args.p_nonce_key);
      return { data: null, error: { message: 'synthetic lost response' } };
    }
    if (consumedNonces.has(args.p_nonce_key)) return { data: false, error: null };
    consumedNonces.add(args.p_nonce_key);
    return { data: true, error: null };
  },
  from: table => {
    assert.equal(table, 'profiles');
    return { select: () => ({ eq: (column, value) => {
      assert.equal(column, 'wallet_address');
      assert.equal(value, account.address.toLowerCase());
      return { maybeSingle: async () => ({ data: { id: 'synthetic-existing-user' } }) };
    } }) };
  },
  auth: { admin: {
    createUser: async () => { throw new Error('Unexpected account creation'); },
    generateLink: async ({ email }) => {
      assert.equal(email, wallet.walletSyntheticEmail(account.address));
      links += 1;
      if (linkMode === 'error') return { data: null, error: { message: 'synthetic link failure' } };
      const token = randomUUID();
      issuedTokens.set(token, email);
      return { data: { properties: { hashed_token: token } }, error: null };
    },
  } },
};
const imports = {
  'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
  'next/headers': { cookies: async () => requests.getStore().cookies },
  'next-intl/server': { getTranslations: async () => key => key },
  'viem': { ...viem, verifyMessage: verifySignature },
  '@/i18n/routing': { routing: { locales: ['zh', 'en'], defaultLocale: 'zh' } },
  '@/lib/wallet': wallet,
  '@/lib/supabase/config': { isSupabaseConfigured: () => true },
  '@/lib/supabase/admin': { createAdminClient: () => admin },
  '@/lib/supabase/server': { createClient: async () => ({ auth: { verifyOtp: async ({ token_hash }) => {
    assert(issuedTokens.has(token_hash));
    sessions += 1;
    return { error: null };
  } } }) },
};
const nonce = load('src/app/api/auth/wallet/nonce/route.ts', imports).POST;
const verify = load('src/app/api/auth/wallet/verify/route.ts', imports).POST;
async function call(handler, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `${wallet.WALLET_NONCE_COOKIE}=${cookie}`;
  const request = new Request('https://synthetic.invalid/api/auth/wallet', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const values = new Map();
  const incoming = request.headers.get('cookie');
  if (incoming) values.set(wallet.WALLET_NONCE_COOKIE, incoming.slice(incoming.indexOf('=') + 1));
  const cookies = {
    get: key => values.has(key) ? { value: values.get(key) } : undefined,
    set: (key, value) => values.set(key, value),
    delete: key => values.delete(key),
  };
  const response = await requests.run({ cookies }, () => handler(request));
  return { status: response.status, response, cookieAfterResponse: values.get(wallet.WALLET_NONCE_COOKIE) };
}
async function challenge() {
  const result = await call(nonce, { address: account.address, locale: 'en' });
  assert.equal(result.status, 200);
  const message = (await result.response.json()).message;
  const signature = await account.signMessage({ message });
  return { cookie: result.cookieAfterResponse, body: { address: account.address, signature, locale: 'en' } };
}
const findings = [];
function check(name, observed, ok) {
  process.stdout.write(JSON.stringify({ scenario: name, ...observed, result: ok ? 'PASS' : 'FAIL' }) + '\n');
  if (!ok) findings.push(name);
}

function signSyntheticCookie(challengeValue) {
  const payload = Buffer.from(JSON.stringify(challengeValue)).toString('base64url');
  const mac = createHmac('sha256', walletSecret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

const validationCase = await challenge();
const validationChallenge = wallet.verifyChallengeCookieValue(validationCase.cookie, account.address);
assert(validationChallenge);
const stableKey = wallet.walletNonceConsumptionKey(validationChallenge);
assert.match(stableKey, /^[0-9a-f]{64}$/);
assert.equal(wallet.walletNonceConsumptionKey(validationChallenge), stableKey);
const differentNonce = validationChallenge.nonce === 'f'.repeat(32) ? '0'.repeat(32) : 'f'.repeat(32);
assert.notEqual(wallet.walletNonceConsumptionKey({ ...validationChallenge, nonce: differentNonce }), stableKey);
for (const [name, override] of [
  ['expired', { issuedAt: Date.now() - 6 * 60 * 1000 }],
  ['future', { issuedAt: Date.now() + 6 * 60 * 1000 }],
  ['invalid-time', { issuedAt: 'not-a-time' }],
  ['invalid-nonce', { nonce: 'not-a-random-nonce' }],
]) {
  const malformed = signSyntheticCookie({ ...validationChallenge, ...override });
  check(`challenge-${name}`, {}, wallet.verifyChallengeCookieValue(malformed, account.address) === null);
}

const browserCase = await challenge();
const browserBefore = sessions;
const browserFirst = await call(verify, browserCase.body, browserCase.cookie);
const browserRetry = await call(verify, browserCase.body, browserFirst.cookieAfterResponse);
check('browser-after-cookie-delete', { statuses: [browserFirst.status, browserRetry.status], mockSessionWrites: sessions - browserBefore },
  browserFirst.status === 200 && browserRetry.status >= 400 && browserRetry.status < 500 && sessions - browserBefore === 1);

const sequentialCase = await challenge();
const sequentialBefore = { sessions, links };
const first = await call(verify, sequentialCase.body, sequentialCase.cookie);
const replay = await call(verify, sequentialCase.body, sequentialCase.cookie);
check('same-cookie-sequential-replay', { statuses: [first.status, replay.status], mockSessionWrites: sessions - sequentialBefore.sessions, mockLinks: links - sequentialBefore.links },
  first.status === 200 && replay.status >= 400 && replay.status < 500 && sessions - sequentialBefore.sessions === 1 && links - sequentialBefore.links === 1);

const casingCase = await challenge();
const casingBefore = { sessions, links };
const lowercaseFirst = await call(verify, { ...casingCase.body, address: account.address.toLowerCase() }, casingCase.cookie);
const checksumReplay = await call(verify, casingCase.body, casingCase.cookie);
check('same-challenge-address-casing', { statuses: [lowercaseFirst.status, checksumReplay.status], mockSessionWrites: sessions - casingBefore.sessions, mockLinks: links - casingBefore.links },
  lowercaseFirst.status === 200 && checksumReplay.status >= 400 && checksumReplay.status < 500 && sessions - casingBefore.sessions === 1 && links - casingBefore.links === 1);

const aliasCase = await challenge();
const aliasBefore = { sessions, links };
const aliasFirst = await call(verify, aliasCase.body, aliasCase.cookie);
const aliasReplay = await call(verify, aliasCase.body, aliasCase.cookie + '.synthetic-suffix');
check('same-challenge-cookie-suffix-alias', { statuses: [aliasFirst.status, aliasReplay.status], mockSessionWrites: sessions - aliasBefore.sessions, mockLinks: links - aliasBefore.links },
  aliasFirst.status === 200 && aliasReplay.status >= 400 && aliasReplay.status < 500 && sessions - aliasBefore.sessions === 1 && links - aliasBefore.links === 1);

const concurrentCase = await challenge();
const concurrentBefore = { sessions, links };
barrier = { arrivals: 0, release: null, promise: null };
barrier.promise = new Promise(resolve => { barrier.release = resolve; });
const barrierTimer = setTimeout(() => barrier.release(), 1000);
let timeoutId;
const timeout = new Promise((_, reject) => {
  timeoutId = setTimeout(() => reject(new Error('Concurrent signature barrier timed out')), 5000);
});
const both = await Promise.race([
  Promise.all([
    call(verify, concurrentCase.body, concurrentCase.cookie),
    call(verify, concurrentCase.body, concurrentCase.cookie),
  ]),
  timeout,
]).finally(() => { clearTimeout(timeoutId); clearTimeout(barrierTimer); });
const arrivals = barrier.arrivals;
barrier = null;
const concurrentStatuses = both.map(result => result.status).sort((a, b) => a - b);
check('same-cookie-concurrent-replay', { statuses: concurrentStatuses, signatureChecksBeforeRelease: arrivals, mockSessionWrites: sessions - concurrentBefore.sessions, mockLinks: links - concurrentBefore.links },
  concurrentStatuses[0] === 200 && concurrentStatuses[1] >= 400 && concurrentStatuses[1] < 500 && sessions - concurrentBefore.sessions === 1 && links - concurrentBefore.links === 1);

const invalidCase = await challenge();
const other = privateKeyToAccount(generatePrivateKey());
const invalidMessage = wallet.buildChallengeMessage(wallet.verifyChallengeCookieValue(invalidCase.cookie, account.address));
const wrongSignature = await other.signMessage({ message: invalidMessage });
const invalidBefore = { sessions, links };
const wrong = await call(verify, { ...invalidCase.body, signature: wrongSignature }, invalidCase.cookie);
check('wrong-signer-control', { status: wrong.status, mockSessionWrites: sessions - invalidBefore.sessions, mockLinks: links - invalidBefore.links },
  wrong.status === 401 && sessions - invalidBefore.sessions === 0 && links - invalidBefore.links === 0);
const validAfterWrong = await call(verify, invalidCase.body, invalidCase.cookie);
check('wrong-signer-does-not-consume-valid-challenge', { status: validAfterWrong.status, mockSessionWrites: sessions - invalidBefore.sessions, mockLinks: links - invalidBefore.links },
  validAfterWrong.status === 200 && sessions - invalidBefore.sessions === 1 && links - invalidBefore.links === 1);

for (const mode of ['error', 'throw', 'invalid']) {
  const unavailableCase = await challenge();
  const unavailableBefore = { sessions, links };
  nonceStoreMode = mode;
  const unavailable = await call(verify, unavailableCase.body, unavailableCase.cookie);
  nonceStoreMode = 'normal';
  check(`nonce-store-${mode}-fails-closed`, { status: unavailable.status, mockSessionWrites: sessions - unavailableBefore.sessions, mockLinks: links - unavailableBefore.links },
    unavailable.status === 503 && sessions - unavailableBefore.sessions === 0 && links - unavailableBefore.links === 0);
}

const lostResponseCase = await challenge();
const lostResponseBefore = { sessions, links };
nonceStoreMode = 'commit-then-error';
const lostResponse = await call(verify, lostResponseCase.body, lostResponseCase.cookie);
nonceStoreMode = 'normal';
const lostResponseRetry = await call(verify, lostResponseCase.body, lostResponseCase.cookie);
check('committed-claim-with-lost-response-fails-closed', { statuses: [lostResponse.status, lostResponseRetry.status], mockSessionWrites: sessions - lostResponseBefore.sessions, mockLinks: links - lostResponseBefore.links },
  lostResponse.status === 503 && lostResponseRetry.status >= 400 && lostResponseRetry.status < 500 && sessions - lostResponseBefore.sessions === 0 && links - lostResponseBefore.links === 0);

const downstreamCase = await challenge();
const downstreamBefore = { sessions, links };
linkMode = 'error';
const downstreamFailure = await call(verify, downstreamCase.body, downstreamCase.cookie);
linkMode = 'normal';
const retryAfterFailure = await call(verify, downstreamCase.body, downstreamCase.cookie);
check('failed-auth-does-not-restore-consumed-nonce', { statuses: [downstreamFailure.status, retryAfterFailure.status], mockSessionWrites: sessions - downstreamBefore.sessions, mockLinks: links - downstreamBefore.links },
  downstreamFailure.status === 500 && retryAfterFailure.status >= 400 && retryAfterFailure.status < 500 && sessions - downstreamBefore.sessions === 0 && links - downstreamBefore.links === 1);

if (findings.length) {
  process.stderr.write(JSON.stringify({ result: 'FAIL', reason: 'A valid signed nonce was not consumed once by the route', failedScenarios: findings }) + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('PASS: replay checks rejected duplicate signed challenges in synthetic request contexts.\n');
}
