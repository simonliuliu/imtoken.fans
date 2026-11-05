-- ADM-02: serialize activity writes with changes to the blacklist.
-- Apply only after the independently deployed 0032 and 0033 migrations.
-- Existing profile, tag, activity, prize, XP, ticket and audit rows are retained.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception '0034_requires_database_owner';
  end if;
  if to_regclass('public.forum_feedback_jobs') is null
     or not exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = 'public.submissions'::regclass
         and attname = 'moderation_revision' and not attisdropped
     )
     or to_regprocedure('public.perform_checkin(uuid)') is null
     or to_regprocedure('public.perform_lottery_draw(uuid)') is null then
    raise exception '0034_requires_complete_0032_and_0033';
  end if;
  -- The guard depends on every successful legacy RPC writing its ledger.
  -- Stop on definition drift instead of assuming an unknown RPC still does so.
  if md5(pg_catalog.pg_get_functiondef('public.perform_checkin(uuid)'::regprocedure))
       is distinct from 'b40bcfc698adca7cb13edc0f83cc4f83'
     or md5(pg_catalog.pg_get_functiondef('public.perform_lottery_draw(uuid)'::regprocedure))
       is distinct from '822463bec87a1594c794075c14dd925e' then
    raise exception '0034_activity_function_drift_requires_inspection';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class c cross join pg_catalog.pg_roles r
    where c.oid in ('public.profiles'::regclass, 'public.user_tags'::regclass,
                    'public.checkins'::regclass, 'public.lottery_draws'::regclass)
      and r.rolname in ('anon', 'authenticated', 'service_role')
      and pg_catalog.pg_has_role(r.oid, c.relowner, 'MEMBER')
  ) then
    raise exception '0034_application_role_can_assume_table_owner';
  end if;
  -- An earlier BEFORE INSERT trigger could suppress a ledger row before our
  -- guard runs; any unknown trigger on these tables requires investigation.
  if exists (
    select 1 from pg_catalog.pg_trigger t
    where not t.tgisinternal
      and t.tgrelid in ('public.profiles'::regclass, 'public.user_tags'::regclass,
                        'public.checkins'::regclass, 'public.lottery_draws'::regclass)
  ) then
    raise exception '0034_unreviewed_guarded_table_trigger';
  end if;
  -- A pre-existing SECURITY DEFINER writer could retain owner access after the
  -- service-role table revoke. Stop on unreviewed direct references. This is
  -- only one gate: dynamic or indirect dependencies still require preflight.
  if exists (
    with tag_definitions as materialized (
      select p.oid, n.nspname,
        case when p.prokind in ('f', 'p') then pg_catalog.pg_get_functiondef(p.oid) end as definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
    )
    select 1 from tag_definitions d
    where d.definition ~* 'user_tags'
      and not coalesce((
        d.nspname = 'public' and (
          (d.oid = to_regprocedure('public.community_actor(uuid)')
            and md5(d.definition) = '5561604d64a55d2df3226adf8cbf84b0')
          or (d.oid = to_regprocedure('public.feedback_actor(boolean)')
            and md5(d.definition) = '4c025728f878357d3772a5cc5402661a')
        )
      ), false)
  ) then
    raise exception '0034_unreviewed_tag_security_definer';
  end if;
  if to_regclass('public.activity_restriction_guard') is not null
     or exists (
       select 1 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('activity_restriction_touch', 'activity_restriction_enforce', 'admin_set_user_tag')
     ) then
    raise exception '0034_existing_object_requires_inspection';
  end if;
end;
$$;

lock table public.profiles, public.user_tags, public.checkins, public.lottery_draws
  in share row exclusive mode;

-- Private per-user version: changing the same row makes a stale REPEATABLE READ
-- transaction fail with 40001 instead of seeing an obsolete blacklist snapshot.
create table public.activity_restriction_guard (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  revision bigint not null default 0
);
alter table public.activity_restriction_guard enable row level security;
revoke all on public.activity_restriction_guard from public, anon, authenticated, service_role;

