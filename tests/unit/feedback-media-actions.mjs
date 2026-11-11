// Actual server actions executed with synthetic auth, RPC and Storage doubles.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const draft = '44444444-4444-4444-8444-444444444444';
const token = '55555555-5555-4555-8555-555555555555';
const bytes = Uint8Array.from([1, 2, 3, 4]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const stage = `staging/${owner}/${id}`, verified = `verified/${owner}/${id}`, bucket = 'feedback-media-images';

function host(options = {}) {
  const calls = [];
  const lease = { id, state: 'validating', token, bucket, staging_path: stage, verified_path: verified, type: 'image/png', size: bytes.length, ...options.lease };
  const storage = {
    async createSignedUploadUrl(path, settings) { calls.push(['sign', path, settings]); return { data: { path, token: 'fictional-upload-token' }, error: null }; },
    async download(path) { calls.push(['download', path]); const value = path === verified ? options.previous ?? bytes : options.source ?? bytes; return { data: new Blob([value]), error: null }; },
    async upload(path, value, settings) { calls.push(['upload', path, Array.from(value), settings]); return { error: options.copyError ? { message: 'already exists' } : null }; },
  };
  const userClient = {
    auth: { getUser: async () => ({ data: { user: options.user === null ? null : { id: options.user ?? owner } }, error: null }) },
    rpc: async (name, args) => { calls.push(['user-rpc', name, args]); return options.rpcError ? { data: null, error: options.rpcError } : { data: name === 'feedback_media_cancel' ? { state: 'cleanup_pending' } : name === 'feedback_media_list' ? [{ id, post_id: draft, type: 'image/png', size: 4, review_state: 'approved', revision: 2, removed: false }] : name === 'feedback_media_moderate' ? { id, revision: 2 } : { id, state: 'reserved', bucket, staging_path: stage }, error: null }; },
    storage: { from: (value) => { calls.push(['user-bucket', value]); return storage; } },
  };
  const admin = {
    rpc: async (name, args) => { calls.push(['admin-rpc', name, args]); if (name === 'feedback_media_begin_validation') return { data: lease, error: null }; if (name === 'feedback_media_record_verified') return options.finishError ? { data: null, error: { message: 'feedback_media_conflict' } } : { data: { id, state: 'verified' }, error: null }; return { data: true, error: null }; },
    storage: { from: (value) => { calls.push(['admin-bucket', value]); return storage; } },
  };
  const imports = {
    'node:crypto': { createHash },
    '@/lib/supabase/server': { createClient: async () => userClient },
    '@/lib/supabase/admin': { createAdminClient: () => admin },
    '@/lib/feedback-media-limits.mjs': { FEEDBACK_MEDIA_TYPES: { 'image/png': 5 * 1024 * 1024, 'video/mp4': 30 * 1024 * 1024 } },
    '@/lib/feedback-media-inspect.mjs': { inspectFeedbackMedia: async () => options.inspect ?? { ok: true, type: 'image/png', size: bytes.length, duration: null, sha256 } },
  };
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../../src/app/actions/feedback-media.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports: testModule.exports, module: testModule, Uint8Array, AbortSignal, require(name) { assert(name in imports, name); return imports[name]; } });
  return { ...testModule.exports, calls };
}
const reservation = { id, draftId: draft, expectedUserId: owner, type: 'image/png', size: bytes.length };
const request = { id, expectedUserId: owner };
test('reservation uses authenticated owner and a non-overwriting, exact staging path', async () => {
  const h = host(); const result = await h.reserveFeedbackMedia(reservation);
  assert.equal(result.ok, true); assert.equal(result.path, stage); assert.equal(result.token, 'fictional-upload-token');
  const settings = h.calls.find((c) => c[0] === 'sign')[2];
  assert.equal(settings.upsert, false); assert.deepEqual(Object.keys(settings), ['upsert']);
});
test('another session and invalid input cannot reach RPC or Storage', async () => {
  const h = host({ user: other }); assert.equal((await h.reserveFeedbackMedia(reservation)).code, 'sign_in');
  assert.equal((await h.verifyFeedbackMedia(request)).code, 'sign_in');
  assert.equal((await h.cancelFeedbackMedia(request)).code, 'sign_in');
  assert.equal(h.calls.some((c) => c[0].includes('rpc') || c[0].includes('bucket')), false);
  const invalid = host(); assert.equal((await invalid.reserveFeedbackMedia({ ...reservation, type: 'text/html' })).code, 'invalid'); assert.equal(invalid.calls.length, 0);
});
test('array-shaped UUID values are rejected without throwing or touching storage', async () => {
  const h = host();
  assert.equal((await h.reserveFeedbackMedia({ ...reservation, id: [id] })).code, 'invalid');
  assert.equal((await h.verifyFeedbackMedia({ ...request, expectedUserId: [owner] })).code, 'invalid');
  assert.equal((await h.cancelFeedbackMedia({ ...request, id: [id] })).code, 'invalid');
  assert.equal(h.calls.length, 0);
});
test('SQL errors are sanitized and cancel marks state without deleting objects', async () => {
  const bad = host({ rpcError: { message: 'feedback_media_quota internal-secret-details' } });
  assert.equal((await bad.reserveFeedbackMedia(reservation)).code, 'quota');
  const good = host(); assert.equal((await good.cancelFeedbackMedia(request)).ok, true);
  assert.equal(good.calls.some((c) => c[0].includes('bucket')), false);
});
test('verification inspects actual bytes and copies the exact result before recording the lease', async () => {
  const h = host(); assert.equal((await h.verifyFeedbackMedia(request)).ok, true);
  const copied = h.calls.find((c) => c[0] === 'upload');
  assert.equal(copied[1], verified); assert.deepEqual(copied[2], Array.from(bytes)); assert.equal(copied[3].upsert, false);
  const completed = h.calls.find((c) => c[1] === 'feedback_media_record_verified');
  assert.equal(completed[2].p_token, token); assert.equal(completed[2].p_sha256, sha256);
  assert.equal(h.calls.some((c) => c[1] === 'feedback_media_release_validation'), false);
});
test('mismatched server paths cannot turn the service role into an arbitrary storage reader', async () => {
  for (const override of [{ bucket: 'submission-media' }, { staging_path: `staging/${other}/${id}` }, { verified_path: `verified/${owner}/${other}` }]) {
    const h = host({ lease: override }); assert.equal((await h.verifyFeedbackMedia(request)).ok, false);
    assert.equal(h.calls.some((c) => c[0] === 'admin-bucket'), false);
  }
});
test('invalid bytes and missing decoder release the lease without copying', async () => {
  for (const inspect of [{ ok: false, code: 'invalid_media' }, { ok: false, code: 'decoder_unavailable' }]) {
    const h = host({ inspect }); const result = await h.verifyFeedbackMedia(request);
    assert.equal(result.code, inspect.code === 'decoder_unavailable' ? 'unavailable' : 'invalid');
    assert.equal(h.calls.some((c) => c[0] === 'upload'), false);
    assert.equal(h.calls.some((c) => c[1] === 'feedback_media_release_validation'), true);
  }
});
test('an uncertain previous copy is reusable only when its bytes have the same digest', async () => {
  const same = host({ copyError: true }); assert.equal((await same.verifyFeedbackMedia(request)).ok, true);
  const different = host({ copyError: true, previous: Uint8Array.from([4, 3, 2, 1]) });
  assert.equal((await different.verifyFeedbackMedia(request)).ok, false);
  assert.equal(different.calls.some((c) => c[1] === 'feedback_media_record_verified'), false);
});
test('cancelled or expired verification is not reported successful', async () => {
  const h = host({ finishError: true }); assert.equal((await h.verifyFeedbackMedia(request)).code, 'conflict');
  assert.equal(h.calls.some((c) => c[1] === 'feedback_media_release_validation'), true);
});
test('media lists and moderation use the constrained database projections', async () => {
  const h = host({ user: null }); const list = await h.readFeedbackMedia(draft); assert.equal(list.ok, true); assert.equal(list.data[0].id, id);
  const admin = host(); const result = await admin.moderateFeedbackMedia({ id, expectedUserId: owner, revision: 1, action: 'approve', reason: '' });
  assert.equal(result.ok, true); assert.equal(result.revision, 2);
  const denied = host({ rpcError: { message: 'feedback_forbidden private details' } });
  assert.equal((await denied.moderateFeedbackMedia({ id, expectedUserId: owner, revision: 1, action: 'approve', reason: '' })).code, 'forbidden');
  const invalid = host(); assert.equal((await invalid.moderateFeedbackMedia({ id, expectedUserId: owner, revision: 1, action: 'reject', reason: '   ' })).code, 'invalid');
  assert.equal(invalid.calls.length, 0);
});
