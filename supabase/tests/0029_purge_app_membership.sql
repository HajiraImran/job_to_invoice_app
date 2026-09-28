-- Runtime login can assume purge_app only inside a transaction.
-- Unrelated roles have no SET grant. purge_app attributes stay restrictive.

begin;

do $switch$
declare
  v_session text := session_user;
begin
  if not pg_has_role(session_user, 'purge_app', 'set') then
    raise exception 'runtime login cannot set purge_app';
  end if;
  set local role purge_app;
  if current_user <> 'purge_app' then
    raise exception 'current_user did not become purge_app';
  end if;
  if session_user <> v_session then
    raise exception 'session_user changed during set local role';
  end if;
end
$switch$;

rollback;

select
  current_user = session_user
  and current_user <> 'purge_app'
  and pg_has_role(current_user, 'purge_app', 'set')
  and not pg_has_role('api_app', 'purge_app', 'set')
  and not pg_has_role('worker_app', 'purge_app', 'set')
  and not pg_has_role('anon', 'purge_app', 'set')
  and not pg_has_role('authenticated', 'purge_app', 'set')
  and exists (
    select 1
    from pg_auth_members membership
    join pg_roles granted on granted.oid = membership.roleid
    join pg_roles member on member.oid = membership.member
    where granted.rolname = 'purge_app'
      and member.rolname = current_user
      and membership.set_option
      and not membership.inherit_option
      and not membership.admin_option
  )
  and not exists (
    select 1
    from pg_auth_members membership
    join pg_roles granted on granted.oid = membership.roleid
    join pg_roles member on member.oid = membership.member
    where granted.rolname = 'purge_app'
      and member.rolname in ('authenticated', 'anon', 'api_app', 'worker_app')
  )
  and exists (
    select 1
    from pg_roles
    where rolname = 'purge_app'
      and not rolcanlogin
      and not rolsuper
      and not rolbypassrls
      and not rolcreatedb
      and not rolcreaterole
      and not rolreplication
  )
  as ok;
