-- Forum feedback + private operator queue. Apply only after complete 0031.
-- Preserve all historical rows, IDs, XP, notification event ledgers and ACLs.
begin;
do $$ begin
 if to_regprocedure('public.feedback_text_trim(text)') is null or
 (select count(*) from pg_constraint where (conrelid='public.feedback_posts'::regclass and conname in ('feedback_posts_review_title_check','feedback_posts_review_description_check')) or (conrelid='public.feedback_comments'::regclass and conname='feedback_comments_review_body_check'))<>3 then
  raise exception '0032 requires complete 0031; inspect pg_catalog before deployment';
 end if;
end; $$;
alter table public.feedback_posts drop constraint feedback_posts_module_check;
alter table public.feedback_posts add constraint feedback_posts_module_check check(module in ('wallet','transfer','browser','other','forum'));
alter table public.feedback_posts add column kind text, add column details jsonb;
create function public.feedback_details_valid(p_kind text,p_details jsonb) returns boolean
language plpgsql immutable set search_path=public,pg_temp as $$
declare entry record;
begin
 if p_kind is null then return p_details is null; end if;
 if p_kind not in ('bug','suggestion') or jsonb_typeof(p_details) is distinct from 'object' or octet_length(p_details::text)>16000 then return false; end if;
 for entry in select * from jsonb_each(p_details) loop
  if jsonb_typeof(entry.value)<>'string' or char_length(entry.value#>>'{}')>2000 then return false; end if;
  if p_kind='bug' and entry.key not in ('appVersion','device','steps','expected','actual') or p_kind='suggestion' and entry.key not in ('scenario','proposal','impact') then return false; end if;
  if entry.key='device' and entry.value#>>'{}' not in ('','ios','android','browserExtension','other') then return false; end if;
 end loop;
 return true;
end; $$;
revoke all on function public.feedback_details_valid(text,jsonb) from public,anon,authenticated;
grant execute on function public.feedback_details_valid(text,jsonb) to service_role;
alter table public.feedback_posts add constraint feedback_posts_structured_check check(public.feedback_details_valid(kind,details) and (module<>'forum' or kind is not null)) not valid;

create or replace function public.feedback_card(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',p.id,'title',p.title,'description',p.description,'module',p.module,'kind',p.kind,'details',p.details,'status',p.status,'mark',p.mark,'visibility',p.visibility,'version',p.version,'created_at',p.created_at,'updated_at',p.updated_at,
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
  if p_module not in ('all','product','wallet','transfer','browser','other','forum') then raise exception 'feedback_invalid'; end if;
  if p_offset<0 or p_offset>100000 or p_comment_offset<0 or p_comment_offset>100000 or char_length(p_query)>120 or p_sort not in ('latest','oldest','popular') then raise exception 'feedback_invalid'; end if;
  select count(*) into v_total from public.feedback_posts p where (p.visibility='published' or v_admin) and public.feedback_root(p.id)=p.id and (p_module='all' or p_module='product' and p.module<>'forum' or p.module=p_module) and (p_status='all' or p.status=p_status) and (p_query='' or position(lower(p_query) in lower(p.title||' '||p.description||' '||coalesce(p.details::text,'')))>0);
  select coalesce(jsonb_agg(card order by ordering),'[]'::jsonb) into v_posts from (
    select public.feedback_card(p.id) card,row_number() over(order by case when p_sort='popular' then (public.feedback_card(p.id)->>'support_count')::bigint end desc nulls last,case when p_sort='oldest' then p.created_at end asc nulls last,p.created_at desc,p.id) ordering
    from public.feedback_posts p where (p.visibility='published' or v_admin) and public.feedback_root(p.id)=p.id and (p_module='all' or p_module='product' and p.module<>'forum' or p.module=p_module) and (p_status='all' or p.status=p_status) and (p_query='' or position(lower(p_query) in lower(p.title||' '||p.description||' '||coalesce(p.details::text,'')))>0)
    order by ordering limit 20 offset p_offset
  ) listed;
  if p_id is not null then
    v_root:=public.feedback_root(p_id);
    if not exists(select 1 from public.feedback_posts p where p.id=v_root and (p.visibility='published' or v_admin) and (p_module='all' or p_module='product' and p.module<>'forum' or p.module=p_module)) or not exists(select 1 from public.feedback_posts p where p.id=p_id and (p.visibility='published' or v_admin)) then raise exception 'feedback_not_found'; end if;
    select coalesce(jsonb_agg(public.feedback_card(p.id) order by p.created_at,p.id),'[]') into v_sources from public.feedback_posts p where public.feedback_root(p.id)=v_root and p.id<>v_root and (p.visibility='published' or v_admin);
    select count(*) into v_comment_total from public.feedback_comments c join public.feedback_posts p on p.id=c.post_id where public.feedback_root(c.post_id)=v_root and ((c.visibility='published' and p.visibility='published') or v_admin);
    select coalesce(jsonb_agg(item order by created_at,id),'[]') into v_comments from (
      select c.id,c.created_at,jsonb_build_object('id',c.id,'post_id',c.post_id,'source_title',p.title,'parent_id',c.parent_id,'parent_author_name',case when parent.visibility='published' or v_admin then coalesce(nullif(pa.display_name,''),nullif(pa.username,'')) else null end,
        'author_name',coalesce(nullif(a.display_name,''),nullif(a.username,'')),'body',c.body,'mark',c.mark,'visibility',c.visibility,'version',c.version,'created_at',c.created_at,
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
    if not public.feedback_details_valid(p_payload->>'kind',p_payload->'details') or (p_payload->>'module'='forum' and p_payload->>'kind' is null) then raise exception 'feedback_invalid'; end if;
    if char_length(public.feedback_text_trim(coalesce(p_payload->>'title',''))) not between 2 and 120 or char_length(public.feedback_text_trim(coalesce(p_payload->>'description',''))) not between 2 and 5000 or coalesce(p_payload->>'module','') not in ('wallet','transfer','browser','other','forum') then raise exception 'feedback_invalid'; end if;
    insert into public.feedback_posts(id,author_id,title,description,module,kind,details) values(v_id,v_actor,public.feedback_text_trim(p_payload->>'title'),public.feedback_text_trim(p_payload->>'description'),p_payload->>'module',p_payload->>'kind',p_payload->'details') on conflict(id) do nothing;
    select * into v_post from public.feedback_posts where id=v_id;
    if v_post.author_id is distinct from v_actor or v_post.title<>public.feedback_text_trim(p_payload->>'title') or v_post.description<>public.feedback_text_trim(p_payload->>'description') or v_post.module<>p_payload->>'module' or v_post.kind is distinct from (p_payload->>'kind') or v_post.details is distinct from (p_payload->'details') then raise exception 'feedback_conflict'; end if;
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
    if char_length(public.feedback_text_trim(coalesce(p_payload->>'title',''))) not between 2 and 120 or char_length(public.feedback_text_trim(coalesce(p_payload->>'description',''))) not between 2 and 5000 or coalesce(p_payload->>'module','') not in ('wallet','transfer','browser','other','forum') or coalesce(p_payload->>'status','') not in ('inbox','evaluating','planned','building','done','needsInfo','declined') or coalesce(p_payload->>'mark','') not in ('none','research','needsInfo','featured') or coalesce(p_payload->>'visibility','') not in ('published','hidden') then raise exception 'feedback_invalid'; end if;
    if (v_post.module='forum') is distinct from (p_payload->>'module'='forum') then raise exception 'feedback_scope'; end if;
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
    if (v_post.module='forum') is distinct from (v_other.module='forum') then raise exception 'feedback_scope'; end if;
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

create or replace function public.notification_read(p_expected_user_id uuid,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_items jsonb;
begin
 if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'notification_session'; end if;
 if p_offset<0 or p_offset>100000 then raise exception 'notification_invalid'; end if;
 select coalesce(jsonb_agg(item order by created_at desc,id desc),'[]'::jsonb) into v_items from (
 select n.id,n.created_at,jsonb_build_object('id',n.id,'type',n.type,'read_at',n.read_at,'created_at',n.created_at,'detail',case when n.event_key is null then n.detail else jsonb_build_object('kind',n.detail->>'kind') end,
 'actor_username',a.username,'actor_avatar_url',a.avatar_url,
 'submission_id',s.id,'submission_type',s.type,'submission_title',coalesce(s.title,fp.title),
 'comment_id',coalesce(c.id,fc.id),'comment_preview',left(coalesce(c.body,fc.body),60),
 'href',case when fp.id is not null then '/community/feedback?category='||case when fp.module='forum' then 'forum' else 'wallet' end||'&idea='||fp.id||case when fc.id is not null then '&commentOffset='||((select count(*) from feedback_comments prev join feedback_posts origin on origin.id=prev.post_id where feedback_root(prev.post_id)=feedback_root(fp.id) and prev.visibility='published' and origin.visibility='published' and (prev.created_at,prev.id)<(fc.created_at,fc.id))/50*50)::text||'#comment-'||fc.id else '' end when s.id is not null then case when s.type='post' then '/community/'||s.community_section||'/'||coalesce(s.legacy_slug,s.id::text) else case when s.type='product' then '/products/' else '/ideas/' end||s.id end||case when c.id is not null then '#comment-'||c.id else '' end else null end) item
 from notifications n left join profiles a on a.id=n.actor_id
 left join submissions s on s.id=n.submission_id and s.status='published' and s.deleted_at is null
 left join comments c on c.id=n.comment_id and s.id is not null and c.status='published' and c.deleted_at is null and community_comment_public(c.id)
 left join feedback_posts fp on fp.id=n.feedback_post_id and fp.visibility='published' and exists(select 1 from feedback_posts root where root.id=feedback_root(fp.id) and root.visibility='published')
 left join feedback_comments fc on fc.id=n.feedback_comment_id and fp.id is not null and fc.visibility='published'
 where n.user_id=auth.uid() and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null and community_comment_public(x.id))) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published'))) order by n.created_at desc,n.id desc limit 20 offset p_offset
 ) rows;
 return jsonb_build_object('items',v_items,'unread',(select count(*) from notifications n where user_id=auth.uid() and read_at is null and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null and community_comment_public(x.id))) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published')))),'total',(select count(*) from notifications n where user_id=auth.uid() and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null and community_comment_public(x.id))) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published')))));
