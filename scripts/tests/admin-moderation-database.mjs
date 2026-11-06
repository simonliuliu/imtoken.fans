// Isolated PostgreSQL only. No production credentials, users, or network.
import { db, ids, as, post, root } from './community-database-base.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const q = (sql, params = []) => db.query(sql, params);
const migration = (name) => fs.readFile(`${root}/supabase/migrations/${name}`, 'utf8');
for (const name of ['0029_community_post_type.sql', '0030_real_community.sql', '0031_feedback_text_validation.sql']) await db.exec(await migration(name));
const forumMigration = process.env.FORUM_FEEDBACK_SQL ?? `${root}/supabase/migrations/0032_forum_feedback_inbox.sql`;
try { await db.exec(await fs.readFile(forumMigration, 'utf8')); console.log('FORUM_MIGRATION_INCLUDED'); }
catch (error) { if (error.code !== 'ENOENT' || process.env.FORUM_FEEDBACK_SQL) throw error; }
await db.exec(await fs.readFile(`${root}/docs/operations/2026-11-04-moderation-preflight.sql`, 'utf8'));
console.log('PASS read-only moderation preflight on isolated baseline');

const legacy = await post('a', 'pending', 'product');
const legacyQueue = (await q("insert into moderation_queue(target_type,target_id,source,result) values('submission',$1,'human','pending') returning id", [legacy])).rows[0].id;
// Recreate a historical list-path publication before installing the fix.
await q("update submissions set status='published' where id=$1", [legacy]);
const legacyForum = (await as('authenticated', 'a', () => q("select community_post_create($1,$2,'discussion','questions','Legacy duplicate queue','Synthetic historical forum content') id", [ids.a, randomUUID()]))).rows[0].id;
const legacyForumQueue = (await q("select id from moderation_queue where target_type='submission' and target_id=$1", [legacyForum])).rows[0].id;
await q("insert into moderation_queue(target_type,target_id,source,result) values('submission',$1,'human','pending'),('submission',$1,'human','rejected')", [legacyForum]);
const before = {
  submissions: (await q('select id,status,deleted_at,deleted_prev_status,submitted_by from submissions order by id')).rows,
  queue: (await q('select id,target_type,target_id,result,reviewed_by,reviewed_at from moderation_queue order by id')).rows,
  xp: (await q('select id,user_id,action,ref_id,amount,revoked_at from xp_events order by id')).rows,
  notifications: (await q('select id,user_id,type from notifications order by id')).rows,
};
await db.exec(await migration('0033_submission_moderation_consistency.sql'));

let passed = 0;
async function check(name, run) { await run(); console.log('PASS', name); passed++; }
const call = (actor, id, revision, status, queue = null, reason = null) => as('service_role', null, () => q('select public.admin_moderate_submission($1,$2,$3,$4,$5,$6) result', [actor, id, revision, status, queue, reason])).then((r) => r.rows[0].result);
const state = (id) => q('select id,status,deleted_at,deleted_prev_status,moderation_revision from submissions where id=$1', [id]).then((r) => r.rows[0]);
const queues = (id) => q("select id,result,source,reviewed_by,reason from moderation_queue where target_type='submission' and target_id=$1 order by created_at,id", [id]).then((r) => r.rows);
const xp = (id, action) => q('select id,amount,revoked_at from xp_events where ref_id=$1 and action=$2', [id, action]).then((r) => r.rows);
const logs = (id) => q("select action,detail from admin_logs where target_type='submission' and target_id=$1 order by created_at,id", [id]).then((r) => r.rows);
async function product(actor = 'a') {
  const id = await post(actor, 'pending', 'product');
  const rows = await queues(id);
  assert.equal(rows.length, 1); assert.equal(rows[0].result, 'pending'); assert.equal(rows[0].source, 'human');
  const queue = rows[0].id;
  return { id, queue };
}
async function forum(actor = 'a') {
  const id = (await as('authenticated', actor, () => q("select community_post_create($1,$2,'discussion','questions','Synthetic forum title','Synthetic forum body') id", [ids[actor], randomUUID()]))).rows[0].id;
  return { id, queue: (await queues(id))[0].id };
}

