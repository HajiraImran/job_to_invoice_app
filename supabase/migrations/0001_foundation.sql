-- Identity and tenancy foundation. Jobs, quotes, approvals and invoices are later migrations.
-- Runtime roles are nologin; CI/tests SET ROLE from the migration bootstrap user.
-- Hosted Supabase rejects ALTER ROLE. Safe attributes are assigned only at CREATE ROLE.
-- Pre-existing application roles are validated and never repaired (D-010).

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'migrator') then
    create role migrator nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'api_app') then
    create role api_app nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'worker_app') then
    create role worker_app nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'purge_app') then
    create role purge_app nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
end
$roles$;

do $guard$
declare
  v_unsafe text;
begin
  select string_agg(format('%s (%s)', rolname, attrs), '; ' order by rolname)
    into v_unsafe
  from (
    select
      rolname,
      concat_ws(
        ', ',
        case when rolcanlogin then 'LOGIN' end,
        case when rolsuper then 'SUPERUSER' end,
        case when rolcreatedb then 'CREATEDB' end,
        case when rolcreaterole then 'CREATEROLE' end,
        case when rolreplication then 'REPLICATION' end,
        case when rolbypassrls then 'BYPASSRLS' end
      ) as attrs
    from pg_roles
    where rolname in ('migrator', 'api_app', 'worker_app', 'purge_app')
      and (
        rolcanlogin
        or rolsuper
        or rolcreatedb
        or rolcreaterole
        or rolreplication
        or rolbypassrls
      )
  ) unsafe;
  if v_unsafe is not null then
    raise exception 'application role is unsafe (D-010): %', v_unsafe
      using errcode = '42501';
  end if;
end
$guard$;

comment on role migrator is
  'Object owner. Migrations and SECURITY DEFINER only. Safe attributes set at CREATE ROLE only. Bootstrap rejects unsafe pre-existing roles (D-010). FORCE RLS owner access is table-scoped policies. Not a runtime pool.';
comment on role api_app is 'FORCE RLS API runtime. Not owner, not superuser, not BYPASSRLS.';
comment on role worker_app is 'FORCE RLS worker. EXECUTE named functions only. Separate from API.';
comment on role purge_app is 'Scheduled deletion job only. Never in Fastify or outbox pools.';

grant migrator to current_user;
grant api_app to current_user;

create schema if not exists identity authorization migrator;
create schema if not exists commercial authorization migrator;

comment on schema identity is
  'Restricted identity schema (ACC02A). Client grants remain revoked.';
comment on schema commercial is
  'Private commercial schema (ARC02). Client grants remain revoked. FORCE RLS on tenant tables.';

revoke create on schema public from public;
revoke all on schema identity from public;
revoke all on schema commercial from public;
revoke all on schema identity from anon, authenticated;
revoke all on schema commercial from anon, authenticated;

grant usage on schema identity to api_app, worker_app, purge_app;
grant usage on schema commercial to api_app, worker_app, purge_app;
