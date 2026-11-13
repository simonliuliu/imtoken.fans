// Functional migration checks in an isolated in-memory PGlite database.
// This does not establish multi-connection PostgreSQL or production behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const fixtureRoot = process.env.PGLITE_TEST_DEPS_ROOT;
if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) {
  process.stderr.write('Set PGLITE_TEST_DEPS_ROOT to an absolute isolated dependency directory.\n');
  process.exit(1);
}
const fixtureRequire = createRequire(path.join(fixtureRoot, 'package.json'));
const { PGlite } = fixtureRequire('@electric-sql/pglite');
const root = fileURLToPath(new URL('../../', import.meta.url));
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0037_wallet_nonce_consumption.sql'), 'utf8');
const preflight = fs.readFileSync(path.join(root, 'docs/operations/2026-11-12-wallet-nonce-preflight.sql'), 'utf8');
const postflight = fs.readFileSync(path.join(root, 'docs/operations/2026-11-12-wallet-nonce-postflight.sql'), 'utf8');
const db = new PGlite();
let completed = 0;
const currentMillis = Date.now();
const key = n => n.toString(16).padStart(64, '0');
const claim = async (id, issuedAt = currentMillis) => (await db.query(
  'select public.consume_wallet_sign_in_nonce($1, $2::bigint) as consumed', [id, issuedAt],
)).rows[0].consumed;

