/** Name projection regression. Runs only against the existing ephemeral PGlite QA base. */
import { db, ids, as, ok, denied, results } from './feedback-security-base.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
await db.exec(`create function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;`);
await db.exec(await fs.readFile(new URL('../../supabase/migrations/0025_product_feedback.sql', import.meta.url), 'utf8'));
await db.exec(await fs.readFile(new URL('../../supabase/migrations/0026_feedback_forum_names.sql', import.meta.url), 'utf8'));
const wallet = `0x${'a'.repeat(40)}`;
const name = async (display, username) => (await db.query('select feedback_forum_name($1,$2) label', [display, username])).rows[0].label;
const cases = [
  ['custom forum nickname wins', ' 小林 ', 'lin', '小林'],
  ['missing nickname uses forum handle', null, 'forum_member', 'forum_member'],
  ['full wallet default uses chosen handle', wallet, 'chosen_handle', 'chosen_handle'],
  ['uppercase wallet default is excluded', wallet.toUpperCase(), 'alice', 'alice'],
  ['shortened wallet default uses handle', '0xabcd...1234', 'alice', 'alice'],
  ['unicode shortened wallet uses handle', '0xabcd…1234', 'alice', 'alice'],
  ['synthetic wallet email is excluded', `${wallet}@wallet.imaihunt.internal`, 'alice', 'alice'],
  ['real email is not a forum nickname', 'reader@example.test', 'alice', 'alice'],
  ['empty nickname uses handle', '  ', 'alice', 'alice'],
  ['automatic wallet handle is not a fallback', wallet, wallet.slice(0, 20), null],
  ['missing valid handle returns no name', wallet, null, null],
  ['invalid handle cannot leak email', null, 'reader@example.test', null],
];
for (const [label, display, username, expected] of cases) await ok(label, async () => assert.equal(await name(display, username), expected));
for (const role of ['anon', 'authenticated']) await denied(`${role} cannot execute name helper`, () => as(role, 'user', () => db.query("select feedback_forum_name('name','handle')")));
await db.query('update profiles set display_name=$1,username=$2 where id=$3', [wallet, 'chosen_handle', ids.user]);
await db.query('update profiles set display_name=$1,username=$2 where id=$3', ['社区昵称', 'other', ids.other]);
const postId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', commentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', replyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const write = (action, payload) => db.query('select feedback_write($1,$2::jsonb) result', [action, JSON.stringify(payload)]).then((r) => r.rows[0].result);
const read = (id = null) => db.query('select feedback_read($1) result', [id]).then((r) => r.rows[0].result);
await as('authenticated', 'user', async () => {
  await write('create', { id: postId, title: 'Real feedback title', description: 'Real description', module: 'wallet' });
  await write('comment', { id: postId, request_id: commentId, body: 'Root comment' });
});
await as('authenticated', 'other', () => write('comment', { id: postId, request_id: replyId, parent_id: commentId, body: 'Reply comment' }));
await ok('list/detail/comment/reply author projections consistently use forum names', () => as('anon', null, async () => {
  const data = await read(postId);
  assert.equal(data.posts[0].author_name, 'chosen_handle'); assert.equal(data.selected.author_name, 'chosen_handle');
  assert.equal(data.comments.find((c) => c.id === commentId).author_name, 'chosen_handle');
  const reply = data.comments.find((c) => c.id === replyId); assert.equal(reply.author_name, '社区昵称'); assert.equal(reply.parent_author_name, 'chosen_handle');
  assert(!JSON.stringify(data).includes(wallet)); assert(!JSON.stringify(data).includes('wallet.imaihunt.internal'));
}));
await ok('updated chosen forum nickname takes precedence without rewriting posts', async () => {
  await db.query('update profiles set display_name=$1 where id=$2', ['新的论坛昵称', ids.user]);
  await as('anon', null, async () => assert.equal((await read(postId)).selected.author_name, '新的论坛昵称'));
});
await as('authenticated', 'admin', () => write('edit', { id: postId, version: 1, title: 'Real feedback title', description: 'Real description', module: 'wallet', status: 'inbox', mark: 'none', visibility: 'hidden' }));
await ok('name migration preserves hidden-post filtering', () => as('anon', null, async () => assert.equal((await read()).total, 0)));
await denied('hidden detail remains inaccessible to anonymous readers', () => as('anon', null, () => read(postId)));
await denied('card helper remains private', () => as('authenticated', 'user', () => db.query('select feedback_card($1)', [postId])));
await denied('write privilege remains unavailable to anonymous users', () => as('anon', null, () => write('vote', { id: postId, supported: true })));

const compiled = ts.transpileModule(await fs.readFile(new URL('../../src/lib/feedback-author.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {}; vm.runInNewContext(compiled, { exports });
await ok('old-RPC frontend fallback suppresses wallet/email and preserves normal names', async () => {
  for (const raw of [wallet, wallet.slice(0, 20), '0xabcd...1234', '0xabcd…1234', 'reader@example.test', null]) assert.equal(exports.feedbackForumName(raw), null);
  assert.equal(exports.feedbackForumName('  社区昵称  '), '社区昵称'); assert.equal(exports.feedbackForumName('chosen_handle'), 'chosen_handle');
});
for (const result of results) console.log(`${result.result} ${result.name}${result.message ? `: ${result.message}` : ''}`);
console.log(`${results.filter((result) => result.result === 'PASS').length}/${results.length} name projection checks passed. This is simulated PostgreSQL, not the target Supabase.`);
await db.close(); if (results.some((result) => result.result === 'FAIL')) process.exit(1);