await check('migration preserves historical rows and adds only revision baseline', async () => {
  assert.deepEqual((await q('select id,status,deleted_at,deleted_prev_status,submitted_by from submissions order by id')).rows, before.submissions);
  assert.deepEqual((await q('select id,target_type,target_id,result,reviewed_by,reviewed_at from moderation_queue order by id')).rows, before.queue);
  assert.deepEqual((await q('select id,user_id,action,ref_id,amount,revoked_at from xp_events order by id')).rows, before.xp);
  assert.deepEqual((await q('select id,user_id,type from notifications order by id')).rows, before.notifications);
  assert.equal((await state(legacy)).moderation_revision, 0);
  assert.equal((await q('select moderation_revision from submission_cards where id=$1', [legacy])).rows[0].moderation_revision, 0);
});

await check('product insert creates exactly one human queue and stale enqueue cannot reopen a new cycle', async () => {
  const sample = await product();
  const duplicate = await q("insert into moderation_queue(target_type,target_id,source,result) values('submission',$1,'human','pending') returning id", [sample.id]);
  assert.equal(duplicate.rows.length, 0); assert.equal((await queues(sample.id)).length, 1);
  await call(ids.admin, sample.id, 0, 'published');
  const late = await q("insert into moderation_queue(target_type,target_id,source,result) values('submission',$1,'human','pending') returning id", [sample.id]);
  assert.equal(late.rows.length, 0); assert.equal((await queues(sample.id)).filter((row) => row.result === 'pending').length, 0);
  await call(ids.admin, sample.id, 1, 'pending');
  const stale = await q("insert into moderation_queue(target_type,target_id,source,result,submission_revision) values('submission',$1,'human','pending',0) returning id", [sample.id]);
  const legacyStale = await q("insert into moderation_queue(target_type,target_id,source,result) values('submission',$1,'human','pending') returning id", [sample.id]);
  assert.equal(stale.rows.length, 0); assert.equal(legacyStale.rows.length, 0);
  assert.equal((await queues(sample.id)).filter((row) => row.result === 'pending').length, 1);
});

await check('authenticated product creation queues atomically without opening blacklisted inserts', async () => {
  const created = await as('authenticated', 'a', () => q("insert into submissions(type,title,tagline,description,submitted_by) values('product','Synthetic product','Synthetic tagline','Synthetic content',$1) returning id", [ids.a]));
  const rows = await queues(created.rows[0].id);
  assert.equal(rows.length, 1); assert.equal(rows[0].result, 'pending'); assert.equal(rows[0].source, 'human');
  await assert.rejects(() => as('authenticated', 'blocked', () => q("insert into submissions(type,title,tagline,description,submitted_by) values('product','Blocked product','Synthetic tagline','Synthetic content',$1)", [ids.blocked])));
});

await check('queue creation failure rolls back the product insert', async () => {
  const count = (await q("select count(*)::int n from submissions where type='product'")).rows[0].n;
  await db.exec("create function public.test_deny_queue() returns trigger language plpgsql as $$ begin raise exception 'test_queue_failure'; end; $$; create trigger test_deny_queue before insert on public.moderation_queue for each row execute function public.test_deny_queue();");
  try { await assert.rejects(() => post('a', 'pending', 'product'), /test_queue_failure/); }
  finally { await db.exec('drop trigger test_deny_queue on public.moderation_queue; drop function public.test_deny_queue();'); }
  assert.equal((await q("select count(*)::int n from submissions where type='product'")).rows[0].n, count);
});

await check('RPC and trigger function are not callable by public roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(() => as(role, 'a', () => q("select admin_moderate_submission($1,$2,0,'rejected',null,null)", [ids.admin, legacy])));
    await assert.rejects(() => as(role, 'a', () => q('select submission_moderation_guard()')));
    await assert.rejects(() => as(role, 'a', () => q('select submission_queue_guard()')));
    await assert.rejects(() => as(role, 'a', () => q('select product_submission_enqueue()')));
  }
});

