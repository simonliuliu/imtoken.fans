// Ephemeral PostgreSQL; mock auth/Storage only. No production data or network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db, ids, as, root } from './community-database-base.mjs';

const migration = (name) => fs.readFile(root + '/supabase/migrations/' + name, 'utf8');
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
for (const name of ['0029_community_post_type.sql', '0030_real_community.sql', '0031_feedback_text_validation.sql', '0032_forum_feedback_inbox.sql']) await db.exec(await migration(name));
await db.exec('alter table storage.objects add column metadata jsonb');
const user = (name, fn) => as('authenticated', name, fn);
const anon = (fn) => as('anon', null, fn);
const service = (fn) => as('service_role', null, fn);
const write = (name, action, payload) => user(name, () => db.query('select feedback_write($1,$2::jsonb) r', [action, JSON.stringify(payload)])).then((r) => r.rows[0].r);
const payload = (id, mediaIds) => ({ id, title: 'Forum issue', description: 'A reproducible issue', module: 'forum', kind: 'bug', details: { steps: 'Open the example' }, ...(mediaIds === undefined ? {} : { media_ids: mediaIds }) });
const readMedia = (name, id) => (name === 'anon' ? anon(() => db.query('select feedback_media_list($1) r', [id])) : user(name, () => db.query('select feedback_media_list($1) r', [id]))).then((r) => r.rows[0].r);
const object = (name, id) => (name === 'anon' ? anon(() => db.query('select feedback_media_object($1) r', [id])) : user(name, () => db.query('select feedback_media_object($1) r', [id]))).then((r) => r.rows[0].r);
const moderate = (name, id, revision, action, reason = '') => user(name, () => db.query('select feedback_media_moderate($1,$2,$3,$4) r', [id, revision, action, reason])).then((r) => r.rows[0].r);
const edit = async (id, changes = {}) => {
  const post = (await db.query('select * from feedback_posts where id=$1', [id])).rows[0];
  return write('admin', 'edit', { id, version: post.version, title: post.title, description: post.description, module: post.module, status: post.status, mark: post.mark, visibility: post.visibility, ...changes });
};
const oldPost = randomUUID();
await write('a', 'create', payload(oldPost));
const oldJobId = (await db.query('select id from forum_feedback_jobs where feedback_id=$1', [oldPost])).rows[0].id;
const oldLease = (await service(() => db.query("select forum_feedback_jobs_claim('fixture',$1,3600) r", [oldJobId]))).rows[0].r;
await db.exec(await migration('0035_feedback_media_staging.sql'));
await db.exec(await migration('0036_feedback_media_linking.sql'));

async function staged(name, postId, mediaId = randomUUID()) {
  const result = (await user(name, () => db.query('select feedback_media_reserve($1,$2,$3,$4) r', [mediaId, postId, 'image/png', 42]))).rows[0].r;
  const path = `verified/${ids[name]}/${mediaId}`;
  await db.query('insert into storage.objects(id,bucket_id,name,metadata) values($1,$2,$3,$4::jsonb)', [randomUUID(), result.bucket, path, JSON.stringify({ size: 42 })]);
  const lease = (await service(() => db.query('select feedback_media_begin_validation($1,$2) r', [mediaId, ids[name]]))).rows[0].r;
  await service(() => db.query('select feedback_media_record_verified($1,$2,$3,$4,$5)', [mediaId, ids[name], lease.token, 'a'.repeat(64), null]));
  return mediaId;
}

