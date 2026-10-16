-- Reviewed PR18-22 deployment. No historical row updates/deletes.
-- One transaction; any assertion/DDL error rolls back all three migrations.
begin;
set local lock_timeout='10s';
set local statement_timeout='90s';
lock table public.submissions,public.comments,public.notifications,public.feedback_posts,public.feedback_comments in share row exclusive mode;
create temporary table pr22_original on commit drop as
 select 'notifications' kind,id::text key,to_jsonb(t) payload from public.notifications t
 union all select 'submissions',id::text,to_jsonb(t) from public.submissions t
 union all select 'comments',id::text,to_jsonb(t) from public.comments t
 union all select 'profiles',id::text,to_jsonb(t) from public.profiles t
 union all select 'feedback_posts',id::text,to_jsonb(t) from public.feedback_posts t
 union all select 'feedback_comments',id::text,to_jsonb(t) from public.feedback_comments t;
-- 0026_feedback_forum_names.sql
-- Author display only: preserve custom forum names and avoid wallet/email placeholders.
-- No stored data updates, new profile queries, or permission/visibility changes.
-- Rollback: restore the feedback_card/read definitions from 0025; submitted data is untouched.

create function public.feedback_forum_name(p_display_name text,p_username text) returns text
language sql immutable set search_path=public,pg_temp as $$
  with names as (
    select regexp_replace(coalesce(p_display_name,''),'^[[:space:]]+|[[:space:]]+$','','g') as display_name,
           regexp_replace(coalesce(p_username,''),'^[[:space:]]+|[[:space:]]+$','','g') as username
  )
  select case
    when display_name<>''
      and display_name !~ '[^[:space:]@]+@[^[:space:]@]+'
      and display_name !~* '^0x[0-9a-f]{6,}$'
      and display_name !~* '^0x[0-9a-f]+([.]{2,3}|…)[0-9a-f]+$'
    then display_name
    when username ~ '^[a-z0-9_]{3,20}$' and username !~* '^0x[0-9a-f]{6,}$' then username
    else null
  end from names;
$$;
revoke all on function public.feedback_forum_name(text,text) from public,anon,authenticated;

-- CREATE OR REPLACE retains existing ACLs; all filters/security settings stay unchanged.
create or replace function public.feedback_card(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',p.id,'title',p.title,'description',p.description,'module',p.module,'status',p.status,'mark',p.mark,'visibility',p.visibility,'version',p.version,'created_at',p.created_at,'updated_at',p.updated_at,
    'author_name',public.feedback_forum_name(a.display_name,a.username),
    'support_count',(select count(distinct v.user_id) from public.feedback_post_votes v join public.feedback_posts origin on origin.id=v.post_id where public.feedback_root(v.post_id)=p.id and origin.visibility='published'),
    'supported',exists(select 1 from public.feedback_post_votes v join public.feedback_posts origin on origin.id=v.post_id where public.feedback_root(v.post_id)=p.id and v.user_id=auth.uid() and origin.visibility='published'),
    'comment_count',(select count(*) from public.feedback_comments c join public.feedback_posts origin on origin.id=c.post_id where public.feedback_root(c.post_id)=p.id and c.visibility='published' and origin.visibility='published'),
    'merge_id',(select m.id from public.feedback_merges m where m.target_id=p.id and m.undone_at is null))
  from public.feedback_posts p left join public.profiles a on a.id=p.author_id where p.id=p_id;
$$;

