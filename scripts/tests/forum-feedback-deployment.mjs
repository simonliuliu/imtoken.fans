// Execute the exact controlled SQL against four independent ephemeral databases.
// No network, production credentials, or real user data are read by this test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarios = ['without-0031', 'with-0031', 'partial-0031', 'mismatched-helper'];
const scenario = process.argv[2];

if (!scenario) {
  for (const name of scenarios) {
    try {
      const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), name], {
        encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024,
      });
      process.stdout.write(output);
    } catch (error) {
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
      throw new Error(`Controlled deployment scenario failed: ${name}`);
    }
  }
  console.log('4 controlled deployment paths passed; no real database accessed.');
} else {
  assert(scenarios.includes(scenario), 'Unknown controlled deployment scenario');
  const { db, ids, root } = await import('./community-database-base.mjs');
  try {
    for (const migration of ['0029_community_post_type.sql', '0030_real_community.sql']) {
      await db.exec(await fs.readFile(`${root}/supabase/migrations/${migration}`, 'utf8'));
    }
    if (scenario === 'with-0031' || scenario === 'mismatched-helper') {
      await db.exec(await fs.readFile(`${root}/supabase/migrations/0031_feedback_text_validation.sql`, 'utf8'));
    }
    if (scenario === 'partial-0031') {
      await db.exec('create function public.feedback_text_trim(value text) returns text language sql immutable strict as $$select value$$;');
    }
    if (scenario === 'mismatched-helper') {
      await db.exec('create or replace function public.feedback_text_trim(value text) returns text language sql immutable strict as $$select value$$;');
    }
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await db.query("insert into feedback_posts(id,author_id,title,description,module) values($1,$2,'Legacy feedback title','Legacy feedback body','wallet')", [id, ids.a]);
    const before = (await db.query('select to_jsonb(p) value from feedback_posts p where id=$1', [id])).rows[0].value;
    const sql = await fs.readFile(`${root}/docs/operations/2026-11-03-forum-feedback-transaction.sql`, 'utf8');
    if (scenario === 'partial-0031' || scenario === 'mismatched-helper') {
      const reason = scenario === 'partial-0031' ? /forum_deploy_partial_0031_dependency/ : /forum_deploy_0031_helper_mismatch/;
      await assert.rejects(() => db.exec(sql), reason);
      await db.exec('rollback');
      assert.equal((await db.query("select to_regclass('public.forum_feedback_jobs') value")).rows[0].value, null);
      assert.equal((await db.query("select count(*)::integer value from information_schema.columns where table_schema='public' and table_name='feedback_posts' and column_name in ('kind','details')")).rows[0].value, 0);
      assert.deepEqual((await db.query('select to_jsonb(p) value from feedback_posts p where id=$1', [id])).rows[0].value, before);
    } else {
      await db.exec(sql);
      const row = (await db.query('select to_jsonb(p) value from feedback_posts p where id=$1', [id])).rows[0].value;
      assert.equal(row.kind, null);
      assert.equal(row.details, null);
      delete row.kind;
      delete row.details;
      assert.deepEqual(row, before);
      assert.equal((await db.query('select count(*)::integer value from forum_feedback_jobs')).rows[0].value, 0);
      const read = await db.query("select feedback_read(null,'','forum','all','latest',0,0) value");
      assert.equal(read.rows[0].value.total, 0);
      const contract = await db.query("select has_function_privilege('service_role','public.forum_feedback_jobs_list(integer,integer,boolean)','execute') as worker,has_function_privilege('authenticated','public.forum_feedback_jobs_list(integer,integer,boolean)','execute') as client");
      assert.equal(contract.rows[0].worker, true);
      assert.equal(contract.rows[0].client, false);
      await assert.rejects(() => db.exec(sql), /forum_deploy_0032_already_or_partially_installed/);
      await db.exec('rollback');
      assert.equal((await db.query('select count(*)::integer value from feedback_posts where id=$1', [id])).rows[0].value, 1);
    }
    console.log(`PASS controlled deployment: ${scenario}`);
  } catch (error) {
    console.error(`FAIL controlled deployment: ${scenario}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