await check('historical jobs without attachments retain their active lease on metadata-only edits', async () => {
  await edit(oldPost, { status: 'evaluating' });
  const jobs = (await db.query('select status,lease_token from forum_feedback_jobs where feedback_id=$1', [oldPost])).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'claimed'); assert.equal(jobs[0].lease_token, oldLease.lease_token);
});
await check('legacy clients and private helpers keep their old permissions', async () => {
  const id = randomUUID(); await write('b', 'create', payload(id));
  await assert.rejects(() => user('a', () => db.query("select feedback_write_without_media('create','{}'::jsonb)")));
  await assert.rejects(() => user('admin', () => db.query('select * from feedback_media_audit')));
  await assert.rejects(() => service(() => db.query('select * from feedback_media_audit')));
});
const firstPost = randomUUID(), firstMedia = await staged('a', firstPost);
await check('unowned, invalid, duplicated or mismatched media cannot create a feedback post', async () => {
  await assert.rejects(() => write('b', 'create', payload(firstPost, [firstMedia])), /feedback_conflict/);
  await assert.rejects(() => write('a', 'create', payload(firstPost, [firstMedia, firstMedia])), /feedback_invalid/);
  await assert.rejects(() => write('a', 'create', payload(firstPost, ['not-a-uuid'])), /feedback_invalid/);
  await assert.rejects(() => write('a', 'create', payload(randomUUID(), [firstMedia])), /feedback_conflict/);
  assert.equal((await db.query('select count(*)::int n from feedback_posts where id=$1', [firstPost])).rows[0].n, 0);
});
await check('create attaches the immutable owner media in one transaction and is idempotent', async () => {
  const p = payload(firstPost, [firstMedia]); await write('a', 'create', p); await write('a', 'create', p);
  assert.equal((await db.query('select post_id from feedback_media_uploads where id=$1', [firstMedia])).rows[0].post_id, firstPost);
  assert.equal((await db.query('select count(*)::int n from feedback_posts where id=$1', [firstPost])).rows[0].n, 1);
  await assert.rejects(() => write('a', 'create', payload(firstPost, [])), /feedback_conflict/);
  const active = (await db.query("select snapshot from forum_feedback_jobs where feedback_id=$1 and status='queued'", [firstPost])).rows;
  assert.equal(active.length, 1); assert.equal(active[0].snapshot.attachments[0].id, firstMedia);
  assert.equal(active[0].snapshot.attachments[0].sha256, 'a'.repeat(64));
});
await check('pending media is limited to the owner and administrator, without public object access', async () => {
  assert.equal((await readMedia('a', firstPost)).length, 1); assert.equal((await readMedia('admin', firstPost)).length, 1);
  assert.deepEqual(await readMedia('anon', firstPost), []); assert.deepEqual(await readMedia('b', firstPost), []);
  await assert.rejects(() => object('anon', firstMedia), /feedback_media_not_found/);
  await assert.rejects(() => object('b', firstMedia), /feedback_media_not_found/);
  assert.equal((await object('a', firstMedia)).path, `verified/${ids.a}/${firstMedia}`);
});
await check('moderation requires the admin, current revision and a rejection reason', async () => {
  await assert.rejects(() => moderate('a', firstMedia, 1, 'approve'), /feedback_forbidden/);
  await assert.rejects(() => moderate('admin', firstMedia, 2, 'approve'), /feedback_conflict/);
  await assert.rejects(() => moderate('admin', firstMedia, 1, 'reject'), /feedback_invalid/);
  assert.equal((await moderate('admin', firstMedia, 1, 'approve')).revision, 2);
  assert.equal((await object('anon', firstMedia)).id, firstMedia);
  const jobs = (await db.query('select status,snapshot from forum_feedback_jobs where feedback_id=$1 order by source_version', [firstPost])).rows;
  assert.equal(jobs.at(-1).status, 'queued'); assert.equal(jobs.at(-1).snapshot.attachments[0].review_state, 'approved');
  assert(jobs.slice(0, -1).every((job) => job.status === 'stale'));
});
await check('owner removal and restoration change visibility without physical deletion', async () => {
  await assert.rejects(() => moderate('b', firstMedia, 2, 'remove'), /feedback_forbidden/);
  assert.equal((await moderate('a', firstMedia, 2, 'remove')).revision, 3);
  await assert.rejects(() => object('anon', firstMedia), /feedback_media_not_found/);
  assert.equal((await readMedia('a', firstPost))[0].removed, true);
  assert.equal((await db.query('select count(*)::int n from storage.objects where name=$1', [`verified/${ids.a}/${firstMedia}`])).rows[0].n, 1);
  assert.equal((await moderate('a', firstMedia, 3, 'restore')).revision, 4);
  assert.equal((await object('anon', firstMedia)).id, firstMedia);
  assert.equal((await moderate('admin', firstMedia, 4, 'remove', 'Moderator removal')).revision, 5);
  await assert.rejects(() => moderate('a', firstMedia, 5, 'restore'), /feedback_forbidden/);
  await assert.rejects(() => object('anon', firstMedia), /feedback_media_not_found/);
  assert.equal((await moderate('admin', firstMedia, 5, 'restore')).revision, 6);
  assert.equal((await object('anon', firstMedia)).id, firstMedia);
});
await check('hiding and restoring the feedback immediately affects attachment visibility', async () => {
  await edit(firstPost, { visibility: 'hidden' });
  await assert.rejects(() => object('anon', firstMedia), /feedback_media_not_found/);
  await assert.rejects(() => object('a', firstMedia), /feedback_media_not_found/);
  assert.equal((await object('admin', firstMedia)).id, firstMedia);
  await edit(firstPost, { visibility: 'published' });
  assert.equal((await object('anon', firstMedia)).id, firstMedia);
});
await check('cancelled or cleaning media cannot be attached', async () => {
  const postId = randomUUID(), mediaId = await staged('b', postId);
  await user('b', () => db.query('select feedback_media_cancel($1)', [mediaId]));
  await assert.rejects(() => write('b', 'create', payload(postId, [mediaId])), /feedback_conflict/);
  assert.equal((await db.query('select count(*)::int n from feedback_posts where id=$1', [postId])).rows[0].n, 0);
});
await check('merged media retains original provenance, source visibility and unmerge behavior', async () => {
  const target = randomUUID(), source = randomUUID(), mediaId = await staged('b', source);
  await write('a', 'create', payload(target)); await write('b', 'create', payload(source, [mediaId]));
  await moderate('admin', mediaId, 1, 'approve');
  const posts = (await db.query('select id,version from feedback_posts where id in ($1,$2)', [target, source])).rows;
  const versions = Object.fromEntries(posts.map((p) => [p.id, p.version]));
  const merged = await write('admin', 'merge', { id: target, other_id: source, version: versions[target], other_version: versions[source] });
  const rootId = merged.id, childId = rootId === target ? source : target;
  assert.equal((await readMedia('anon', rootId)).find((m) => m.id === mediaId).post_id, source);
  if (childId === source) {
    await db.query("update feedback_posts set visibility='hidden' where id=$1", [source]);
    await assert.rejects(() => object('anon', mediaId), /feedback_media_not_found/);
    await db.query("update feedback_posts set visibility='published' where id=$1", [source]);
  }
  const merge = (await db.query('select id from feedback_merges where target_id=$1 and undone_at is null', [rootId])).rows[0];
  const rootVersion = (await db.query('select version from feedback_posts where id=$1', [rootId])).rows[0].version;
  await write('admin', 'unmerge', { id: merge.id, version: rootVersion });
  assert.equal((await readMedia('anon', source)).find((m) => m.id === mediaId).post_id, source);
  assert.equal((await db.query('select post_id from feedback_media_uploads where id=$1', [mediaId])).rows[0].post_id, source);
});
console.log(`Passed ${checks.length} linking checks; Storage and concurrent clients are simulated.`);
await db.close();
