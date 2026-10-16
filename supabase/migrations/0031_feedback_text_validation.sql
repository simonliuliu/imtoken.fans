-- Review R3: match JavaScript String.trim whitespace for feedback RPC validation.
-- No historic rows are rewritten. Existing invalid content stays intact; NOT VALID
-- checks protect subsequent inserts/updates without failing on historical rows.
-- Roll back by restoring feedback_write from 0025, dropping the new constraints,
-- then dropping feedback_text_trim. Preserve all feedback tables and user data.
begin;

create function public.feedback_text_trim(value text) returns text
language sql immutable strict parallel safe set search_path=public,pg_temp as $$
  select btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
revoke all on function public.feedback_text_trim(text) from public,anon,authenticated;
grant execute on function public.feedback_text_trim(text) to service_role;

-- Retain authority checks, advisory locks, idempotency and ACLs of the original
-- RPC. Only text normalization/length validation changes (posts and comments).
create or replace function public.feedback_write(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_admin boolean; v_id uuid; v_root uuid; v_parent public.feedback_comments; v_post public.feedback_posts; v_other public.feedback_posts; v_comment public.feedback_comments; v_merge public.feedback_merges; v_before jsonb; v_target uuid; v_source uuid; v_result uuid;
begin
  if p_action is null or p_payload is null or p_action not in ('create','comment','vote','comment_vote','edit','edit_comment','merge','preview_merge','unmerge') or jsonb_typeof(p_payload)<>'object' then raise exception 'feedback_invalid'; end if;
  v_admin:=p_action in ('edit','edit_comment','merge','preview_merge','unmerge');
  v_actor:=public.feedback_actor(v_admin);
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'feedback_invalid'; end if;
  if p_action='create' then
    if char_length(public.feedback_text_trim(coalesce(p_payload->>'title',''))) not between 2 and 120 or char_length(public.feedback_text_trim(coalesce(p_payload->>'description',''))) not between 2 and 5000 or coalesce(p_payload->>'module','') not in ('wallet','transfer','browser','other') then raise exception 'feedback_invalid'; end if;
    insert into public.feedback_posts(id,author_id,title,description,module) values(v_id,v_actor,public.feedback_text_trim(p_payload->>'title'),public.feedback_text_trim(p_payload->>'description'),p_payload->>'module') on conflict(id) do nothing;
    select * into v_post from public.feedback_posts where id=v_id;
    if v_post.author_id is distinct from v_actor or v_post.title<>public.feedback_text_trim(p_payload->>'title') or v_post.description<>public.feedback_text_trim(p_payload->>'description') or v_post.module<>p_payload->>'module' then raise exception 'feedback_conflict'; end if;
    return jsonb_build_object('id',v_id);
  end if;
  if p_action in ('comment_vote','edit_comment') then
    select * into v_comment from public.feedback_comments where id=v_id for update;
    if not found then raise exception 'feedback_not_found'; end if;
    v_root:=public.feedback_root(v_comment.post_id);
  elsif p_action='unmerge' then
    select * into v_merge from public.feedback_merges where id=v_id and undone_at is null for update;
    if not found then raise exception 'feedback_conflict'; end if;
    v_root:=v_merge.target_id;
  else v_root:=public.feedback_root(v_id);
  end if;
  select * into v_post from public.feedback_posts where id=v_root for update;
  if not found then raise exception 'feedback_not_found'; end if;
  if not v_admin and (v_post.visibility<>'published' or not exists(select 1 from public.feedback_posts p where p.id=case when p_action in ('comment_vote') then v_comment.post_id else v_id end and p.visibility='published')) then raise exception 'feedback_not_found'; end if;

  if p_action='vote' then
    if jsonb_typeof(p_payload->'supported') is distinct from 'boolean' then raise exception 'feedback_invalid'; end if;
    if (p_payload->>'supported')::boolean then
      -- Already supported through a source: true is a no-op, preserving provenance
      -- for later undo rather than duplicating the same intent on the main post.
      if not exists(select 1 from public.feedback_post_votes where user_id=v_actor and public.feedback_root(post_id)=v_root) then
        insert into public.feedback_post_votes(post_id,user_id) values(v_root,v_actor) on conflict do nothing;
      end if;
    else
      delete from public.feedback_post_votes where user_id=v_actor and public.feedback_root(post_id)=v_root;
    end if;
  elsif p_action='comment_vote' then
    if v_comment.visibility<>'published' then raise exception 'feedback_not_found'; end if;
    if jsonb_typeof(p_payload->'supported') is distinct from 'boolean' then raise exception 'feedback_invalid'; end if;
    if (p_payload->>'supported')::boolean then insert into public.feedback_comment_votes(comment_id,user_id) values(v_id,v_actor) on conflict do nothing;
    else delete from public.feedback_comment_votes where comment_id=v_id and user_id=v_actor; end if;
  elsif p_action='comment' then
    if char_length(public.feedback_text_trim(coalesce(p_payload->>'body',''))) not between 2 and 2000 or (p_payload->>'request_id') is null then raise exception 'feedback_invalid'; end if;
    v_target:=v_root;
    if nullif(p_payload->>'parent_id','') is not null then
      select * into v_parent from public.feedback_comments where id=(p_payload->>'parent_id')::uuid;
      if not found or v_parent.visibility<>'published' or public.feedback_root(v_parent.post_id)<>v_root or not exists(select 1 from public.feedback_posts where id=v_parent.post_id and visibility='published') then raise exception 'feedback_parent'; end if;
      v_target:=v_parent.post_id;
    end if;
    v_result:=(p_payload->>'request_id')::uuid;
    insert into public.feedback_comments(id,post_id,author_id,parent_id,body) values(v_result,v_target,v_actor,v_parent.id,public.feedback_text_trim(p_payload->>'body')) on conflict(id) do nothing;
    select * into v_comment from public.feedback_comments where id=v_result;
    if v_comment.author_id is distinct from v_actor or v_comment.body<>public.feedback_text_trim(p_payload->>'body') or v_comment.post_id<>v_target or v_comment.parent_id is distinct from v_parent.id then raise exception 'feedback_conflict'; end if;
  elsif p_action='edit' then
    if v_id<>v_root or (p_payload->>'version')::integer is distinct from v_post.version then raise exception 'feedback_conflict'; end if;
    if char_length(public.feedback_text_trim(coalesce(p_payload->>'title',''))) not between 2 and 120 or char_length(public.feedback_text_trim(coalesce(p_payload->>'description',''))) not between 2 and 5000 or coalesce(p_payload->>'module','') not in ('wallet','transfer','browser','other') or coalesce(p_payload->>'status','') not in ('inbox','evaluating','planned','building','done','needsInfo','declined') or coalesce(p_payload->>'mark','') not in ('none','research','needsInfo','featured') or coalesce(p_payload->>'visibility','') not in ('published','hidden') then raise exception 'feedback_invalid'; end if;
    v_before:=to_jsonb(v_post);
    update public.feedback_posts set title=public.feedback_text_trim(p_payload->>'title'),description=public.feedback_text_trim(p_payload->>'description'),module=p_payload->>'module',status=p_payload->>'status',mark=p_payload->>'mark',visibility=p_payload->>'visibility',version=version+1,updated_at=now() where id=v_id returning * into v_post;
    insert into public.feedback_audit(actor_id,action,post_id,before_data,after_data) values(v_actor,'edit',v_id,v_before,to_jsonb(v_post));
  elsif p_action='edit_comment' then
    if (p_payload->>'version')::integer is distinct from v_comment.version then raise exception 'feedback_conflict'; end if;
    if char_length(public.feedback_text_trim(coalesce(p_payload->>'body',''))) not between 2 and 2000 or coalesce(p_payload->>'mark','') not in ('none','research','needsInfo','featured') or coalesce(p_payload->>'visibility','') not in ('published','hidden') then raise exception 'feedback_invalid'; end if;
    v_before:=to_jsonb(v_comment);
    update public.feedback_comments set body=public.feedback_text_trim(p_payload->>'body'),mark=p_payload->>'mark',visibility=p_payload->>'visibility',version=version+1,updated_at=now() where id=v_id returning * into v_comment;
    insert into public.feedback_audit(actor_id,action,post_id,comment_id,before_data,after_data) values(v_actor,'edit_comment',v_comment.post_id,v_id,v_before,to_jsonb(v_comment));
  elsif p_action in ('merge','preview_merge') then
    select * into v_other from public.feedback_posts where id=(p_payload->>'other_id')::uuid for update;
    if not found or v_other.id=v_id or v_id<>v_root or v_post.visibility<>'published' or v_other.visibility<>'published' or (p_payload->>'version')::integer is distinct from v_post.version or (p_payload->>'other_version')::integer is distinct from v_other.version then raise exception 'feedback_conflict'; end if;
    if exists(select 1 from public.feedback_merges where undone_at is null and (source_id in (v_id,v_other.id) or target_id in (v_id,v_other.id))) then raise exception 'feedback_merge_blocked'; end if;
    if (v_post.created_at,v_post.id)<(v_other.created_at,v_other.id) then v_target:=v_post.id; v_source:=v_other.id; else v_target:=v_other.id; v_source:=v_post.id; end if;
    if p_action='preview_merge' then return jsonb_build_object('id',v_target,'support_count',(select count(distinct user_id) from public.feedback_post_votes where post_id in (v_source,v_target))); end if;
    insert into public.feedback_merges(source_id,target_id,actor_id) values(v_source,v_target,v_actor) returning * into v_merge;
    update public.feedback_posts set version=version+1,updated_at=now() where id in (v_source,v_target);
    insert into public.feedback_audit(actor_id,action,post_id,after_data) values(v_actor,'merge',v_target,to_jsonb(v_merge));
    v_root:=v_target;
  elsif p_action='unmerge' then
    if (p_payload->>'version')::integer is distinct from v_post.version then raise exception 'feedback_conflict'; end if;
    v_before:=to_jsonb(v_merge);
    update public.feedback_merges set undone_at=now(),undone_by=v_actor where id=v_id returning * into v_merge;
    update public.feedback_posts set version=version+1,updated_at=now() where id in (v_merge.source_id,v_merge.target_id);
    insert into public.feedback_audit(actor_id,action,post_id,before_data,after_data) values(v_actor,'unmerge',v_root,v_before,to_jsonb(v_merge));
  end if;
  return jsonb_build_object('id',v_root,'comment_id',v_result);
end;
$$;

-- Defence in depth for privileged/direct writes. NOT VALID avoids scanning or
-- modifying old content; new and changed rows must satisfy the same limits.
alter table public.feedback_posts
  add constraint feedback_posts_review_title_check check (char_length(public.feedback_text_trim(title)) between 2 and 120) not valid,
  add constraint feedback_posts_review_description_check check (char_length(public.feedback_text_trim(description)) between 2 and 5000) not valid;
alter table public.feedback_comments
  add constraint feedback_comments_review_body_check check (char_length(public.feedback_text_trim(body)) between 2 and 2000) not valid;

-- Parent publication rechecks must not rewrite legacy invalid child rows.
-- Their event ledger remains intact; valid comments keep the existing fanout.
create or replace function public.emit_content_notification() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
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
 elsif tg_table_name='feedback_posts' then update feedback_comments set visibility=visibility where post_id=new.id and visibility='published' and char_length(btrim(body, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) between 2 and 2000; end if;
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

commit;
