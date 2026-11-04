// Complete historical 0001–0032 baseline, ephemeral PostgreSQL only. No Supabase credentials.
import { db, ids, as, root } from './community-database-base.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const checks = [];
async function check(name, run) { await run(); checks.push(name); console.log('PASS', name); }
const migration = (name) => fs.readFile(root + '/supabase/migrations/' + name, 'utf8');
for (const name of ['0029_community_post_type.sql', '0030_real_community.sql']) await db.exec(await migration(name));
const sql = await migration('0032_forum_feedback_inbox.sql');
await check('0032 refuses a baseline missing its explicit0031 dependency', async () => { await assert.rejects(() => db.exec(sql), /0032 requires complete 0031/); await db.exec('rollback'); });
const write = (action, payload) => db.query('select feedback_write($1,$2::jsonb) result', [action, JSON.stringify(payload)]).then((r) => r.rows[0].result);
const user = (run) => as('authenticated', 'a', run), other = (run) => as('authenticated', 'b', run), admin = (run) => as('authenticated', 'admin', run);
const service = (run) => as('service_role', null, run);
const legacy = randomUUID(), invalidComment = randomUUID();
await user(() => write('create', { id: legacy, title: 'Legacy title', description: 'Legacy content', module: 'wallet' }));
await other(() => write('comment', { id: legacy, request_id: invalidComment, body: '\t\t' }));
const before = (await db.query('select id,title,description,module,version,created_at from feedback_posts order by id')).rows;
await db.exec(await migration('0031_feedback_text_validation.sql'));
await db.exec(sql);
await check('migration preserves historical feedback contents and leaves structured data unknown', async () => {
  assert.deepEqual((await db.query('select id,title,description,module,version,created_at from feedback_posts order by id')).rows, before);
  assert.equal((await db.query('select kind from feedback_posts where id=$1', [legacy])).rows[0].kind, null);
});
const create = (id = randomUUID(), patch = {}) => ({ id, title: 'Forum title', description: 'A reproducible forum issue', module: 'forum', kind: 'bug', details: { steps: 'Open notifications', expected: 'Open the reply' }, ...patch });
const edit = async (id, patch = {}) => { const post = (await db.query('select * from feedback_posts where id=$1', [id])).rows[0]; return admin(() => write('edit', { id, version: post.version, title: post.title, description: post.description, module: post.module, status: post.status, mark: post.mark, visibility: post.visibility, ...patch })); };
const forum = randomUUID(), second = randomUUID();
await check('structured forum creation persists fields and exactly one private job', async () => {
  const p = create(forum); await user(() => write('create', p)); await user(() => write('create', p));
  const row = (await db.query('select kind,details from feedback_posts where id=$1', [forum])).rows[0];
  assert.equal(row.kind, 'bug'); assert.equal(row.details.steps, p.details.steps);
  assert.equal((await db.query('select count(*)::int n from forum_feedback_jobs where feedback_id=$1', [forum])).rows[0].n, 1);
  const projection = await user(() => db.query("select feedback_read($1,'','forum') result", [forum])); assert.equal(projection.rows[0].result.selected.kind, 'bug');
});
await check('changed structured payload with the same request ID conflicts', () => assert.rejects(() => user(() => write('create', create(forum, { kind: 'suggestion', details: { proposal: 'A new proposal' } }))), /feedback_conflict/));
for (const patch of [{ kind: undefined, details: undefined }, { details: { steps: 5 } }, { details: { command: 'shell input' } }, { kind: 'suggestion', details: { steps: 'wrong type' } }, { details: { device: 'invalid' } }, { details: { steps: 'x'.repeat(2001) } }]) {
  await check('invalid structured input is refused: ' + JSON.stringify(patch).slice(0, 80), () => assert.rejects(() => user(() => write('create', create(randomUUID(), patch))), /feedback_invalid/));
}
await check('forum/product filtering and selected targets cannot cross scopes', async () => {
  for (const [module, id] of [['forum', forum], ['product', legacy]]) {
    const data = (await user(() => db.query('select feedback_read($1,\'\',$2) r', [id, module]))).rows[0].r;
    assert(data.posts.every((post) => (post.module === 'forum') === (module === 'forum')));
  }
  await assert.rejects(() => user(() => db.query("select feedback_read($1,'','product')", [forum])), /feedback_not_found/);
  assert.equal((await user(() => db.query('select feedback_read($1) r', [forum]))).rows[0].r.selected.id, forum, 'all retains legacy link resolution');
});
await check('search finds structured details only within the visible feedback scope', async () => {
  const query = 'Open notifications';
  const read = (scope) => user(() => db.query('select feedback_read(null,$1,$2) r', [query, scope]));
  const visible = (await read('forum')).rows[0].r;
  assert(visible.posts.some((post) => post.id === forum));
  assert.equal(visible.total, 1);
  assert(!(await read('product')).rows[0].r.posts.some((post) => post.id === forum));
  await db.exec('begin');
  try {
    await edit(forum, { visibility: 'hidden' });
    assert(!(await read('forum')).rows[0].r.posts.some((post) => post.id === forum));
  } finally { await db.exec('rollback'); }
});
await check('forum/nonforum edit and both merge directions are rejected without mutation', async () => {
  await assert.rejects(() => edit(forum, { module: 'wallet' }), /feedback_scope/);
  await assert.rejects(() => edit(legacy, { module: 'forum' }), /feedback_scope/);
  for (const action of ['merge', 'preview_merge']) for (const [id, otherId] of [[forum, legacy], [legacy, forum]]) await assert.rejects(() => admin(() => write(action, { id, other_id: otherId, version: 1, other_version: 1 })), /feedback_scope/);
});
await check('private table and operator RPCs are inaccessible to anonymous/user/admin, including helpers', async () => {
  for (const role of ['anon', 'authenticated']) for (const name of [null, 'a', 'admin']) {
    await assert.rejects(() => as(role, name, () => db.query('select * from forum_feedback_jobs')));
    await assert.rejects(() => as(role, name, () => db.query('select forum_feedback_jobs_list()')));
    await assert.rejects(() => as(role, name, () => db.query("select forum_feedback_jobs_claim('forged')")));
    await assert.rejects(() => as(role, name, () => db.query("select forum_feedback_jobs_record($1,$2,'blocked')", [forum, randomUUID()])));
  }
  await assert.rejects(() => service(() => db.query('select * from forum_feedback_jobs')));
});
const claim = (id = null) => service(() => db.query("select forum_feedback_jobs_claim('fixture-worker',$1,60) r", [id])).then((r) => r.rows[0].r);
const record = (job, status, metadata = {}, token = job.lease_token) => service(() => db.query('select forum_feedback_jobs_record($1,$2,$3,$4::jsonb) r', [job.id, token, status, JSON.stringify(metadata)])).then((r) => r.rows[0].r);
const jobId = (id) => db.query('select id from forum_feedback_jobs where feedback_id=$1 order by created_at desc limit 1', [id]).then((r) => r.rows[0].id);
let leased;
await check('operator list omits tokens and a job has one live lease', async () => {
  const list = (await service(() => db.query('select forum_feedback_jobs_list() r'))).rows[0].r; assert(list.length); assert(list.every((row) => !('lease_token' in row)));
  leased = await claim(await jobId(forum)); assert(leased.lease_token); assert.equal(await claim(leased.id), null);
  await assert.rejects(() => record(leased, 'blocked', {}, randomUUID()), /forum_queue_lease/);
});
await check('expired leases can be reclaimed and the old token cannot record', async () => {
  await db.query("update forum_feedback_jobs set lease_until=now()-interval '1 second' where id=$1", [leased.id]);
  const next = await claim(leased.id); assert.notEqual(next.lease_token, leased.lease_token);
  await assert.rejects(() => record(leased, 'blocked'), /forum_queue_lease/); leased = next;
});
await check('deployed needs PR, commit and production association and keeps public workflow separate', async () => {
  await assert.rejects(() => record(leased, 'deployed'), /forum_queue_evidence/);
  const ready = await record(leased, 'pr_ready', { task_key: 'forum-fixture', pr_url: 'https://github.com/simonliuliu/imtoken.fans/pull/1' }); assert.equal(ready.status, 'pr_ready');
  const next = await claim(leased.id); const deployed = await record(next, 'deployed', { commit_sha: 'a'.repeat(40), deployment_id: 'fixture-deployment', deployment_url: 'https://imtoken-fans.vercel.app' });
  assert.equal(deployed.status, 'deployed'); assert(!('lease_token' in deployed));
  assert.equal((await db.query('select status from feedback_posts where id=$1', [forum])).rows[0].status, 'inbox');
});
await check('explicit reopen after deployment creates a fresh task and preserves prior production evidence', async () => {
  const before=(await db.query('select count(*)::int n from forum_feedback_jobs where feedback_id=$1',[forum])).rows[0].n;
  await edit(forum,{mark:'research'});assert.equal((await db.query('select count(*)::int n from forum_feedback_jobs where feedback_id=$1',[forum])).rows[0].n,before);
  await edit(forum,{status:'done'});await edit(forum,{status:'inbox'});
  const jobs=(await db.query('select * from forum_feedback_jobs where feedback_id=$1 order by created_at,id',[forum])).rows;
  assert.equal(jobs.length,before+1);assert.equal(jobs[0].status,'deployed');assert.equal(jobs[0].deployment_id,'fixture-deployment');
  const reopened=jobs.find(job=>job.status==='queued');assert(reopened);assert.equal(reopened.source_version,4);assert((await claim(reopened.id)).lease_token);
});
await user(() => write('create', create(second)));
await check('content revision invalidates a claimed snapshot and creates a new version once', async () => {
  const lease = await claim(await jobId(second)); await edit(second, { title: 'Revised forum issue' });
  assert.equal((await db.query('select status from forum_feedback_jobs where id=$1', [lease.id])).rows[0].status, 'stale');
  await assert.rejects(() => record(lease, 'blocked'), /forum_queue_lease/);
  assert.equal((await db.query('select count(*)::int n from forum_feedback_jobs where feedback_id=$1', [second])).rows[0].n, 2);
});
await check('status-only changes do not create loops; explicit reopen queues a new version', async () => {
  const count = (await db.query('select count(*)::int n from forum_feedback_jobs where feedback_id=$1', [second])).rows[0].n;
  const currentJob=await jobId(second);
  await edit(second, { status: 'building' });
  assert.equal((await db.query('select status from forum_feedback_jobs where id=$1',[currentJob])).rows[0].status,'queued');
  assert.equal((await db.query('select current_version from forum_feedback_jobs where id=$1',[currentJob])).rows[0].current_version,(await db.query('select version from feedback_posts where id=$1',[second])).rows[0].version);
  assert.equal((await db.query('select count(*)::int n from forum_feedback_jobs where feedback_id=$1', [second])).rows[0].n, count);
  await edit(second, { status: 'needsInfo' }); await edit(second, { status: 'inbox' });
  assert.equal((await db.query('select count(*)::int n from forum_feedback_jobs where feedback_id=$1', [second])).rows[0].n, count + 1);
});
await check('hidden feedback invalidates its queue and is not visible to a normal reader', async () => {
  const id = await jobId(second); await edit(second, { visibility: 'hidden' }); assert.equal((await db.query('select status from forum_feedback_jobs where id=$1', [id])).rows[0].status, 'stale');
  await assert.rejects(() => user(() => db.query("select feedback_read($1,'','forum')", [second])), /feedback_not_found/);
  await edit(second, { visibility: 'published' }); assert(await claim(await jobId(second)));
});
await check('same-scope merge/unmerge preserves sources and invalidates obsolete jobs', async () => {
  const third = randomUUID(); await user(() => write('create', create(third)));
  const rows = (await db.query('select id,version from feedback_posts where id in ($1,$2) order by id', [second, third])).rows;
  const merged = await admin(() => write('merge', { id: rows[0].id, version: rows[0].version, other_id: rows[1].id, other_version: rows[1].version }));
  const detail = (await admin(() => db.query("select feedback_read($1,'','forum') r", [merged.id]))).rows[0].r;
  assert.equal(detail.sources.length, 1);
  const active = (await db.query('select id from feedback_merges where undone_at is null')).rows[0];
  await admin(() => write('unmerge', { id: active.id, version: detail.selected.version }));
  assert.equal((await db.query('select count(*)::int n from feedback_posts where id in ($1,$2)', [second, third])).rows[0].n, 2);
});
await check('forum comment notification resolves to the forum category and comment anchor', async () => {
  const request = randomUUID(); await other(() => write('comment', { id: forum, request_id: request, body: 'A useful forum comment' }));
  const notifications = (await user(() => db.query('select notification_read($1) r', [ids.a]))).rows[0].r.items;
  assert(notifications.some((item) => item.href?.includes('category=forum&idea=' + forum) && item.href.endsWith('#comment-' + request)));
});
await check('metadata-only change preserves a claimed lease without creating duplicate repair', async () => {
  const id=randomUUID(); await user(()=>write('create',create(id))); const lease=await claim(await jobId(id));
  await edit(id,{status:'evaluating',mark:'research'}); const latest=(await db.query('select * from forum_feedback_jobs where id=$1',[lease.id])).rows[0];
  assert.equal(latest.lease_token,lease.lease_token); assert.equal(latest.status,'claimed'); assert.equal(latest.current_version,2);
  await record(lease,'blocked',{failure_reason:'Fixture needs more information'});
});
await check('default actionable list is not crowded out by more than20 historical jobs; history is paginated', async () => {
  for(let index=0;index<22;index++){const id=randomUUID();await user(()=>write('create',create(id)));await edit(id,{visibility:'hidden'});}
  const fresh=randomUUID();await user(()=>write('create',create(fresh)));
  const active=(await service(()=>db.query('select forum_feedback_jobs_list(100) r'))).rows[0].r;
  assert(active.some(j=>j.feedback_id===fresh)); assert(active.every(j=>!['deployed','stale'].includes(j.status)));
  const page1=(await service(()=>db.query('select forum_feedback_jobs_list(20,0,true) r'))).rows[0].r;
  const page2=(await service(()=>db.query('select forum_feedback_jobs_list(20,20,true) r'))).rows[0].r;
  assert.equal(page1.length,20);assert(page2.length);assert(!page2.some(j=>page1.some(old=>old.id===j.id)));
});
await check('fifth repair attempt can record a PR then claim explicit deployment registration without spending a repair retry', async () => {
  const id=randomUUID();await user(()=>write('create',create(id)));const jid=await jobId(id);
  await db.query('update forum_feedback_jobs set attempts=4 where id=$1',[jid]);const repair=await claim(jid);assert.equal(repair.attempts,5);
  await record(repair,'pr_ready',{pr_url:'https://github.com/simonliuliu/imtoken.fans/pull/2'});
  const list=(await service(()=>db.query('select forum_feedback_jobs_list(100) r'))).rows[0].r;assert(list.some(j=>j.id===jid));
  const delivery=await claim(jid);assert(delivery);assert.equal(delivery.attempts,5);
  await db.query("update forum_feedback_jobs set lease_until=now()-interval '1 second' where id=$1",[jid]);
  const resumed=await claim(jid);assert(resumed);assert.equal(resumed.attempts,5);assert.notEqual(resumed.lease_token,delivery.lease_token);
  await assert.rejects(()=>record(delivery,'deployed'),/forum_queue_lease/);
  const result=await record(resumed,'deployed',{commit_sha:'b'.repeat(40),deployment_id:'fifth-attempt-deployment',deployment_url:'https://imtoken-fans.vercel.app'});assert.equal(result.status,'deployed');
});
await check('forum list paginates real rows without product records or duplicate boundaries', async () => {
  for(let index=0;index<21;index++)await user(()=>write('create',create(randomUUID(),{title:'Pagination forum '+index})));
  const first=(await user(()=>db.query("select feedback_read(null,'','forum','all','latest',0) r"))).rows[0].r;
  const secondPage=(await user(()=>db.query("select feedback_read(null,'','forum','all','latest',20) r"))).rows[0].r;
  assert.equal(first.posts.length,20);assert(secondPage.posts.length);assert(first.posts.every(p=>p.module==='forum'));
  assert(!secondPage.posts.some(p=>first.posts.some(old=>old.id===p.id)));
});
await check('legacy invalid child and0031 whitespace protection remain intact', async () => {
  await edit(legacy, { title: 'Legacy title edited' }); assert.equal((await db.query('select body from feedback_comments where id=$1', [invalidComment])).rows[0].body, '\t\t');
  await assert.rejects(() => user(() => write('create', create(randomUUID(), { title: '\u00a0\u00a0' }))), /feedback_invalid/);
});
console.log(`${checks.length} full-baseline forum database checks passed; all records synthetic.`);
await db.close();
