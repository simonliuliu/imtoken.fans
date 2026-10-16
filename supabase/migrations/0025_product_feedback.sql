-- Real Product Cooperation feedback, isolated from historical product/idea content.
-- No demo seeds, XP hooks or privileged client keys. Revert by disabling the new UI;
-- preserve these tables/audit rather than dropping submitted content.
begin;

create table public.feedback_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles(id) on delete set null,
  title text not null check (char_length(btrim(title)) between 2 and 120),
  description text not null check (char_length(btrim(description)) between 2 and 5000),
  module text not null check (module in ('wallet','transfer','browser','other')),
  status text not null default 'inbox' check (status in ('inbox','evaluating','planned','building','done','needsInfo','declined')),
  mark text not null default 'none' check (mark in ('none','research','needsInfo','featured')),
  visibility text not null default 'published' check (visibility in ('published','hidden')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.feedback_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feedback_posts(id),
  author_id uuid references public.profiles(id) on delete set null,
  parent_id uuid references public.feedback_comments(id),
  body text not null check (char_length(btrim(body)) between 2 and 2000),
  mark text not null default 'none' check (mark in ('none','research','needsInfo','featured')),
  visibility text not null default 'published' check (visibility in ('published','hidden')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.feedback_post_votes (
  post_id uuid not null references public.feedback_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), primary key(post_id,user_id)
);
create table public.feedback_comment_votes (
  comment_id uuid not null references public.feedback_comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), primary key(comment_id,user_id)
);
create table public.feedback_merges (
  id uuid primary key default gen_random_uuid(), source_id uuid not null references public.feedback_posts(id),
  target_id uuid not null references public.feedback_posts(id),
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(), undone_at timestamptz, undone_by uuid references public.profiles(id) on delete set null,
  check (source_id <> target_id)
);
create unique index feedback_merge_source_active on public.feedback_merges(source_id) where undone_at is null;
create unique index feedback_merge_target_active on public.feedback_merges(target_id) where undone_at is null;
create table public.feedback_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null, post_id uuid not null references public.feedback_posts(id),
  comment_id uuid references public.feedback_comments(id),
  before_data jsonb, after_data jsonb, created_at timestamptz not null default now()
);
create index feedback_posts_created on public.feedback_posts(created_at desc,id);
create index feedback_comments_post on public.feedback_comments(post_id,created_at,id);
create index feedback_audit_post on public.feedback_audit(post_id,created_at desc);

alter table public.feedback_posts enable row level security;
alter table public.feedback_comments enable row level security;
alter table public.feedback_post_votes enable row level security;
alter table public.feedback_comment_votes enable row level security;
alter table public.feedback_merges enable row level security;
alter table public.feedback_audit enable row level security;
-- All writes are RPC-only. Raw tables and voter identities are not exposed to clients.
revoke all on public.feedback_posts,public.feedback_comments,public.feedback_post_votes,public.feedback_comment_votes,public.feedback_merges,public.feedback_audit from anon,authenticated;
revoke all on sequence public.feedback_audit_id_seq from anon,authenticated;
-- Defence in depth: even if SELECT is later granted, private votes/audit stay restricted.
create policy feedback_posts_read on public.feedback_posts for select using (visibility='published' or public.is_admin());
create policy feedback_comments_read on public.feedback_comments for select using ((visibility='published' and exists(select 1 from public.feedback_posts p where p.id=post_id and p.visibility='published')) or public.is_admin());
create policy feedback_own_post_votes on public.feedback_post_votes for select to authenticated using (user_id=auth.uid());
create policy feedback_own_comment_votes on public.feedback_comment_votes for select to authenticated using (user_id=auth.uid());
create policy feedback_merges_read on public.feedback_merges for select using (public.is_admin());
create policy feedback_audit_read on public.feedback_audit for select to authenticated using (public.is_admin());

create function public.feedback_root(p_id uuid) returns uuid
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((select m.target_id from public.feedback_merges m where m.source_id=p_id and m.undone_at is null),p_id);
$$;
create function public.feedback_actor(p_admin boolean default false) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid:=auth.uid(); v_profile public.profiles;
begin
  -- Every write shares this transaction lock: merge/unmerge cannot race votes/replies.
  -- Single lock intentionally serializes this small feedback subsystem; no lock-order cycles.
  perform pg_advisory_xact_lock(824024);
  if v_id is null then raise exception 'feedback_sign_in'; end if;
  select * into v_profile from public.profiles where id=v_id for share;
  if not found then raise exception 'feedback_sign_in'; end if;
  if v_profile.muted_until > now() or exists(select 1 from public.user_tags where user_id=v_id and tag_key='blacklisted') then raise exception 'feedback_restricted'; end if;
  if p_admin and v_profile.role is distinct from 'admin' then raise exception 'feedback_forbidden'; end if;
  return v_id;
end;
$$;

-- Sanitized read projection. Helpers have no client EXECUTE privilege.
create function public.feedback_card(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',p.id,'title',p.title,'description',p.description,'module',p.module,'status',p.status,'mark',p.mark,'visibility',p.visibility,'version',p.version,'created_at',p.created_at,'updated_at',p.updated_at,
    'author_name',coalesce(nullif(a.display_name,''),nullif(a.username,'')),
    'support_count',(select count(distinct v.user_id) from public.feedback_post_votes v join public.feedback_posts origin on origin.id=v.post_id where public.feedback_root(v.post_id)=p.id and origin.visibility='published'),
    'supported',exists(select 1 from public.feedback_post_votes v join public.feedback_posts origin on origin.id=v.post_id where public.feedback_root(v.post_id)=p.id and v.user_id=auth.uid() and origin.visibility='published'),
    'comment_count',(select count(*) from public.feedback_comments c join public.feedback_posts origin on origin.id=c.post_id where public.feedback_root(c.post_id)=p.id and c.visibility='published' and origin.visibility='published'),
    'merge_id',(select m.id from public.feedback_merges m where m.target_id=p.id and m.undone_at is null))
  from public.feedback_posts p left join public.profiles a on a.id=p.author_id where p.id=p_id;
