-- Read-only postflight for candidate 0034. Run only against the independently
-- confirmed target, after controlled activation. Any false result stops release.
-- These checks do not replace the preflight audit of indirect/privileged writers.
begin isolation level repeatable read read only;

with objects as (
  select to_regclass('public.profiles') as profiles,
         to_regclass('public.user_tags') as tags,
         to_regclass('public.checkins') as checkins,
         to_regclass('public.lottery_draws') as draws,
         to_regclass('public.activity_restriction_guard') as guard,
         to_regprocedure('public.activity_restriction_touch(uuid)') as touch,
         to_regprocedure('public.activity_restriction_enforce()') as enforce,
         to_regprocedure('public.admin_set_user_tag(uuid,uuid,text,boolean)') as tag_rpc,
         to_regprocedure('public.perform_checkin(uuid)') as checkin_rpc,
         to_regprocedure('public.perform_lottery_draw(uuid)') as draw_rpc
), checks as (
  select 'guard_table_structure_and_rls' as check_name,
    case when o.guard is null or o.profiles is null then false else
      exists (select 1 from pg_catalog.pg_class c where c.oid=o.guard and c.relkind='r' and c.relrowsecurity)
      and (select count(*)=2 from pg_catalog.pg_attribute a where a.attrelid=o.guard and a.attnum>0 and not a.attisdropped)
      and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid=o.guard and a.attname='user_id'
                  and a.atttypid='uuid'::regtype and a.attnotnull and not a.attisdropped)
      and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid=o.guard and a.attname='revision'
                  and a.atttypid='bigint'::regtype and a.attnotnull and not a.attisdropped)
      and exists (select 1 from pg_catalog.pg_constraint c where c.conrelid=o.guard and c.contype='p'
                  and c.conkey=array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid=o.guard and a.attname='user_id')]::smallint[])
      and exists (select 1 from pg_catalog.pg_constraint c where c.conrelid=o.guard and c.contype='f'
                  and c.confrelid=o.profiles and c.confdeltype='c'
                  and c.conkey=array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid=o.guard and a.attname='user_id')]::smallint[]
                  and c.confkey=array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid=o.profiles and a.attname='id')]::smallint[])
    end as ok from objects o

  union all
  select 'guard_table_acl', case when o.guard is null then false else
    not exists (
      select 1 from pg_catalog.pg_class c,
        lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      where c.oid=o.guard and a.grantee<>c.relowner
    ) and not exists (
      select 1 from pg_catalog.pg_attribute col join pg_catalog.pg_class c on c.oid=col.attrelid,
        lateral pg_catalog.aclexplode(col.attacl) a
      where col.attrelid=o.guard and col.attnum>0 and not col.attisdropped and a.grantee<>c.relowner
    ) and not exists (
      select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role')
        and (has_table_privilege(r.oid,o.guard,'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
             or has_any_column_privilege(r.oid,o.guard,'SELECT, INSERT, UPDATE'))
    ) end from objects o

  union all
  select 'tag_write_acl', case when o.tags is null then false else
    not exists (
      select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role')
        and (has_table_privilege(r.oid,o.tags,'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
             or has_any_column_privilege(r.oid,o.tags,'INSERT, UPDATE'))
    ) end from objects o

  union all
  select 'protected_table_owners', case when o.profiles is null or o.tags is null or o.checkins is null
    or o.draws is null or o.guard is null then false else
    not exists (
      select 1 from pg_catalog.pg_class c cross join pg_catalog.pg_roles r
      where c.oid in (o.profiles,o.tags,o.checkins,o.draws,o.guard)
        and r.rolname in ('anon','authenticated','service_role')
        and pg_catalog.pg_has_role(r.oid,c.relowner,'MEMBER')
    ) end from objects o

  union all
  select 'guard_functions_and_ownership', case when o.guard is null or o.touch is null or o.enforce is null
    or o.tag_rpc is null then false else
    (select count(*)=3 from pg_catalog.pg_proc p join pg_catalog.pg_class c on c.oid=o.guard
      where p.proowner=c.relowner and p.prosecdef and (
        (p.oid=o.touch and md5(pg_get_functiondef(p.oid))='8ff22e947fe145f8164dc64a4204ce2d') or
        (p.oid=o.enforce and md5(pg_get_functiondef(p.oid))='35b473b3fed5212e27f031aa8c5e733b') or
        (p.oid=o.tag_rpc and md5(pg_get_functiondef(p.oid))='8feb22e6c266609474cfcaa5c93d4593')
      )) end from objects o

  union all
  select 'guard_function_acl', case when o.touch is null or o.enforce is null or o.tag_rpc is null then false else
    not exists (
      select 1 from pg_catalog.pg_proc p,
        lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      where p.oid in (o.touch,o.enforce,o.tag_rpc) and a.privilege_type='EXECUTE'
        and a.grantee<>p.proowner
        and not (p.oid=o.tag_rpc and a.grantee='service_role'::regrole)
    ) and not exists (
      select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role')
        and (has_function_privilege(r.oid,o.touch,'EXECUTE') or has_function_privilege(r.oid,o.enforce,'EXECUTE'))
    ) and not has_function_privilege('anon',o.tag_rpc,'EXECUTE')
      and not has_function_privilege('authenticated',o.tag_rpc,'EXECUTE')
      and has_function_privilege('service_role',o.tag_rpc,'EXECUTE') end from objects o

  union all
  select 'activity_triggers', case when o.profiles is null or o.tags is null or o.checkins is null
    or o.draws is null or o.enforce is null then false else
    (select count(*)=2 and coalesce(bool_and(
      t.tgtype=7 and t.tgenabled='O' and t.tgfoid=o.enforce and t.tgqual is null
      and t.tgnargs=0 and t.tgconstraint=0 and (
        (t.tgrelid=o.checkins and t.tgname='activity_restriction_checkin'
          and md5(pg_get_triggerdef(t.oid))='1ac0aaf3b3b6c5093d91390096ba8023') or
        (t.tgrelid=o.draws and t.tgname='activity_restriction_lottery'
          and md5(pg_get_triggerdef(t.oid))='252ed43f11bb7ec84d918d69857745ab')
      )),false) from pg_catalog.pg_trigger t
      where not t.tgisinternal and t.tgrelid in (o.profiles,o.tags,o.checkins,o.draws)) end from objects o

  union all
  select 'legacy_activity_rpc_contract_and_acl', case when o.checkin_rpc is null or o.draw_rpc is null
    or o.guard is null then false else
    (select count(*)=2 from pg_catalog.pg_proc p join pg_catalog.pg_class c on c.oid=o.guard
      where p.proowner=c.relowner and p.prosecdef and (
        (p.oid=o.checkin_rpc and md5(pg_get_functiondef(p.oid))='b40bcfc698adca7cb13edc0f83cc4f83') or
        (p.oid=o.draw_rpc and md5(pg_get_functiondef(p.oid))='822463bec87a1594c794075c14dd925e')))
    and not exists (
      select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated')
        and (has_function_privilege(r.oid,o.checkin_rpc,'EXECUTE') or has_function_privilege(r.oid,o.draw_rpc,'EXECUTE'))
    ) and not exists (
      select 1 from pg_catalog.pg_roles r cross join pg_catalog.pg_proc p
      where r.rolname in ('anon','authenticated','service_role') and p.oid in (o.checkin_rpc,o.draw_rpc)
        and pg_catalog.pg_has_role(r.oid,p.proowner,'MEMBER')
    ) and has_function_privilege('service_role',o.checkin_rpc,'EXECUTE')
      and has_function_privilege('service_role',o.draw_rpc,'EXECUTE') end from objects o

  union all
  select 'direct_tag_security_definers', case when o.enforce is null or o.tag_rpc is null then false else
    not exists (
      with definitions as materialized (
        select p.oid,n.nspname,
          case when p.prokind in ('f','p') then pg_get_functiondef(p.oid) end as definition
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where p.prosecdef and n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      )
      select 1 from definitions d where d.definition ~* 'user_tags' and not coalesce((
        d.nspname='public' and (
          (d.oid=to_regprocedure('public.community_actor(uuid)') and md5(d.definition)='5561604d64a55d2df3226adf8cbf84b0') or
          (d.oid=to_regprocedure('public.feedback_actor(boolean)') and md5(d.definition)='4c025728f878357d3772a5cc5402661a') or
          (d.oid=o.enforce and md5(d.definition)='35b473b3fed5212e27f031aa8c5e733b') or
          (d.oid=o.tag_rpc and md5(d.definition)='8feb22e6c266609474cfcaa5c93d4593')
        )),false)
    ) end from objects o
)
select check_name, coalesce(ok,false) as ok from checks order by check_name;

-- Review effective access for login roles as well as application roles. Trusted
-- owners/superusers may have access; any unexpected role requires investigation.
select r.rolname, r.rolsuper as is_superuser,
       case when c.oid is null then null else pg_has_role(r.oid,c.relowner,'MEMBER') end as can_assume_guard_owner,
       case when c.oid is null then null else has_table_privilege(r.oid,c.oid,'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
         or has_any_column_privilege(r.oid,c.oid,'SELECT, INSERT, UPDATE') end as effective_guard_access,
       case when to_regprocedure('public.admin_set_user_tag(uuid,uuid,text,boolean)') is null then null
         else has_function_privilege(r.oid,to_regprocedure('public.admin_set_user_tag(uuid,uuid,text,boolean)'),'EXECUTE') end as effective_tag_rpc_execute
from pg_catalog.pg_roles r left join pg_catalog.pg_class c on c.oid=to_regclass('public.activity_restriction_guard')
where r.rolcanlogin or r.rolname in ('anon','authenticated','service_role')
order by r.rolname;

-- Compare these metadata and aggregate counts with the saved preflight; counts
-- can legitimately change through concurrent work and are not a backup.
select p.oid::regprocedure::text as function_name, p.oid as function_oid,
       pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
       p.proacl::text as function_acl, md5(pg_get_functiondef(p.oid)) as definition_fingerprint
from pg_catalog.pg_proc p
where p.oid in (to_regprocedure('public.perform_checkin(uuid)'),
                to_regprocedure('public.perform_lottery_draw(uuid)'))
order by function_name;

select r.rolname, has_table_privilege(r.oid,'public.user_tags','SELECT') as can_select
from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role')
order by r.rolname;

select (select count(*) from public.profiles) as profiles,
       (select count(*) from public.user_tags) as user_tags,
       (select count(*) from public.checkins) as checkins,
       (select count(*) from public.lottery_draws) as lottery_draws,
       (select count(*) from public.xp_events) as xp_events,
       (select count(*) from public.lottery_ticket_events) as ticket_events,
       (select count(*) from public.admin_logs) as admin_logs;

commit;
