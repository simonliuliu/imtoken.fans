// Actual feedback Server Actions with isolated auth/RPC doubles.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const ID = '11111111-1111-4111-8111-111111111111';
function load(file, imports = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports: testModule.exports, module: testModule, process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'http://localhost', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fictional-key' } }, require(name) { assert(name in imports, name); return imports[name]; } });
  return testModule.exports;
}
const feedback = load('../../src/lib/feedback.ts');
function host({ rpcError = null, user = ID, role = 'user' } = {}) {
  const calls = [];
  const query = { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { role, muted_until: null } }; }, then(resolve) { resolve({ data: [] }); } };
  const actions = load('../../src/app/actions/feedback.ts', {
    'next/cache': { revalidatePath() {} }, 'next-intl/server': { getTranslations: async () => (key) => key },
    '@/lib/feedback': feedback,
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user ? { id: user } : null } }) }, from: () => query, rpc: async (...args) => { calls.push(args); return rpcError ? { error: rpcError } : { data: args[0] === 'feedback_read' ? { posts: [], viewer: { user_id: user } } : { id: ID } }; } }) },
  });
  return { ...actions, calls };
}
const payload = (extra = {}) => ({ id: ID, expected_user_id: ID, title: 'Forum issue', description: 'Reproducible forum issue', module: 'forum', kind: 'bug', details: { steps: 'Open a notification' }, ...extra });
test('forum creation sends structured fields to the actual RPC', async () => { const h = host(); assert((await h.writeFeedback('create', payload())).ok); assert.equal(h.calls[0][1].p_payload.details.steps, 'Open a notification'); });
test('forum and product filters reach the existing read RPC', async () => { for (const feedbackScope of ['forum', 'product']) { const h = host(); assert((await h.readFeedback({ module: feedbackScope })).ok); assert.equal(h.calls[0][1].p_module, feedbackScope); } });
test('legacy product creation without structured data remains compatible', async () => { const h = host(); assert((await h.writeFeedback('create', payload({ module: 'wallet', kind: undefined, details: undefined }))).ok); });
for (const extra of [{ kind: undefined }, { kind: 'shell' }, { details: { command: 'anything' } }, { details: { steps: 123 } }, { details: { device: 'invalid' } }, { details: { steps: 'x'.repeat(2001) } }]) {
  test(`invalid structured forum input is rejected before RPC: ${Object.keys(extra)}`, async () => { const h = host(); assert.equal((await h.writeFeedback('create', payload(extra))).code, 'invalid'); assert.equal(h.calls.length, 0); });
}
test('SQL scope guard maps to a translated failure without exposing internals', async () => { const h = host({ role: 'admin', rpcError: { message: 'feedback_scope' } }); const result = await h.writeFeedback('merge', { id: ID, other_id: ID, version: 1, other_version: 1, expected_user_id: ID }); assert.equal(result.code, 'scope'); });
test('foreign-account forum submissions never reach the RPC', async () => { const h = host({ user: '22222222-2222-4222-8222-222222222222' }); assert.equal((await h.writeFeedback('create', payload())).code, 'sign_in'); assert.equal(h.calls.length, 0); });