create or replace function public.feedback_read(p_id uuid default null,p_query text default '',p_module text default 'all',p_status text default 'all',p_sort text default 'latest',p_offset integer default 0,p_comment_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_admin boolean:=coalesce((select role='admin' from public.profiles where id=auth.uid()),false); v_root uuid; v_posts jsonb; v_total integer; v_comments jsonb:='[]'; v_sources jsonb:='[]'; v_history jsonb:='[]'; v_comment_total integer:=0;
begin
  if p_offset<0 or p_offset>100000 or p_comment_offset<0 or p_comment_offset>100000 or char_length(p_query)>120 or p_sort not in ('latest','oldest','popular') then raise exception 'feedback_invalid'; end if;
  select count(*) into v_total from public.feedback_posts p where (p.visibility='published' or v_admin) and public.feedback_root(p.id)=p.id and (p_module='all' or p.module=p_module) and (p_status='all' or p.status=p_status) and (p_query='' or position(lower(p_query) in lower(p.title||' '||p.description))>0);
  select coalesce(jsonb_agg(card order by ordering),'[]'::jsonb) into v_posts from (
    select public.feedback_card(p.id) card,row_number() over(order by case when p_sort='popular' then (public.feedback_card(p.id)->>'support_count')::bigint end desc nulls last,case when p_sort='oldest' then p.created_at end asc nulls last,p.created_at desc,p.id) ordering
    from public.feedback_posts p where (p.visibility='published' or v_admin) and public.feedback_root(p.id)=p.id and (p_module='all' or p.module=p_module) and (p_status='all' or p.status=p_status) and (p_query='' or position(lower(p_query) in lower(p.title||' '||p.description))>0)
    order by ordering limit 20 offset p_offset
  ) listed;
  if p_id is not null then
    v_root:=public.feedback_root(p_id);
    if not exists(select 1 from public.feedback_posts p where p.id=v_root and (p.visibility='published' or v_admin)) or not exists(select 1 from public.feedback_posts p where p.id=p_id and (p.visibility='published' or v_admin)) then raise exception 'feedback_not_found'; end if;
    select coalesce(jsonb_agg(public.feedback_card(p.id) order by p.created_at,p.id),'[]') into v_sources from public.feedback_posts p where public.feedback_root(p.id)=v_root and p.id<>v_root and (p.visibility='published' or v_admin);
    select count(*) into v_comment_total from public.feedback_comments c join public.feedback_posts p on p.id=c.post_id where public.feedback_root(c.post_id)=v_root and ((c.visibility='published' and p.visibility='published') or v_admin);
    select coalesce(jsonb_agg(item order by created_at,id),'[]') into v_comments from (
      select c.id,c.created_at,jsonb_build_object('id',c.id,'post_id',c.post_id,'source_title',p.title,'parent_id',c.parent_id,'parent_author_name',case when parent.visibility='published' or v_admin then public.feedback_forum_name(pa.display_name,pa.username) else null end,
        'author_name',public.feedback_forum_name(a.display_name,a.username),'body',c.body,'mark',c.mark,'visibility',c.visibility,'version',c.version,'created_at',c.created_at,
        'support_count',(select count(*) from public.feedback_comment_votes v where v.comment_id=c.id),'supported',exists(select 1 from public.feedback_comment_votes v where v.comment_id=c.id and v.user_id=auth.uid())) item
      from public.feedback_comments c join public.feedback_posts p on p.id=c.post_id left join public.profiles a on a.id=c.author_id left join public.feedback_comments parent on parent.id=c.parent_id left join public.profiles pa on pa.id=parent.author_id
      where public.feedback_root(c.post_id)=v_root and ((c.visibility='published' and p.visibility='published') or v_admin) order by c.created_at,c.id limit 50 offset p_comment_offset
    ) discussion;
    if v_admin then
      select coalesce(jsonb_agg(jsonb_build_object('id',id,'action',action,'comment_id',comment_id,'before_data',before_data,'after_data',after_data,'created_at',created_at) order by created_at desc,id desc),'[]') into v_history from (
        select * from public.feedback_audit where public.feedback_root(post_id)=v_root order by created_at desc,id desc limit 50
      ) history;
    end if;
  end if;
  return jsonb_build_object('posts',v_posts,'total',v_total,'viewer',jsonb_build_object('user_id',auth.uid(),'signed_in',auth.uid() is not null,'can_manage',v_admin),'selected',case when v_root is null then null else public.feedback_card(v_root) end,'sources',v_sources,'comments',v_comments,'comment_total',v_comment_total,'history',v_history);
end;
$$;

notify pgrst, 'reload schema';

-- 0027_product_submissions_only.sql
-- Stop new legacy idea submissions without changing historical rows or links.
-- RESTRICTIVE composes with existing author, pending-status and blacklist policies.
create policy "submission insert must be product"
  on public.submissions as restrictive for insert to authenticated
  with check (type = 'product');

-- Rollback: drop policy "submission insert must be product" on public.submissions;
notify pgrst, 'reload schema';

-- 0028_following_notifications.sql
-- Additive; no historical notifications/content are removed. Roll back UI first;
-- keep follows/event ledger so cleared notifications never replay on restore.

-- Repair deployed databases that skipped 0018; these values are not used until
-- after COMMIT, avoiding PostgreSQL unsafe-new-enum-value transaction errors.
alter type public.notification_type add value if not exists 'lottery_ticket';
alter type public.notification_type add value if not exists 'badge';
alter type public.notification_type add value if not exists 'xp_adjust';
create table public.user_follows (
 follower_id uuid not null references public.profiles(id) on delete cascade,
 followed_id uuid not null references public.profiles(id) on delete cascade,
 notify_posts boolean not null default true, notify_comments boolean not null default true,
 created_at timestamptz not null default now(), primary key(follower_id,followed_id), check(follower_id<>followed_id)
);
create index user_follows_target on public.user_follows(followed_id);
alter table public.user_follows enable row level security;
-- Private subscription settings are RPC-only, including counts/list projections.
revoke all on public.user_follows from anon,authenticated;
create table public.notification_events (event_key text primary key, created_at timestamptz not null default now());
revoke all on public.notification_events from anon,authenticated;
alter table public.notification_events enable row level security;
alter table public.notifications add column event_key text, add column feedback_post_id uuid references public.feedback_posts(id) on delete cascade, add column feedback_comment_id uuid references public.feedback_comments(id) on delete cascade;
create unique index notifications_recipient_event on public.notifications(user_id,event_key) where event_key is not null;
create index notifications_unread on public.notifications(user_id) where read_at is null;

-- DB-first deployment compatibility: the previous app's after() callback still
-- attempts service-role comment reply/mention inserts without an event receipt.
-- Suppress only those new bypass writes; existing rows and system rewards stay.
create function public.notification_legacy_insert_guard() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if new.event_key is null and new.type in ('reply','mention')
    and (new.comment_id is not null or new.feedback_comment_id is not null) then
  return null;
 end if;
 return new;
end; $$;
revoke all on function public.notification_legacy_insert_guard() from public,anon,authenticated;
create trigger notification_legacy_insert_guard before insert on public.notifications
 for each row execute function public.notification_legacy_insert_guard();

create function public.follow_read(p_target uuid,p_expected_user_id uuid default null) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is distinct from p_expected_user_id then raise exception 'notification_session'; end if;
 return (select jsonb_build_object('followers',(select count(*) from user_follows where followed_id=p_target),'following',(select count(*) from user_follows where follower_id=p_target),'subscription',(select jsonb_build_object('posts',notify_posts,'comments',notify_comments) from user_follows where follower_id=auth.uid() and followed_id=p_target),'people',coalesce((select jsonb_agg(jsonb_build_object('username',p.username,'name',coalesce(nullif(p.display_name,''),p.username))) from (select followed_id from user_follows where follower_id=p_target order by created_at desc limit 100) f join profiles p on p.id=f.followed_id),'[]'::jsonb)));
end;
$$;
create function public.follow_write(p_expected_user_id uuid,p_target uuid,p_follow boolean,p_posts boolean default true,p_comments boolean default true) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'notification_session'; end if;
 if p_target=auth.uid() or p_target is null or p_follow is null or p_posts is null or p_comments is null then raise exception 'notification_invalid'; end if;
 if p_follow then
 insert into user_follows(follower_id,followed_id,notify_posts,notify_comments) values(auth.uid(),p_target,p_posts,p_comments) on conflict(follower_id,followed_id) do update set notify_posts=excluded.notify_posts,notify_comments=excluded.notify_comments;
 else delete from user_follows where follower_id=auth.uid() and followed_id=p_target; end if;
end; $$;

-- Direct REST inserts must enter moderation and cannot forge parent relationships.
create policy comments_insert_notification_guard on public.comments as restrictive for insert to authenticated with check (
 user_id=auth.uid() and status='pending' and deleted_at is null and pinned_at is null
 and exists(select 1 from public.submissions s where s.id=comments.submission_id and s.status='published' and s.deleted_at is null)
 and (parent_id is null or exists(select 1 from public.comments parent where parent.id=comments.parent_id and parent.submission_id=comments.submission_id and parent.status='published' and parent.deleted_at is null))
 and exists(select 1 from public.profiles p where p.id=auth.uid() and (p.muted_until is null or p.muted_until<=now()))
 and not exists(select 1 from public.user_tags where user_id=auth.uid() and tag_key='blacklisted')
);

create function public.emit_content_notification() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_key text; v_actor uuid; v_author uuid; v_parent uuid; v_body text; v_submission uuid; v_comment uuid; v_feedback uuid; v_fc uuid; v_kind text; v_inserted integer;
begin
 if tg_table_name='submissions' then
  if new.status<>'published' or new.deleted_at is not null then return new; end if;
  v_actor:=new.submitted_by; v_submission:=new.id; v_kind:='follow_post';
 elsif tg_table_name='comments' then
  if new.status<>'published' or new.deleted_at is not null or not exists(select 1 from submissions where id=new.submission_id and status='published' and deleted_at is null) then return new; end if;
  v_actor:=new.user_id; v_submission:=new.submission_id; v_comment:=new.id; v_body:=new.body; v_kind:='follow_comment';
  if new.parent_id is null then select submitted_by into v_author from submissions where id=new.submission_id;
  else select user_id into v_parent from comments where id=new.parent_id and submission_id=new.submission_id and status='published' and deleted_at is null; end if;
 elsif tg_table_name='feedback_posts' then
  if new.visibility<>'published' then return new; end if;
  v_actor:=new.author_id; v_feedback:=new.id; v_kind:='follow_post';
 else
  if new.visibility<>'published' or not exists(select 1 from feedback_posts where id=new.post_id and visibility='published') then return new; end if;
  v_actor:=new.author_id; v_feedback:=new.post_id; v_fc:=new.id; v_body:=new.body; v_kind:='follow_comment';
  if new.parent_id is null then select author_id into v_author from feedback_posts where id=new.post_id;
  else select author_id into v_parent from feedback_comments where id=new.parent_id and visibility='published' and feedback_root(post_id)=feedback_root(new.post_id); end if;
 end if;
 if tg_table_name='comments' then select submitted_by into v_author from submissions where id=v_submission;
 elsif tg_table_name='feedback_comments' then select author_id into v_author from feedback_posts where id=v_feedback; end if;
 v_key:=tg_table_name||':'||new.id;
 insert into notification_events(event_key) values(v_key) on conflict do nothing;
 get diagnostics v_inserted=row_count;
 if tg_table_name='submissions' then update comments set status=status where submission_id=new.id and status='published' and deleted_at is null;
 elsif tg_table_name='feedback_posts' then update feedback_comments set visibility=visibility where post_id=new.id and visibility='published'; end if;
 if v_inserted=0 then return new; end if;
 -- One recipient per event. Direct replies take priority over mentions and follows.
 insert into notifications(user_id,actor_id,type,submission_id,comment_id,feedback_post_id,feedback_comment_id,event_key,detail)
 select recipient,v_actor,case when priority=2 then 'mention'::notification_type else 'reply'::notification_type end,v_submission,v_comment,v_feedback,v_fc,v_key,jsonb_build_object('kind',case when priority=1 then 'reply' when priority=2 then 'mention' else v_kind end)
 from (select recipient,min(priority) priority from (
  select v_author recipient,1 priority
  union all select v_parent,1
  union all select p.id,2 from profiles p where v_body is not null and lower(p.username) in (select lower(m[2]) from regexp_matches(v_body,'(^|[^a-zA-Z0-9_@.])@([a-zA-Z0-9_]{3,20})(?![a-zA-Z0-9_])','g') m)
  union all select follower_id,3 from user_follows where followed_id=v_actor and (case when v_kind='follow_post' then notify_posts else notify_comments end)
 ) candidates where recipient is not null and recipient is distinct from v_actor group by recipient) recipients
 on conflict(user_id,event_key) where event_key is not null do nothing;
 return new;
end; $$;
-- Baseline existing public events: this migration never sends historical activity.
insert into notification_events(event_key) select 'submissions:'||id from submissions where status='published' or deleted_prev_status='published' union all select 'comments:'||id from comments where status='published' or deleted_prev_status='published' union all select 'feedback_posts:'||id from feedback_posts union all select 'feedback_comments:'||id from feedback_comments;
create trigger submission_notification after insert or update on public.submissions for each row execute function public.emit_content_notification();
create trigger comment_notification after insert or update on public.comments for each row execute function public.emit_content_notification();
create trigger feedback_post_notification after insert or update on public.feedback_posts for each row execute function public.emit_content_notification();
create trigger feedback_comment_notification after insert or update on public.feedback_comments for each row execute function public.emit_content_notification();

-- Always project public visibility even for admins/authors. No cached title/body in detail.
create function public.notification_read(p_expected_user_id uuid,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_items jsonb;
begin
 if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'notification_session'; end if;
 if p_offset<0 or p_offset>100000 then raise exception 'notification_invalid'; end if;
 select coalesce(jsonb_agg(item order by created_at desc,id desc),'[]'::jsonb) into v_items from (
 select n.id,n.created_at,jsonb_build_object('id',n.id,'type',n.type,'read_at',n.read_at,'created_at',n.created_at,'detail',case when n.event_key is null then n.detail else jsonb_build_object('kind',n.detail->>'kind') end,
 'actor_username',a.username,'actor_avatar_url',a.avatar_url,
 'submission_id',s.id,'submission_type',s.type,'submission_title',coalesce(s.title,fp.title),
 'comment_id',coalesce(c.id,fc.id),'comment_preview',left(coalesce(c.body,fc.body),60),
 'href',case when fp.id is not null then '/community/feedback?category=wallet&idea='||fp.id||case when fc.id is not null then '&commentOffset='||((select count(*) from feedback_comments prev join feedback_posts origin on origin.id=prev.post_id where feedback_root(prev.post_id)=feedback_root(fp.id) and prev.visibility='published' and origin.visibility='published' and (prev.created_at,prev.id)<(fc.created_at,fc.id))/50*50)::text||'#comment-'||fc.id else '' end when s.id is not null then case when s.type='product' then '/products/' else '/ideas/' end||s.id||case when c.id is not null then '#comment-'||c.id else '' end else null end) item
 from notifications n left join profiles a on a.id=n.actor_id
 left join submissions s on s.id=n.submission_id and s.status='published' and s.deleted_at is null
 left join comments c on c.id=n.comment_id and s.id is not null and c.status='published' and c.deleted_at is null
 left join feedback_posts fp on fp.id=n.feedback_post_id and fp.visibility='published' and exists(select 1 from feedback_posts root where root.id=feedback_root(fp.id) and root.visibility='published')
 left join feedback_comments fc on fc.id=n.feedback_comment_id and fp.id is not null and fc.visibility='published'
 where n.user_id=auth.uid() and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null)) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published'))) order by n.created_at desc,n.id desc limit 20 offset p_offset
 ) rows;
 return jsonb_build_object('items',v_items,'unread',(select count(*) from notifications n where user_id=auth.uid() and read_at is null and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null)) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published')))),'total',(select count(*) from notifications n where user_id=auth.uid() and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null)) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published')))));
