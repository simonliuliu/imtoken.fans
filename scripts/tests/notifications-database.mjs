// Isolated PostgreSQL contract test. Never connects to Supabase.
import {db,ids,as,ok,denied,results} from './feedback-security-base.mjs';
import fs from 'node:fs/promises'; import assert from 'node:assert/strict';
await db.exec(`create function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;
create type notification_type as enum('reply','mention','level_up');
create table submissions(id uuid primary key default gen_random_uuid(),submitted_by uuid references profiles(id),status text default 'pending',deleted_at timestamptz,deleted_prev_status text,type text default 'idea',title text default 'public title');
create table comments(id uuid primary key default gen_random_uuid(),submission_id uuid references submissions(id),user_id uuid references profiles(id),parent_id uuid references comments(id),body text default 'comment body',status text default 'pending',deleted_at timestamptz,deleted_prev_status text,pinned_at timestamptz);
create table notifications(id uuid primary key default gen_random_uuid(),user_id uuid references profiles(id),actor_id uuid references profiles(id),type notification_type,submission_id uuid references submissions(id),comment_id uuid references comments(id),read_at timestamptz,created_at timestamptz default now(),detail jsonb);
grant all on notifications,comments to authenticated; grant select on submissions to authenticated;
alter table comments enable row level security; create policy old_insert on comments for insert with check(user_id=auth.uid());create policy public_read on comments for select using(status='published' or user_id=auth.uid());`);
// A pre-migration legacy row must survive the insert guard unchanged.
const legacyPost=(await db.query("insert into submissions(submitted_by,status) values($1,'published') returning id",[ids.other])).rows[0].id;
const legacyComment=(await db.query("insert into comments(submission_id,user_id,status) values($1,$2,'published') returning id",[legacyPost,ids.admin])).rows[0].id;
await db.query("insert into notifications(user_id,actor_id,type,submission_id,comment_id) values($1,$2,'reply',$3,$4)",[ids.member,ids.admin,legacyPost,legacyComment]);
await db.exec('grant insert on notifications to service_role');
for(const name of ['0025_product_feedback.sql','0026_following_notifications.sql'])await db.exec(await fs.readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
const rpc=(sql,args=[])=>db.query(sql,args).then(r=>r.rows[0]?.result);
const read=(who)=>as('authenticated',who,()=>rpc('select notification_read($1) result',[ids[who]]));
await ok('follow own subscription',()=>as('authenticated','user',()=>rpc('select follow_write($1,$2,true)',[ids.user,ids.other])));
await denied('forged follower rejected',()=>as('authenticated','other',()=>rpc('select follow_write($1,$2,true)',[ids.user,ids.admin])));
await denied('self follow rejected',()=>as('authenticated','user',()=>rpc('select follow_write($1,$1,true)',[ids.user])));
const post=(await db.query('insert into submissions(submitted_by) values($1) returning id',[ids.other])).rows[0].id;
assert.equal((await read('user')).total,0);
await ok('approval sends post notification',async()=>{await db.query("update submissions set status='published' where id=$1",[post]);assert.equal((await read('user')).total,1);});
await denied('cannot insert published comment via REST',()=>as('authenticated','user',()=>db.query("insert into comments(submission_id,user_id,status) values($1,$2,'published')",[post,ids.user])));
await ok('pending comment does not notify; approval notifies author and follower deduplicated',async()=>{const c=(await db.query("insert into comments(submission_id,user_id,body) values($1,$2,'hello @user') returning id",[post,ids.admin])).rows[0].id;assert.equal((await read('user')).total,1);await db.query("update comments set status='published' where id=$1",[c]);assert.equal((await read('user')).total,2);assert.equal((await read('other')).total,1);});
await ok('hidden target removed from list and counts',async()=>{await db.query('update submissions set deleted_at=now() where id=$1',[post]);assert.equal((await read('user')).total,0);assert.equal((await read('user')).unread,0);});
await ok('clear and restore does not replay events',async()=>{await as('authenticated','user',()=>rpc("select notification_write($1,'clear')",[ids.user]));await db.query('update submissions set deleted_at=null where id=$1',[post]);assert.equal((await read('user')).total,0);});
await denied('raw notification read denied',()=>as('authenticated','user',()=>db.query('select * from notifications')));
await denied('account mismatch rejects mutation',()=>as('authenticated','other',()=>rpc("select notification_write($1,'clear')",[ids.user])));
const fp=(await db.query("insert into feedback_posts(author_id,title,description,module) values($1,'feedback title','feedback description','wallet') returning id",[ids.other])).rows[0].id;
await ok('feedback comments notify post owner and mention',async()=>{await db.query("insert into feedback_comments(post_id,author_id,body) values($1,$2,'hello @user')",[fp,ids.admin]);const result=await read('other');assert(result.items.some(n=>n.href?.includes('idea='+fp)&&n.href.includes('#comment-')));});
await ok('system types repaired and unread count exceeds page size',async()=>{for(let i=0;i<25;i++)await db.query("insert into notifications(user_id,type,detail) values($1,'badge','{}')",[ids.user]);const r=await read('user');assert.equal(r.items.length,20);assert(r.unread>=25);const page=await as('authenticated','user',()=>rpc('select notification_read($1,20) result',[ids.user]));assert(page.items.length>0);});
await ok('follow settings fenced to expected account',async()=>{await denied('follow_read account mismatch',()=>as('authenticated','other',()=>rpc('select follow_read($1,$2) result',[ids.admin,ids.user])));const r=await as('authenticated','user',()=>rpc('select follow_read($1,$2) result',[ids.other,ids.user]));assert(r.subscription.posts);});
await ok('emails and overlong identifiers do not emit substring mentions',async()=>{const before=(await read('blocked')).total;await db.query("insert into feedback_comments(post_id,author_id,body) values($1,$2,'mail@blocked and @blockedabcdefghijklmnopqrstuv')",[fp,ids.admin]);assert.equal((await read('blocked')).total,before);await db.query("insert into feedback_comments(post_id,author_id,body) values($1,$2,'hello @blocked!')",[fp,ids.admin]);assert.equal((await read('blocked')).total,before+1);});
await ok('DB-first legacy after callback cannot duplicate published comment events',async()=>{
 const c=(await db.query("insert into comments(submission_id,user_id,status,body) values($1,$2,'published','published reply @user') returning id",[post,ids.admin])).rows[0].id;
 const before=(await db.query('select count(*)::int count from notifications where comment_id=$1',[c])).rows[0].count;assert(before>0);
 for(const type of ['reply','mention'])await as('service_role',null,()=>db.query('insert into notifications(user_id,actor_id,type,submission_id,comment_id) values($1,$2,$3,$4,$5)',[ids.user,ids.admin,type,post,c]));
 assert.equal((await db.query('select count(*)::int count from notifications where comment_id=$1',[c])).rows[0].count,before);
});
await ok('DB-first legacy after callback cannot notify pending comments',async()=>{
 const c=(await db.query('insert into comments(submission_id,user_id) values($1,$2) returning id',[post,ids.admin])).rows[0].id;
 await as('service_role',null,()=>db.query("insert into notifications(user_id,actor_id,type,submission_id,comment_id) values($1,$2,'mention',$3,$4)",[ids.user,ids.admin,post,c]));
 assert.equal((await db.query('select count(*)::int count from notifications where comment_id=$1',[c])).rows[0].count,0);
});
await ok('legacy feedback bypass suppressed; historical rows and service rewards preserved',async()=>{
 const c=(await db.query("insert into feedback_comments(post_id,author_id,body) values($1,$2,'feedback reply') returning id",[fp,ids.admin])).rows[0].id;
 const before=(await db.query('select count(*)::int count from notifications where feedback_comment_id=$1',[c])).rows[0].count;
 await as('service_role',null,()=>db.query("insert into notifications(user_id,actor_id,type,feedback_post_id,feedback_comment_id) values($1,$2,'reply',$3,$4)",[ids.other,ids.admin,fp,c]));
 assert.equal((await db.query('select count(*)::int count from notifications where feedback_comment_id=$1',[c])).rows[0].count,before);
 assert.equal((await db.query('select count(*)::int count from notifications where comment_id=$1 and event_key is null',[legacyComment])).rows[0].count,1);
 for(const type of ['level_up','lottery_ticket','badge','xp_adjust'])await as('service_role',null,()=>db.query('insert into notifications(user_id,type,detail) values($1,$2,$3)',[ids.member,type,'{}']));
 assert.equal((await read('member')).total,5);
});
await denied('authenticated cannot execute legacy guard helper',()=>as('authenticated','user',()=>db.query('select notification_legacy_insert_guard()')));
console.log(JSON.stringify(results,null,2)); await db.close(); if(results.some(r=>r.result!=='PASS'))process.exit(1);