create function public.activity_restriction_touch(p_user_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform 1 from public.profiles where id = p_user_id for no key update;
  if not found then raise exception 'activity_profile_missing'; end if;
  insert into public.activity_restriction_guard(user_id, revision) values (p_user_id, 1)
  on conflict (user_id) do update
    set revision = public.activity_restriction_guard.revision + 1;
end;
$$;
revoke all on function public.activity_restriction_touch(uuid) from public, anon, authenticated, service_role;

-- Both legacy activity functions lock the profile and insert a ledger row on
-- every successful path. An exception here rolls the entire function back,
-- including any earlier lottery inventory, ticket, XP or badge writes.
create function public.activity_restriction_enforce() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform public.activity_restriction_touch(new.user_id);
  if exists (
    select 1 from public.user_tags where user_id = new.user_id and tag_key = 'blacklisted'
  ) then
    raise exception 'activity_restricted' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.activity_restriction_enforce() from public, anon, authenticated, service_role;
create trigger activity_restriction_checkin before insert on public.checkins
  for each row execute function public.activity_restriction_enforce();
create trigger activity_restriction_lottery before insert on public.lottery_draws
  for each row execute function public.activity_restriction_enforce();

-- The only application tag writer goes through this service-only transaction.
-- Lock both involved profiles in stable UUID order before the guard or tag row.
create function public.admin_set_user_tag(
  p_actor uuid, p_user_id uuid, p_tag_key text, p_on boolean
) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_role text;
  v_permissions jsonb;
begin
  if p_actor is null or p_user_id is null or p_on is null
     or p_tag_key is null or p_tag_key not in ('vip', 'verified', 'blacklisted') then
    raise exception 'tag_invalid';
  end if;

  perform id from public.profiles
    where id = any (array[p_actor, p_user_id]) order by id for no key update;
  select role::text, permissions into v_role, v_permissions
    from public.profiles where id = p_actor;
  if not found or not (
    v_role = 'admin' or (v_role = 'member' and v_permissions @> '{"manage_user_tags":true}'::jsonb)
  ) then
    raise exception 'tag_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'tag_target_not_found';
  end if;

  if p_tag_key = 'blacklisted' then
    perform public.activity_restriction_touch(p_user_id);
  end if;
  if p_on then
    insert into public.user_tags(user_id, tag_key, set_by)
      values (p_user_id, p_tag_key, p_actor)
      on conflict (user_id, tag_key) do update set set_by = excluded.set_by;
  else
    delete from public.user_tags where user_id = p_user_id and tag_key = p_tag_key;
  end if;
  insert into public.admin_logs(admin_id, action, target_type, target_id)
    values (p_actor, case when p_on then 'tag_added_' else 'tag_removed_' end || p_tag_key, 'profile', p_user_id);
end;
$$;
revoke all on function public.admin_set_user_tag(uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_user_tag(uuid, uuid, text, boolean) to service_role;

-- Do not leave an application role a second, unordered direct write path.
-- Existing SELECT privileges remain untouched. Column grants are distinct from
-- table grants and must also be removed; inherited grants cause a safe abort.
revoke insert, update, delete, truncate, trigger on public.user_tags from public, anon, authenticated, service_role;
do $$
declare v_column text;
begin
  for v_column in
    select attname from pg_catalog.pg_attribute
    where attrelid = 'public.user_tags'::regclass and attnum > 0 and not attisdropped
  loop
    execute format('revoke insert (%I), update (%I) on public.user_tags from public, anon, authenticated, service_role', v_column, v_column);
  end loop;
end;
$$;

do $$
declare v_role text;
begin
  -- Default privileges can grant newly created objects to roles other than the
  -- three application roles. Do not silently widen access or alter those roles.
  if exists (
    select 1 from pg_catalog.pg_class c,
      lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    where c.oid = 'public.activity_restriction_guard'::regclass
      and a.grantee <> c.relowner
  ) then
    raise exception '0034_unexpected_guard_grant';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p,
      lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid in (
      'public.activity_restriction_touch(uuid)'::regprocedure,
      'public.activity_restriction_enforce()'::regprocedure,
      'public.admin_set_user_tag(uuid,uuid,text,boolean)'::regprocedure
    )
      and a.privilege_type = 'EXECUTE'
      and a.grantee <> p.proowner
      and not (p.oid = 'public.admin_set_user_tag(uuid,uuid,text,boolean)'::regprocedure
               and a.grantee = 'service_role'::regrole)
  ) then
    raise exception '0034_unexpected_function_grant';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(v_role, 'public.user_tags', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
       or has_any_column_privilege(v_role, 'public.user_tags', 'INSERT, UPDATE')
       or has_table_privilege(v_role, 'public.activity_restriction_guard', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or has_function_privilege(v_role, 'public.activity_restriction_touch(uuid)', 'EXECUTE')
       or has_function_privilege(v_role, 'public.activity_restriction_enforce()', 'EXECUTE') then
      raise exception '0034_unexpected_effective_privilege: %', v_role;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.admin_set_user_tag(uuid,uuid,text,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.admin_set_user_tag(uuid,uuid,text,boolean)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.admin_set_user_tag(uuid,uuid,text,boolean)', 'EXECUTE') then
    raise exception '0034_rpc_privileges_invalid';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
