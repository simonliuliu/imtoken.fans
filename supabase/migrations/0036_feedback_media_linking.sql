-- FB-03 candidate: transactionally link verified attachments and preserve
-- original feedback provenance across moderation and merge/unmerge. This does
-- not expose the private Storage objects or turn on a user interface.
begin;

do $$
begin
  if to_regclass('public.feedback_media_uploads') is null
     or to_regprocedure('public.forum_feedback_snapshot(uuid)') is null
     or to_regprocedure('public.feedback_write(text,jsonb)') is null
     or to_regprocedure('public.feedback_write_without_media(text,jsonb)') is not null then
    raise exception '0036 requires the unmodified 0032 and 0035 feedback interfaces';
  end if;
end;
$$;

alter table public.feedback_media_uploads
  add column revision integer not null default 1 check (revision > 0),
  add column removed_at timestamptz,
  add column removed_by uuid references public.profiles(id);
create table public.feedback_media_audit (
  id bigint generated always as identity primary key,
  media_id uuid not null references public.feedback_media_uploads(id),
  post_id uuid not null references public.feedback_posts(id),
  actor_id uuid references public.profiles(id),
  action text not null check (action in ('approve', 'reject', 'remove', 'restore')),
  reason text not null default '' check (char_length(reason) <= 500),
  before_data jsonb not null,
  after_data jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.feedback_media_audit enable row level security;
revoke all on public.feedback_media_audit from public, anon, authenticated, service_role;
revoke all on sequence public.feedback_media_audit_id_seq from public, anon, authenticated, service_role;

create or replace function public.forum_feedback_snapshot(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', p.id, 'version', p.version, 'title', p.title, 'description', p.description,
    'module', p.module, 'kind', p.kind, 'details', p.details,
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('id', src.id, 'title', src.title,
      'description', src.description, 'kind', src.kind, 'details', src.details) order by src.created_at, src.id), '[]')
      from public.feedback_posts src where src.id <> p.id and public.feedback_root(src.id) = p.id and src.visibility = 'published'))
    || coalesce((select jsonb_build_object('attachments', jsonb_agg(jsonb_build_object('id', m.id, 'post_id', m.post_id,
      'type', m.declared_type, 'size', m.declared_size, 'sha256', m.verified_sha256,
      'duration', m.verified_duration, 'review_state', m.review_state, 'revision', m.revision)
      order by m.post_id, m.id))
      from public.feedback_media_uploads m join public.feedback_posts src on src.id = m.post_id
      where public.feedback_root(src.id) = p.id and src.visibility = 'published'
        and m.state = 'verified' and m.removed_at is null having count(*) > 0), '{}'::jsonb)
  from public.feedback_posts p where p.id = p_id;
$$;

