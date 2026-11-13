// Isolated integration test: no Supabase credentials, non-loopback listener or real data.
// WALLET_QA_PG_BIN must point to a local PostgreSQL 16.9 bin directory and
// WALLET_QA_PG_MODULE to the entry point of an independently installed pg.
// WALLET_QA_MIGRATION_0032 through 0036 select the existing candidate files.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const binDir = process.env.WALLET_QA_PG_BIN;
const pgModule = process.env.WALLET_QA_PG_MODULE;
if (!binDir || !pgModule || !path.isAbsolute(binDir) || !path.isAbsolute(pgModule)) {
  throw new Error("Set absolute WALLET_QA_PG_BIN and WALLET_QA_PG_MODULE paths");
}
const { Client } = await import(pathToFileURL(pgModule).href).then((m) => m.default ?? m);
const migrationNames = {
  "0031": "0031_feedback_text_validation.sql",
  "0032": "0032_forum_feedback_inbox.sql",
  "0033": "0033_submission_moderation_consistency.sql",
  "0034": "0034_activity_restriction_atomicity.sql",
  "0035": "0035_feedback_media_staging.sql",
  "0036": "0036_feedback_media_linking.sql",
  "0037": "0037_wallet_nonce_consumption.sql",
};
const migrations = {};
const hashes = {};
for (const [id, name] of Object.entries(migrationNames)) {
  const configured = process.env[`WALLET_QA_MIGRATION_${id}`];
  if (configured && !path.isAbsolute(configured)) throw new Error(`${id} path must be absolute`);
  const sql = await fs.readFile(configured ?? path.join(root, "supabase/migrations", name), "utf8");
  migrations[id] = sql;
  hashes[id] = createHash("sha256").update(sql).digest("hex");
}
const oldNames = (await fs.readdir(path.join(root, "supabase/migrations")))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0031")
  .sort();
