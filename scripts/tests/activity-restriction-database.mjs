// Isolated PGlite validation only. No production connections or credentials.
// Before PR #41/#42 are merged, point the optional migration variables at their
// exact candidate 0032/0033 files; after merging the normal repository paths work.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { db, ids, as, check, out, root } from "./community-database-base.mjs";

const migrationDir = `${root}/supabase/migrations`;
const migrations = [
  `${migrationDir}/0029_community_post_type.sql`,
  `${migrationDir}/0030_real_community.sql`,
  `${migrationDir}/0031_feedback_text_validation.sql`,
  process.env.ACTIVITY_MIGRATION_0032 ?? `${migrationDir}/0032_forum_feedback_inbox.sql`,
  process.env.ACTIVITY_MIGRATION_0033 ?? `${migrationDir}/0033_submission_moderation_consistency.sql`,
];
for (const file of migrations) await db.exec(await fs.readFile(file, "utf8"));

await check("read-only preflight runs on the complete candidate baseline", async () => {
  const results = await db.exec(await fs.readFile(`${root}/docs/operations/2026-11-05-activity-restriction-preflight.sql`, "utf8"));
  const readiness = results.find((result) => result.rows?.[0]?.forum_queue_exists !== undefined)?.rows[0];
  assert.equal(readiness?.forum_queue_exists, true);
  assert.equal(readiness?.moderation_revision_exists, true);
  assert.equal(readiness?.guard_name_available, true);
  assert.equal(readiness?.function_names_available, true);
});

const migration = await fs.readFile(`${migrationDir}/0034_activity_restriction_atomicity.sql`, "utf8");
await check("inherited column-level write access aborts the entire migration", async () => {
  await db.exec(`create role qa_inherited_writer noinherit;
    alter role service_role inherit;
    grant qa_inherited_writer to service_role;
    grant insert (tag_key) on public.user_tags to qa_inherited_writer;`);
  try {
    await assert.rejects(() => db.exec(migration), /0034_unexpected_effective_privilege/);
    await db.exec("rollback");
    assert.equal((await db.query("select to_regclass('public.activity_restriction_guard') guard")).rows[0].guard, null);
  } finally {
    await db.exec(`revoke insert (tag_key) on public.user_tags from qa_inherited_writer;
      revoke qa_inherited_writer from service_role;
      alter role service_role noinherit;
      drop role qa_inherited_writer;`);
  }
});

await check("unexpected default grants on new guard objects abort the migration", async () => {
  await db.exec("create role qa_extra_default noinherit");
  try {
    for (const [objectType, privilege, expected] of [
      ["tables", "select", /0034_unexpected_guard_grant/],
      ["functions", "execute", /0034_unexpected_function_grant/],
    ]) {
      await db.exec(`alter default privileges in schema public grant ${privilege} on ${objectType} to qa_extra_default`);
      try {
        await assert.rejects(() => db.exec(migration), expected);
        await db.exec("rollback");
        assert.equal((await db.query("select to_regclass('public.activity_restriction_guard') guard")).rows[0].guard, null);
      } finally {
        await db.exec(`alter default privileges in schema public revoke ${privilege} on ${objectType} from qa_extra_default`);
      }
    }
  } finally {
    await db.exec("drop role qa_extra_default");
  }
});

const before = (await db.query(`select
  (select count(*) from profiles) profiles,
  (select count(*) from user_tags) tags,
  (select count(*) from checkins) checkins,
  (select count(*) from lottery_draws) draws,
  (select count(*) from xp_events) xp,
  (select count(*) from lottery_ticket_events) tickets,
  (select count(*) from admin_logs) logs,
  'public.perform_checkin(uuid)'::regprocedure::oid checkin_oid,
  'public.perform_lottery_draw(uuid)'::regprocedure::oid draw_oid`)).rows[0];

await db.exec(migration);
const q = (sql, values = []) => db.query(sql, values);
const rpcTag = (actor, target, tag, on) => as("service_role", null, () =>
  q("select public.admin_set_user_tag($1,$2,$3,$4)", [actor, target, tag, on]));
