// Runs the actual normalization and tracking handler in a VM; no network or real database.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = fileURLToPath(new URL('../..', import.meta.url));
const ts = createRequire(import.meta.url)('typescript');
function load(file, imports, globals = {}) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(readFileSync(`${root}/${file}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, URL, Headers, Request, console,
    require(name) { if (!(name in imports)) throw Error(`Unexpected import ${name}`); return imports[name]; }, ...globals }, { filename: file });
  return loaded.exports;
}
const analytics = load('src/lib/analytics.ts', {});
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('community UUIDs, legacy slugs and both locales map to bounded routes', () => {
  for (const prefix of ['', '/zh', '/en']) {
    const uuid = analytics.normalizePath(`${prefix}/community/discussion/${id}?secret=hidden#reply`);
    assert.equal(uuid.route, '/community/discussion/[id]');
    assert.equal(uuid.contentId, id);
    assert(!uuid.path.includes('secret'));
    assert(!uuid.path.includes('#'));
    const legacy = analytics.normalizePath(`${prefix}/community/safety/approval-checklist`);
    assert.equal(legacy.route, '/community/safety/[id]');
    assert.equal(legacy.contentId, null);
    assert.equal(analytics.normalizePath(`${prefix}/products/${id}`).contentId, id);
    assert.equal(analytics.normalizePath(`${prefix}/community/safety`).route, '/community/safety');
  }
});

test('invalid boards, extra path parts and URL payloads cannot become community content', () => {
  for (const path of ['/community/admin/' + id, '/community/safety/a/b', '/community/safety/a%2Fb', '/community/safety/@private', '/community/safety/' + 'a'.repeat(81)]) {
    assert.equal(analytics.communityAnalyticsTarget(path), null);
    assert.equal(analytics.normalizePath(path).contentId, null);
  }
  for (const path of ['/api/private', '/zh/admin/users', '/en/auth/callback?token=secret', '/en/_next/static/file']) assert.equal(analytics.isTrackablePath(path), false);
});

function trackingHarness(posts, failure = false) {
  const saved = [];
  class NextResponse {
    constructor(_, options) { this.status = options.status; this.cookies = { set() {} }; }
  }
  const admin = { from(table) {
    if (table === 'page_views') return { async insert(value) { saved.push(value); return { error: null }; } };
    assert.equal(table, 'submissions');
    const conditions = [];
    const query = {
      select() { return query; },
      eq(key, value) { conditions.push([key, value]); return query; },
      is(key, value) { conditions.push([key, value]); return query; },
      async maybeSingle() {
        if (failure) throw Error('Simulated read failure');
        return { data: posts.find(post => conditions.every(([key, value]) => post[key] === value)) ?? null, error: null };
      },
    };
    return query;
  } };
  const route = load('src/app/api/analytics/track/route.ts', {
    'next/server': { NextResponse },
    'next/headers': { headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 Safari/605.1', host: 'community.example' }), cookies: async () => ({ get: () => ({ value: id }) }) },
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) },
    '@/lib/supabase/admin': { createAdminClient: () => admin },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/lib/analytics': analytics,
  }, { process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'isolated-test-placeholder', NODE_ENV: 'test' } } });
  return { saved, post: path => route.POST(new Request('https://community.example/api/analytics/track', { method: 'POST', body: JSON.stringify({ path, contentId: 'forged-client-id', referrer: 'https://referrer.example/private?token=hidden' }) })) };
}
const publicPost = { id, type: 'post', community_section: 'safety', legacy_slug: 'approval-checklist', status: 'published', deleted_at: null };

test('tracking handler resolves legacy slug to public post UUID and strips URL secrets', async () => {
  const h = trackingHarness([publicPost]);
  assert.equal((await h.post('/zh/community/safety/approval-checklist?token=hidden#comment-private')).status, 204);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].content_id, id);
  assert.equal(h.saved[0].route, '/community/safety/[id]');
  assert.equal(h.saved[0].path, '/zh/community/safety/approval-checklist');
  assert.equal(h.saved[0].referrer_host, 'referrer.example');
});

test('UUID content attribution validates board, type, public status and deletion on the server', async () => {
  for (const [post, path] of [
    [publicPost, '/en/community/discussion/' + id],
    [{ ...publicPost, status: 'pending' }, '/en/community/safety/' + id],
    [{ ...publicPost, deleted_at: '2026-10-16' }, '/en/community/safety/' + id],
    [{ ...publicPost, type: 'product' }, '/en/community/safety/' + id],
  ]) {
    const h = trackingHarness([post]);
    await h.post(path);
    assert.equal(h.saved[0].content_id, null);
  }
  const valid = trackingHarness([publicPost]);
  await valid.post('/en/community/safety/' + id);
  assert.equal(valid.saved[0].content_id, id);
});

test('unknown slugs or resolution failure remain anonymous page views; ignored paths do not write', async () => {
  for (const h of [trackingHarness([]), trackingHarness([publicPost], true)]) {
    assert.equal((await h.post('/community/safety/approval-checklist')).status, 204);
    assert.equal(h.saved[0].content_id, null);
  }
  const h = trackingHarness([publicPost]);
  await h.post('/en/admin/users?token=hidden');
  assert.equal(h.saved.length, 0);
});
