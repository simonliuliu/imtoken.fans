import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

function load(file, imports = {}, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, URL, AbortSignal, Uint8Array,
    require: name => {
      if (Object.hasOwn(imports, name)) return imports[name];
      throw new Error(`Unexpected import: ${name}`);
    },
    console: { warn() {}, error() {} }, ...globals,
  });
  return exports;
}

test('login redirects stay on the site after URL normalization', () => {
  const { sanitizeRedirect } = load('src/lib/redirect.ts');
  for (const value of [null, undefined, '', 'https://outside.invalid', '//outside.invalid', '/.//outside.invalid', '/%2e//outside.invalid', '/\\outside.invalid', '/\n/outside.invalid', '/\t/outside.invalid']) {
    assert.equal(sanitizeRedirect(value), '/');
  }
  assert.equal(sanitizeRedirect('/zh/products?sort=hot#reviews'), '/zh/products?sort=hot#reviews');
});

function avatarModule(fetch) {
  return load('src/lib/avatar-mirror.ts', {
    'server-only': {}, crypto,
    '@/lib/supabase/admin': { createAdminClient() { throw new Error('Unexpected storage write'); } },
    '@/lib/media': { ALLOWED_UPLOAD_MIME_TYPES: ['image/png'], MAX_UPLOAD_SIZE_BYTES: 16, SUBMISSION_MEDIA_BUCKET: 'media' },
  }, { fetch, process: { env: {} } });
}

test('avatar callback never fetches arbitrary or internal URLs', async () => {
  let calls = 0;
  const { mirrorExternalAvatar } = avatarModule(async () => { calls++; });
  for (const url of ['http://127.0.0.1/a', 'https://169.254.169.254/a', 'https://outside.invalid/a', 'https://lh3.googleusercontent.com.evil.invalid/a', 'https://user:secret@lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com:444/a']) {
    assert.equal(await mirrorExternalAvatar('test-user', url), null);
  }
  assert.equal(calls, 0);
});

test('Google avatar fetch disables redirects and bounds streamed bytes', async () => {
  let canceled = false;
  const { mirrorExternalAvatar } = avatarModule(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return { ok: true, headers: { get: () => 'image/png' }, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(17) }), cancel: async () => { canceled = true; } }) } };
  });
  assert.equal(await mirrorExternalAvatar('test-user', 'https://lh3.googleusercontent.com/avatar'), null);
  assert.equal(canceled, true);
});

test('products stay in the human queue even when the global mode is none', async () => {
  let modeLookups = 0;
  const writes = [];
  const admin = { from: table => ({
    update: value => ({ eq: async () => { writes.push({ table, value }); } }),
    insert: async value => { writes.push({ table, value }); return { error: null }; },
  }) };
  const { runModerationPipeline } = load('src/lib/moderation/pipeline.ts', {
    'server-only': {}, 'next/server': { after() {} },
    '@/lib/supabase/server': { createClient: async () => ({}) },
    '@/lib/supabase/admin': { createAdminClient: () => admin },
    '@/lib/moderation/settings': { getModerationMode: async () => { modeLookups++; return 'none'; } },
    '@/lib/moderation/ai-review': {}, '@/lib/badges': {},
    '@/lib/xp': { awardXpByRule() { throw new Error('Pending products must not award XP'); } },
  });
  const state = await runModerationPipeline({ targetType: 'submission', targetId: 'test-id', authorId: 'test-user', content: 'test', requireManual: true });
  assert.equal(state, 'pending');
  assert.equal(modeLookups, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, 'moderation_queue');
  assert.equal(writes[0].value.source, 'human');
  assert.equal(writes[0].value.result, 'pending');
});


const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

function authHarness() {
  const initial = deferred();
  const profiles = { A: deferred(), B: deferred() };
  const updates = [];
  let callback;
  let effect;
  let stateIndex = 0;
  const client = {
    auth: {
      getUser: () => initial.promise,
      onAuthStateChange: fn => { callback = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: async () => {},
    },
    from: () => ({ select: () => ({ eq: (_column, id) => ({ maybeSingle: () => profiles[id].promise }) }) }),
  };
  const { AuthProvider } = load('src/lib/auth-context.tsx', {
    'react/jsx-runtime': { jsx: (_type, props) => props },
    react: {
      createContext: () => ({ Provider: 'provider' }), useContext() {},
      useEffect: fn => { effect = fn; }, useRef: value => ({ current: value }),
      useState: value => {
        const index = stateIndex++;
        return [typeof value === 'function' ? value() : value, next => { if (index === 0) updates.push(next); }];
      },
    },
    '@/i18n/navigation': { useRouter: () => ({ push() {} }) },
    '@/lib/supabase/client': { createClient: () => client },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/lib/derive-user': { deriveUser: user => user ? { name: user.id, identifier: user.id, method: 'password' } : null },
  }, { setTimeout });
  const provider = AuthProvider({ children: null });
  effect();
  return { initial, profiles, updates, provider, emit: user => callback('test', user ? { user } : null) };
}

test('a late profile response cannot restore a signed-out account', async () => {
  const h = authHarness();
  h.emit({ id: 'A' });
  h.emit(null);
  h.profiles.A.resolve({ data: { username: 'A' } });
  await flush();
  assert.equal(h.updates.at(-1), null);
});

test('an old initial session cannot overwrite a newer account', async () => {
  const h = authHarness();
  h.emit({ id: 'B' });
  h.profiles.B.resolve({ data: { username: 'B' } });
  await flush();
  h.initial.resolve({ data: { user: { id: 'A' } }, error: null });
  await flush();
  assert.equal(h.updates.at(-1).id, 'B');
});
