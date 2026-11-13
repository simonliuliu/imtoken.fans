// Real Server Action and moderation pipeline handlers, with synthetic services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const actionCode = compile('../../src/app/admin/actions.ts');
const pipelineCode = compile('../../src/lib/moderation/pipeline.ts');
const trashCode = compile('../../src/lib/admin-moderation.ts');
const adminProfile = { id: 'admin-id', role: 'admin', permissions: {} };
const memberProfile = { id: 'member-id', role: 'member', permissions: { moderate_comments: true } };
let profile = adminProfile, rpcResult, queue, calls, queryCalls, revalidations, badgeCalls, xpCalls, afters, moderationModes, contentRow, mutationFound;
const hasPermission = (actor, key) => actor.role === 'admin' || actor.role === 'member' && actor.permissions[key] === true;
function reset() {
  profile = adminProfile; rpcResult = { data: { revision: 1, author_id: 'author-id' }, error: null };
  queue = { id: 'queue-id', target_type: 'submission', target_id: 'submission-id' };
  contentRow = null; mutationFound = true;
  calls = []; queryCalls = []; revalidations = []; badgeCalls = []; xpCalls = []; afters = []; moderationModes = [];
}
const client = {
  async rpc(name, args) { calls.push({ name, args }); return rpcResult; },
  from(table) {
    let operation = 'select', value = null, filters = [];
    const builder = {
      select() { return builder; }, eq(key, input) { filters.push(['eq', key, input]); return builder; }, is(key, input) { filters.push(['is', key, input]); return builder; },
      update(input) { operation = 'update'; value = input; return builder; },
      insert(input) { operation = 'insert'; value = input; return builder; },
      async maybeSingle() {
        queryCalls.push({ table, operation, value, filters });
        if (table === 'moderation_queue' && operation === 'select') return { data: queue, error: null };
        if ((table === 'submissions' || table === 'comments') && operation === 'select') return { data: contentRow, error: null };
        if (table === 'submissions' && operation === 'update') return { data: mutationFound ? { id: 'submission-id' } : null, error: null };
        if (table === 'comments' && operation === 'update') return { data: { user_id: 'comment-author' }, error: null };
        return { data: null, error: null };
      },
      then(resolve, reject) { queryCalls.push({ table, operation, value }); return Promise.resolve({ data: null, error: null }).then(resolve, reject); },
    };
    return builder;
  },
};
const modules = {
  'next/cache': { revalidatePath: (...args) => revalidations.push(args) },
  '@/lib/supabase/admin': { createAdminClient: () => client },
  '@/lib/admin-guard': {
    hasPermission,
    requirePermission: async (key) => !profile ? { error: '请先登录' } : hasPermission(profile, key) ? { profile } : { error: '没有权限执行这个操作' },
    requireAdminForAction: async () => profile?.role === 'admin' ? { profile } : { error: '没有管理员权限' },
  },
  '@/lib/profile': { getCurrentProfile: async () => profile },
  '@/lib/admin-moderation': { purgeContent() {}, restoreContent() {}, softDeleteContent() {} },
  '@/lib/badges': { refreshBadgesForUser: async (id) => { badgeCalls.push(id); } },
  '@/lib/notify': { notifyBadgeAwarded() {} },
  '@/lib/xp': { awardXpByRule: async (input) => { xpCalls.push(input); }, revokeContentXp: async (...args) => { xpCalls.push(args); } },
  '@/lib/types': { BADGE_INFO: {}, PERMANENT_MUTE_UNTIL: '', muteDurationLabel: () => '' },
};
function load(code, imports) {
  const output = { exports: {} };
  vm.runInNewContext(code, { module: output, exports: output.exports, require(name) { assert(name in imports, name); return imports[name]; }, console: { error() {} }, Date, Number, Set });
  return output.exports;
}
const actions = load(actionCode, modules);
const trash = load(trashCode, { 'server-only': {}, '@/lib/supabase/admin': modules['@/lib/supabase/admin'], '@/lib/xp': modules['@/lib/xp'] });
let passed = 0;
async function test(name, run) { reset(); await run(); console.log('PASS', name); passed++; }

