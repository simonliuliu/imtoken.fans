// Exercises the read-only 0034 postflight against isolated PGlite only.
// Optional paths permit testing the exact unmerged 0032/0033 candidates.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { db, check, out, root } from "./community-database-base.mjs";

const dir = `${root}/supabase/migrations`;
const before = [
  `${dir}/0029_community_post_type.sql`,
  `${dir}/0030_real_community.sql`,
  `${dir}/0031_feedback_text_validation.sql`,
  process.env.ACTIVITY_MIGRATION_0032 ?? `${dir}/0032_forum_feedback_inbox.sql`,
  process.env.ACTIVITY_MIGRATION_0033 ?? `${dir}/0033_submission_moderation_consistency.sql`,
];
for (const path of before) await db.exec(await fs.readFile(path, "utf8"));
const postflight = await fs.readFile(`${root}/docs/operations/2026-11-05-activity-restriction-postflight.sql`, "utf8");
const names = [
  "activity_triggers", "direct_tag_security_definers", "guard_function_acl",
  "guard_functions_and_ownership", "guard_table_acl", "guard_table_structure_and_rls",
  "legacy_activity_rpc_contract_and_acl", "protected_table_owners", "tag_write_acl",
];

async function runPostflight() {
  const result = await db.exec(postflight);
  const rows = result.find((item) => item.rows?.[0]?.check_name)?.rows;
  assert(rows, "postflight must return named checks");
  assert.deepEqual(rows.map((row) => row.check_name), names);
  return Object.fromEntries(rows.map((row) => [row.check_name, row.ok]));
}

await check("before migration the postflight cannot report guard success", async () => {
  const state = await runPostflight();
  assert.equal(state.guard_table_structure_and_rls, false);
  assert.equal(state.guard_function_acl, false);
  assert.equal(state.activity_triggers, false);
});

await db.exec(await fs.readFile(`${dir}/0034_activity_restriction_atomicity.sql`, "utf8"));

await check("the exact migration passes every postflight without changing business data", async () => {
  const sql = "select (select count(*) from profiles) p,(select count(*) from user_tags) t,(select count(*) from checkins) c,(select count(*) from lottery_draws) d,(select count(*) from admin_logs) a";
  const beforeCounts = (await db.query(sql)).rows[0];
  assert(Object.values(await runPostflight()).every((value) => value === true));
  assert.deepEqual((await db.query(sql)).rows[0], beforeCounts);
});

await check("disabled activity trigger is detected", async () => {
  await db.exec("alter table public.checkins disable trigger activity_restriction_checkin");
  try { assert.equal((await runPostflight()).activity_triggers, false); }
  finally { await db.exec("alter table public.checkins enable trigger activity_restriction_checkin"); }
});

await check("an activity trigger with a false WHEN condition is detected", async () => {
  for (const [table, trigger] of [["checkins", "activity_restriction_checkin"], ["lottery_draws", "activity_restriction_lottery"]]) {
    await db.exec(`create or replace trigger ${trigger} before insert on public.${table} for each row when (false) execute function public.activity_restriction_enforce()`);
    try { assert.equal((await runPostflight()).activity_triggers, false); }
    finally { await db.exec(`create or replace trigger ${trigger} before insert on public.${table} for each row execute function public.activity_restriction_enforce()`); }
  }
});

await check("an extra pre-existing trigger is detected", async () => {
  await db.exec(`create function public.qa_postflight_trigger() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger aaa_qa_postflight before insert on public.checkins for each row execute function public.qa_postflight_trigger();`);
  try { assert.equal((await runPostflight()).activity_triggers, false); }
  finally { await db.exec("drop trigger aaa_qa_postflight on public.checkins; drop function public.qa_postflight_trigger()"); }
});

await check("restored service-role tag write permission is detected", async () => {
  await db.exec("grant insert on public.user_tags to service_role");
  try { assert.equal((await runPostflight()).tag_write_acl, false); }
  finally { await db.exec("revoke insert on public.user_tags from service_role"); }
});

await check("column-level access to private guard is detected", async () => {
  await db.exec("grant select (revision) on public.activity_restriction_guard to authenticated");
  try { assert.equal((await runPostflight()).guard_table_acl, false); }
  finally { await db.exec("revoke select (revision) on public.activity_restriction_guard from authenticated"); }
});

await check("effective access by an unexpected login role is visible for audit", async () => {
  await db.exec("create role qa_external_login login; grant select (revision) on public.activity_restriction_guard to qa_external_login");
  try {
    const results = await db.exec(postflight);
    const rows = results.flatMap((item) => item.rows ?? []);
    const role = rows.find((row) => row.rolname === "qa_external_login");
    assert.equal(role?.effective_guard_access, true);
    assert.equal(rows.find((row) => row.check_name === "guard_table_acl")?.ok, false);
  } finally {
    await db.exec("revoke select (revision) on public.activity_restriction_guard from qa_external_login; drop role qa_external_login");
  }
});

