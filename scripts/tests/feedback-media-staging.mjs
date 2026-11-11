// Ephemeral PostgreSQL, simulated auth/Storage only. Does not contact Supabase.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db, ids, as, root } from './community-database-base.mjs';

const migration = (name) => fs.readFile(root + '/supabase/migrations/' + name, 'utf8');
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
for (const name of ['0029_community_post_type.sql', '0030_real_community.sql', '0031_feedback_text_validation.sql', '0032_forum_feedback_inbox.sql']) await db.exec(await migration(name));
await db.exec(`alter table storage.objects add column metadata jsonb;
  alter table storage.objects enable row level security;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  grant select, insert, update, delete on storage.objects to service_role;`);
const sql = await migration('0035_feedback_media_staging.sql');
await check('existing bucket collision aborts migration without changing the bucket', async () => {
  await db.exec("insert into storage.buckets(id,name,public) values('feedback-media-images','other',true)");
  await assert.rejects(() => db.exec(sql), /requires new feedback media buckets/);
  await db.exec('rollback');
  assert.equal((await db.query("select public from storage.buckets where id='feedback-media-images'")).rows[0].public, true);
  await db.exec("delete from storage.buckets where id='feedback-media-images'");
});
await db.exec(sql);
const reserve = (name, id, draft, type = 'image/png', size = 42) => as('authenticated', name, () => db.query('select feedback_media_reserve($1,$2,$3,$4) r', [id, draft, type, size])).then((r) => r.rows[0].r);
const owned = (name, id) => as('authenticated', name, () => db.query('select feedback_media_owned($1) r', [id])).then((r) => r.rows[0].r);
const cancel = (name, id) => as('authenticated', name, () => db.query('select feedback_media_cancel($1) r', [id])).then((r) => r.rows[0].r);
const upload = (name, path, bucket = 'feedback-media-images') => as('authenticated', name, () => db.query('insert into storage.objects(id,bucket_id,name,metadata) values($1,$2,$3,$4::jsonb)', [randomUUID(), bucket, path, JSON.stringify({ size: 42 })]));
const service = (fn) => as('service_role', null, fn);
const first = randomUUID(), draft = randomUUID();
let slot;
await check('new private bucket leaves public submission media untouched', async () => {
  const rows = (await db.query("select id,public,file_size_limit from storage.buckets where id in ('feedback-media-images','feedback-media-videos','submission-media') order by id")).rows;
  assert.deepEqual(rows.map((r) => [r.id, r.public]), [['feedback-media-images', false], ['feedback-media-videos', false], ['submission-media', true]]);
  assert.deepEqual(rows.slice(0, 2).map((r) => Number(r.file_size_limit)), [5242880, 31457280]);
});
await check('anonymous, muted, blacklisted and invalid uploads fail closed', async () => {
  await assert.rejects(() => as('anon', null, () => db.query('select feedback_media_reserve($1,$2,$3,$4)', [randomUUID(), draft, 'image/png', 42])));
  for (const name of ['muted', 'blocked']) await assert.rejects(() => reserve(name, randomUUID(), draft), /feedback_restricted/);
  for (const [type, size] of [['text/html', 1], ['image/png', 5242881], ['video/mp4', 31457281], ['image/png', 0]]) await assert.rejects(() => reserve('a', randomUUID(), draft, type, size), /feedback_media_invalid/);
});
await check('owner reservation is idempotent only for the exact original payload', async () => {
  slot = await reserve('a', first, draft);
  assert.equal(slot.staging_path, `staging/${ids.a}/${first}`);
  assert.deepEqual(await reserve('a', first, draft), slot);
  await assert.rejects(() => reserve('a', first, draft, 'image/jpeg', 42), /feedback_media_conflict/);
  await assert.rejects(() => reserve('b', first, draft), /feedback_media_conflict/);
  await assert.rejects(() => owned('b', first), /feedback_media_not_found/);
});
await check('the exact active staging key is the only client-writable path', async () => {
  await assert.rejects(() => upload('b', slot.staging_path));
  await assert.rejects(() => upload('a', slot.staging_path, 'feedback-media-videos'));
  await assert.rejects(() => upload('a', `verified/${ids.a}/${first}`));
  await assert.rejects(() => upload('a', `staging/${ids.a}/${randomUUID()}`));
  await upload('a', slot.staging_path);
  assert.equal((await as('authenticated', 'a', () => db.query("select * from storage.objects where bucket_id='feedback-media-images'"))).rows.length, 0);
  assert.equal((await as('authenticated', 'a', () => db.query("update storage.objects set name='different' where name=$1 returning id", [slot.staging_path]))).rows.length, 0);
  assert.equal((await as('authenticated', 'a', () => db.query('delete from storage.objects where name=$1 returning id', [slot.staging_path]))).rows.length, 0);
});
await check('a later restriction revokes new staging inserts', async () => {
  const id = randomUUID(); const current = await reserve('a', id, randomUUID());
  await db.query("insert into user_tags(user_id,tag_key) values($1,'blacklisted')", [ids.a]);
  await assert.rejects(() => upload('a', current.staging_path));
  await db.query("delete from user_tags where user_id=$1 and tag_key='blacklisted'", [ids.a]);
});
await check('untrusted roles cannot read raw rows or mark a file verified', async () => {
  for (const name of ['a', 'b', 'admin']) {
    await assert.rejects(() => as('authenticated', name, () => db.query('select * from feedback_media_uploads')));
    await assert.rejects(() => as('authenticated', name, () => db.query('select feedback_media_begin_validation($1,$2)', [first, ids.a])));
    await assert.rejects(() => as('authenticated', name, () => db.query('select feedback_media_record_verified($1,$2,$3,$4,$5)', [first, ids.a, randomUUID(), 'a'.repeat(64), null])));
  }
  await assert.rejects(() => service(() => db.query('select * from feedback_media_uploads')));
});
await check('trusted verification requires the immutable destination and consistent stored size', async () => {
  const begin = () => service(() => db.query('select feedback_media_begin_validation($1,$2) r', [first, ids.a])).then((r) => r.rows[0].r);
  const lease = await begin();
  assert.equal(lease.state, 'validating');
  await assert.rejects(() => begin(), /feedback_media_conflict/);
  const call = (owner, digest, duration, token = lease.token) => service(() => db.query('select feedback_media_record_verified($1,$2,$3,$4,$5) r', [first, owner, token, digest, duration]));
  await assert.rejects(() => call(ids.a, 'a'.repeat(64), null, randomUUID()), /feedback_media_conflict/);
  await assert.rejects(() => call(ids.a, 'a'.repeat(64), null), /feedback_media_object/);
  const verified = `verified/${ids.a}/${first}`;
  await db.query("insert into storage.objects(id,bucket_id,name,metadata) values($1,'feedback-media-images',$2,$3::jsonb)", [randomUUID(), verified, JSON.stringify({ size: 41 })]);
  await assert.rejects(() => call(ids.a, 'a'.repeat(64), null), /feedback_media_object/);
  await db.query("update storage.objects set metadata=$1::jsonb where name=$2", [JSON.stringify({ size: 42 }), verified]);
  await assert.rejects(() => call(ids.b, 'a'.repeat(64), null), /feedback_media_conflict/);
  await assert.rejects(() => call(ids.a, 'bad', null), /feedback_media_invalid/);
  await assert.rejects(() => call(ids.a, 'a'.repeat(64), 2), /feedback_media_invalid/);
  assert.equal((await call(ids.a, 'a'.repeat(64), null)).rows[0].r.state, 'verified');
  await assert.rejects(() => call(ids.a, 'a'.repeat(64), null), /feedback_media_conflict/);
  await assert.rejects(() => upload('a', slot.staging_path));
});
await check('expired verification leases can be reclaimed and old tokens cannot change state', async () => {
  const id = randomUUID(); await reserve('a', id, randomUUID());
  const begin = () => service(() => db.query('select feedback_media_begin_validation($1,$2) r', [id, ids.a])).then((r) => r.rows[0].r);
  const firstLease = await begin();
  await db.query("update feedback_media_uploads set validation_lease_until=now()-interval '1 second' where id=$1", [id]);
  const secondLease = await begin(); assert.notEqual(firstLease.token, secondLease.token);
  assert.equal((await service(() => db.query('select feedback_media_release_validation($1,$2,$3) r', [id, ids.a, firstLease.token]))).rows[0].r, false);
  assert.equal((await service(() => db.query('select feedback_media_release_validation($1,$2,$3) r', [id, ids.a, secondLease.token]))).rows[0].r, true);
});
await check('per-file and per-account verification limits bound repeated expensive validation', async () => {
  const begin = (id) => service(() => db.query('select feedback_media_begin_validation($1,$2) r', [id, ids.member])).then((r) => r.rows[0].r);
  const release = (id, token) => service(() => db.query('select feedback_media_release_validation($1,$2,$3)', [id, ids.member, token]));
  const one = randomUUID(), two = randomUUID(), three = randomUUID();
  for (const id of [one, two, three]) await reserve('member', id, randomUUID());
  for (let i = 0; i < 5; i++) { const lease = await begin(one); await release(one, lease.token); }
  await assert.rejects(() => begin(one), /feedback_media_quota/);
  for (let i = 0; i < 5; i++) { const lease = await begin(two); await release(two, lease.token); }
  await assert.rejects(() => begin(three), /feedback_media_quota/);
  await db.query("update feedback_media_validation_rates set window_started=clock_timestamp()-interval '6 minutes' where owner_id=$1", [ids.member]);
  assert.equal((await begin(three)).state, 'validating');
});
await check('a transaction started before expiry cannot commit an expired verification lease', async () => {
  const id = randomUUID(); await reserve('a', id, randomUUID());
  const lease = (await service(() => db.query('select feedback_media_begin_validation($1,$2) r', [id, ids.a]))).rows[0].r;
  await db.query("update feedback_media_uploads set validation_lease_until=clock_timestamp()+interval '150 milliseconds' where id=$1", [id]);
  await db.exec('set role service_role');
  await db.exec('begin');
  try {
    await db.query('select pg_sleep(0.25)');
    await assert.rejects(() => db.query('select feedback_media_record_verified($1,$2,$3,$4,$5)', [id, ids.a, lease.token, 'a'.repeat(64), null]), /feedback_media_conflict/);
  } finally { await db.exec('rollback'); await db.exec('reset role'); }
});
await check('cancellation is owner-only and waits for outstanding resumable sessions', async () => {
  await assert.rejects(() => cancel('b', first), /feedback_media_not_found/);
  assert.equal((await cancel('a', first)).state, 'cleanup_pending');
  assert.equal((await cancel('a', first)).state, 'cleanup_pending');
  const row = (await db.query('select cleanup_after > now() + interval \'26 hours\' as delayed from feedback_media_uploads where id=$1', [first])).rows[0];
  assert.equal(row.delayed, true);
  await assert.rejects(() => upload('a', slot.staging_path));
});
await check('cleanup is leased, restricted to service and cannot claim before the safety delay', async () => {
  await assert.rejects(() => as('authenticated', 'a', () => db.query('select feedback_media_cleanup_claim(10)')));
  assert.equal((await service(() => db.query('select feedback_media_cleanup_claim(10) r'))).rows[0].r.length, 0);
  await db.query("update feedback_media_uploads set cleanup_after=clock_timestamp()-interval '1 second' where id=$1", [first]);
  const claims = (await service(() => db.query('select feedback_media_cleanup_claim(10) r'))).rows[0].r;
  assert.equal(claims.length, 1); assert.equal(claims[0].id, first);
  const finish = (token, success) => service(() => db.query('select feedback_media_cleanup_finish($1,$2,$3) r', [first, token, success]));
  await assert.rejects(() => cancel('a', first), /feedback_media_conflict/);
  await assert.rejects(() => finish(randomUUID(), true), /feedback_media_conflict/);
  await assert.rejects(() => finish(claims[0].token, true), /feedback_media_object/);
  // Mock only: a real worker must use Storage's delete API, not SQL.
  await db.query('delete from storage.objects where name in ($1,$2)', [claims[0].staging_path, claims[0].verified_path]);
  assert.equal((await finish(claims[0].token, true)).rows[0].r, true);
  assert.equal((await owned('a', first)).state, 'cleaned');
});
await check('failed cleanup retries safely and a reclaimed lease rejects the old worker', async () => {
  const id = randomUUID(); await reserve('a', id, randomUUID()); await cancel('a', id);
  await db.query("update feedback_media_uploads set cleanup_after=clock_timestamp()-interval '1 second' where id=$1", [id]);
  const claim = () => service(() => db.query('select feedback_media_cleanup_claim(10) r')).then((r) => r.rows[0].r.find((v) => v.id === id));
  const firstClaim = await claim();
  await db.query("update feedback_media_uploads set cleanup_lease_until=clock_timestamp()-interval '1 second' where id=$1", [id]);
  const secondClaim = await claim(); assert.notEqual(firstClaim.token, secondClaim.token);
  await assert.rejects(() => service(() => db.query('select feedback_media_cleanup_finish($1,$2,true)', [id, firstClaim.token])), /feedback_media_conflict/);
  assert.equal((await service(() => db.query('select feedback_media_cleanup_finish($1,$2,false) r', [id, secondClaim.token]))).rows[0].r, true);
  assert.equal((await owned('a', id)).state, 'cleanup_pending');
  assert.equal(await claim(), undefined);
});
await check('per-draft quota prevents repeated retries from creating unlimited files', async () => {
  const d = randomUUID();
  const imageIds = Array.from({ length: 5 }, () => randomUUID());
  for (const id of imageIds) await reserve('b', id, d);
  await assert.rejects(() => reserve('b', randomUUID(), d), /feedback_media_quota/);
  await reserve('b', randomUUID(), d, 'video/mp4', 30 * 1024 * 1024);
  await assert.rejects(() => reserve('b', randomUUID(), d, 'video/webm', 42), /feedback_media_quota/);
  // One more image fills the 60 MiB worst-case owner budget, even though its
  // declared length is one byte; a second cannot reserve another bucket slot.
  await reserve('b', randomUUID(), randomUUID(), 'image/png', 1);
  await assert.rejects(() => reserve('b', randomUUID(), randomUUID(), 'image/png', 1), /feedback_media_quota/);
});
console.log(`Passed ${checks.length} staging checks; simulated Storage is not a real Supabase acceptance test.`);
await db.close();
