-- Additive; no historical notifications/content are removed. Roll back UI first;
-- keep follows/event ledger so cleared notifications never replay on restore.
begin;
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
commit;
