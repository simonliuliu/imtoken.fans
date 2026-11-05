-- Read-only preflight for candidate 0034. Confirm the intended Supabase project
-- independently before running. Do not output user rows, tokens or credentials.
begin read only;

select current_database() as database_name, current_user as execution_role,
       version() as database_version;

select
  to_regclass('public.forum_feedback_jobs') is not null as forum_queue_exists,
  exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.submissions'::regclass
      and attname = 'moderation_revision' and not attisdropped
  ) as moderation_revision_exists,
  to_regclass('public.activity_restriction_guard') is null as guard_name_available,
  not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('activity_restriction_touch', 'activity_restriction_enforce', 'admin_set_user_tag')
  ) as function_names_available;

-- Compare both definition hashes and contracts with the audited 0016/0017
-- baseline; unknown functions/dependencies require review before any DDL.
select p.oid::regprocedure::text as function_name,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       pg_get_function_result(p.oid) as result_contract,
       md5(pg_get_functiondef(p.oid)) as definition_fingerprint,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
from pg_catalog.pg_proc p
where p.oid in (to_regprocedure('public.perform_checkin(uuid)'),
                to_regprocedure('public.perform_lottery_draw(uuid)'))
order by function_name;

-- Record effective rights including inherited and column-level grants. Any
-- unknown application writer must be resolved before activating the migration.
select r.rolname,
       has_table_privilege(r.oid, 'public.user_tags', 'SELECT') as can_select,
       has_table_privilege(r.oid, 'public.user_tags', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') as table_write_or_trigger,
       has_any_column_privilege(r.oid, 'public.user_tags', 'INSERT, UPDATE') as column_write,
       r.rolsuper as is_superuser
from pg_catalog.pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
   or r.rolcanlogin
order by r.rolname;

-- Preserve the exact table and column ACL metadata for the rollback plan.
select pg_get_userbyid(c.relowner) as owner, c.relacl::text as table_acl
from pg_catalog.pg_class c where c.oid = 'public.user_tags'::regclass;
select a.attname, a.attacl::text as column_acl
from pg_catalog.pg_attribute a
where a.attrelid = 'public.user_tags'::regclass and a.attnum > 0
  and not a.attisdropped and a.attacl is not null
order by a.attnum;
select member.rolname as member_role, granted.rolname as inherited_role
from pg_catalog.pg_auth_members m
join pg_catalog.pg_roles member on member.oid = m.member
join pg_catalog.pg_roles granted on granted.oid = m.roleid
where member.rolname in ('anon', 'authenticated', 'service_role')
   or granted.rolname = 'service_role'
order by member.rolname, granted.rolname;

select t.tgrelid::regclass::text as table_name, t.tgname, t.tgenabled,
       md5(pg_get_triggerdef(t.oid)) as definition_fingerprint
from pg_catalog.pg_trigger t
where not t.tgisinternal and t.tgrelid in (
  'public.profiles'::regclass, 'public.user_tags'::regclass,
  'public.checkins'::regclass, 'public.lottery_draws'::regclass
)
order by table_name, t.tgname;

-- Aggregate counts are only a change detector, not a backup.
select (select count(*) from public.profiles) as profiles,
       (select count(*) from public.user_tags) as user_tags,
       (select count(*) from public.checkins) as checkins,
       (select count(*) from public.lottery_draws) as lottery_draws,
       (select count(*) from public.xp_events) as xp_events,
       (select count(*) from public.lottery_ticket_events) as ticket_events,
       (select count(*) from public.admin_logs) as admin_logs;

commit;