assert.equal(oldNames.length, 30, "expected all 0001–0030 baseline migrations");
const oldSql = await Promise.all(oldNames.map((name) => fs.readFile(path.join(root, "supabase/migrations", name), "utf8")));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "imtoken-order-"));
const dataDir = path.join(temp, "data");
const ownerName = "wallet_migration_qa";
const init = spawnSync(path.join(binDir, "initdb"), ["-D", dataDir, "-U", ownerName, "--auth=trust", "--encoding=UTF8", "--no-locale", "--no-sync"], { encoding: "utf8" });
if (init.status !== 0) {
  await fs.rm(temp, { recursive: true, force: true });
  throw new Error(`initdb failed: ${init.stderr || init.error?.message || init.status}`);
}
// Reserve an ephemeral port; PostgreSQL binds loopback only and no Unix socket.
const reservation = net.createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
const port = reservation.address().port;
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
const server = spawn(path.join(binDir, "postgres"), ["-D", dataDir, "-h", "127.0.0.1", "-p", String(port), "-c", "unix_socket_directories=", "-c", "shared_buffers=16MB", "-c", "max_connections=20"], { stdio: ["ignore", "ignore", "pipe"] });
let serverError = "";
server.stderr.on("data", (data) => { serverError += data.toString(); });
const clients = new Set();
async function connect(database = "postgres") {
  const client = new Client({ host: "127.0.0.1", port, user: ownerName, database, ssl: false, connectionTimeoutMillis: 500, statement_timeout: 15000 });
  try {
    await client.connect();
    // The reserved port is released before postgres binds it. Refuse to run
    // any test SQL unless this connection belongs to the child we started.
    const actualDataDir = (await client.query("show data_directory")).rows[0].data_directory;
    const [actual, expected, pidFile] = await Promise.all([
      fs.realpath(actualDataDir), fs.realpath(dataDir), fs.readFile(path.join(dataDir, "postmaster.pid"), "utf8"),
    ]);
    if (actual !== expected || Number(pidFile.split("\n", 1)[0]) !== server.pid || server.exitCode !== null || server.signalCode !== null) {
      const error = new Error("Refusing to use an unexpected PostgreSQL instance");
      error.code = "WALLET_QA_WRONG_INSTANCE";
      throw error;
    }
    clients.add(client);
    return client;
  } catch (error) {
    try { await client.end(); } catch {}
    throw error;
  }
}
async function as(client, role, actor, fn) {
  await client.query(`set role ${role}`);
  try {
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [actor ?? ""]);
    return await fn();
  } finally {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claim.sub','',false)");
  }
}
async function claim(client, key) {
  return as(client, "service_role", null, async () => (await client.query("select public.consume_wallet_sign_in_nonce($1,$2::bigint) as consumed", [key, Date.now()])).rows[0].consumed);
}
async function snapshot(client, ids) {
  return (await client.query(`select
    (select row_to_json(f) from (select id,author_id,title,description,module,version from public.feedback_posts where id=$1) f) as legacy,
    (select row_to_json(s) from (select id,submitted_by,title,status,type from public.submissions where id=$2) s) as submission,
    (select row_to_json(j) from (select feedback_id,status,lease_token,source_version,current_version from public.forum_feedback_jobs where id=$3) j) as job,
    (select row_to_json(m) from (select id,owner_id,draft_id,state,bucket_id,staging_path from public.feedback_media_uploads where id=$4) m) as media`, [ids.legacy, ids.submission, ids.job, ids.media])).rows[0];
}
async function businessRows(client) {
  const tables = ["profiles", "user_tags", "submissions", "moderation_queue", "feedback_posts", "feedback_comments", "feedback_post_votes", "feedback_audit", "forum_feedback_jobs", "feedback_media_uploads", "feedback_media_audit", "xp_events", "notifications", "checkins", "lottery_draws", "lottery_prizes", "lottery_ticket_events"];
  const result = {};
  for (const table of tables) {
    result[table] = (await client.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from public.${table} t`)).rows[0].rows;
  }
  for (const table of ["objects", "buckets"]) {
    result[`storage.${table}`] = (await client.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from storage.${table} t`)).rows[0].rows;
  }
  return result;
}
async function schemaContract(client) {
  const relations = (await client.query(`select c.relname,c.relkind,c.relrowsecurity,pg_catalog.pg_get_userbyid(c.relowner) owner,c.relacl::text
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','S') order by c.relname`)).rows;
  const functions = (await client.query(`select p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) args,
    p.prosecdef,p.proconfig,pg_catalog.pg_get_userbyid(p.proowner) owner,p.proacl::text,pg_catalog.pg_get_functiondef(p.oid) definition
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' order by p.proname,args`)).rows;
  const columns = (await client.query(`select c.relname,a.attname,a.attacl::text from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid=a.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and a.attnum>0 and not a.attisdropped and c.relkind in ('r','p','v','m') order by c.relname,a.attname`)).rows;
  const indexes = (await client.query("select indexname,indexdef from pg_catalog.pg_indexes where schemaname='public' order by indexname")).rows;
  const triggers = (await client.query(`select c.relname,t.tgname,pg_catalog.pg_get_triggerdef(t.oid) definition from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`)).rows;
  return { relations, functions, columns, indexes, triggers };
}
async function runOrder(admin, database, mode) {
  await admin.query(`create database ${database}`);
  const db = await connect(database);
  await db.query(`create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text);
    create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  for (let i = 0; i < oldNames.length; i++) {
    try { await db.query(oldSql[i]); } catch (error) { throw new Error(`${database} ${oldNames[i]}: ${error.message}`, { cause: error }); }
  }
  const actor = randomUUID(), moderator = randomUUID(), restricted = randomUUID();
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'user@example.invalid',$4),($2,'admin@example.invalid',$5),($3,'restricted@example.invalid',$6)", [actor, moderator, restricted, JSON.stringify({ username: "qa_user" }), JSON.stringify({ username: "qa_admin" }), JSON.stringify({ username: "qa_restricted" })]);
  await db.query("update public.profiles set role='admin' where id=$1", [moderator]);
  const ids = { legacy: randomUUID(), submission: randomUUID(), forum: randomUUID(), media: randomUUID(), draft: randomUUID() };
  const write = (action, payload) => as(db, "authenticated", actor, () => db.query("select public.feedback_write($1,$2::jsonb) r", [action, JSON.stringify(payload)]));
  await write("create", { id: ids.legacy, title: "Historical feedback", description: "Synthetic historical record", module: "wallet" });
  await db.query("insert into public.submissions(id,submitted_by,status,type,title,tagline,description) values($1,$2,'pending','product','Historical submission','Fixture','Synthetic historical record')", [ids.submission, actor]);
  assert.equal((await as(db, "service_role", null, () => db.query("select ok from public.perform_checkin($1)", [actor]))).rows[0].ok, true);
  await db.query("insert into public.notifications(user_id,actor_id,type,submission_id) values($1,$2,'mention',$3)", [actor, moderator, ids.submission]);
  const legacyBefore = (await db.query("select id,author_id,title,description,module,version from public.feedback_posts where id=$1", [ids.legacy])).rows[0];
  const submissionBefore = (await db.query("select id,submitted_by,title,status,type from public.submissions where id=$1", [ids.submission])).rows[0];
  const oldKey = "a".repeat(64);
  if (mode === "before_0031" || mode === "invalid") {
    await db.query(migrations["0037"]);
    assert.equal(await claim(db, oldKey), true);
  }
  async function rejectMigration(id, message, absent) {
    await assert.rejects(db.query(migrations[id]), message);
    await db.query("rollback");
    assert.equal((await db.query("select to_regclass($1) is null absent", [absent])).rows[0].absent, true);
    assert.equal(await claim(db, oldKey), false);
  }
  if (mode === "invalid") {
    await rejectMigration("0032", /0032 requires complete 0031/, "public.forum_feedback_jobs");
    await rejectMigration("0034", /0034_requires_complete_0032_and_0033/, "public.activity_restriction_guard");
  }
  await db.query(migrations["0031"]);
  if (mode === "after_0031") {
    await db.query(migrations["0037"]);
    assert.equal(await claim(db, oldKey), true);
  }
  await db.query(migrations["0032"]);
  await write("create", { id: ids.forum, title: "Forum issue", description: "A synthetic reproducible issue", module: "forum", kind: "bug", details: { steps: "Open the example" } });
  ids.job = (await db.query("select id from public.forum_feedback_jobs where feedback_id=$1", [ids.forum])).rows[0].id;
  const lease = (await as(db, "service_role", null, () => db.query("select public.forum_feedback_jobs_claim('isolated-order',$1,3600) r", [ids.job]))).rows[0].r;
  assert(lease.lease_token);
  await db.query(migrations["0033"]);
  if (mode === "invalid") await rejectMigration("0036", /0036 requires the unmodified 0032 and 0035/, "public.feedback_media_audit");
  if (mode !== "invalid") await db.query(migrations["0034"]);
  await db.query(`alter table storage.objects add column metadata jsonb;
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;`);
  await db.query(migrations["0035"]);
  if (mode === "invalid") {
    await rejectMigration("0034", /0034_unreviewed_tag_security_definer/, "public.activity_restriction_guard");
    assert.equal((await db.query("select to_regprocedure('public.admin_set_user_tag(uuid,uuid,text,boolean)') is null absent")).rows[0].absent, true);
    assert.equal((await db.query("select to_regclass('public.feedback_media_uploads') is not null present")).rows[0].present, true);
    console.log("PASS missing and unsafe business migration orders fail and roll back without erasing the nonce");
    return null;
  }
  await db.query(migrations["0036"]);
  const reserved = (await as(db, "authenticated", actor, () => db.query("select public.feedback_media_reserve($1,$2,'image/png',42) r", [ids.media, ids.draft]))).rows[0].r;
  assert.equal(reserved.state, "reserved");
  const before = await snapshot(db, ids);
  const beforeBusiness = await businessRows(db);
  assert.deepEqual(before.legacy, legacyBefore);
  assert.deepEqual(before.submission, submissionBefore);
  assert.equal(before.job.lease_token, lease.lease_token);
  assert.equal(before.job.status, "claimed");
  assert.equal(before.media.state, "reserved");
  if (mode === "last") await db.query(migrations["0037"]);
  assert.deepEqual(await snapshot(db, ids), before, "0037 must preserve business records and active lease");
  assert.deepEqual(await businessRows(db), beforeBusiness, "0037 must preserve the complete synthetic business tables");
  if (mode !== "last") assert.equal(await claim(db, oldKey), false, "later migrations must preserve consumed nonce");
  const freshKey = "b".repeat(64);
  assert.equal(await claim(db, freshKey), true);
  assert.equal(await claim(db, freshKey), false);
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(as(db, role, actor, () => db.query("select public.consume_wallet_sign_in_nonce($1,$2::bigint)", ["c".repeat(64), Date.now()])), (error) => error.code === "42501");
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    await assert.rejects(as(db, role, actor, () => db.query("select * from public.wallet_sign_in_nonce_claims")), (error) => error.code === "42501");
    await assert.rejects(as(db, role, actor, () => db.query("select * from public.feedback_media_uploads")), (error) => error.code === "42501");
  }
  const stillOwned = (await as(db, "authenticated", actor, () => db.query("select public.feedback_media_owned($1) r", [ids.media]))).rows[0].r;
  assert.equal(stillOwned.id, ids.media);
  const storageInsert = (role, user) => as(db, role, user, () => db.query("insert into storage.objects(id,bucket_id,name,metadata) values($1,$2,$3,$4::jsonb)", [randomUUID(), reserved.bucket, reserved.staging_path, JSON.stringify({ size: 42 })]));
  await assert.rejects(storageInsert("authenticated", moderator), (error) => error.code === "42501");
  await storageInsert("authenticated", actor);
  assert.equal((await as(db, "authenticated", moderator, () => db.query("select count(*)::int n from storage.objects where name=$1", [reserved.staging_path]))).rows[0].n, 0);
  const validation = (await as(db, "service_role", null, () => db.query("select public.feedback_media_begin_validation($1,$2) r", [ids.media, actor]))).rows[0].r;
  await db.query("insert into storage.objects(id,bucket_id,name,metadata) values($1,$2,$3,$4::jsonb)", [randomUUID(), reserved.bucket, `verified/${actor}/${ids.media}`, JSON.stringify({ size: 42 })]);
  await as(db, "service_role", null, () => db.query("select public.feedback_media_record_verified($1,$2,$3,$4,null)", [ids.media, actor, validation.token, "a".repeat(64)]));
  await write("create", { id: ids.draft, title: "Media feedback", description: "A synthetic attachment", module: "forum", kind: "bug", details: { steps: "Attach image" }, media_ids: [ids.media] });
  await assert.rejects(as(db, "authenticated", actor, () => db.query("select public.feedback_media_moderate($1,1,'approve','')", [ids.media])), /feedback_forbidden/);
  const approved = (await as(db, "authenticated", moderator, () => db.query("select public.feedback_media_moderate($1,1,'approve','') r", [ids.media]))).rows[0].r;
  assert.equal(approved.revision, 2);
  assert.equal((await as(db, "anon", null, () => db.query("select public.feedback_media_object($1) r", [ids.media]))).rows[0].r.id, ids.media);
  const next = randomUUID();
  await write("create", { id: next, title: "Another forum issue", description: "A second synthetic issue", module: "forum", kind: "bug", details: { steps: "Retry" } });
  assert.equal((await db.query("select count(*)::int n from public.forum_feedback_jobs where feedback_id=$1", [next])).rows[0].n, 1);
  const revision = (await db.query("select moderation_revision from public.submissions where id=$1", [ids.submission])).rows[0].moderation_revision;
  await as(db, "service_role", null, () => db.query("select public.admin_moderate_submission($1,$2,$3,'published')", [moderator, ids.submission, revision]));
  assert.equal((await db.query("select status from public.submissions where id=$1", [ids.submission])).rows[0].status, "published");
  await as(db, "service_role", null, () => db.query("select public.admin_set_user_tag($1,$2,'blacklisted',true)", [moderator, restricted]));
  await assert.rejects(as(db, "service_role", null, () => db.query("select * from public.perform_checkin($1)", [restricted])), /activity_restricted/);
  assert.equal((await db.query("select count(*)::int n from public.checkins where user_id=$1", [restricted])).rows[0].n, 0);
  const contract = await schemaContract(db);
  console.log(`PASS ${mode}: history, lease, media, moderation, activity and nonce permissions`);
  return contract;
}
try {
  let admin;
  for (let i = 0; i < 100; i++) {
    try { admin = await connect(); break; } catch (error) {
      if (error.code === "WALLET_QA_WRONG_INSTANCE") throw error;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`PostgreSQL failed: ${serverError}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert(admin, `PostgreSQL did not start: ${serverError}`);
  const version = (await admin.query("select version() v")).rows[0].v;
  assert.match(version, /PostgreSQL 16\.9/);
  await admin.query("create role anon noinherit;create role authenticated noinherit;create role service_role noinherit bypassrls;");
  const first = await runOrder(admin, "qa_nonce_first", "before_0031");
  const middle = await runOrder(admin, "qa_nonce_middle", "after_0031");
  const last = await runOrder(admin, "qa_nonce_last", "last");
  await runOrder(admin, "qa_nonce_invalid", "invalid");
  assert.deepEqual(first, middle, "final public schema contracts must match when 0037 follows 0031");
  assert.deepEqual(first, last, "final public schema contracts must match when 0037 follows 0036");
  console.log("PASS three migration orders have identical public object definitions, owners, grants, indexes and triggers");
  console.log(JSON.stringify({ result: "PASS", postgres: "16.9", orders: 3, negativeOrderScenarios: 4, migrationSha256: hashes }));
} finally {
  for (const client of clients) { try { await client.end(); } catch {} }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => { server.once("exit", resolve); setTimeout(resolve, 5000).unref(); });
  }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await fs.rm(temp, { recursive: true, force: true });
}