await test('anonymous and unprivileged users cannot query the review queue', async () => {
  profile = null; assert((await actions.moderateQueueItem('queue-id', 'approved')).error); assert.equal(queryCalls.length, 0);
  profile = { id: 'user-id', role: 'user', permissions: {} }; assert((await actions.moderateQueueItem('queue-id', 'approved')).error); assert.equal(queryCalls.length, 0);
});
await test('comment-only member cannot approve a submission', async () => {
  profile = memberProfile; assert((await actions.moderateQueueItem('queue-id', 'approved')).error); assert.equal(calls.length, 0);
});
await test('submission queue approval invokes the transactional RPC with actor and queue', async () => {
  const result = await actions.moderateQueueItem('queue-id', 'approved', 'review reason');
  assert.equal(result.error, undefined); assert.equal(calls.length, 1); assert.equal(calls[0].name, 'admin_moderate_submission');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), { p_actor: 'admin-id', p_submission: 'submission-id', p_expected_revision: null, p_status: 'published', p_queue: 'queue-id', p_reason: 'review reason' });
  assert.equal(queryCalls.filter((entry) => entry.operation === 'update').length, 0); assert.equal(xpCalls.length, 0); assert.deepEqual(badgeCalls, ['author-id']); assert(revalidations.length);
});
await test('list status change requires revision and passes it to the RPC', async () => {
  assert((await actions.setSubmissionStatus('submission-id', 'published')).error); assert.equal(calls.length, 0);
  const result = await actions.setSubmissionStatus('submission-id', 'published', 4);
  assert.equal(result.revision, 1); assert.equal(calls[0].args.p_expected_revision, 4); assert.equal(calls[0].args.p_actor, 'admin-id');
});
await test('stale, missing-RPC and malformed responses never fall back to old writes', async () => {
  for (const error of [{ message: 'moderation_conflict' }, { message: 'function unavailable' }]) {
    rpcResult = { data: null, error }; const before = revalidations.length;
    assert((await actions.setSubmissionStatus('submission-id', 'published', 0)).error); assert.equal(revalidations.length, before);
  }
  rpcResult = { data: {}, error: null }; assert((await actions.setSubmissionStatus('submission-id', 'published', 0)).error);
  assert.equal(queryCalls.filter((entry) => entry.operation === 'update').length, 0);
});
await test('database-level revoked permission is returned as a refusal', async () => {
  profile = { id: 'member-id', role: 'member', permissions: { moderate_submissions: true } };
  rpcResult = { data: null, error: { message: 'moderation_forbidden' } };
  const result = await actions.setSubmissionStatus('submission-id', 'published', 0); assert(result.error.includes('权限')); assert.equal(revalidations.length, 0);
});
await test('comment moderation retains its existing permission and action path', async () => {
  profile = memberProfile; queue = { id: 'queue-id', target_type: 'comment', target_id: 'comment-id' };
  const result = await actions.moderateQueueItem('queue-id', 'approved'); assert.equal(result.error, undefined);
  assert.equal(calls.length, 0); assert(queryCalls.some((entry) => entry.table === 'comments' && entry.operation === 'update'));
  assert.equal(xpCalls[0].action, 'comment_posted');
});
await test('invalid review decision is rejected before accessing privileged data', async () => {
  assert((await actions.moderateQueueItem('queue-id', 'unexpected')).error); assert.equal(queryCalls.length, 0);
});
await test('submission deletion fences stale reads and leaves XP to the database transaction', async () => {
  contentRow = { id: 'submission-id', status: 'published', deleted_at: null, submitted_by: 'author-id', type: 'product' };
  assert.equal((await trash.softDeleteContent({ kind: 'submission', id: 'submission-id', actorId: 'admin-id' })).error, undefined);
  const update = queryCalls.find((entry) => entry.table === 'submissions' && entry.operation === 'update');
  assert(update.filters.some((entry) => entry[0] === 'is' && entry[1] === 'deleted_at' && entry[2] === null)); assert.equal(xpCalls.length, 0);
  mutationFound = false; assert((await trash.softDeleteContent({ kind: 'submission', id: 'submission-id', actorId: 'admin-id' })).error);
});
await test('submission restore binds the trash cycle and avoids a delayed XP award', async () => {
  contentRow = { id: 'submission-id', status: 'rejected', deleted_at: '2026-11-04T00:00:00Z', deleted_prev_status: 'published', submitted_by: 'author-id', type: 'product' };
  assert.equal((await trash.restoreContent('submission', 'submission-id', 'admin-id')).error, undefined);
  const update = queryCalls.find((entry) => entry.table === 'submissions' && entry.operation === 'update');
  assert(update.filters.some((entry) => entry[0] === 'eq' && entry[1] === 'deleted_at' && entry[2] === contentRow.deleted_at)); assert.equal(xpCalls.length, 0);
  mutationFound = false; assert((await trash.restoreContent('submission', 'submission-id', 'admin-id')).error);
});

await test('new submissions remain human review even when the old mode is AI', async () => {
  const imports = {
    'server-only': {}, 'next/server': { after: (fn) => afters.push(fn) },
    '@/lib/supabase/server': { createClient: async () => ({}) }, '@/lib/supabase/admin': { createAdminClient: () => client },
    '@/lib/moderation/settings': { getModerationMode: async () => { moderationModes.push('queried'); return 'ai'; } },
    '@/lib/moderation/ai-review': { runAiModeration: async () => ({ approved: true }) },
    '@/lib/xp': modules['@/lib/xp'], '@/lib/badges': modules['@/lib/badges'],
  };
  const pipeline = load(pipelineCode, imports);
  const result = await pipeline.runModerationPipeline({ targetType: 'submission', targetId: 'submission-id', content: 'Synthetic', authorId: 'author-id' });
  assert.equal(result, 'pending'); assert.equal(moderationModes.length, 0); assert.equal(afters.length, 0);
  assert.equal(queryCalls.find((entry) => entry.table === 'moderation_queue').value.source, 'human');
});
console.log(`${passed} actual moderation action checks passed; services mocked.`);
