-- Customer command privileges, tenant isolation, and FORCE RLS (CUS01 / AUTHZ01 / DB04).

do $probe$
declare
  v_user_a uuid := 'a1111111-1111-4111-8111-111111111111';
  v_user_b uuid := 'b2222222-2222-4222-8222-222222222222';
  v_ws_a uuid := 'a3333333-3333-4333-8333-333333333333';
  v_ws_b uuid := 'b4444444-4444-4444-8444-444444444444';
  v_mem_a uuid := 'a5555555-5555-4555-8555-555555555555';
  v_mem_b uuid := 'b6666666-6666-4666-8666-666666666666';
  v_cus_a uuid := 'a7777777-7777-4777-8777-777777777777';
  v_cus_b uuid := 'b8888888-8888-4888-8888-888888888888';
  v_count integer;
  v_role text;
  v_visible integer;
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'commercial'
      and p.proname in (
        'customer_actor_workspace',
        'create_customer',
        'update_customer',
        'archive_customer',
        'delete_customer',
        'create_job_for_customer'
      )
      and pg_get_function_identity_arguments(p.oid) ilike '%workspace%'
  ) then
    raise exception 'customer commands must not accept a workspace argument';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'commercial'
      and c.relname = 'customers'
      and c.relrowsecurity
      and c.relforcerowsecurity
      and pg_get_userbyid(c.relowner) = 'migrator'
  ) then
    raise exception 'customers FORCE RLS or owner is missing';
  end if;

  insert into identity.app_users (
    id, auth_user_id, normalized_email, display_email, status, last_authenticated_at, terms_version, privacy_version
  ) values
    (v_user_a, v_user_a, 'probe-a@example.com', 'probe-a@example.com', 'active', now(), '2026-01', '2026-01'),
    (v_user_b, v_user_b, 'probe-b@example.com', 'probe-b@example.com', 'active', now(), '2026-01', '2026-01');

  insert into commercial.workspaces (
    workspace_id, id, owner_user_id, business_name, legal_name, contact_name, contact_email,
    address_json, timezone, currency, trade, default_terms, setup_completed_at
  ) values
    (
      v_ws_a, v_ws_a, v_user_a, 'Probe A Business', 'Probe A Legal', 'Owner A', 'probe-a@example.com',
      '{"line1":"1 Main","line2":"","city":"Austin","state":"TX","postal_code":"78701"}'::jsonb,
      'America/Chicago', 'USD', 'handyman', 'Due on receipt.', now()
    ),
    (
      v_ws_b, v_ws_b, v_user_b, 'Probe B Business', 'Probe B Legal', 'Owner B', 'probe-b@example.com',
      '{"line1":"2 Main","line2":"","city":"Austin","state":"TX","postal_code":"78702"}'::jsonb,
      'America/Chicago', 'USD', 'handyman', 'Due on receipt.', now()
    );

  insert into commercial.memberships (workspace_id, id, user_id, role, status) values
    (v_ws_a, v_mem_a, v_user_a, 'owner', 'active'),
    (v_ws_b, v_mem_b, v_user_b, 'owner', 'active');

  insert into commercial.customers (workspace_id, id, name) values
    (v_ws_a, v_cus_a, 'Probe A'),
    (v_ws_b, v_cus_b, 'Probe B');

  set local role api_app;
  perform identity.set_local_tenant_context(v_ws_a, v_user_a);

  select count(*) into v_visible from commercial.customers where id = v_cus_a;
  if v_visible <> 1 then
    raise exception 'owner cannot read own customer';
  end if;
  select count(*) into v_visible from commercial.customers where id = v_cus_b;
  if v_visible <> 0 then
    raise exception 'owner read another workspace customer';
  end if;

  begin
    perform 1 from commercial.update_customer(
      v_user_a, 'c1111111-1111-4111-8111-111111111111'::uuid, 'probe-hash',
      'c2222222-2222-4222-8222-222222222222'::uuid, v_cus_b, 1,
      true, 'Changed', false, null::text, null::text, false, null::text, false, null::jsonb, false
    ) as updated;
    raise exception 'owner mutated another workspace customer';
  exception
    when sqlstate 'P0005' then
      null;
  end;

  begin
    perform 1 from commercial.delete_customer(
      v_user_a, 'c3333333-3333-4333-8333-333333333333'::uuid, 'probe-delete',
      'c4444444-4444-4444-8444-444444444444'::uuid, v_cus_b
    );
    raise exception 'owner deleted another workspace customer';
  exception
    when sqlstate 'P0005' then
      null;
  end;

  update commercial.customers set name = 'Hacked' where id = v_cus_b;
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'direct update crossed tenants';
  end if;

  begin
    perform commercial.customer_actor_workspace(v_user_b);
    raise exception 'mismatched actor id was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  perform identity.set_local_tenant_context(v_ws_b, v_user_a);
  begin
    perform commercial.customer_actor_workspace(v_user_a);
    raise exception 'direct workspace selection was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  perform identity.set_local_tenant_context(v_ws_a, v_user_a);
  select count(*) into v_visible from commercial.customers where id = v_cus_b;
  if v_visible <> 0 then
    raise exception 'FORCE RLS did not hide the other customer';
  end if;
  reset role;

  foreach v_role in array array['worker_app', 'purge_app', 'anon', 'authenticated']
  loop
    execute format('set local role %I', v_role);
    begin
      perform commercial.customer_actor_workspace(v_user_a);
      raise exception '% executed a customer command', v_role;
    exception
      when insufficient_privilege then
        null;
    end;
    begin
      perform 1 from commercial.customers limit 1;
      raise exception '% read customers', v_role;
    exception
      when insufficient_privilege then
        null;
    end;
    reset role;
  end loop;

  delete from commercial.customers where id in (v_cus_a, v_cus_b);
  delete from commercial.memberships where id in (v_mem_a, v_mem_b);
  delete from commercial.workspaces where id in (v_ws_a, v_ws_b);
  delete from identity.app_users where id in (v_user_a, v_user_b);
