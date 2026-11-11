-- Private staging foundation for FB-03. This migration does not expose a
-- posting UI, publish attachments, or change the existing public image bucket.
-- The upload/verification service, feedback transaction and cleanup worker must
-- be deployed and independently verified before the feature can be enabled.
begin;

do $$
begin
  if to_regprocedure('public.feedback_actor(boolean)') is null
     or to_regclass('public.forum_feedback_jobs') is null then
    raise exception '0035 requires feedback migrations through 0032';
  end if;
  if exists (select 1 from storage.buckets where id in ('feedback-media-images', 'feedback-media-videos')) then
    raise exception '0035 requires new feedback media buckets';
  end if;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-media-images', 'feedback-media-images', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
       ('feedback-media-videos', 'feedback-media-videos', false, 31457280,
        array['video/mp4', 'video/webm']);

create table public.feedback_media_uploads (
  id uuid primary key,
  owner_id uuid not null references public.profiles(id),
  draft_id uuid not null,
  post_id uuid references public.feedback_posts(id),
  bucket_id text not null check (bucket_id in ('feedback-media-images', 'feedback-media-videos')),
  staging_path text not null unique,
  verified_path text not null unique,
  declared_type text not null check (declared_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm')),
  declared_size bigint not null check (declared_size > 0 and declared_size <= 31457280),
  state text not null default 'reserved' check (state in ('reserved', 'validating', 'verified', 'cleanup_pending', 'cleaning', 'cleaned')),
  review_state text not null default 'pending' check (review_state in ('pending', 'approved', 'rejected')),
  verified_object_id uuid,
  verified_sha256 text check (verified_sha256 is null or verified_sha256 ~ '^[0-9a-f]{64}$'),
  verified_duration numeric check (verified_duration is null or verified_duration > 0 and verified_duration <= 120),
  validation_token uuid,
  validation_lease_until timestamptz,
  cleanup_token uuid,
  cleanup_lease_until timestamptz,
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
  verified_at timestamptz,
  cleanup_after timestamptz,
  check (staging_path = 'staging/' || owner_id::text || '/' || id::text),
  check (verified_path = 'verified/' || owner_id::text || '/' || id::text),
  check (declared_type not like 'image/%' or declared_size <= 5242880),
  check (bucket_id = case when declared_type like 'image/%' then 'feedback-media-images' else 'feedback-media-videos' end),
  check (post_id is null or post_id = draft_id),
  check (state <> 'verified' or verified_object_id is not null and verified_sha256 is not null and verified_at is not null),
  check (state <> 'verified' or (declared_type like 'video/%') = (verified_duration is not null)),
  check ((state = 'validating' and validation_token is not null and validation_lease_until is not null)
      or (state <> 'validating' and validation_token is null and validation_lease_until is null)),
  check ((state = 'cleaning' and cleanup_token is not null and cleanup_lease_until is not null)
      or (state <> 'cleaning' and cleanup_token is null and cleanup_lease_until is null)),
  check (review_state = 'pending' or post_id is not null)
);
create index feedback_media_owner_active on public.feedback_media_uploads(owner_id, created_at)
  where state <> 'cleaned';
create index feedback_media_draft on public.feedback_media_uploads(owner_id, draft_id)
  where state <> 'cleaned';
alter table public.feedback_media_uploads enable row level security;
revoke all on public.feedback_media_uploads from public, anon, authenticated, service_role;

-- The policy reveals only whether this exact generated staging key is currently
-- writable by its owner. There is deliberately no client SELECT/UPDATE/DELETE
-- policy on this bucket, including for the verified namespace.
create function public.feedback_media_can_upload(p_bucket text, p_path text) returns boolean
language sql volatile security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from public.feedback_media_uploads m
    join public.profiles p on p.id = m.owner_id
    where m.owner_id = auth.uid() and m.bucket_id = p_bucket and m.staging_path = p_path
      and m.state = 'reserved' and m.post_id is null and m.expires_at > clock_timestamp()
      and (p.muted_until is null or p.muted_until <= clock_timestamp())
      and not exists (select 1 from public.user_tags t where t.user_id = m.owner_id and t.tag_key = 'blacklisted')
  );