$$;

create function public.feedback_read(p_id uuid default null,p_query text default '',p_module text default 'all',p_status text default 'all',p_sort text default 'latest',p_offset integer default 0,p_comment_offset integer default 0)
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

create function public.feedback_write(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_admin boolean; v_id uuid; v_root uuid; v_parent public.feedback_comments; v_post public.feedback_posts; v_other public.feedback_posts; v_comment public.feedback_comments; v_merge public.feedback_merges; v_before jsonb; v_target uuid; v_source uuid; v_result uuid;
begin
  if p_action is null or p_payload is null or p_action not in ('create','comment','vote','comment_vote','edit','edit_comment','merge','preview_merge','unmerge') or jsonb_typeof(p_payload)<>'object' then raise exception 'feedback_invalid'; end if;
  v_admin:=p_action in ('edit','edit_comment','merge','preview_merge','unmerge');
  v_actor:=public.feedback_actor(v_admin);
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'feedback_invalid'; end if;
  if p_action='create' then
    if char_length(btrim(coalesce(p_payload->>'title',''))) not between 2 and 120 or char_length(btrim(coalesce(p_payload->>'description',''))) not between 2 and 5000 or coalesce(p_payload->>'module','') not in ('wallet','transfer','browser','other') then raise exception 'feedback_invalid'; end if;
    insert into public.feedback_posts(id,author_id,title,description,module) values(v_id,v_actor,btrim(p_payload->>'title'),btrim(p_payload->>'description'),p_payload->>'module') on conflict(id) do nothing;
    select * into v_post from public.feedback_posts where id=v_id;
    if v_post.author_id is distinct from v_actor or v_post.title<>btrim(p_payload->>'title') or v_post.description<>btrim(p_payload->>'description') or v_post.module<>p_payload->>'module' then raise exception 'feedback_conflict'; end if;
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
    if char_length(btrim(coalesce(p_payload->>'body',''))) not between 2 and 2000 or (p_payload->>'request_id') is null then raise exception 'feedback_invalid'; end if;
    v_target:=v_root;
    if nullif(p_payload->>'parent_id','') is not null then
      select * into v_parent from public.feedback_comments where id=(p_payload->>'parent_id')::uuid;
      if not found or v_parent.visibility<>'published' or public.feedback_root(v_parent.post_id)<>v_root or not exists(select 1 from public.feedback_posts where id=v_parent.post_id and visibility='published') then raise exception 'feedback_parent'; end if;
      v_target:=v_parent.post_id;
    end if;
    v_result:=(p_payload->>'request_id')::uuid;
    insert into public.feedback_comments(id,post_id,author_id,parent_id,body) values(v_result,v_target,v_actor,v_parent.id,btrim(p_payload->>'body')) on conflict(id) do nothing;
    select * into v_comment from public.feedback_comments where id=v_result;
    if v_comment.author_id is distinct from v_actor or v_comment.body<>btrim(p_payload->>'body') or v_comment.post_id<>v_target or v_comment.parent_id is distinct from v_parent.id then raise exception 'feedback_conflict'; end if;
  elsif p_action='edit' then
    if v_id<>v_root or (p_payload->>'version')::integer is distinct from v_post.version then raise exception 'feedback_conflict'; end if;
    if char_length(btrim(coalesce(p_payload->>'title',''))) not between 2 and 120 or char_length(btrim(coalesce(p_payload->>'description',''))) not between 2 and 5000 or coalesce(p_payload->>'module','') not in ('wallet','transfer','browser','other') or coalesce(p_payload->>'status','') not in ('inbox','evaluating','planned','building','done','needsInfo','declined') or coalesce(p_payload->>'mark','') not in ('none','research','needsInfo','featured') or coalesce(p_payload->>'visibility','') not in ('published','hidden') then raise exception 'feedback_invalid'; end if;
    v_before:=to_jsonb(v_post);
    update public.feedback_posts set title=btrim(p_payload->>'title'),description=btrim(p_payload->>'description'),module=p_payload->>'module',status=p_payload->>'status',mark=p_payload->>'mark',visibility=p_payload->>'visibility',version=version+1,updated_at=now() where id=v_id returning * into v_post;
    insert into public.feedback_audit(actor_id,action,post_id,before_data,after_data) values(v_actor,'edit',v_id,v_before,to_jsonb(v_post));
  elsif p_action='edit_comment' then
    if (p_payload->>'version')::integer is distinct from v_comment.version then raise exception 'feedback_conflict'; end if;
    if char_length(btrim(coalesce(p_payload->>'body',''))) not between 2 and 2000 or coalesce(p_payload->>'mark','') not in ('none','research','needsInfo','featured') or coalesce(p_payload->>'visibility','') not in ('published','hidden') then raise exception 'feedback_invalid'; end if;
    v_before:=to_jsonb(v_comment);
    update public.feedback_comments set body=btrim(p_payload->>'body'),mark=p_payload->>'mark',visibility=p_payload->>'visibility',version=version+1,updated_at=now() where id=v_id returning * into v_comment;
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
revoke all on function public.feedback_root(uuid),public.feedback_actor(boolean),public.feedback_card(uuid),public.feedback_read(uuid,text,text,text,text,integer,integer),public.feedback_write(text,jsonb) from public,anon,authenticated;
grant execute on function public.feedback_read(uuid,text,text,text,text,integer,integer) to anon,authenticated;
grant execute on function public.feedback_write(text,jsonb) to authenticated;
commit;
