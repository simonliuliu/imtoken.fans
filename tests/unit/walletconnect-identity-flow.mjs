import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const deny = () => { throw new Error('Network forbidden in independent identity QA'); };
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };
http.request = http.get = https.request = https.get = deny;
net.Socket.prototype.connect = tls.connect = deny;

function load(file, imports = {}, globals = {}) {
  const target = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(repo, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module: target,
    exports: target.exports,
    require: id => id in imports ? imports[id] : require(id),
    Buffer,
    Date,
    ...globals,
  });
  return target.exports;
}

// Entirely synthetic stores. No environment file, external API or database is read.
const cookieJar = new Map();
const tokens = new Map();
const profiles = new Map();
let loggedIn = null;
let issued = 0;
const cookies = {
  get: key => cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
  set: (key, value) => cookieJar.set(key, value),
  delete: key => cookieJar.delete(key),
};
const wallet = load('src/lib/wallet.ts', { 'server-only': {} }, {
  process: { env: { WALLET_AUTH_SECRET: randomBytes(32).toString('hex') } },
});
const admin = {
  from: () => ({
    select: () => ({
      eq: (_, address) => ({
        maybeSingle: async () => ({ data: profiles.has(address) ? { id: profiles.get(address) } : null }),
      }),
    }),
  }),
  auth: {
    admin: {
      createUser: async ({ email, user_metadata }) => {
        profiles.set(user_metadata.wallet_address, email);
        return { error: null };
      },
      generateLink: async ({ email }) => {
        const token = randomUUID();
        tokens.set(token, email);
        return { data: { properties: { hashed_token: token } }, error: null };
      },
    },
  },
};
const imports = {
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  'next/headers': { cookies: async () => cookies },
  'next-intl/server': { getTranslations: async () => key => key },
  '@/i18n/routing': { routing: { locales: ['zh', 'en'], defaultLocale: 'zh' } },
  '@/lib/wallet': wallet,
  '@/lib/supabase/config': { isSupabaseConfigured: () => true },
  '@/lib/supabase/admin': { createAdminClient: () => admin },
  '@/lib/supabase/server': {
    createClient: async () => ({
      auth: {
        verifyOtp: async ({ token_hash }) => {
          assert(tokens.has(token_hash));
          loggedIn = tokens.get(token_hash);
          issued += 1;
          return { error: null };
        },
      },
    }),
  },
};
const nonce = load('src/app/api/auth/wallet/nonce/route.ts', imports).POST;
const verify = load('src/app/api/auth/wallet/verify/route.ts', imports).POST;
const sessionGuard = load('src/lib/walletconnect-session.ts');
const signInLock = load('src/lib/wallet-sign-in-lock.ts');
function request(url, body) {
  return new Request('https://synthetic.invalid' + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

for (const locale of ['zh', 'en']) {
  const account = privateKeyToAccount(generatePrivateKey());
  let signAs = account;
  let disconnected = 0;
  const provider = {
    chainId: 1,
    accounts: [account.address],
    session: {
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: { eip155: { accounts: [`eip155:1:${account.address}`], methods: ['personal_sign'] } },
    },
    connect: async () => {},
    disconnect: async () => { disconnected += 1; },
    request: async args => {
      assert.equal(args.method, 'personal_sign');
      assert.equal(args.params[1], account.address);
      return signAs.signMessage({ message: args.params[0] });
    },
  };
  const client = load('src/lib/wallet-client.ts', {
    '@/lib/walletconnect-session': sessionGuard,
    '@/lib/wallet-sign-in-lock': signInLock,
    '@walletconnect/ethereum-provider': { EthereumProvider: { init: async () => provider } },
  }, {
    process: { env: { NEXT_PUBLIC_REOWN_PROJECT_ID: 'synthetic-project' } },
    document: { documentElement: { lang: locale } },
    window: { location: { origin: 'https://synthetic.invalid' } },
    fetch: async (url, options) => url.endsWith('/nonce')
      ? nonce(request(url, JSON.parse(options.body)))
      : verify(request(url, JSON.parse(options.body))),
  });
  const messages = {
    walletConnectUnauthorized: 'unauthorized', walletSignInInProgress: 'busy',
    walletSignInCoordinationUnavailable: 'unavailable', nonceFailed: 'nonce failed', verifyFailed: 'verify failed',
  };
  const before = issued;
  const result = await client.connectWalletConnectAndSignIn(messages);
  assert.equal(result.address, account.address);
  assert.equal(loggedIn, wallet.walletSyntheticEmail(account.address));
  assert.equal(issued, before + 1);
  assert.equal(disconnected, 1);
  const previousIdentity = loggedIn;
  signAs = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(client.connectWalletConnectAndSignIn(messages), /signatureInvalid/);
  assert.equal(loggedIn, previousIdentity);
  assert.equal(issued, before + 1);
  console.log(JSON.stringify({ locale, validSignature: 'CORRECT_SYNTHETIC_IDENTITY', wrongSigner: 'REJECTED_WITHOUT_SESSION_WRITE' }));
}

const first = privateKeyToAccount(generatePrivateKey());
const second = privateKeyToAccount(generatePrivateKey());
const firstNonce = await (await nonce(request('/nonce', { address: first.address, locale: 'en' }))).json();
await nonce(request('/nonce', { address: second.address, locale: 'en' }));
const before = issued;
const signature = await first.signMessage({ message: firstNonce.message });
const rejected = await verify(request('/verify', { address: first.address, signature, locale: 'en' }));
assert.equal(rejected.status, 400);
assert.equal(issued, before);
console.log(JSON.stringify({ scenario: 'second-nonce-overwrites-first-address', result: 'REJECTED_WITHOUT_SESSION_WRITE' }));
console.log('PASS: 5 isolated identity assertions; real client, guard, nonce, HMAC, verify and viem; mocked HTTP, cookies, translations, admin and OTP stores.');
