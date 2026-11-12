-- Read-only evidence for 0037. Confirm the intended project separately.
-- An empty CLI history is not evidence that an object is absent.
begin read only;

select current_database() as database_name,
       current_user as execution_role,
       session_user as session_role,
       clock_timestamp() as database_time;

select to_regclass('public.wallet_sign_in_nonce_claims') is null as claim_table_absent,
       to_regclass('public.wallet_sign_in_nonce_claims_claimed_at_idx') is null as cleanup_index_absent,
       to_regprocedure('public.consume_wallet_sign_in_nonce(text,bigint)') is null as claim_function_absent,
       (select count(*) = 3 from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) as required_roles_exist,
       to_regclass('supabase_migrations.schema_migrations') as migration_history_table,
       case when to_regclass('supabase_migrations.schema_migrations') is null then 'not_present'
            when has_table_privilege(current_user, to_regclass('supabase_migrations.schema_migrations'), 'select') then 'review_0037_history_separately'
            else 'history_unreadable' end as migration_history_followup,
       has_schema_privilege(current_user, 'public', 'create') as execution_role_can_create,
       has_language_privilege(current_user, 'plpgsql', 'usage') as execution_role_can_use_plpgsql,
       has_schema_privilege((select oid from pg_roles where rolname = 'service_role'), 'public', 'usage') as service_role_can_use_public;

select r.rolname,
       r.rolsuper,
       r.rolbypassrls,
       pg_has_role(r.oid, (select oid from pg_roles where rolname = 'service_role'), 'member') as member_of_service_role
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

-- Review all relevant default grants, including grantees other than the three
-- application roles. The migration itself aborts on unexpected direct grants.
select pg_get_userbyid(d.defaclrole) as owner,
       coalesce(n.nspname, '(global)') as schema_name,
       d.defaclobjtype as object_type,
       d.defaclacl::text as default_acl
from pg_default_acl d
left join pg_namespace n on n.oid = d.defaclnamespace
where d.defaclrole = (select oid from pg_roles where rolname = current_user)
  and (d.defaclnamespace = 0 or n.nspname = 'public')
  and d.defaclobjtype in ('r', 'f')
order by schema_name, object_type;

commit;