await check('database rechecks admin and exact member permission, including missing and revoked keys', async () => {
  const sample = await product();
  for (const permissions of [{}, { moderate_submissions: false }, { moderate_submissions: 'true' }]) {
    await q('update profiles set permissions=$1::jsonb where id=$2', [JSON.stringify(permissions), ids.member]);
    await assert.rejects(() => call(ids.member, sample.id, 0, 'published'), /moderation_forbidden/);
  }
  await assert.rejects(() => call(ids.a, sample.id, 0, 'published'), /moderation_forbidden/);
  await q('update profiles set permissions=$1::jsonb where id=$2', [JSON.stringify({ moderate_submissions: true }), ids.member]);
  await call(ids.member, sample.id, 0, 'published');
  await q("update profiles set permissions='{}'::jsonb where id=$1", [ids.member]);
  await assert.rejects(() => call(ids.member, sample.id, 1, 'pending'), /moderation_forbidden/);
  assert.equal((await state(sample.id)).status, 'published');
});

await check('legacy direct status writes and stale AI updates fail closed', async () => {
  const sample = await product();
  await assert.rejects(() => q("update submissions set status='published' where id=$1 and status='pending' and deleted_at is null", [sample.id]), /moderation_use_transaction/);
  assert.equal((await state(sample.id)).status, 'pending');
  assert.equal((await queues(sample.id))[0].result, 'pending');
});

await check('explicit queue reconciliation fixes an old stale record and missing product XP', async () => {
  const result = await call(ids.admin, legacy, null, 'published', legacyQueue, '确认原状态');
  assert.equal(result.revision, 0);
  assert.equal((await queues(legacy))[0].result, 'approved');
  assert.equal((await xp(legacy, 'submission_product')).length, 1);
  assert.equal((await logs(legacy)).length, 1);
  await assert.rejects(() => call(ids.admin, legacy, null, 'published', legacyQueue), /moderation_conflict/);
  assert.equal((await xp(legacy, 'submission_product')).length, 1);
  assert.equal((await logs(legacy)).length, 1);
});

await check('list action atomically updates queue, product XP, level notice and audit', async () => {
  const sample = await product('b');
  const noticesBefore = (await q("select count(*)::int n from notifications where user_id=$1 and type='level_up'", [ids.b])).rows[0].n;
  const result = await call(ids.admin, sample.id, 0, 'published');
  assert.equal(result.revision, 1);
  assert.equal((await state(sample.id)).status, 'published');
  assert.equal((await queues(sample.id))[0].result, 'approved');
  assert.equal((await queues(sample.id))[0].reviewed_by, ids.admin);
  assert.equal((await xp(sample.id, 'submission_product'))[0].revoked_at, null);
  assert.equal((await logs(sample.id)).length, 1);
  assert.equal((await q("select count(*)::int n from notifications where user_id=$1 and type='level_up'", [ids.b])).rows[0].n, noticesBefore + 1);
  await assert.rejects(() => call(ids.admin, sample.id, 0, 'published'), /moderation_conflict/);
  assert.equal((await xp(sample.id, 'submission_product')).length, 1);
  assert.equal((await logs(sample.id)).length, 1);
});

await check('queue review closes all duplicate pending rows without touching older decisions', async () => {
  await call(ids.admin, legacyForum, null, 'published', legacyForumQueue);
  const rows = await queues(legacyForum);
  assert.equal(rows.filter((r) => r.result === 'approved').length, 2);
  assert.equal(rows.filter((r) => r.result === 'rejected').length, 1);
  assert.equal((await xp(legacyForum, 'submission_post')).length, 1);
});

await check('reopen creates new human cycle, rejects stale revision and queue, then restores same XP event', async () => {
  const sample = await product();
  await call(ids.admin, sample.id, null, 'published', sample.queue);
  const firstXp = (await xp(sample.id, 'submission_product'))[0].id;
  await call(ids.admin, sample.id, 1, 'pending');
  assert((await xp(sample.id, 'submission_product'))[0].revoked_at);
  const open = (await queues(sample.id)).find((r) => r.result === 'pending');
  assert(open && open.id !== sample.queue && open.source === 'human');
  await assert.rejects(() => call(ids.admin, sample.id, 0, 'rejected'), /moderation_conflict/);
  await assert.rejects(() => call(ids.admin, sample.id, null, 'rejected', sample.queue), /moderation_conflict/);
  await call(ids.admin, sample.id, null, 'published', open.id);
  const entries = await xp(sample.id, 'submission_product');
  assert.equal(entries.length, 1); assert.equal(entries[0].id, firstXp); assert.equal(entries[0].revoked_at, null);
});

