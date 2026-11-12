-- Read-only metadata checks after a controlled 0037 transaction.
-- Compare the function definition and owner with the reviewed migration.
begin read only;

select current_database() as database_name,
       current_user as execution_role,
       clock_timestamp() as database_time;

select to_regclass('public.wallet_sign_in_nonce_claims') is not null as claim_table_exists,
       to_regclass('public.wallet_sign_in_nonce_claims_claimed_at_idx') is not null as cleanup_index_exists,
       to_regprocedure('public.consume_wallet_sign_in_nonce(text,bigint)') is not null as claim_function_exists,
       (select count(*) = 3 from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) as required_roles_exist,
       to_regclass('supabase_migrations.schema_migrations') as migration_history_table,
       case when to_regclass('supabase_migrations.schema_migrations') is null then 'not_present'
            when has_table_privilege(current_user, to_regclass('supabase_migrations.schema_migrations'), 'select') then 'review_0037_history_separately'
            else 'history_unreadable' end as migration_history_followup;

select c.oid::regclass as claim_table,
       pg_get_userbyid(c.relowner) as owner,
       c.relrowsecurity as row_level_security,
       c.relforcerowsecurity as force_row_level_security,
       c.relacl::text as table_acl,
       to_regclass('public.wallet_sign_in_nonce_claims_claimed_at_idx') as cleanup_index
from pg_class c
where c.oid = to_regclass('public.wallet_sign_in_nonce_claims');

select a.attname as column_name,
       format_type(a.atttypid, a.atttypmod) as column_type,
       a.attnotnull as not_null,
       a.attacl::text as column_acl,
       pg_get_expr(d.adbin, d.adrelid) as default_expression
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = to_regclass('public.wallet_sign_in_nonce_claims')
  and a.attnum > 0 and not a.attisdropped
order by a.attnum;

select conname, contype, pg_get_constraintdef(oid) as constraint_definition
from pg_constraint
where conrelid = to_regclass('public.wallet_sign_in_nonce_claims')
order by conname;

select i.indexrelid::regclass as index_name,
       i.indisunique as unique_index,
       i.indisvalid as valid_index,
       pg_get_indexdef(i.indexrelid) as index_definition
from pg_index i
where i.indrelid = to_regclass('public.wallet_sign_in_nonce_claims')
order by i.indexrelid::regclass::text;

select count(*) as unexpected_trigger_count,
       coalesce(array_agg(pg_get_triggerdef(t.oid) order by t.tgname), array[]::text[]) as unexpected_triggers
from pg_trigger t
where t.tgrelid = to_regclass('public.wallet_sign_in_nonce_claims')
  and not t.tgisinternal;

select count(*) as incoming_foreign_key_count,
       coalesce(array_agg(conrelid::regclass::text || ': ' || pg_get_constraintdef(oid) order by conname), array[]::text[]) as incoming_foreign_keys
from pg_constraint
where confrelid = to_regclass('public.wallet_sign_in_nonce_claims');

select p.oid::regprocedure as claim_function,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       p.provolatile as volatility,
       p.proconfig as configuration,
       p.proacl::text as function_acl,
       pg_get_functiondef(p.oid) as function_definition
from pg_proc p
where p.oid = to_regprocedure('public.consume_wallet_sign_in_nonce(text,bigint)');

select c.relowner = p.proowner as matching_owners,
       not exists (
         select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         where a.grantee <> c.relowner
       ) as table_acl_owner_only,
       not exists (
         select 1 from pg_attribute col, lateral aclexplode(col.attacl) a
         where col.attrelid = c.oid and col.attnum > 0 and not col.attisdropped
           and a.grantee <> c.relowner
       ) as column_acl_owner_only,
       exists (select 1 from pg_roles where rolname = 'service_role') and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where a.grantee not in (p.proowner, (select oid from pg_roles where rolname = 'service_role'))
       ) as function_acl_owner_and_service_only
from pg_class c
cross join pg_proc p
where c.oid = to_regclass('public.wallet_sign_in_nonce_claims')
  and p.oid = to_regprocedure('public.consume_wallet_sign_in_nonce(text,bigint)');

select r.rolname,
       has_function_privilege(r.oid, p.oid, 'execute') as can_execute_claim,
       has_table_privilege(r.oid, c.oid, 'select') as can_select_claims,
       has_table_privilege(r.oid, c.oid, 'insert') as can_insert_claims,
       has_table_privilege(r.oid, c.oid, 'update') as can_update_claims,
       has_table_privilege(r.oid, c.oid, 'delete') as can_delete_claims,
       has_any_column_privilege(r.oid, c.oid, 'select') as can_select_any_column,
       has_any_column_privilege(r.oid, c.oid, 'insert') as can_insert_any_column,
       has_any_column_privilege(r.oid, c.oid, 'update') as can_update_any_column,
       has_any_column_privilege(r.oid, c.oid, 'references') as can_reference_any_column
from pg_roles r
cross join pg_class c
cross join pg_proc p
where r.rolname in ('anon', 'authenticated', 'service_role')
  and c.oid = to_regclass('public.wallet_sign_in_nonce_claims')
  and p.oid = to_regprocedure('public.consume_wallet_sign_in_nonce(text,bigint)')
order by r.rolname;

commit;