end; $$;
create function public.notification_write(p_expected_user_id uuid,p_action text,p_id uuid default null) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'notification_session'; end if;
 if p_action='clear' then delete from notifications where user_id=auth.uid();
 elsif p_action='all' then update notifications set read_at=coalesce(read_at,now()) where user_id=auth.uid() and read_at is null;
 elsif p_action='read' then
  if not exists(select 1 from notifications where id=p_id and user_id=auth.uid()) then raise exception 'notification_invalid'; end if;
  update notifications set read_at=coalesce(read_at,now()) where id=p_id and user_id=auth.uid();
 else raise exception 'notification_invalid'; end if;
end; $$;
revoke all on function public.emit_content_notification() from public,anon,authenticated;
revoke all on function public.follow_read(uuid,uuid),public.follow_write(uuid,uuid,boolean,boolean,boolean),public.notification_read(uuid,integer),public.notification_write(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.follow_read(uuid,uuid) to anon,authenticated;
grant execute on function public.follow_write(uuid,uuid,boolean,boolean,boolean),public.notification_read(uuid,integer),public.notification_write(uuid,text,uuid) to authenticated;
-- Read/mutation clients use the safe RPC exclusively; prevent direct relation joins from
-- leaking owner-visible pending targets or forged read fields.
revoke select,update,delete on public.notifications from anon,authenticated;

do $$ begin
 if exists(select 1 from pr22_original b left join public.notifications t on t.id::text=b.key where b.kind='notifications' and (t.id is null or (to_jsonb(t)-array['event_key','feedback_post_id','feedback_comment_id']) is distinct from b.payload)) then raise exception 'Historical notifications changed'; end if;
 if exists(select 1 from pr22_original b left join public.submissions t on t.id::text=b.key where b.kind='submissions' and to_jsonb(t) is distinct from b.payload) then raise exception 'Historical submissions changed'; end if;
 if exists(select 1 from pr22_original b left join public.comments t on t.id::text=b.key where b.kind='comments' and to_jsonb(t) is distinct from b.payload) then raise exception 'Historical comments changed'; end if;
 if exists(select 1 from pr22_original b left join public.profiles t on t.id::text=b.key where b.kind='profiles' and to_jsonb(t) is distinct from b.payload) then raise exception 'Historical profiles changed'; end if;
 if exists(select 1 from pr22_original b left join public.feedback_posts t on t.id::text=b.key where b.kind='feedback_posts' and to_jsonb(t) is distinct from b.payload) then raise exception 'Historical feedback changed'; end if;
 if exists(select 1 from pr22_original b left join public.feedback_comments t on t.id::text=b.key where b.kind='feedback_comments' and to_jsonb(t) is distinct from b.payload) then raise exception 'Historical feedback comments changed'; end if;
 if has_table_privilege('authenticated','public.notifications','SELECT') or has_table_privilege('authenticated','public.notifications','UPDATE') or has_table_privilege('authenticated','public.notifications','DELETE') then raise exception 'Raw notification permissions remain'; end if;
 if not has_function_privilege('authenticated','public.notification_read(uuid,integer)','EXECUTE') or has_function_privilege('anon','public.notification_read(uuid,integer)','EXECUTE') then raise exception 'RPC permissions mismatch'; end if;
end $$;
notify pgrst,'reload schema';
select kind,count(*) as preserved_rows from pr22_original group by kind order by kind;
commit;