const checkin = (user) => as("service_role", null, () => q("select * from public.perform_checkin($1)", [user]));
const draw = (user) => as("service_role", null, () => q("select * from public.perform_lottery_draw($1)", [user]));

await check("migration preserves existing rows and activity RPC identities", async () => {
  const after = (await q(`select
    (select count(*) from profiles) profiles,
    (select count(*) from user_tags) tags,
    (select count(*) from checkins) checkins,
    (select count(*) from lottery_draws) draws,
    (select count(*) from xp_events) xp,
    (select count(*) from lottery_ticket_events) tickets,
    (select count(*) from admin_logs) logs,
    'public.perform_checkin(uuid)'::regprocedure::oid checkin_oid,
    'public.perform_lottery_draw(uuid)'::regprocedure::oid draw_oid`)).rows[0];
  assert.deepEqual(after, before);
});

await check("ordinary and service roles cannot directly write tags or access private guards", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER"]) {
      const row = (await q("select has_table_privilege($1,'public.user_tags',$2) allowed", [role, privilege])).rows[0];
      assert.equal(row.allowed, false, `${role} ${privilege}`);
    }
    for (const privilege of ["INSERT", "UPDATE"]) {
      const row = (await q("select has_any_column_privilege($1,'public.user_tags',$2) allowed", [role, privilege])).rows[0];
      assert.equal(row.allowed, false, `${role} column ${privilege}`);
    }
    await assert.rejects(() => as(role, null, () => q("select * from public.activity_restriction_guard")));
    await assert.rejects(() => as(role, null, () => q("select public.activity_restriction_touch($1)", [ids.a])));
  }
  await assert.rejects(() => as("service_role", null, () => q("insert into public.user_tags(user_id,tag_key) values($1,'vip')", [ids.a])));
  await assert.rejects(() => as("service_role", null, () => q("update public.user_tags set set_by=$1 where user_id=$2", [ids.admin, ids.blocked])));
  await assert.rejects(() => as("service_role", null, () => q("delete from public.user_tags where user_id=$1", [ids.blocked])));
  await assert.rejects(() => as("service_role", null, () => q("truncate table public.user_tags")));
  const visible = await as("authenticated", "a", () => q("select tag_key from public.user_tags where user_id=$1", [ids.blocked]));
  assert.equal(visible.rows[0].tag_key, "blacklisted");
});

await check("tag RPC is service-only and checks actor permission, target and inputs", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(() => as(role, "admin", () => q("select public.admin_set_user_tag($1,$2,$3,$4)", [ids.admin, ids.a, "vip", true])));
  }
  await assert.rejects(() => rpcTag(ids.a, ids.b, "blacklisted", true));
  await assert.rejects(() => rpcTag(ids.member, ids.b, "blacklisted", true));
  await assert.rejects(() => rpcTag(ids.admin, ids.a, "unrecognised", true));
  await assert.rejects(() => rpcTag(ids.admin, ids.a, "vip", null));
  await assert.rejects(() => rpcTag(ids.admin, "99999999-9999-4999-8999-999999999999", "vip", true));
  await q("update public.profiles set permissions=$2 where id=$1", [ids.member, { manage_user_tags: true }]);
  await rpcTag(ids.member, ids.a, "vip", true);
  assert.equal((await q("select count(*) n from public.user_tags where user_id=$1 and tag_key='vip'", [ids.a])).rows[0].n, 1);
});

await check("tag changes and audit records commit together, including existing-tag upsert", async () => {
  const start = (await q("select count(*) n from public.admin_logs where target_id=$1", [ids.b])).rows[0].n;
  await rpcTag(ids.admin, ids.b, "blacklisted", true);
  await rpcTag(ids.admin, ids.b, "blacklisted", true);
  await rpcTag(ids.admin, ids.b, "blacklisted", false);
  assert.equal((await q("select count(*) n from public.user_tags where user_id=$1 and tag_key='blacklisted'", [ids.b])).rows[0].n, 0);
  assert.equal((await q("select count(*) n from public.admin_logs where target_id=$1", [ids.b])).rows[0].n, start + 3);
  assert.equal(Number((await q("select revision from public.activity_restriction_guard where user_id=$1", [ids.b])).rows[0].revision), 3);
});

