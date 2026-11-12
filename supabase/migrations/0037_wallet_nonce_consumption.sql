-- Independent of the feedback/moderation/media migrations. Apply only after
-- target-database preflight and a reviewed deployment/rollback procedure.
begin;

create table public.wallet_sign_in_nonce_claims (
  nonce_key text primary key check (nonce_key ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index wallet_sign_in_nonce_claims_claimed_at_idx
  on public.wallet_sign_in_nonce_claims (claimed_at, nonce_key);

alter table public.wallet_sign_in_nonce_claims enable row level security;
revoke all on table public.wallet_sign_in_nonce_claims from public, anon, authenticated, service_role;

create function public.consume_wallet_sign_in_nonce(p_nonce_key text, p_issued_at_ms bigint)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_now_ms bigint;
  v_inserted integer;
begin
  if p_nonce_key is null or p_nonce_key !~ '^[0-9a-f]{64}$' or p_issued_at_ms is null then
    raise exception 'invalid nonce claim' using errcode = '22023';
  end if;

  v_now_ms := pg_catalog.floor(extract(epoch from v_now) * 1000)::bigint;
  -- The application accepts five minutes of age and five minutes of future
  -- clock skew. This independent bound also rejects delayed database calls.
  if p_issued_at_ms < v_now_ms - 15 * 60 * 1000
     or p_issued_at_ms > v_now_ms + 10 * 60 * 1000 then
    return false;
  end if;

  insert into public.wallet_sign_in_nonce_claims (nonce_key, claimed_at)
    values (p_nonce_key, v_now)
    on conflict (nonce_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 1 then
    return false;
  end if;

  -- Retain claims well past the validity window. Limit each cleanup so one
  -- login cannot trigger an unbounded deletion or remove live claims.
  delete from public.wallet_sign_in_nonce_claims as spent
    where spent.nonce_key in (
      select old.nonce_key
      from public.wallet_sign_in_nonce_claims as old
      where old.claimed_at < v_now - interval '48 hours'
      order by old.claimed_at, old.nonce_key
      limit 64
      for update skip locked
    );

  return true;
end;
$$;

revoke all on function public.consume_wallet_sign_in_nonce(text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_wallet_sign_in_nonce(text, bigint) to service_role;

-- Abort rather than inherit unexpected default grants on the new objects.
do $$
declare
  v_table oid := 'public.wallet_sign_in_nonce_claims'::regclass;
  v_function oid := 'public.consume_wallet_sign_in_nonce(text,bigint)'::regprocedure;
  v_service oid := (select oid from pg_catalog.pg_roles where rolname = 'service_role');
begin
  if exists (
    select 1
    from pg_catalog.pg_class c,
      lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    where c.oid = v_table and a.grantee <> c.relowner
  ) then
    raise exception 'unexpected wallet nonce table grant';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class c
      join pg_catalog.pg_attribute col on col.attrelid = c.oid,
      lateral pg_catalog.aclexplode(col.attacl) a
    where c.oid = v_table and col.attnum > 0 and not col.attisdropped
      and a.grantee <> c.relowner
  ) then
    raise exception 'unexpected wallet nonce column grant';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p,
      lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = v_function and a.grantee not in (p.proowner, v_service)
  ) then
    raise exception 'unexpected wallet nonce function grant';
  end if;

  if pg_catalog.has_function_privilege('anon', v_function, 'execute')
     or pg_catalog.has_function_privilege('authenticated', v_function, 'execute')
     or not pg_catalog.has_function_privilege('service_role', v_function, 'execute') then
    raise exception 'unexpected wallet nonce function access';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(array['anon', 'authenticated', 'service_role']) as roles(role_name),
      pg_catalog.unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as privileges(privilege_name)
    where pg_catalog.has_table_privilege(role_name, v_table, privilege_name)
  ) then
    raise exception 'unexpected wallet nonce table access';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(array['anon', 'authenticated', 'service_role']) as roles(role_name),
      pg_catalog.unnest(array['select', 'insert', 'update', 'references']) as privileges(privilege_name)
    where pg_catalog.has_any_column_privilege(role_name, v_table, privilege_name)
  ) then
    raise exception 'unexpected wallet nonce column access';
  end if;
end;
$$;

commit;
