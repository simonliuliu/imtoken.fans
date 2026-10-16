// Ephemeral PostgreSQL only; never uses Supabase credentials or network.
// Set PGLITE_MODULE to an installed @electric-sql/pglite module when needed.
import { fileURLToPath } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
export const db=new PGlite();
export const root=fileURLToPath(new URL('../..',import.meta.url));
await db.exec(`create role anon noinherit;create role authenticated noinherit;create role service_role noinherit bypassrls;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key,bucket_id text,name text);
create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
`);
for(const name of (await fs.readdir(root+'/supabase/migrations')).filter(n=>n.endsWith('.sql')&&n<'0029').sort()){
try{await db.exec((await fs.readFile(root+'/supabase/migrations/'+name,'utf8')).replace('create extension if not exists "pgcrypto";',''));}catch(e){console.log('MIGRATION_FAIL',name,e.message);throw e;}
}
export const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',admin:'33333333-3333-4333-8333-333333333333',blocked:'44444444-4444-4444-8444-444444444444',muted:'55555555-5555-4555-8555-555555555555',member:'66666666-6666-4666-8666-666666666666'};
for(const [n,id] of Object.entries(ids))await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id,n+'@example.invalid',JSON.stringify({username:'qa_'+n})]);
await db.query("update profiles set role='admin' where id=$1",[ids.admin]);
await db.query("update profiles set role='member' where id=$1",[ids.member]);
await db.query("update profiles set muted_until=now()+interval '1 day' where id=$1",[ids.muted]);
await db.query("insert into user_tags(user_id,tag_key) values($1,'blacklisted')",[ids.blocked]);
export async function as(role,actor,fn){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[actor]??actor??'']);try{return await fn()}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
export async function denied(fn){await assert.rejects(fn);}
export const out=[];
export async function check(name,fn){try{await fn();out.push({name,result:'PASS'})}catch(e){out.push({name,result:'FAIL',error:e.message})}}
export async function post(actor='a',status='published',type='product'){return (await db.query('insert into submissions(submitted_by,status,type,title,tagline,description) values($1,$2,$3,\'QA title\',\'QA tagline\',\'QA description\') returning id',[ids[actor],status,type])).rows[0].id;}
export async function comment(pid,actor='b',status='published',parent=null){return (await db.query('insert into comments(submission_id,user_id,status,body,parent_id) values($1,$2,$3,\'QA comment\',$4) returning id',[pid,ids[actor],status,parent])).rows[0].id;}
console.log('HARNESS_READY exact migrations 0001-0028; mock auth/storage platform schemas, pgcrypto extension omitted (native UUID available); ephemeral PostgreSQL');