await check('opposing decision on a stale queue is refused without changing content', async () => {
  const sample = await product();
  await call(ids.admin, sample.id, 0, 'published');
  await assert.rejects(() => call(ids.admin, sample.id, null, 'rejected', sample.queue), /moderation_conflict/);
  assert.equal((await state(sample.id)).status, 'published');
});

await check('delete and restore close old cycle, preserve actual previous status and block old queue', async () => {
  const sample = await product();
  await q("update submissions set deleted_at=now(),deleted_by=$2,deleted_prev_status='published',status='rejected' where id=$1", [sample.id, ids.admin]);
  let row = await state(sample.id);
  assert.equal(row.deleted_prev_status, 'pending'); assert.equal(row.moderation_revision, 1);
  assert.equal((await queues(sample.id))[0].result, 'withdrawn');
  await q("update submissions set deleted_at=null,deleted_by=null,deleted_prev_status=null,status='published' where id=$1", [sample.id]);
  row = await state(sample.id); assert.equal(row.status, 'pending'); assert.equal(row.moderation_revision, 2);
  const current = (await queues(sample.id)).find((r) => r.result === 'pending');
  assert(current && current.id !== sample.queue && current.source === 'human');
  await assert.rejects(() => call(ids.admin, sample.id, null, 'published', sample.queue), /moderation_conflict/);
  await call(ids.admin, sample.id, null, 'published', current.id);
});

await check('published product delete and restore revoke/reactivate one XP event transactionally', async () => {
  const sample = await product(); await call(ids.admin, sample.id, 0, 'published');
  const first = (await xp(sample.id, 'submission_product'))[0].id;
  await q("update submissions set deleted_at=now(),deleted_by=$2,status='rejected' where id=$1", [sample.id, ids.admin]);
  assert((await xp(sample.id, 'submission_product'))[0].revoked_at);
  await q("update submissions set deleted_at=null,deleted_by=null,deleted_prev_status=null,status='pending' where id=$1", [sample.id]);
  assert.equal((await state(sample.id)).status, 'published');
  const entries = await xp(sample.id, 'submission_product'); assert.equal(entries.length, 1); assert.equal(entries[0].id, first); assert.equal(entries[0].revoked_at, null);
  assert.equal((await queues(sample.id)).filter((r) => r.result === 'pending').length, 0);
});

await check('removed content cannot be moderated and examples never earn submission XP', async () => {
  const sample = await forum();
  await q("update submissions set deleted_at=now(),deleted_by=$2,status='rejected' where id=$1", [sample.id, ids.admin]);
  await assert.rejects(() => call(ids.admin, sample.id, 1, 'published'), /moderation_unavailable/);
  const example = (await q('select id,moderation_revision from submissions where is_example limit 1')).rows[0];
  await call(ids.admin, example.id, example.moderation_revision, 'rejected');
  assert.equal((await q('select count(*)::int n from xp_events where ref_id=$1', [example.id])).rows[0].n, 0);
});

await check('disabled XP rule is respected', async () => {
  const sample = await product();
  await q("update xp_rules set enabled=false where action_key='submission_product'");
  try { await call(ids.admin, sample.id, 0, 'published'); assert.equal((await xp(sample.id, 'submission_product')).length, 0); }
  finally { await q("update xp_rules set enabled=true where action_key='submission_product'"); }
});

await check('audit failure rolls back submission, queue, XP and notifications', async () => {
  const sample = await product();
  const noticeCount = (await q('select count(*)::int n from notifications')).rows[0].n;
  await db.exec("create function public.test_deny_admin_log() returns trigger language plpgsql as $$ begin raise exception 'test_audit_failure'; end; $$; create trigger test_deny_admin_log before insert on public.admin_logs for each row execute function public.test_deny_admin_log();");
  try { await assert.rejects(() => call(ids.admin, sample.id, 0, 'published'), /test_audit_failure/); }
  finally { await db.exec('drop trigger test_deny_admin_log on public.admin_logs; drop function public.test_deny_admin_log();'); }
  assert.equal((await state(sample.id)).status, 'pending'); assert.equal((await state(sample.id)).moderation_revision, 0);
  assert.equal((await queues(sample.id))[0].result, 'pending'); assert.equal((await xp(sample.id, 'submission_product')).length, 0);
  assert.equal((await q('select count(*)::int n from notifications')).rows[0].n, noticeCount);
});

console.log(`${passed} isolated moderation database checks passed; synthetic data only.`);
await db.close();