try {
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const before = await db.exec(preflight);
  const absence = before.find(result => result.rows?.[0]?.claim_table_absent !== undefined)?.rows[0];
  assert.equal(absence.claim_table_absent, true);
  assert.equal(absence.cleanup_index_absent, true);
  assert.equal(absence.claim_function_absent, true);
  assert.equal(absence.required_roles_exist, true);
  assert.equal(absence.migration_history_followup, 'not_present');
  completed += 1;
  await db.exec(sql);

  const after = await db.exec(postflight);
  const tableMetadata = after.find(result => result.rows?.[0]?.claim_table !== undefined)?.rows[0];
  const functionMetadata = after.find(result => result.rows?.[0]?.claim_function !== undefined)?.rows[0];
  const roleMetadata = after.find(result => result.rows?.[0]?.can_execute_claim !== undefined)?.rows;
  const existence = after.find(result => result.rows?.[0]?.claim_table_exists !== undefined)?.rows[0];
  const columns = after.find(result => result.rows?.[0]?.column_name !== undefined)?.rows;
  const triggers = after.find(result => result.rows?.[0]?.unexpected_trigger_count !== undefined)?.rows[0];
  const aclChecks = after.find(result => result.rows?.[0]?.matching_owners !== undefined)?.rows[0];
  assert.equal(existence.claim_table_exists, true);
  assert.equal(existence.cleanup_index_exists, true);
  assert.equal(existence.claim_function_exists, true);
  assert.equal(existence.required_roles_exist, true);
  assert.deepEqual(columns.map(row => row.column_name), ['nonce_key', 'claimed_at']);
  assert.equal(Number(triggers.unexpected_trigger_count), 0);
  assert.equal(aclChecks.matching_owners, true);
  assert.equal(aclChecks.table_acl_owner_only, true);
  assert.equal(aclChecks.column_acl_owner_only, true);
  assert.equal(aclChecks.function_acl_owner_and_service_only, true);
  assert.equal(tableMetadata.row_level_security, true);
  assert.equal(tableMetadata.force_row_level_security, false);
  assert.equal(functionMetadata.security_definer, true);
  assert.deepEqual(functionMetadata.configuration, ['search_path=pg_catalog']);
  assert.equal(functionMetadata.volatility, 'v');
  assert.equal(roleMetadata.length, 3);
  assert.equal(roleMetadata.find(row => row.rolname === 'service_role').can_execute_claim, true);
  assert.equal(roleMetadata.find(row => row.rolname === 'anon').can_execute_claim, false);
  completed += 1;

  const privileges = await db.query(`
    select has_function_privilege('anon', 'public.consume_wallet_sign_in_nonce(text,bigint)', 'execute') as anon_execute,
           has_function_privilege('authenticated', 'public.consume_wallet_sign_in_nonce(text,bigint)', 'execute') as authenticated_execute,
           has_function_privilege('service_role', 'public.consume_wallet_sign_in_nonce(text,bigint)', 'execute') as service_execute,
           has_table_privilege('service_role', 'public.wallet_sign_in_nonce_claims', 'insert') as service_insert,
           has_table_privilege('service_role', 'public.wallet_sign_in_nonce_claims', 'select') as service_select,
           (select relrowsecurity from pg_class where oid = 'public.wallet_sign_in_nonce_claims'::regclass) as rls
  `);
  assert.deepEqual(privileges.rows[0], {
    anon_execute: false, authenticated_execute: false, service_execute: true,
    service_insert: false, service_select: false, rls: true,
  });
  completed += 1;

  await db.exec('set role anon');
  await assert.rejects(claim(key(1)), /permission denied/i);
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await assert.rejects(claim(key(1)), /permission denied/i);
  await db.exec('reset role');
  completed += 1;

  await db.exec('set role service_role');
  assert.equal(await claim(key(1)), true);
  assert.equal(await claim(key(1)), false);
  assert.equal(await claim(key(1), currentMillis + 1000), false);
  assert.equal(await claim(key(2)), true);
  await assert.rejects(db.query('select * from public.wallet_sign_in_nonce_claims'), /permission denied/i);
  await db.exec('reset role');
  completed += 1;

  await assert.rejects(claim('not-a-key'), /invalid nonce claim/i);
  await assert.rejects(db.query('select public.consume_wallet_sign_in_nonce(null, $1::bigint)', [currentMillis]), /invalid nonce claim/i);
  await assert.rejects(db.query('select public.consume_wallet_sign_in_nonce($1, null)', [key(4)]), /invalid nonce claim/i);
  assert.equal(await claim(key(5), currentMillis - 16 * 60 * 1000), false);
  assert.equal(await claim(key(6), currentMillis + 11 * 60 * 1000), false);
  completed += 1;

  const contenders = await Promise.all(Array.from({ length: 12 }, () => claim(key(7))));
  assert.equal(contenders.filter(Boolean).length, 1);
  completed += 1;

  await db.query(`insert into public.wallet_sign_in_nonce_claims(nonce_key, claimed_at)
    select lpad(to_hex(value), 64, '0'), clock_timestamp() - interval '49 hours'
      from generate_series(100, 169) as value`);
  const freshKey = key(999);
  assert.equal(await claim(freshKey), true);
  const counts = await db.query(`select count(*) filter (where claimed_at < clock_timestamp() - interval '48 hours')::int as old,
      count(*) filter (where nonce_key = $1)::int as fresh from public.wallet_sign_in_nonce_claims`, [freshKey]);
  assert.equal(counts.rows[0].old, 6);
  assert.equal(counts.rows[0].fresh, 1);
  completed += 1;

  await db.exec(`create function public.synthetic_nonce_trigger() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger synthetic_nonce_trigger after insert on public.wallet_sign_in_nonce_claims
    for each row execute function public.synthetic_nonce_trigger();
    grant select (nonce_key) on public.wallet_sign_in_nonce_claims to anon;`);
  const drift = await db.exec(postflight);
  const driftTrigger = drift.find(result => result.rows?.[0]?.unexpected_trigger_count !== undefined)?.rows[0];
  const driftAcl = drift.find(result => result.rows?.[0]?.matching_owners !== undefined)?.rows[0];
  const driftRoles = drift.find(result => result.rows?.[0]?.can_execute_claim !== undefined)?.rows;
  assert.equal(Number(driftTrigger.unexpected_trigger_count), 1);
  assert.equal(driftAcl.table_acl_owner_only, true);
  assert.equal(driftAcl.column_acl_owner_only, false);
  assert.equal(driftRoles.find(row => row.rolname === 'anon').can_select_claims, false);
  assert.equal(driftRoles.find(row => row.rolname === 'anon').can_select_any_column, true);
  await db.exec('drop trigger synthetic_nonce_trigger on public.wallet_sign_in_nonce_claims; drop function public.synthetic_nonce_trigger(); revoke select (nonce_key) on public.wallet_sign_in_nonce_claims from anon;');
  completed += 1;

  for (const [setup, expected] of [
    ["create role extra_reader; alter default privileges in schema public grant select on tables to extra_reader", /unexpected wallet nonce table grant/i],
    ["create role extra_executor; alter default privileges in schema public grant execute on functions to extra_executor", /unexpected wallet nonce function grant/i],
    ["grant service_role to authenticated", /unexpected wallet nonce function access/i],
  ]) {
    const unsafe = new PGlite();
    try {
      await unsafe.exec('create role anon; create role authenticated; create role service_role;');
      await unsafe.exec(setup);
      await assert.rejects(unsafe.exec(sql), expected);
      await unsafe.exec('rollback');
      const remaining = await unsafe.query("select to_regclass('public.wallet_sign_in_nonce_claims') as relation, to_regprocedure('public.consume_wallet_sign_in_nonce(text,bigint)') as operation");
      assert.equal(remaining.rows[0].relation, null);
      assert.equal(remaining.rows[0].operation, null);
      completed += 1;
    } finally {
      await unsafe.close();
    }
  }

  process.stdout.write(JSON.stringify({ result: 'PASS', scenarios: completed, storage: 'isolated PGlite', multiConnection: false }) + '\n');
} finally {
  await db.close();
}