$$;
revoke all on function public.feedback_media_can_upload(text,text) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_can_upload(text,text) to authenticated;
create policy "feedback media reserved staging insert" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('feedback-media-images', 'feedback-media-videos') and public.feedback_media_can_upload(bucket_id, name));

create function public.feedback_media_reserve(p_id uuid, p_draft_id uuid, p_type text, p_size bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor uuid;
  existing public.feedback_media_uploads;
  draft_images integer;
  draft_videos integer;
  draft_bytes bigint;
  owner_reservation bigint;
begin
  actor := public.feedback_actor(false);
  if p_id is null or p_draft_id is null or p_type is null or p_size is null
     or p_type not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm')
     or p_size <= 0 or p_size > 31457280 or (p_type like 'image/%' and p_size > 5242880) then
    raise exception 'feedback_media_invalid';
  end if;
  select * into existing from public.feedback_media_uploads where id = p_id for update;
  if found then
    if existing.owner_id is distinct from actor or existing.draft_id is distinct from p_draft_id
       or existing.declared_type is distinct from p_type or existing.declared_size is distinct from p_size
       or existing.state not in ('reserved', 'validating', 'verified') or existing.post_id is not null
       or existing.expires_at <= clock_timestamp() then
      raise exception 'feedback_media_conflict';
    end if;
    return jsonb_build_object('id', existing.id, 'state', existing.state, 'bucket', existing.bucket_id, 'staging_path', existing.staging_path);
  end if;
  -- Uploads cannot be attached to an already published post through this API.
  if exists (select 1 from public.feedback_posts where id = p_draft_id) then
    raise exception 'feedback_media_conflict';
  end if;
  if (select count(*) from public.feedback_media_uploads where owner_id = actor and post_id is null and state <> 'cleaned') >= 18 then
    raise exception 'feedback_media_quota';
  end if;
  -- Charge the bucket maximum, not the client's declared size. One staging
  -- object can therefore never reserve one byte and consume 30 MiB of quota.
  -- Verified copies can temporarily double this staging allowance.
  select coalesce(sum(case when bucket_id = 'feedback-media-images' then 5242880 else 31457280 end), 0)
    into owner_reservation from public.feedback_media_uploads where owner_id = actor and post_id is null and state <> 'cleaned';
  if owner_reservation + (case when p_type like 'image/%' then 5242880 else 31457280 end) > 62914560 then
    raise exception 'feedback_media_quota';
  end if;
  select count(*) filter (where declared_type like 'image/%'),
         count(*) filter (where declared_type like 'video/%'), coalesce(sum(declared_size), 0)
    into draft_images, draft_videos, draft_bytes
    from public.feedback_media_uploads
    where owner_id = actor and draft_id = p_draft_id and state <> 'cleaned';
  if (p_type like 'image/%' and draft_images >= 5) or (p_type like 'video/%' and draft_videos >= 1)
     or draft_bytes + p_size > 57671680 then
    raise exception 'feedback_media_quota';
  end if;
  insert into public.feedback_media_uploads
    (id, owner_id, draft_id, bucket_id, staging_path, verified_path, declared_type, declared_size)
  values
    (p_id, actor, p_draft_id, case when p_type like 'image/%' then 'feedback-media-images' else 'feedback-media-videos' end, 'staging/' || actor::text || '/' || p_id::text,
     'verified/' || actor::text || '/' || p_id::text, p_type, p_size)
  returning * into existing;
  return jsonb_build_object('id', existing.id, 'state', existing.state, 'bucket', existing.bucket_id, 'staging_path', existing.staging_path);
end;
$$;
revoke all on function public.feedback_media_reserve(uuid,uuid,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_reserve(uuid,uuid,text,bigint) to authenticated;

create function public.feedback_media_owned(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare media public.feedback_media_uploads;
begin
  if auth.uid() is null then raise exception 'feedback_sign_in'; end if;
  select * into media from public.feedback_media_uploads where id = p_id and owner_id = auth.uid();
  if not found then raise exception 'feedback_media_not_found'; end if;
  return jsonb_build_object('id', media.id, 'draft_id', media.draft_id, 'state', media.state,
    'type', media.declared_type, 'size', media.declared_size, 'bucket', media.bucket_id, 'staging_path', media.staging_path,
    'verified_path', media.verified_path, 'expires_at', media.expires_at, 'post_id', media.post_id);
end;
$$;
revoke all on function public.feedback_media_owned(uuid) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_owned(uuid) to authenticated;

-- Only the trusted verifier may acquire a validation lease. The caller must
-- authenticate the user before passing p_owner; SQL repeats the governance
-- checks and serializes this transition with feedback and cancellation writes.
create function public.feedback_media_begin_validation(p_id uuid, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare media public.feedback_media_uploads; actor public.profiles; token uuid;
begin
  perform pg_advisory_xact_lock(824024);
  select * into actor from public.profiles where id = p_owner for share;
  if not found then raise exception 'feedback_sign_in'; end if;
  if actor.muted_until > clock_timestamp() or exists(select 1 from public.user_tags where user_id = p_owner and tag_key = 'blacklisted') then
    raise exception 'feedback_restricted';
  end if;
  select * into media from public.feedback_media_uploads where id = p_id for update;
  if not found or media.owner_id is distinct from p_owner or media.post_id is not null or media.expires_at <= clock_timestamp() then
    raise exception 'feedback_media_conflict';
  end if;
  if media.state = 'verified' then return jsonb_build_object('id', media.id, 'state', 'verified'); end if;
  if media.state <> 'reserved' and not (media.state = 'validating' and media.validation_lease_until <= clock_timestamp()) then
    raise exception 'feedback_media_conflict';
  end if;
  token := gen_random_uuid();
  update public.feedback_media_uploads set state = 'validating', validation_token = token,
    validation_lease_until = clock_timestamp() + interval '2 minutes' where id = media.id;
  return jsonb_build_object('id', media.id, 'state', 'validating', 'token', token,
    'bucket', media.bucket_id, 'staging_path', media.staging_path, 'verified_path', media.verified_path,
    'type', media.declared_type, 'size', media.declared_size);
end;
$$;
revoke all on function public.feedback_media_begin_validation(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_begin_validation(uuid,uuid) to service_role;

create function public.feedback_media_release_validation(p_id uuid, p_owner uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(824024);
  update public.feedback_media_uploads set state = 'reserved', validation_token = null, validation_lease_until = null
    where id = p_id and owner_id = p_owner and state = 'validating' and validation_token = p_token;
  return found;
end;
$$;
revoke all on function public.feedback_media_release_validation(uuid,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_release_validation(uuid,uuid,uuid) to service_role;

-- Only the trusted verifier may transition state. The service must read and
-- inspect the actual bytes, copy them to the service-only verified path, and
-- pass the resulting digest; Storage metadata is an additional consistency check.
create function public.feedback_media_record_verified(p_id uuid, p_owner uuid, p_token uuid, p_sha256 text, p_duration numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare media public.feedback_media_uploads; stored storage.objects; actor public.profiles;
begin
  perform pg_advisory_xact_lock(824024);
  select * into actor from public.profiles where id = p_owner for share;
  if not found then raise exception 'feedback_sign_in'; end if;
  if actor.muted_until > clock_timestamp() or exists(select 1 from public.user_tags where user_id = p_owner and tag_key = 'blacklisted') then
    raise exception 'feedback_restricted';
  end if;
  select * into media from public.feedback_media_uploads where id = p_id for update;
  if not found or media.owner_id is distinct from p_owner or media.state <> 'validating'
     or media.validation_token is distinct from p_token or media.validation_lease_until <= clock_timestamp()
     or media.post_id is not null or media.expires_at <= clock_timestamp() then raise exception 'feedback_media_conflict'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or (media.declared_type like 'video/%' and (p_duration is null or p_duration <= 0 or p_duration > 120))
     or (media.declared_type like 'image/%' and p_duration is not null) then raise exception 'feedback_media_invalid'; end if;
  select * into stored from storage.objects where bucket_id = media.bucket_id and name = media.verified_path;
  if not found or stored.metadata->>'size' is distinct from media.declared_size::text then raise exception 'feedback_media_object'; end if;
  update public.feedback_media_uploads set state = 'verified', verified_object_id = stored.id,
    verified_sha256 = p_sha256, verified_duration = p_duration, verified_at = clock_timestamp(),
    validation_token = null, validation_lease_until = null where id = media.id;
  return jsonb_build_object('id', media.id, 'state', 'verified');
end;
$$;
revoke all on function public.feedback_media_record_verified(uuid,uuid,uuid,text,numeric) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_record_verified(uuid,uuid,uuid,text,numeric) to service_role;

create function public.feedback_media_cancel(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare actor uuid; media public.feedback_media_uploads;
begin
  actor := public.feedback_actor(false);
  select * into media from public.feedback_media_uploads where id = p_id and owner_id = actor for update;
  if not found then raise exception 'feedback_media_not_found'; end if;
  if media.post_id is not null or media.state not in ('reserved', 'validating', 'verified', 'cleanup_pending') then
    raise exception 'feedback_media_conflict';
  end if;
  if media.state <> 'cleanup_pending' then
    -- A resumable upload started before cancellation can remain valid for 24h.
    -- Cleanup must wait and use the Storage API, never DELETE storage.objects.
    update public.feedback_media_uploads set state = 'cleanup_pending', cleanup_after = clock_timestamp() + interval '27 hours',
      validation_token = null, validation_lease_until = null
      where id = media.id;
  end if;
  return jsonb_build_object('id', media.id, 'state', 'cleanup_pending');
end;
$$;
revoke all on function public.feedback_media_cancel(uuid) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_cancel(uuid) to authenticated;

-- Cleanup is two-phase. The worker claims only unattached files after all
-- signed upload / resumable sessions have expired, deletes both objects using
-- the Storage API, then confirms the result with its short-lived lease token.
create function public.feedback_media_cleanup_claim(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare item public.feedback_media_uploads; token uuid; result jsonb := '[]'::jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'feedback_media_invalid'; end if;
  perform pg_advisory_xact_lock(824024);
  for item in select * from public.feedback_media_uploads
    where post_id is null and (
      (state = 'cleanup_pending' and cleanup_after <= clock_timestamp())
      or (state in ('reserved', 'validating', 'verified') and expires_at + interval '27 hours' <= clock_timestamp())
      or (state = 'cleaning' and cleanup_lease_until <= clock_timestamp())
    ) order by created_at, id for update skip locked limit p_limit
  loop
    token := gen_random_uuid();
    update public.feedback_media_uploads set state = 'cleaning', validation_token = null, validation_lease_until = null,
      cleanup_token = token, cleanup_lease_until = clock_timestamp() + interval '5 minutes', cleanup_attempts = cleanup_attempts + 1
      where id = item.id;
    result := result || jsonb_build_array(jsonb_build_object('id', item.id, 'token', token, 'bucket', item.bucket_id,
      'staging_path', item.staging_path, 'verified_path', item.verified_path));
  end loop;
  return result;
end;
$$;
revoke all on function public.feedback_media_cleanup_claim(integer) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_cleanup_claim(integer) to service_role;

create function public.feedback_media_cleanup_finish(p_id uuid, p_token uuid, p_success boolean) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare item public.feedback_media_uploads;
begin
  if p_id is null or p_token is null or p_success is null then raise exception 'feedback_media_invalid'; end if;
  perform pg_advisory_xact_lock(824024);
  select * into item from public.feedback_media_uploads where id = p_id for update;
  if not found or item.state <> 'cleaning' or item.post_id is not null or item.cleanup_token is distinct from p_token
     or item.cleanup_lease_until <= clock_timestamp() then raise exception 'feedback_media_conflict'; end if;
  if p_success and exists(select 1 from storage.objects where bucket_id = item.bucket_id and name in (item.staging_path, item.verified_path)) then
    raise exception 'feedback_media_object';
  end if;
  update public.feedback_media_uploads set state = case when p_success then 'cleaned' else 'cleanup_pending' end,
    cleanup_after = case when p_success then null else clock_timestamp() + interval '5 minutes' end,
    cleanup_token = null, cleanup_lease_until = null where id = item.id;
  return true;
end;
$$;
revoke all on function public.feedback_media_cleanup_finish(uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.feedback_media_cleanup_finish(uuid,uuid,boolean) to service_role;

commit;