await check("public helper execution is detected", async () => {
  await db.exec("grant execute on function public.activity_restriction_touch(uuid) to anon");
  try { assert.equal((await runPostflight()).guard_function_acl, false); }
  finally { await db.exec("revoke execute on function public.activity_restriction_touch(uuid) from anon"); }
});

await check("an unknown direct SECURITY DEFINER tag writer is detected", async () => {
  await db.exec(`create function public.qa_postflight_writer(p_user uuid) returns void language sql security definer as $$
    delete from public.user_tags where user_id=p_user and tag_key='blacklisted'
  $$`);
  try { assert.equal((await runPostflight()).direct_tag_security_definers, false); }
  finally { await db.exec("drop function public.qa_postflight_writer(uuid)"); }
});

await check("a changed guard function definition is detected", async () => {
  const original = (await db.query("select pg_get_functiondef('public.activity_restriction_enforce()'::regprocedure) definition")).rows[0].definition;
  const changed = original.replace("activity_restricted", "activity_blocked");
  assert.notEqual(changed, original);
  await db.exec(changed);
  try {
    const state = await runPostflight();
    assert.equal(state.guard_functions_and_ownership, false);
    assert.equal(state.direct_tag_security_definers, false);
  } finally { await db.exec(original); }
});

await check("a changed legacy activity RPC is detected", async () => {
  const original = (await db.query("select pg_get_functiondef('public.perform_checkin(uuid)'::regprocedure) definition")).rows[0].definition;
  const changed = original.replace("签到暂未开放", "签到维护中");
  assert.notEqual(changed, original);
  await db.exec(changed);
  try { assert.equal((await runPostflight()).legacy_activity_rpc_contract_and_acl, false); }
  finally { await db.exec(original); }
});

await check("preflight exposes dynamic writers and direct views for manual audit", async () => {
  await db.exec(`create function public.qa_dynamic_tag_writer(p_user uuid) returns void language plpgsql security definer as $$
    begin execute 'delete from public.' || quote_ident('user_' || 'tags') || ' where user_id = $1' using p_user; end $$;
    create view public.qa_tags_view as select user_id,tag_key from public.user_tags;
    revoke all on public.qa_tags_view from public,anon,authenticated,service_role;
    grant update (tag_key) on public.qa_tags_view to authenticated;`);
  try {
    const preflight = await db.exec(await fs.readFile(`${root}/docs/operations/2026-11-05-activity-restriction-preflight.sql`, "utf8"));
    const functionRow = preflight.flatMap((item) => item.rows ?? []).find((row) => row.function_name === "qa_dynamic_tag_writer(uuid)");
    const viewRow = preflight.flatMap((item) => item.rows ?? []).find((row) => row.viewname === "qa_tags_view");
    assert(functionRow, "dynamic SECURITY DEFINER function must appear in the audit inventory");
    assert.equal(functionRow.directly_mentions_user_tags, false);
    assert.equal(functionRow.anon_execute, true);
    assert(viewRow, "direct tag view must appear in the audit inventory");
    assert.equal(viewRow.authenticated_write, true);
    assert(viewRow.column_acls.some((column) => column.column === "tag_key"));
    // Dynamic writers need the separate manual audit; the textual gate alone
    // does not prove that an unknown function is safe.
    assert.equal((await runPostflight()).direct_tag_security_definers, true);
  } finally {
    await db.exec("drop view public.qa_tags_view; drop function public.qa_dynamic_tag_writer(uuid)");
  }
});

await check("an unapproved legacy RPC owner is detected", async () => {
  await db.exec("create role qa_unprivileged_rpc_owner noinherit; alter function public.perform_checkin(uuid) owner to qa_unprivileged_rpc_owner");
  try { assert.equal((await runPostflight()).legacy_activity_rpc_contract_and_acl, false); }
  finally {
    await db.exec("alter function public.perform_checkin(uuid) owner to current_user; drop role qa_unprivileged_rpc_owner");
  }
});

await check("a missing guard table cannot pass postflight", async () => {
  await db.exec("drop table public.activity_restriction_guard cascade");
  const state = await runPostflight();
  assert.equal(state.guard_table_structure_and_rls, false);
  assert.equal(state.guard_table_acl, false);
  assert.equal(state.protected_table_owners, false);
});

console.log(JSON.stringify(out, null, 2));
await db.close();
if (out.some((result) => result.result === "FAIL")) process.exit(1);