end; $$;

-- Private queue. RPCs are service_role-only; even service_role has no raw table
-- grants. Tokens authorize one lease and are never included in read-only lists.
create table public.forum_feedback_jobs (
 id uuid primary key default gen_random_uuid(),
 feedback_id uuid not null references public.feedback_posts(id),
 source_version integer not null check(source_version>0),
 current_version integer not null check(current_version>0),
 snapshot jsonb not null,
 status text not null default 'queued' check(status in ('queued','claimed','pr_ready','deployed','blocked','stale')),
 attempts integer not null default 0 check(attempts>=0),
 lease_reclaims integer not null default 0 check(lease_reclaims>=0),
 consecutive_expirations integer not null default 0 check(consecutive_expirations>=0),
 available_at timestamptz not null default now(),
 claimed_by text, lease_token uuid, lease_until timestamptz,
 task_key text check(char_length(task_key)<=200),
 pr_url text check(pr_url ~ '^https://github[.]com/simonliuliu/imtoken[.]fans/pull/[1-9][0-9]*$'),
 commit_sha text check(commit_sha ~ '^[0-9a-f]{40}$'),
 deployment_id text check(char_length(deployment_id) between 1 and 128),
 deployment_url text check(deployment_url ~ '^https://imtoken-fans([a-z0-9-]*)[.]vercel[.]app$'),
 failure_reason text check(char_length(failure_reason)<=2000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(feedback_id,source_version)
);
alter table public.forum_feedback_jobs enable row level security;
revoke all on public.forum_feedback_jobs from public,anon,authenticated,service_role;
create index forum_feedback_jobs_ready on public.forum_feedback_jobs(status,available_at,created_at);

create function public.forum_feedback_source_current(p_id uuid,p_version integer) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from feedback_posts p where p.id=p_id and p.version=p_version and p.module='forum' and p.visibility='published' and p.kind is not null and p.status not in ('done','declined','needsInfo') and feedback_root(p.id)=p.id);
$$;
revoke all on function public.forum_feedback_source_current(uuid,integer) from public,anon,authenticated,service_role;

