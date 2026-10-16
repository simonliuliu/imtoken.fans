// Test-only dependency may be installed outside the repository; see the persistence task.
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.FEEDBACK_QA_PGLITE ? pathToFileURL(process.env.FEEDBACK_QA_PGLITE).href : '@electric-sql/pglite');
import assert from 'node:assert/strict';
export const db = new PGlite();
export const ids={admin:'11111111-1111-4111-8111-111111111111',user:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333',member:'44444444-4444-4444-8444-444444444444',muted:'55555555-5555-4555-8555-555555555555',blocked:'66666666-6666-4666-8666-666666666666',missing:'77777777-7777-4777-8777-777777777777'};
await db.exec(`create role anon noinherit; create role authenticated noinherit; create role service_role noinherit bypassrls; create schema auth; grant usage on schema auth,public to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create type public.user_role as enum ('user','member','admin');
create table public.profiles(id uuid primary key,username text,display_name text,avatar_url text,role public.user_role default 'user',muted_until timestamptz,permissions jsonb default '{}',submission_cooldown_until timestamptz,created_at timestamptz default now());
create table public.user_tags(id uuid primary key default gen_random_uuid(),user_id uuid references profiles(id),tag_key text not null,set_by uuid,unique(user_id,tag_key));
grant select on profiles,user_tags to anon,authenticated; grant all on profiles,user_tags to service_role;`);
for (const [name,id] of Object.entries(ids).filter(([k])=>k!=='missing')) await db.query('insert into profiles(id,username,display_name,role,muted_until) values($1,$2,$2,$3,$4)',[id,name,name==='admin'?'admin':name==='member'?'member':'user',name==='muted'?'2099-01-01':null]);
await db.query('insert into user_tags(user_id,tag_key) values($1,$2)',[ids.blocked,'blacklisted']);
export async function as(role,name,fn){await db.exec(`set role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[name?ids[name]:'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
export const results=[];
export async function ok(name,fn){try{await fn();results.push({name,result:'PASS'});}catch(e){results.push({name,result:'FAIL',message:e.message,code:e.code});}}
export async function denied(name,fn){await ok(name,async()=>{let threw=false;try{await fn();}catch{threw=true;}assert(threw,'operation unexpectedly succeeded');});}
console.log('QA base created: ephemeral PostgreSQL with simulated auth.uid and Supabase roles. No real Supabase access.');