await check("audit failure rolls back both tag and guard version", async () => {
  const revision = (await q("select revision from public.activity_restriction_guard where user_id=$1", [ids.b])).rows[0].revision;
  await db.exec(`create function public.qa_reject_log() returns trigger language plpgsql as $$ begin raise exception 'synthetic_audit_failure'; end $$;
    create trigger qa_reject_log before insert on public.admin_logs for each row execute function public.qa_reject_log();`);
  try {
    await assert.rejects(() => rpcTag(ids.admin, ids.b, "blacklisted", true));
    assert.equal((await q("select count(*) n from public.user_tags where user_id=$1 and tag_key='blacklisted'", [ids.b])).rows[0].n, 0);
    assert.equal((await q("select revision from public.activity_restriction_guard where user_id=$1", [ids.b])).rows[0].revision, revision);
  } finally {
    await db.exec("drop trigger qa_reject_log on public.admin_logs; drop function public.qa_reject_log();");
  }
});

await check("unrestricted check-in succeeds, confirmed blacklist fails without changing XP", async () => {
  const allowed = await checkin(ids.a);
  assert.equal(allowed.rows[0].ok, true);
  const xp = (await q("select xp from public.profiles where id=$1", [ids.blocked])).rows[0].xp;
  await assert.rejects(() => checkin(ids.blocked), /activity_restricted/);
  assert.equal((await q("select count(*) n from public.checkins where user_id=$1", [ids.blocked])).rows[0].n, 0);
  assert.equal((await q("select xp from public.profiles where id=$1", [ids.blocked])).rows[0].xp, xp);
});

await check("blacklisted lottery rolls back inventory, tickets, XP, badges and ledger", async () => {
  await q("update public.profiles set lottery_tickets=5 where id=$1", [ids.blocked]);
  await db.exec("update public.lottery_settings set enabled=true, starts_at=null, ends_at=null, draws_per_day=0, cost_tickets=1, cost_xp=0 where id=true");
  const snapshot = async () => (await q(`select
    (select row_to_json(p) from (select xp,level,lottery_tickets from public.profiles where id=$1) p) profile,
    (select coalesce(sum(awarded_count),0) from public.lottery_prizes) awarded,
    (select count(*) from public.lottery_draws where user_id=$1) draws,
    (select count(*) from public.lottery_ticket_events where user_id=$1) tickets,
    (select count(*) from public.xp_events where user_id=$1) xp,
    (select count(*) from public.badges where user_id=$1) badges`, [ids.blocked])).rows[0];
  const prior = await snapshot();
  await assert.rejects(() => draw(ids.blocked), /activity_restricted/);
  assert.deepEqual(await snapshot(), prior);
});

await check("clearing restriction allows activity without changing earlier user history", async () => {
  await rpcTag(ids.admin, ids.blocked, "blacklisted", false);
  assert.equal((await checkin(ids.blocked)).rows[0].ok, true);
  assert.equal((await draw(ids.blocked)).rows[0].ok, true);
});

await check("profile deletion cascades private guard and tags", async () => {
  const user = "77777777-7777-4777-8777-777777777777";
  await q("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)", [user, "qa_delete@example.invalid", { username: "qa_delete" }]);
  await rpcTag(ids.admin, user, "blacklisted", true);
  await q("delete from auth.users where id=$1", [user]);
  assert.equal((await q("select count(*) n from public.activity_restriction_guard where user_id=$1", [user])).rows[0].n, 0);
  assert.equal((await q("select count(*) n from public.user_tags where user_id=$1", [user])).rows[0].n, 0);
});

console.log(JSON.stringify(out, null, 2));
await db.close();
if (out.some((result) => result.result === "FAIL")) process.exit(1);