alter function public.feedback_write(text,jsonb) rename to feedback_write_without_media;
revoke all on function public.feedback_write_without_media(text,jsonb) from public, anon, authenticated, service_role;
create function public.feedback_write(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor uuid; v_post_id uuid; requested uuid[] := '{}'::uuid[]; available uuid[]; attached uuid[];
  existed boolean; result jsonb;
begin
  if p_action is distinct from 'create' or jsonb_typeof(p_payload) is distinct from 'object' then
    return public.feedback_write_without_media(p_action, p_payload);
  end if;
  actor := public.feedback_actor(false);
  if coalesce(p_payload->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'feedback_invalid';
  end if;
  v_post_id := (p_payload->>'id')::uuid;
  if p_payload ? 'media_ids' then
    if jsonb_typeof(p_payload->'media_ids') is distinct from 'array' or jsonb_array_length(p_payload->'media_ids') > 6
       or exists(select 1 from jsonb_array_elements(p_payload->'media_ids') v
         where jsonb_typeof(v) <> 'string' or (v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'feedback_invalid';
    end if;
    select coalesce(array_agg((v #>> '{}')::uuid order by (v #>> '{}')::uuid), '{}'::uuid[])
      into requested from jsonb_array_elements(p_payload->'media_ids') v;
    if cardinality(requested) <> (select count(distinct x) from unnest(requested) x) then raise exception 'feedback_invalid'; end if;
  end if;
  select exists(select 1 from public.feedback_posts where id = v_post_id) into existed;
  if existed then
    select coalesce(array_agg(m.id order by m.id), '{}'::uuid[]) into attached
      from public.feedback_media_uploads m where m.post_id = v_post_id;
    if attached is distinct from requested then raise exception 'feedback_conflict'; end if;
    return public.feedback_write_without_media(p_action, p_payload);
  end if;
  select coalesce(array_agg(locked.id order by locked.id), '{}'::uuid[]) into available from (
    select m.id from public.feedback_media_uploads m
      where m.id = any(requested) and m.owner_id = actor and m.draft_id = v_post_id
        and m.post_id is null and m.state = 'verified' and m.review_state = 'pending'
        and m.expires_at > clock_timestamp()
      order by m.id for update
  ) locked;
  if available is distinct from requested then raise exception 'feedback_conflict'; end if;
  result := public.feedback_write_without_media(p_action, p_payload);
  if cardinality(requested) > 0 then
    update public.feedback_media_uploads set post_id = v_post_id where id = any(requested);
    update public.feedback_posts set version = version + 1, updated_at = clock_timestamp() where id = v_post_id;
  end if;
  return result;
end;
$$;
revoke all on function public.feedback_write(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.feedback_write(text,jsonb) to authenticated;

-- This predicate is internal; the public projections below reveal only
-- authorized IDs/metadata and never expose staging credentials.
create function public.feedback_media_visible(p_media uuid, p_include_removed boolean default false) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.feedback_media_uploads m
    join public.feedback_posts source on source.id = m.post_id
    join public.feedback_posts root on root.id = public.feedback_root(source.id)
    where m.id = p_media and m.state = 'verified'
      and (m.removed_at is null or p_include_removed and (m.owner_id = auth.uid() or public.is_admin()))
      and (public.is_admin() or (source.visibility = 'published' and root.visibility = 'published'
        and (m.owner_id = auth.uid() or m.review_state = 'approved'))));
$$;
revoke all on function public.feedback_media_visible(uuid,boolean) from public, anon, authenticated, service_role;

create function public.feedback_media_list(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare root_id uuid; result jsonb;
begin
  root_id := public.feedback_root(p_id);
  if not exists(select 1 from public.feedback_posts where id = p_id and (visibility = 'published' or public.is_admin()))
     or not exists(select 1 from public.feedback_posts where id = root_id and (visibility = 'published' or public.is_admin())) then
    raise exception 'feedback_not_found';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'post_id', m.post_id, 'type', m.declared_type,
    'size', m.declared_size, 'duration', m.verified_duration, 'review_state', m.review_state,
    'revision', m.revision, 'removed', m.removed_at is not null) order by m.created_at, m.id), '[]') into result
    from public.feedback_media_uploads m where public.feedback_root(m.post_id) = root_id and public.feedback_media_visible(m.id, true);
  return result;
end;
$$;
revoke all on function public.feedback_media_list(uuid) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_list(uuid) to anon, authenticated;

create function public.feedback_media_object(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare item public.feedback_media_uploads;
begin
  if not public.feedback_media_visible(p_id, false) then raise exception 'feedback_media_not_found'; end if;
  select * into item from public.feedback_media_uploads where id = p_id;
  return jsonb_build_object('id', item.id, 'bucket', item.bucket_id, 'path', item.verified_path,
    'type', item.declared_type, 'size', item.declared_size);
end;
$$;
revoke all on function public.feedback_media_object(uuid) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_object(uuid) to anon, authenticated;

create function public.feedback_media_moderate(p_id uuid, p_revision integer, p_action text, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid; admin boolean; item public.feedback_media_uploads; root_id uuid; before_data jsonb;
begin
  if p_id is null or p_revision is null or p_revision < 1 or p_action is null
     or p_action not in ('approve', 'reject', 'remove', 'restore') or p_reason is null or char_length(p_reason) > 500
     or (p_action = 'reject' and char_length(btrim(p_reason)) = 0) then raise exception 'feedback_invalid'; end if;
  actor := public.feedback_actor(false);
  select role = 'admin' into admin from public.profiles where id = actor;
  admin := coalesce(admin, false);
  select * into item from public.feedback_media_uploads where id = p_id for update;
  if not found or item.post_id is null or item.state <> 'verified' then raise exception 'feedback_media_not_found'; end if;
  if item.revision <> p_revision then raise exception 'feedback_conflict'; end if;
  if (p_action in ('approve', 'reject') and not admin) or (p_action in ('remove', 'restore') and not admin and item.owner_id <> actor) then
    raise exception 'feedback_forbidden';
  end if;
  -- The author cannot undo a moderation removal made by an administrator.
  if p_action = 'restore' and not admin and item.removed_by is distinct from actor then raise exception 'feedback_forbidden'; end if;
  if (p_action in ('approve', 'reject') and item.removed_at is not null)
     or (p_action = 'remove' and item.removed_at is not null)
     or (p_action = 'restore' and item.removed_at is null) then raise exception 'feedback_conflict'; end if;
  before_data := jsonb_build_object('review_state', item.review_state, 'removed', item.removed_at is not null, 'revision', item.revision);
  update public.feedback_media_uploads set
    review_state = case when p_action = 'approve' then 'approved' when p_action = 'reject' then 'rejected' else review_state end,
    removed_at = case when p_action = 'remove' then clock_timestamp() when p_action = 'restore' then null else removed_at end,
    removed_by = case when p_action = 'remove' then actor when p_action = 'restore' then null else removed_by end,
    revision = revision + 1 where id = item.id returning * into item;
  insert into public.feedback_media_audit(media_id, post_id, actor_id, action, reason, before_data, after_data)
    values(item.id, item.post_id, actor, p_action, p_reason, before_data,
      jsonb_build_object('review_state', item.review_state, 'removed', item.removed_at is not null, 'revision', item.revision));
  root_id := public.feedback_root(item.post_id);
  update public.feedback_posts set version = version + 1, updated_at = clock_timestamp() where id in (item.post_id, root_id);
  return jsonb_build_object('id', item.id, 'revision', item.revision);
end;
$$;
revoke all on function public.feedback_media_moderate(uuid,integer,text,text) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_moderate(uuid,integer,text,text) to authenticated;

commit;
