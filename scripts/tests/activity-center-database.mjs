import assert from 'node:assert/strict';
import { db, ids, as, rpc, migrate } from './activity-center-base.mjs';

// Preserve a snapshot of every pre-existing table, including operational config,
// historical rewards and notification events, across the additive migration.
await db.query("select * from award_xp($1,'legacy_fixture',27,null,null,null)", [ids.user]);
await db.query("select * from grant_lottery_tickets($1,4,'legacy_fixture',null)", [ids.user]);
await db.query('select * from perform_checkin($1)', [ids.user]);
const legacyProduct = (await db.query("insert into submissions(type,title,tagline,description,status,submitted_by) values('product','Legacy QA product','Fixture','Historical fixture only','published',$1) returning id", [ids.admin])).rows[0].id;
const legacyRating = (await db.query("insert into product_ratings(submission_id,user_id,rating,body,experienced,created_at) values($1,$2,1,'An older genuine review before the campaign began.',true,'2000-01-01T00:00:00Z') returning id", [legacyProduct, ids.user])).rows[0].id;
const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map((r) => r.tablename);
async function snapshot() {
  const out = {};
  for (const name of tables) out[name] = (await db.query(`select coalesce(jsonb_agg(x order by x::text),'[]'::jsonb) as data from (select to_jsonb(t) as x from public.${name} t) q`)).rows[0].data;
  return out;
}
const before = await snapshot();
await migrate('0032_community_activity_center.sql');
assert.deepEqual(await snapshot(), before, 'migration changes pre-existing data');
const results = [{ name: 'all 32 actual migrations apply; every existing public table preserved', result: 'PASS' }];
async function test(name, fn) { try { await fn(); results.push({ name, result: 'PASS' }); } catch (e) { results.push({ name, result: 'FAIL', message: e.message }); } }
async function rejected(fn, pattern) { await assert.rejects(fn, pattern); }
const write = (name, id, action, payload = {}) => as(name, () => rpc('activity_write', [ids[name], id, action, payload]));
const admin = (action, id = null, payload = {}) => as('admin', () => rpc('activity_admin_write', [ids.admin, action, id, payload]));
const read = (name, id = null) => as(name, () => rpc('activity_read', [name ? ids[name] : null, id]));
async function create(overrides = {}, publish = true) {
  const payload = { title: 'Isolated QA activity', summary: 'Fixture only', body: 'A genuine contribution is required for this isolated QA fixture.', organizer: 'Local fixture', type: 'event', task_kind: 'manual', starts_at: new Date(Date.now() - 3600000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), reward_xp: 15, reward_tickets: 2, reward_badge: 'event_winner', reward_limit: 1, ...overrides };
  const { id } = await admin('save', null, payload);
  if (publish) await admin('publish', id);
  return id;
}
const evidence = 'This contribution contains enough verifiable evidence for a manual review.';
let manual, quiz;
await test('initial public center is empty; drafts and quiz answers remain private', async () => {
  assert.equal((await read(null)).items.length, 0);
  quiz = await create({ task_kind: 'quiz', quiz_question: 'Which option protects a seed phrase?', quiz_options: ['Keep private', 'Share publicly'], quiz_answer: 0, quiz_max_attempts: 2 }, false);
  assert.equal((await read(null)).items.length, 0);
  assert.equal((await as(null, () => db.query('select * from community_activities'))).rows.length, 0);
  await rejected(() => as('user', () => db.query('select * from activity_quiz_answers')), /permission denied/);
  await admin('publish', quiz);
  assert.equal('quiz_answer' in (await read(null, quiz)).items[0], false);
});
await test('guest, mismatched identity, ordinary member and helper RPC writes denied', async () => {
  await rejected(() => as(null, () => rpc('activity_write', [ids.user, quiz, 'join', {}])), /permission denied/);
  await rejected(() => as('user', () => rpc('activity_write', [ids.other, quiz, 'join', {}])), /activity_session/);
  await rejected(() => as('user', () => rpc('activity_read', [ids.other, quiz])), /activity_session/);
  await rejected(() => as('member', () => rpc('activity_admin_read', [ids.member])), /activity_forbidden/);
  await rejected(() => as('user', () => rpc('activity_award', [quiz, ids.user])), /permission denied/);
  for (const table of ['community_activities', 'activity_participations', 'activity_rewards', 'activity_follows', 'activity_notification_receipts']) {
    await rejected(() => as('user', () => db.query(`delete from ${table}`)), /permission denied/);
  }
});
await test('manage_campaigns is an explicit permission; tags are not permissions', async () => {
  await db.query("update profiles set permissions='{" + '"manage_campaigns":true' + "}' where id=$1", [ids.member]);
  assert.equal((await as('member', () => rpc('activity_admin_read', [ids.member]))).items.length, 1);
  await db.query("update profiles set permissions='{}' where id=$1", [ids.member]);
  await db.query("insert into user_tags(user_id,tag_key) values($1,'official')", [ids.other]);
  await rejected(() => as('other', () => rpc('activity_admin_read', [ids.other])), /activity_forbidden/);
});
await test('wrong answers consume persisted attempts; exhausted answer cannot issue rewards', async () => {
  assert.equal((await write('other', quiz, 'quiz', { answer: 1 })).error, 'activity_quiz_wrong');
  assert.equal((await read('other', quiz)).mine[0].attempts, 1);
  await write('other', quiz, 'quiz', { answer: 1 });
  await rejected(() => write('other', quiz, 'quiz', { answer: 0 }), /activity_attempts_exhausted/);
  assert.equal((await read('other', quiz)).mine[0].reward, null);
});
await test('manual evidence private; only authorized review can complete a contribution', async () => {
  manual = await create();
  await rejected(() => write('user', manual, 'submit', { evidence: 'short' }), /activity_evidence/);
  await write('user', manual, 'submit', { evidence });
  assert.equal((await read('other', manual)).mine.length, 0);
  assert.equal((await read('user', manual)).mine[0].status, 'submitted');
  await rejected(() => write('user', manual, 'quiz', { answer: 0 }), /activity_already_submitted/);
  await rejected(() => as('user', () => rpc('activity_admin_write', [ids.user, 'approve', manual, { user_id: ids.user }])), /activity_forbidden/);
  await rejected(() => admin('reject', manual, { user_id: ids.user, note: '' }), /activity_invalid/);
  await admin('reject', manual, { user_id: ids.user, note: 'Please supply verifiable evidence.' });
  await write('user', manual, 'submit', { evidence: evidence + ' Corrected.' });
  assert.equal((await read('user', manual)).mine[0].review_note, null);
});
await test('approval is atomic, repeat-safe and capped across users', async () => {
  const balance = (await db.query('select xp,lottery_tickets from profiles where id=$1', [ids.user])).rows[0];
  await admin('approve', manual, { user_id: ids.user });
  await admin('approve', manual, { user_id: ids.user });
  const after = (await db.query('select xp,lottery_tickets from profiles where id=$1', [ids.user])).rows[0];
  assert.equal(after.xp - balance.xp, 15); assert.equal(after.lottery_tickets - balance.lottery_tickets, 2);
  assert.equal((await read('user', manual)).mine[0].reward.xp, 15);
  assert.equal((await db.query('select count(*)::integer n from badges where user_id=$1 and badge_key=$2', [ids.user, 'event_winner'])).rows[0].n, 1);
  await write('other', manual, 'submit', { evidence });
  await rejected(() => admin('approve', manual, { user_id: ids.other }), /activity_reward_exhausted/);
  assert.equal((await read('other', manual)).mine[0].status, 'submitted');
  assert.equal((await read(null, manual)).items[0].rewarded_count, 1);
});
await test('published rules are frozen; ineligible users cannot join or receive rewards', async () => {
  await rejected(() => admin('save', manual, {}), /activity_frozen/);
  for (const name of ['muted', 'blocked']) await rejected(() => write(name, quiz, 'quiz', { answer: 0 }), /activity_blocked/);
  const id = await create();
  await write('other', id, 'submit', { evidence });
  await db.query("update profiles set muted_until=now()+interval '1 hour' where id=$1", [ids.other]);
  await rejected(() => admin('approve', id, { user_id: ids.other }), /activity_blocked/);
  await db.query('update profiles set muted_until=null where id=$1', [ids.other]);
});
await test('server requires historical checkins in campaign window, not a client assertion', async () => {
  const id = await create({ task_kind: 'checkin', starts_at: new Date(Date.now() - 86400000).toISOString(), checkin_days: 1 });
  await rejected(() => write('other', id, 'checkin'), /activity_checkin_missing/);
  await write('user', id, 'checkin');
  await write('user', id, 'checkin');
  assert.equal((await read('user', id)).mine[0].status, 'approved');
});
await test('product review task verifies real ownership, experience flag and time window', async () => {
  const oldReviewActivity = await create({ task_kind: 'product_review', product_id: legacyProduct });
  await rejected(() => write('user', oldReviewActivity, 'submit', { evidence }), /activity_review_missing/);
  const product = (await db.query("insert into submissions(type,title,tagline,description,status,submitted_by) values('product','QA product','Fixture','Fixture only','published',$1) returning id", [ids.admin])).rows[0].id;
  const id = await create({ task_kind: 'product_review', product_id: product });
  await rejected(() => write('user', id, 'submit', { evidence }), /activity_review_missing/);
  await db.query('insert into product_ratings(submission_id,user_id,rating,body,experienced) values($1,$2,1,$3,true)', [product, ids.user, evidence]);
  await rejected(() => write('other', id, 'submit', { evidence, review_id: 'forged' }), /activity_review_missing/);
  await write('user', id, 'submit', { evidence });
  await db.query('update submissions set deleted_at=now() where id=$1', [product]);
  await rejected(() => admin('approve', id, { user_id: ids.user }), /activity_review_missing/);
  await db.query('update submissions set deleted_at=null where id=$1', [product]);
  await admin('approve', id, { user_id: ids.user });
  assert.equal((await read('user', id)).mine[0].status, 'approved', 'low rating must not disqualify a genuine review');
});
await test('time gates and cancellation preserve prior rewards; old subscribers can unfollow', async () => {
  const future = await create({ starts_at: new Date(Date.now() + 600000).toISOString() });
  await write('user', future, 'follow');
  await rejected(() => write('user', future, 'join'), /activity_not_started/);
  await admin('cancel', future, { note: 'The event has been cancelled.' });
  await rejected(() => write('user', future, 'join'), /activity_unavailable/);
  await write('user', future, 'unfollow');
  const id = await create(); await write('other', id, 'submit', { evidence });
  await db.query("update community_activities set ends_at=now()-interval '1 minute',starts_at=now()-interval '1 day' where id=$1", [id]);
  await rejected(() => write('user', id, 'join'), /activity_ended/);
  await admin('approve', id, { user_id: ids.other });
  await admin('cancel', id, { note: 'Cancelled after completed review.' });
  assert.equal((await read('other', id)).mine[0].reward.tickets, 2);
});
await test('activity notices project correct links and clearing cannot replay historical delivery', async () => {
  const id = await create({ starts_at: new Date(Date.now() + 600000).toISOString() });
  await write('user', id, 'follow');
  await db.query("update community_activities set starts_at=now()-interval '1 minute' where id=$1", [id]);
  const notices = await as('user', () => rpc('notification_read', [ids.user, 0]));
  const notice = notices.items.find((n) => n.detail?.activity_id === id);
  assert.equal(notice.detail.kind, 'activity_started'); assert.equal(notice.href, `/community/activities/${id}`);
  await rejected(() => as('other', () => rpc('notification_read', [ids.user, 0])), /activity_session/);
  await as('user', () => rpc('notification_write', [ids.user, 'clear', null]));
  const cleared = await as('user', () => rpc('notification_read', [ids.user, 0]));
  assert.equal(cleared.items.length, 0);
  await write('user', id, 'unfollow'); await write('user', id, 'follow');
  assert.equal((await as('user', () => rpc('notification_read', [ids.user, 0]))).items.length, 0);
  await rejected(() => as('user', () => rpc('notification_read_before_activity', [ids.user, 0])), /permission denied/);
});
await test('review timestamp and ownership cannot be rewritten through authenticated REST rights', async () => {
  await as('user', () => db.query('update product_ratings set body=$2 where id=$1', [legacyRating, evidence]));
  // Match the existing product rating Action's upsert shape (no id/created_at).
  await as('user', () => db.query('insert into product_ratings(submission_id,user_id,rating,body,experienced,updated_at) values($1,$2,2,$3,true,now()) on conflict(submission_id,user_id) do update set rating=excluded.rating,body=excluded.body,experienced=excluded.experienced,updated_at=excluded.updated_at', [legacyProduct, ids.user, evidence + ' Edited via existing upsert.']));
  assert.equal(new Date((await db.query('select created_at from product_ratings where id=$1', [legacyRating])).rows[0].created_at).getUTCFullYear(), 2000, 'legacy created_at must survive valid editing');
  const product = (await db.query("insert into submissions(type,title,tagline,description,status,submitted_by) values('product','Timestamp fixture','Fixture','Fixture only','published',$1) returning id", [ids.admin])).rows[0].id;
  const second = (await db.query("insert into submissions(type,title,tagline,description,status,submitted_by) values('product','Other fixture','Fixture','Fixture only','published',$1) returning id", [ids.admin])).rows[0].id;
  const r = await as('user', () => db.query("insert into product_ratings(submission_id,user_id,rating,body,experienced,created_at) values($1,$2,1,$3,true,'2099-01-01') returning *", [product, ids.user, evidence]));
  assert(Math.abs(Date.now() - new Date(r.rows[0].created_at).getTime()) < 60_000, 'insert must use server clock');
  const original = r.rows[0];
  try { await as('user', () => db.query("update product_ratings set created_at='2099-01-01' where id=$1", [original.id])); } catch { /* rejecting or preserving are both valid */ }
  assert.equal(new Date((await db.query('select created_at from product_ratings where id=$1', [original.id])).rows[0].created_at).getTime(), new Date(original.created_at).getTime());
  try { await as('user', () => db.query('update product_ratings set submission_id=$2 where id=$1', [original.id, second])); } catch { /* immutable ownership */ }
  assert.equal((await db.query('select submission_id from product_ratings where id=$1', [original.id])).rows[0].submission_id, product);
  await as('user', () => db.query('update product_ratings set body=$2,rating=2 where id=$1', [original.id, evidence + ' Revised.']));
  assert.equal((await db.query('select rating from product_ratings where id=$1', [original.id])).rows[0].rating, 2);
});
await test('deleting a referenced review and purging an expired product preserve activity history', async () => {
  const product = (await db.query("insert into submissions(type,title,tagline,description,status,submitted_by) values('product','Purge fixture','Fixture','Fixture only','published',$1) returning id", [ids.admin])).rows[0].id;
  const id = await create({ task_kind: 'product_review', product_id: product });
  const rating = (await as('user', () => db.query('insert into product_ratings(submission_id,user_id,rating,body,experienced) values($1,$2,1,$3,true) returning id', [product, ids.user, evidence]))).rows[0].id;
  await write('user', id, 'submit', { evidence });
  await as('user', () => db.query('delete from product_ratings where id=$1', [rating]));
  assert.equal((await db.query('select review_id from activity_participations where activity_id=$1', [id])).rows[0].review_id, null);
  await rejected(() => admin('approve', id, { user_id: ids.user }), /activity_review_missing/);
  await db.query("update submissions set deleted_at=now()-interval '8 days' where id=$1", [product]);
  await db.query('select * from purge_expired_deleted_content(7)');
  assert.equal((await db.query('select count(*)::integer n from submissions where id=$1', [product])).rows[0].n, 0);
  assert.equal((await read('user', id)).items[0].product_id, null);
  assert.equal((await read('user', id)).mine[0].evidence, evidence);
});
await test('reward transaction rolls back XP, attempts, status and cap if a downstream ledger fails', async () => {
  const id = await create({ task_kind: 'quiz', quiz_question: 'Local rollback fixture', quiz_options: ['Correct', 'Wrong'], quiz_answer: 0 });
  await write('other', id, 'join');
  const before = (await db.query('select xp,lottery_tickets from profiles where id=$1', [ids.other])).rows[0];
  await db.exec(`create function activity_qa_fail_ticket() returns trigger language plpgsql as $$ begin if new.reason='community_activity' then raise exception 'injected ledger failure'; end if; return new; end $$;
  create trigger activity_qa_fail_ticket before insert on lottery_ticket_events for each row execute function activity_qa_fail_ticket();`);
  try { await rejected(() => write('other', id, 'quiz', { answer: 0 }), /injected ledger failure/); }
  finally { await db.exec('drop trigger activity_qa_fail_ticket on lottery_ticket_events; drop function activity_qa_fail_ticket()'); }
  assert.deepEqual((await db.query('select xp,lottery_tickets from profiles where id=$1', [ids.other])).rows[0], before);
  const data = await read('other', id);
  assert.equal(data.items[0].rewarded_count, 0); assert.equal(data.mine[0].status, 'joined'); assert.equal(data.mine[0].attempts, 0); assert.equal(data.mine[0].reward, null);
  await write('other', id, 'quiz', { answer: 0 });
  assert.equal((await read('other', id)).mine[0].status, 'approved');
});
await test('activity notification wrapper preserves real community links and hidden-content filtering', async () => {
  await as('other', () => rpc('follow_write', [ids.other, ids.admin, true]));
  const post = (await db.query("insert into submissions(type,title,tagline,description,status,submitted_by,community_section,community_category) values('post','Existing community activity thread','Fixture','Local legacy notification fixture','published',$1,'activities','community') returning id", [ids.admin])).rows[0].id;
  let notices = await as('other', () => rpc('notification_read', [ids.other, 0]));
  assert(notices.items.some((n) => n.href === `/community/activities/${post}`), 'real community href must survive activity projection');
  await db.query('update submissions set deleted_at=now() where id=$1', [post]);
  notices = await as('other', () => rpc('notification_read', [ids.other, 0]));
  assert(!notices.items.some((n) => n.submission_id === post), 'hidden legacy post must stay filtered');
  await db.query("insert into notifications(user_id,type,detail) values($1,'lottery_ticket',$2)", [ids.other, { amount: 3 }]);
  notices = await as('other', () => rpc('notification_read', [ids.other, 0]));
  assert(notices.items.some((n) => n.type === 'lottery_ticket' && n.detail?.amount === 3), 'legacy system detail must stay intact');
});
await test('admin changes are audited and repeated approval does not duplicate an audit or reward', async () => {
  const draft = await create({}, false);
  const payload = (await as('admin', () => rpc('activity_admin_read', [ids.admin]))).items.find((a) => a.id === draft);
  await admin('save', draft, { ...payload, title: payload.title + ' revised' });
  const logs = (await db.query("select * from admin_logs where target_type='activity'")).rows;
  for (const action of ['save', 'publish', 'cancel', 'approve', 'reject']) assert(logs.some((l) => l.action.endsWith(`_${action}`)), `missing ${action} audit`);
  assert(logs.every((l) => l.admin_id === ids.admin), 'audit must record authenticated actor');
  assert(logs.every((l) => !Object.hasOwn(l.detail, 'quiz_answer')), 'quiz answers must not spill into general logs');
  assert.equal(logs.filter((l) => l.target_id === manual && l.action.endsWith('_approve')).length, 1);
});
console.table(results);
await db.close();
if (results.some((r) => r.result === 'FAIL')) process.exitCode = 1;
