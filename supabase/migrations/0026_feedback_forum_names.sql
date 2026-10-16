-- Author display only: preserve custom forum names and avoid wallet/email placeholders.
-- No stored data updates, new profile queries, or permission/visibility changes.
-- Rollback: restore the feedback_card/read definitions from 0025; submitted data is untouched.
begin;
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
commit;
