/** Review R3 regression. Ephemeral PostgreSQL only; no target Supabase access. */
import { db, ids, as, ok, denied, results } from './feedback-security-base.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

await db.exec(`create function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;`);
const migration = async (name) => fs.readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const original = await migration('0025_product_feedback.sql');
await db.exec(original);
await db.exec(await migration('0026_feedback_forum_names.sql'));
const tables = ['feedback_posts', 'feedback_comments', 'feedback_post_votes', 'feedback_comment_votes', 'feedback_merges', 'feedback_audit'];
const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await db.query(`select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text`)).rows])));
const acl = async () => (await db.query(`select p.proname,p.proacl::text,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'feedback_%' order by p.proname`)).rows;
const write = (action, payload) => db.query('select feedback_write($1,$2::jsonb) result', [action, JSON.stringify(payload)]).then((r) => r.rows[0].result);
const create = (id = randomUUID(), extra = {}) => ({ id, title: '有效标题 valid title', description: '第一行 first line\n第二行 second line', module: 'wallet', ...extra });
const edit = (id, version = 1, extra = {}) => ({ id, version, title: '已修正 correct', description: '正文 valid description', module: 'wallet', status: 'inbox', mark: 'none', visibility: 'published', ...extra });
const admin = (fn) => as('authenticated', 'admin', fn);
const user = (fn) => as('authenticated', 'user', fn);
const rejects = async (fn, message = 'feedback_invalid') => assert.rejects(fn, (e) => e.message.includes(message));
const legacyPost = randomUUID(), legacyComment = randomUUID(), post = randomUUID(), comment = randomUUID(), source = randomUUID();
await user(async () => {
  await write('create', create(legacyPost, { title: '\n\n', description: '\u00a0\u00a0' }));
  await write('comment', { id: legacyPost, request_id: legacyComment, body: '\t\t' });
  await write('create', create(post));
  await write('comment', { id: post, request_id: comment, body: '原评论 original comment' });
  await write('create', create(source));
  await write('vote', { id: post, supported: true });
  await write('comment_vote', { id: comment, supported: true });
});
await admin(async () => {
  await write('edit', edit(post));
  await write('merge', { id: post, version: 2, other_id: source, other_version: 1 });
});
const before = await snapshot(), beforeACL = await acl();
const updated = await migration('0029_feedback_text_validation.sql');
await ok('0029 applies with legacy whitespace-only content and existing relationships', () => db.exec(updated));
await ok('every historical row remains byte-for-byte unchanged in all six feedback tables', async () => assert.deepEqual(await snapshot(), before));
await ok('existing function ACLs, security-definer settings and search paths remain unchanged', async () => assert.deepEqual((await acl()).filter((r) => r.proname !== 'feedback_text_trim'), beforeACL));
await ok('new constraints are NOT VALID and leave legacy rows readable', async () => {
  const constraints = (await db.query("select conname,convalidated from pg_constraint where conname like '%review_%' order by conname")).rows;
  assert.equal(constraints.length, 3); assert(constraints.every((c) => !c.convalidated));
  const result = await as('anon', null, () => db.query('select feedback_read($1) result', [legacyPost]));
  assert.equal(result.rows[0].result.selected.title, '\n\n');
});
// Current ECMAScript trim set, checked individually as well as in combination.
const whitespace = [...'\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'];
await ok('SQL trim equals JavaScript trim for every ECMAScript whitespace character', async () => {
  for (const w of [...whitespace, whitespace.join('')]) {
    for (const value of [w + w, `${w}中 en\n正文${w}`, `${w}中${w}文${w}`]) {
      assert.equal((await db.query('select feedback_text_trim($1) value', [value])).rows[0].value, value.trim());
    }
  }
});
for (const field of ['title', 'description']) await ok(`create RPC rejects all Unicode whitespace-only ${field} variants`, () => user(async () => {
  for (const w of [...whitespace, whitespace.join('')]) await rejects(() => write('create', create(randomUUID(), { [field]: w.repeat(2) })));
}));
for (const field of ['title', 'description']) await ok(`admin edit RPC rejects all Unicode whitespace-only ${field} variants`, () => admin(async () => {
  for (const w of [...whitespace, whitespace.join('')]) await rejects(() => write('edit', edit(legacyPost, 1, { [field]: w.repeat(2) })));
}));
await ok('comment RPC rejects all Unicode whitespace-only variants', () => user(async () => {
  for (const w of [...whitespace, whitespace.join('')]) await rejects(() => write('comment', { id: post, request_id: randomUUID(), body: w.repeat(2) }));
}));
await ok('admin edit_comment RPC rejects all Unicode whitespace-only variants', () => admin(async () => {
  for (const w of [...whitespace, whitespace.join('')]) await rejects(() => write('edit_comment', { id: comment, version: 1, body: w.repeat(2), mark: 'none', visibility: 'published' }));
}));
await ok('create normalizes Unicode edges while preserving multiline Chinese and English', () => user(async () => {
  const id = randomUUID(), title = '\u3000中文 English\ufeff', description = '\nFirst line\n第二行\r\nThird line\u00a0';
  await write('create', create(id, { title, description }));
  const row = (await db.query('select feedback_read($1) result', [id])).rows[0].result.selected;
  assert.equal(row.title, title.trim()); assert.equal(row.description, description.trim());
}));
await ok('Chinese/English title and description minimum/maximum boundaries enforce trimmed length', () => user(async () => {
  for (const char of ['中', 'a']) for (const [field, max] of [['title', 120], ['description', 5000]]) {
    for (const count of [2, max]) await write('create', create(randomUUID(), { [field]: `\u3000${char.repeat(count)}\ufeff` }));
    for (const count of [0, 1, max + 1]) await rejects(() => write('create', create(randomUUID(), { [field]: `\u3000${char.repeat(count)}\ufeff` })));
  }
}));
await ok('Chinese/English comment boundaries, normalization and same-ID retry remain valid', () => user(async () => {
  for (const char of ['中', 'a']) {
    for (const count of [2, 2000]) {
      const payload = { id: post, request_id: randomUUID(), body: `\u3000${char.repeat(count)}\ufeff` };
      const a = await write('comment', payload), b = await write('comment', payload); assert.deepEqual(a, b);
    }
    for (const count of [0, 1, 2001]) await rejects(() => write('comment', { id: post, request_id: randomUUID(), body: `\u3000${char.repeat(count)}\ufeff` }));
  }
}));
await ok('same-ID original retry is idempotent; changed content and another account cannot claim it', async () => {
  const payload = create(randomUUID(), { title: '\n\u00a0原样重试\ufeff', description: '\tSaved body\n' });
  const a = await user(() => write('create', payload));
  assert.deepEqual(await user(() => write('create', payload)), a);
  await rejects(() => user(() => write('create', { ...payload, title: 'changed title' })), 'feedback_conflict');
  await rejects(() => as('authenticated', 'other', () => write('create', payload)), 'feedback_conflict');
  assert.equal((await db.query('select count(*)::int n from feedback_posts where id=$1', [payload.id])).rows[0].n, 1);
});
for (const who of ['muted', 'blocked', 'missing']) await ok(`${who} cannot create/comment even valid normalized content`, () => as('authenticated', who, async () => {
  await rejects(() => write('create', create()), who === 'missing' ? 'feedback_sign_in' : 'feedback_restricted');
  await rejects(() => write('comment', { id: post, request_id: randomUUID(), body: '有效 comment' }), who === 'missing' ? 'feedback_sign_in' : 'feedback_restricted');
}));
await denied('anonymous retains no feedback_write EXECUTE', () => as('anon', null, () => write('create', create())));
for (const who of ['user', 'other', 'member']) await ok(`${who} cannot admin edit or edit_comment`, () => as('authenticated', who, async () => {
  await rejects(() => write('edit', edit(legacyPost)), 'feedback_forbidden');
  await rejects(() => write('edit_comment', { id: comment, version: 1, body: 'valid', mark: 'none', visibility: 'published' }), 'feedback_forbidden');
}));
for (const role of ['anon', 'authenticated']) await ok(`${role} gains no helper or raw-table privileges`, () => as(role, role === 'anon' ? null : 'user', async () => {
  for (const fn of ["feedback_text_trim('valid')", 'feedback_root(null)', 'feedback_actor(false)', 'feedback_card(null)', "feedback_forum_name('name','handle')"]) await assert.rejects(() => db.query(`select ${fn}`));
  for (const table of tables) for (const action of [`select * from ${table}`, `delete from ${table} where false`]) await assert.rejects(() => db.query(action));
  await assert.rejects(() => db.query("insert into feedback_posts(author_id,title,description,module) values($1,'raw','raw body','wallet')", [ids.user]));
  await assert.rejects(() => db.query("update feedback_posts set title='raw' where false"));
}));
await ok('privileged direct inserts/updates cannot bypass Unicode whitespace constraints', async () => {
  for (const field of ['title', 'description']) {
    const payload = create(); payload[field] = '\u3000\ufeff';
    await rejects(() => db.query('insert into feedback_posts(id,author_id,title,description,module) values($1,$2,$3,$4,$5)', [payload.id, ids.user, payload.title, payload.description, payload.module]), 'violates check constraint');
    await rejects(() => db.query(`update feedback_posts set ${field}=$1 where id=$2`, ['\u00a0\u00a0', post]), 'violates check constraint');
  }
  await rejects(() => db.query('insert into feedback_comments(post_id,author_id,body) values($1,$2,$3)', [post, ids.user, '\t\n']), 'violates check constraint');
  await rejects(() => db.query('update feedback_comments set body=$1 where id=$2', ['\t\n', comment]), 'violates check constraint');
});
await ok('NOT VALID legacy invalid rows block metadata-only updates until content is corrected', async () => {
  await rejects(() => db.query("update feedback_posts set visibility='hidden' where id=$1", [legacyPost]), 'violates check constraint');
  await rejects(() => db.query("update feedback_comments set visibility='hidden' where id=$1", [legacyComment]), 'violates check constraint');
  await admin(() => write('edit', edit(legacyPost)));
  await admin(() => write('edit_comment', { id: legacyComment, version: 1, body: '\u3000已更正 corrected\ufeff', mark: 'none', visibility: 'hidden' }));
  const row = (await db.query('select * from feedback_comments where id=$1', [legacyComment])).rows[0];
  assert.equal(row.body, '已更正 corrected'); assert.equal(row.visibility, 'hidden');
});
await ok('admin edit normalization, version and audit work after migration', () => admin(async () => {
  const id = randomUUID(); await write('create', create(id));
  await write('edit', edit(id, 1, { title: '\t\n管理修改\u3000', description: '\nvalid\nmultiline\ufeff', visibility: 'hidden' }));
  const row = (await db.query('select feedback_read($1) result', [id])).rows[0].result;
  assert.equal(row.selected.title, '管理修改'); assert.equal(row.selected.description, 'valid\nmultiline');
  assert.equal(row.selected.version, 2); assert.equal(row.history.length, 1);
}));
await ok('rollback restores only writer/constraints/helper and preserves all data and original ACLs', async () => {
  const preRollback = await snapshot();
  const originalWriter = original.match(/create function public\.feedback_write\([\s\S]*?\n\$\$;/)?.[0]; assert(originalWriter);
  await db.exec(`begin; ${originalWriter.replace('create function', 'create or replace function')}
    alter table feedback_posts drop constraint feedback_posts_review_title_check, drop constraint feedback_posts_review_description_check;
    alter table feedback_comments drop constraint feedback_comments_review_body_check;
    drop function feedback_text_trim(text); commit;`);
  assert.deepEqual(await snapshot(), preRollback); assert.deepEqual(await acl(), beforeACL);
  // Rollback deliberately restores 0025 validation; the originally reported hole returns.
  await user(() => write('create', create(randomUUID(), { title: '\n\n', description: '\t\t' })));
});
for (const result of results) console.log(`${result.result} ${result.name}${result.message ? `: ${result.message}` : ''}`);
console.log(`${results.filter((r) => r.result === 'PASS').length}/${results.length} text-validation checks passed. Sequential ephemeral PostgreSQL with simulated auth; target Supabase, concurrent sessions and PostgREST remain unverified.`);
await db.close(); if (results.some((r) => r.result === 'FAIL')) process.exit(1);