end
$probe$;

select priv.ok, rls.force_rls, rls.owned_by_migrator, rls.migrator_policy
from (
  select
  has_table_privilege('api_app', 'commercial.customers', 'select')
  and has_table_privilege('api_app', 'commercial.customers', 'insert')
  and has_table_privilege('api_app', 'commercial.customers', 'update')
  and has_table_privilege('api_app', 'commercial.customers', 'delete')
  and not has_table_privilege('api_app', 'commercial.customers', 'truncate')
  and has_function_privilege('api_app', 'commercial.customer_actor_workspace(uuid)', 'execute')
  and has_function_privilege(
    'api_app',
    'commercial.create_customer(uuid, uuid, text, uuid, uuid, text, text, text, text, jsonb, boolean)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.update_customer(uuid, uuid, text, uuid, uuid, integer, boolean, text, boolean, text, text, boolean, text, boolean, jsonb, boolean)',
    'execute'
  )
  and has_function_privilege('api_app', 'commercial.archive_customer(uuid, uuid, text, uuid, uuid, boolean)', 'execute')
  and has_function_privilege('api_app', 'commercial.delete_customer(uuid, uuid, text, uuid, uuid)', 'execute')
  and has_function_privilege(
    'api_app',
    'commercial.create_job_for_customer(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, boolean, text, text, uuid)',
    'execute'
  )
  and not has_table_privilege('anon', 'commercial.customers', 'select')
  and not has_table_privilege('authenticated', 'commercial.customers', 'select')
  and not has_table_privilege('worker_app', 'commercial.customers', 'select')
  and not has_table_privilege('purge_app', 'commercial.customers', 'select')
  and not has_function_privilege('anon', 'commercial.customer_actor_workspace(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'commercial.create_customer(uuid, uuid, text, uuid, uuid, text, text, text, text, jsonb, boolean)', 'execute')
  and not has_function_privilege('worker_app', 'commercial.update_customer(uuid, uuid, text, uuid, uuid, integer, boolean, text, boolean, text, text, boolean, text, boolean, jsonb, boolean)', 'execute')
  and not has_function_privilege('purge_app', 'commercial.archive_customer(uuid, uuid, text, uuid, uuid, boolean)', 'execute')
  and not has_function_privilege('worker_app', 'commercial.delete_customer(uuid, uuid, text, uuid, uuid)', 'execute')
  and not has_function_privilege('purge_app', 'commercial.create_job_for_customer(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, boolean, text, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'commercial.delete_customer(uuid, uuid, text, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'commercial.archive_customer(uuid, uuid, text, uuid, uuid, boolean)', 'execute')
  as ok
) priv
cross join (
  select
  bool_and(c.relrowsecurity and c.relforcerowsecurity) as force_rls,
  bool_and(pg_get_userbyid(c.relowner) = 'migrator') as owned_by_migrator,
  bool_and(exists (
    select 1
    from pg_policy p
    where p.polrelid = c.oid
      and p.polname = n.nspname || '_' || c.relname || '_migrator_all'
      and p.polcmd = '*'
  )) as migrator_policy
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('identity', 'commercial')
  and c.relkind = 'r'
) rls;
