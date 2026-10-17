// Ephemeral PostgreSQL only. Never connects to Supabase or reads .env.local.
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.FEEDBACK_QA_PGLITE ? pathToFileURL(process.env.FEEDBACK_QA_PGLITE).href : '@electric-sql/pglite');
export const db = new PGlite();
export const ids = { admin: '11111111-1111-4111-8111-111111111111', user: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333', member: '44444444-4444-4444-8444-444444444444', muted: '55555555-5555-4555-8555-555555555555', blocked: '66666666-6666-4666-8666-666666666666' };
await db.exec(`
create role anon noinherit; create role authenticated noinherit; create role service_role noinherit bypassrls;
create schema auth; create schema storage;
grant usage on schema auth, public, storage to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', created_at timestamptz default now());
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);
const dir = new URL('../../supabase/migrations/', import.meta.url);
export async function migrate(file) {
  // gen_random_uuid is built in; pgcrypto extension packaging is not needed here.
  const sql = (await readFile(new URL(file, dir), 'utf8')).replace('create extension if not exists "pgcrypto";', '');
  try { await db.exec(sql); } catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
}
for (const file of (await readdir(dir)).filter((f) => /^00\d\d_.*\.sql$/.test(f) && f < '0032').sort()) await migrate(file);
for (const [name, id] of Object.entries(ids)) {
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, `${name}@example.invalid`, JSON.stringify({ username: name })]);
  await db.query('update profiles set role=$2, muted_until=$3 where id=$1', [id, name === 'admin' ? 'admin' : name === 'member' ? 'member' : 'user', name === 'muted' ? '2099-01-01' : null]);
}
await db.query('insert into user_tags(user_id,tag_key) values($1,$2)', [ids.blocked, 'blacklisted']);
export async function as(name, fn) {
  await db.exec(`set role ${name ? 'authenticated' : 'anon'}`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [name ? ids[name] : '']);
  try { return await fn(); } finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
}
export async function rpc(name, args) {
  return (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as data`, args)).rows[0].data;
}