create function public.forum_feedback_snapshot(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('id',p.id,'version',p.version,'title',p.title,'description',p.description,'module',p.module,'kind',p.kind,'details',p.details,
 'sources',(select coalesce(jsonb_agg(jsonb_build_object('id',src.id,'title',src.title,'description',src.description,'kind',src.kind,'details',src.details) order by src.created_at,src.id),'[]') from feedback_posts src where src.id<>p.id and feedback_root(src.id)=p.id and src.visibility='published'))
 from feedback_posts p where p.id=p_id;
$$;
revoke all on function public.forum_feedback_snapshot(uuid) from public,anon,authenticated,service_role;

create function public.enqueue_forum_feedback() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare current_snapshot jsonb; previous public.forum_feedback_jobs; reopening boolean:=false;
begin
 if tg_op='UPDATE' then reopening:=old.status in ('done','declined','needsInfo') and new.status='inbox'; end if;
 if not forum_feedback_source_current(new.id,new.version) then
  update forum_feedback_jobs set status='stale',lease_token=null,lease_until=null,updated_at=now()
   where feedback_id=new.id and status in ('queued','claimed','pr_ready','blocked');
  return new;
 end if;
 current_snapshot:=forum_feedback_snapshot(new.id);
 select * into previous from forum_feedback_jobs where feedback_id=new.id order by created_at desc,id desc limit 1 for update;
 if found and (previous.snapshot-'version')=(current_snapshot-'version') then
  if previous.status in ('queued','claimed','pr_ready','blocked') then
   -- Metadata-only revisions preserve the same unit of work and active lease.
   update forum_feedback_jobs set current_version=new.version,updated_at=now() where id=previous.id;
   return new;
  elsif previous.status='deployed' and not reopening then
   -- Changing editorial metadata after delivery must not repeat the repair.
   return new;
  end if;
 end if;
 update forum_feedback_jobs set status='stale',lease_token=null,lease_until=null,updated_at=now()
  where feedback_id=new.id and status in ('queued','claimed','pr_ready','blocked');
 insert into forum_feedback_jobs(feedback_id,source_version,current_version,snapshot)
  values(new.id,new.version,new.version,current_snapshot) on conflict(feedback_id,source_version) do nothing;
 return new;
end; $$;
revoke all on function public.enqueue_forum_feedback() from public,anon,authenticated,service_role;
create trigger forum_feedback_enqueue after insert or update on public.feedback_posts for each row execute function public.enqueue_forum_feedback();

create function public.forum_feedback_jobs_list(p_limit integer default 20,p_offset integer default 0,p_history boolean default false) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000 or p_history is null then raise exception 'forum_queue_invalid'; end if;
 return (select coalesce(jsonb_agg(item order by needs_attention,created_at,id),'[]') from (
  select id,created_at,
   case when p_history then false else (attempts>=5 or consecutive_expirations>=5) and status<>'pr_ready' end needs_attention,
   (to_jsonb(j)-'lease_token')||jsonb_build_object(
    'source_current',forum_feedback_source_current(feedback_id,current_version),
    'requires_attention',(attempts>=5 or consecutive_expirations>=5) and status<>'pr_ready',
    'requires_resume',(status in ('queued','blocked','pr_ready') or status='claimed' and lease_until<now()) and (task_key is not null or pr_url is not null)) item
  from forum_feedback_jobs j where p_history or forum_feedback_source_current(feedback_id,current_version)
   and (status in ('queued','blocked') and available_at<=now() or status='claimed' and lease_until<now() or status='pr_ready')
  order by needs_attention,created_at,id limit p_limit offset p_offset
 ) listed);
end; $$;

create function public.forum_feedback_jobs_claim(p_worker text,p_id uuid default null,p_lease_seconds integer default 900) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare selected public.forum_feedback_jobs; source_id uuid;
begin
 if p_worker is null or char_length(trim(p_worker)) not between 1 and 120 or p_lease_seconds is null or p_lease_seconds not between 60 and 3600 then raise exception 'forum_queue_invalid'; end if;
 select p.id into source_id from feedback_posts p where exists(
  select 1 from forum_feedback_jobs j where j.feedback_id=p.id and (p_id is null or j.id=p_id) and (j.attempts<5 and j.consecutive_expirations<5 or p_id is not null) and j.available_at<=now()
  and (j.status in ('queued','blocked') and (p_id is not null or j.task_key is null and j.pr_url is null) or j.status='claimed' and j.lease_until<now() and (p_id is not null or j.task_key is null and j.pr_url is null) or p_id is not null and j.status='pr_ready')
  and forum_feedback_source_current(j.feedback_id,j.current_version)) order by p.created_at,p.id for share of p skip locked limit 1;
 if not found then return null; end if;
 select * into selected from forum_feedback_jobs j
  where feedback_id=source_id and (p_id is null or j.id=p_id) and (attempts<5 and consecutive_expirations<5 or p_id is not null) and available_at<=now()
  and (status in ('queued','blocked') and (p_id is not null or task_key is null and pr_url is null) or status='claimed' and lease_until<now() and (p_id is not null or task_key is null and pr_url is null) or p_id is not null and status='pr_ready')
  and forum_feedback_source_current(feedback_id,current_version)
  order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 -- Lock the source before issuing a lease. A concurrent content edit either
 -- precedes this check or invalidates the lease through the enqueue trigger.
 perform 1 from feedback_posts where id=selected.feedback_id for share;
 if not forum_feedback_source_current(selected.feedback_id,selected.current_version) then return null; end if;
 update forum_feedback_jobs set status='claimed',
  attempts=attempts+case when selected.status in ('queued','blocked') then 1 else 0 end,
  lease_reclaims=lease_reclaims+case when selected.status='claimed' then 1 else 0 end,
  consecutive_expirations=case when selected.status='claimed' then consecutive_expirations+1 when selected.status in ('queued','blocked') then 0 else consecutive_expirations end,
  claimed_by=trim(p_worker),lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=now()
  where id=selected.id returning * into selected;
 return to_jsonb(selected);
end; $$;

-- A checkpoint keeps a live lease while recording durable, immutable task links.
create function public.forum_feedback_jobs_renew(p_id uuid,p_token uuid,p_lease_seconds integer default 3600,p_metadata jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare selected public.forum_feedback_jobs;
begin
 if p_id is null or p_token is null or p_lease_seconds is null or p_lease_seconds not between 60 and 3600 or jsonb_typeof(p_metadata) is distinct from 'object'
 or exists(select 1 from jsonb_each(p_metadata) e where e.key not in ('task_key','pr_url') or jsonb_typeof(e.value)<>'string' or length(trim(e.value#>>'{}'))=0) then raise exception 'forum_queue_invalid'; end if;
 select * into selected from forum_feedback_jobs where id=p_id;
 if not found then raise exception 'forum_queue_lease'; end if;
 perform 1 from feedback_posts where id=selected.feedback_id for share;
 select * into selected from forum_feedback_jobs where id=p_id for update;
 if not found or selected.status<>'claimed' or selected.lease_token is distinct from p_token or selected.lease_until<=clock_timestamp() then raise exception 'forum_queue_lease'; end if;
 if not forum_feedback_source_current(selected.feedback_id,selected.current_version) then raise exception 'forum_queue_stale'; end if;
 if (p_metadata ? 'task_key' and selected.task_key is not null and selected.task_key<>(p_metadata->>'task_key'))
 or (p_metadata ? 'pr_url' and selected.pr_url is not null and selected.pr_url<>(p_metadata->>'pr_url')) then raise exception 'forum_queue_association_conflict'; end if;
 update forum_feedback_jobs set task_key=coalesce(p_metadata->>'task_key',task_key),pr_url=coalesce(p_metadata->>'pr_url',pr_url),
  lease_until=greatest(lease_until,clock_timestamp()+make_interval(secs=>p_lease_seconds)),consecutive_expirations=0,updated_at=now()
  where id=p_id returning * into selected;
 return to_jsonb(selected)-'lease_token'-'snapshot';
end; $$;

create function public.forum_feedback_jobs_record(p_id uuid,p_token uuid,p_status text,p_metadata jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare selected public.forum_feedback_jobs;
begin
 if p_id is null or p_token is null or p_status is null or p_status not in ('pr_ready','deployed','blocked') or jsonb_typeof(p_metadata) is distinct from 'object'
 or exists(select 1 from jsonb_each(p_metadata) e where e.key not in ('task_key','pr_url','commit_sha','deployment_id','deployment_url','failure_reason') or jsonb_typeof(e.value)<>'string' or e.key in ('task_key','pr_url') and length(trim(e.value#>>'{}'))=0) then raise exception 'forum_queue_invalid'; end if;
 select * into selected from forum_feedback_jobs where id=p_id;
 if not found then raise exception 'forum_queue_lease'; end if;
 perform 1 from feedback_posts where id=selected.feedback_id for share;
 select * into selected from forum_feedback_jobs where id=p_id for update;
 if not found or selected.status<>'claimed' or selected.lease_token is distinct from p_token or selected.lease_until<=clock_timestamp() then raise exception 'forum_queue_lease'; end if;
 perform 1 from feedback_posts where id=selected.feedback_id for share;
 if not forum_feedback_source_current(selected.feedback_id,selected.current_version) then raise exception 'forum_queue_stale'; end if;
 if (p_metadata ? 'task_key' and selected.task_key is not null and selected.task_key<>(p_metadata->>'task_key'))
 or (p_metadata ? 'pr_url' and selected.pr_url is not null and selected.pr_url<>(p_metadata->>'pr_url')) then raise exception 'forum_queue_association_conflict'; end if;
 if p_status in ('pr_ready','deployed') and coalesce(p_metadata->>'pr_url',selected.pr_url) is null then raise exception 'forum_queue_evidence'; end if;
 if p_status='deployed' and (coalesce(p_metadata->>'commit_sha',selected.commit_sha) is null or coalesce(p_metadata->>'deployment_id',selected.deployment_id) is null or coalesce(p_metadata->>'deployment_url',selected.deployment_url) is null) then raise exception 'forum_queue_evidence'; end if;
 update forum_feedback_jobs set status=p_status,task_key=coalesce(p_metadata->>'task_key',task_key),pr_url=coalesce(p_metadata->>'pr_url',pr_url),commit_sha=coalesce(p_metadata->>'commit_sha',commit_sha),deployment_id=coalesce(p_metadata->>'deployment_id',deployment_id),deployment_url=coalesce(p_metadata->>'deployment_url',deployment_url),failure_reason=case when p_status='blocked' then p_metadata->>'failure_reason' else null end,
  available_at=case when p_status='blocked' then now()+interval '15 minutes' else available_at end,
  lease_token=null,lease_until=null,updated_at=now() where id=p_id returning * into selected;
 -- Public workflow status is deliberately separate. An operator must verify
 -- production evidence before recording deployed; this RPC never publishes code.
 return to_jsonb(selected)-'lease_token';
end; $$;
revoke all on function public.forum_feedback_jobs_list(integer,integer,boolean),public.forum_feedback_jobs_claim(text,uuid,integer),public.forum_feedback_jobs_renew(uuid,uuid,integer,jsonb),public.forum_feedback_jobs_record(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.forum_feedback_jobs_list(integer,integer,boolean),public.forum_feedback_jobs_claim(text,uuid,integer),public.forum_feedback_jobs_renew(uuid,uuid,integer,jsonb),public.forum_feedback_jobs_record(uuid,uuid,text,jsonb) to service_role;
-- Existing public feedback RPC ACLs are retained by CREATE OR REPLACE.
commit;
