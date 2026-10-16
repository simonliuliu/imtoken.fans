import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { LOCAL_DEV_ACCOUNTS, isLocalDevAuthConfigured, isLocalDevAuthRequestAllowed, localDevAccount } from '../src/lib/local-dev-auth.ts';

const base = { NODE_ENV: 'development', LOCAL_DEV_AUTH_ENABLED: 'true', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SITE_URL: 'http://localhost:4000' };
const request = { host: 'localhost:4000', origin: 'http://localhost:4000' };
const source = await readFile('src/app/[locale]/dev/login/actions.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
let checks = 0;
const forbidden = [
  { label: 'production', env: { ...base, NODE_ENV: 'production' } },
  { label: 'test mode', env: { ...base, NODE_ENV: 'test' } },
  { label: 'disabled', env: { ...base, LOCAL_DEV_AUTH_ENABLED: 'false' } },
  { label: 'missing opt-in', env: { ...base, LOCAL_DEV_AUTH_ENABLED: undefined } },
  { label: 'remote database', env: { ...base, NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co' } },
  { label: 'different local service', env: { ...base, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54329' } },
  { label: 'remote site', env: { ...base, NEXT_PUBLIC_SITE_URL: 'https://example.test' } },
  { label: 'wrong site port', env: { ...base, NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' } },
  { label: 'remote host', req: { ...request, host: 'example.test' } },
  { label: 'wrong origin', req: { ...request, origin: 'https://example.test' } },
  { label: 'origin missing on POST', req: { ...request, origin: null } },
  { label: 'cross-loopback origin', req: { ...request, origin: 'http://127.0.0.1:4000' } },
  { label: 'malformed host', req: { ...request, host: 'localhost:4000@outside.test' } },
];

function action(env, req, actor = LOCAL_DEV_ACCOUNTS[0]) {
  const state = { clients: 0, credentialsRead: 0, signedOut: false };
  const environment = { ...env };
  Object.defineProperty(environment, 'LOCAL_DEV_AUTH_PASSWORD', { get() { state.credentialsRead++; return 'unit-test-only'; } });
  const mocks = {
    'next/headers': { headers: async () => new Headers({ ...(req.host ? { host: req.host } : {}), ...(req.origin ? { origin: req.origin } : {}) }) },
    'next/navigation': { notFound: () => { throw new Error('DENIED'); } },
    'next-intl/server': { getLocale: async () => 'zh' },
    '@/lib/local-dev-auth': { isLocalDevAuthRequestAllowed, localDevAccount },
    '@/lib/auth-navigation': { getAuthReturnPath: (path) => path === '/zh/community/discussion' ? path : '/zh' },
    '@/lib/supabase/server': { createClient: async () => {
      state.clients++;
      return { auth: {
        signInWithPassword: async ({ email }) => { assert.equal(email, actor.email); return { data: { user: { id: actor.userId, app_metadata: { local_dev_auth: true } } }, error: null }; },
        signOut: async () => { state.signedOut = true; },
      } };
    } },
  };
  const loaded = { exports: {} };
  const require = id => { assert(id in mocks, `Unexpected dependency ${id}`); return mocks[id]; };
  new Function('require', 'exports', 'module', 'process', compiled)(require, loaded.exports, loaded, { env: environment });
  return { invoke: loaded.exports.signInLocalDev, state };
}

for (const item of forbidden) {
  const test = action(item.env ?? base, item.req ?? request);
  await assert.rejects(test.invoke('admin', '/zh'), /DENIED/);
  assert.equal(test.state.clients, 0);
  assert.equal(test.state.credentialsRead, 0);
  console.log(`PASS ${item.label} rejected before credentials or client access`);
  checks++;
}
for (const key of ['unknown', null, {}, '__proto__', 'local.dev.admin@example.test']) {
  const test = action(base, request);
  assert.deepEqual(await test.invoke(key, '/zh'), {});
  assert.equal(test.state.clients, 0);
  assert.equal(test.state.credentialsRead, 0);
  checks++;
}
for (const account of LOCAL_DEV_ACCOUNTS) {
  const test = action(base, request, account);
  const result = await test.invoke(account.key, '/zh/community/discussion');
  assert.equal(result.redirectTo, account.role === 'admin' ? '/admin' : '/zh/community/discussion');
  assert.equal(test.state.clients, 1);
  checks++;
}
const duplicateReturn = action(base, request);
assert.equal((await duplicateReturn.invoke('userA', ['/zh', '/en'])).redirectTo, '/zh');
checks++;
const replacedIdentity = action(base, request, { ...LOCAL_DEV_ACCOUNTS[0], userId: 'unexpected-user-id' });
assert.deepEqual(await replacedIdentity.invoke('userA', '/zh'), {});
assert.equal(replacedIdentity.state.signedOut, true);
checks++;
assert(isLocalDevAuthConfigured(base));
assert(isLocalDevAuthRequestAllowed(base, { host: '127.0.0.1:4000', origin: null }, false));
assert(!isLocalDevAuthRequestAllowed(base, { host: 'outside.test', origin: null }, false));
console.log(`Local dev auth boundary tests passed: ${checks} action cases plus GET policy checks.`);
