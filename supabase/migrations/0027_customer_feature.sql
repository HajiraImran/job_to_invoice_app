-- Customer CRM commands (S07, S19, CUS01, CUS02).
-- Forward-only. Do not edit 0001–0026.
-- Commands are SECURITY INVOKER: they use the transaction-local actor and
-- workspace from identity.set_local_tenant_context. A supplied actor id that
-- does not match that context is rejected. There is no workspace_id argument.

set role migrator;

alter table commercial.customers
  add constraint customers_email_pair check ((email is null) = (normalized_email is null));

alter table commercial.customers
  add constraint customers_phone_e164 check (
    phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'
  );

alter table commercial.customers
  add constraint customers_billing_address_check check (
    billing_address_json is null
    or (
      jsonb_typeof(billing_address_json) = 'object'
      and char_length(coalesce(billing_address_json->>'line1', '')) between 1 and 150
      and char_length(coalesce(billing_address_json->>'line2', '')) <= 150
      and char_length(coalesce(billing_address_json->>'city', '')) between 1 and 80
      and coalesce(billing_address_json->>'state', '') ~ '^[A-Z]{2}$'
      and coalesce(billing_address_json->>'postal_code', '') ~ '^[0-9]{5}(-[0-9]{4})?$'
    )
  );

create index customers_normalized_email_idx
  on commercial.customers (workspace_id, normalized_email);

create index jobs_customer_list_idx
  on commercial.jobs (workspace_id, customer_id, updated_at desc, id desc);

create policy customers_delete on commercial.customers
  for delete to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = customers.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create function commercial.customer_actor_workspace(p_actor_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = commercial, identity, pg_temp
as $$
declare
  v_actor uuid;
  v_ws uuid;
  v_setup timestamptz;
begin
  if current_user is distinct from 'api_app' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_actor_id is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  v_actor := identity.current_actor_id();
  v_ws := identity.current_workspace_id();
  if v_actor is null or v_ws is null or p_actor_id is distinct from v_actor then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  select w.setup_completed_at
    into v_setup
  from commercial.workspaces w
  where w.workspace_id = v_ws
    and w.owner_user_id = v_actor;
  if not found then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  if v_setup is null then
    raise exception 'SETUP_INCOMPLETE' using errcode = 'P0003';
  end if;
  if not exists (
    select 1
    from commercial.memberships m
    where m.workspace_id = v_ws
      and m.user_id = v_actor
      and m.status = 'active'
  ) then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  return v_ws;
end;
$$;

create function commercial.create_customer(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_customer_id uuid,
  p_name text,
  p_email text,
  p_normalized_email text,
  p_phone text,
  p_billing_address jsonb,
  p_confirm_duplicate boolean
)
returns table (
  id uuid,
  name text,
  email text,
  phone text,
  billing_address_json jsonb,
  archived_at timestamptz,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  replayed boolean
)
language plpgsql
security invoker
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_existing commercial.idempotency_records%rowtype;
  v_customer commercial.customers%rowtype;
  v_payload jsonb;
begin
  if p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_customer_id is null
    or p_name is null
    or p_confirm_duplicate is null then
    raise exception 'invalid customer' using errcode = '22023';
  end if;
  if (p_email is null) is distinct from (p_normalized_email is null) then
    raise exception 'invalid customer' using errcode = '22023';
  end if;

  v_ws := commercial.customer_actor_workspace(p_actor_id);

  select *
    into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id
    and r.key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_hash is distinct from p_request_hash
      or v_existing.route is distinct from '/v1/customers' then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' and v_existing.response_json is not null then
      return query
        select
          (v_existing.response_json->>'id')::uuid,
          v_existing.response_json->>'name',
          v_existing.response_json->>'email',
          v_existing.response_json->>'phone',
          v_existing.response_json->'billing_address_json',
          (v_existing.response_json->>'archived_at')::timestamptz,
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          true;
      return;
    end if;
  end if;

  if p_normalized_email is not null and p_confirm_duplicate is not true then
    if exists (
      select 1
      from commercial.customers c
      where c.workspace_id = v_ws
        and c.normalized_email = p_normalized_email
    ) then
      raise exception 'DUPLICATE_CUSTOMER_EMAIL' using errcode = 'P0060';
    end if;
  end if;

  insert into commercial.customers (
    workspace_id, id, name, email, normalized_email, phone, billing_address_json
  ) values (
    v_ws, p_customer_id, p_name, p_email, p_normalized_email, p_phone, p_billing_address
  )
  returning * into v_customer;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'customer_created', 'customer', p_customer_id,
    p_request_id, v_customer.version, '{}'::jsonb
  );

  v_payload := jsonb_build_object(
    'id', v_customer.id,
    'name', v_customer.name,
    'email', v_customer.email,
    'phone', v_customer.phone,
    'billing_address_json', v_customer.billing_address_json,
    'archived_at', v_customer.archived_at,
    'version', v_customer.version,
    'created_at', v_customer.created_at,
    'updated_at', v_customer.updated_at
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/customers', p_request_hash, gen_random_uuid(),
      'completed', 201, v_payload, now() + interval '30 days', 'ephemeral'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 201,
          response_json = v_payload,
          route = '/v1/customers'
      where id = v_existing.id;
  end if;

  return query
    select
      v_customer.id,
      v_customer.name,
      v_customer.email,
      v_customer.phone,
      v_customer.billing_address_json,
      v_customer.archived_at,
      v_customer.version,
      v_customer.created_at,
      v_customer.updated_at,
      false;
end;
$$;

create function commercial.update_customer(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_customer_id uuid,
  p_expected_version integer,
  p_set_name boolean,
  p_name text,
  p_set_email boolean,
  p_email text,
  p_normalized_email text,
  p_set_phone boolean,
  p_phone text,
  p_set_address boolean,
  p_billing_address jsonb,
  p_confirm_duplicate boolean
)
returns table (
  id uuid,
  name text,
  email text,
  phone text,
  billing_address_json jsonb,
  archived_at timestamptz,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  replayed boolean
)
language plpgsql
security invoker
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_route text;
  v_existing commercial.idempotency_records%rowtype;
  v_customer commercial.customers%rowtype;
  v_name text;
  v_email text;
  v_normalized text;
  v_phone text;
  v_address jsonb;
  v_payload jsonb;
begin
  v_route := '/v1/customers/' || p_customer_id::text;
  if p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_customer_id is null
    or p_expected_version is null
    or p_set_name is null
    or p_set_email is null
    or p_set_phone is null
    or p_set_address is null
    or p_confirm_duplicate is null then
    raise exception 'invalid customer' using errcode = '22023';
  end if;
  if p_set_name is not true and p_set_email is not true and p_set_phone is not true and p_set_address is not true then
    raise exception 'invalid customer' using errcode = '22023';
  end if;
  if p_set_email and (p_email is null) is distinct from (p_normalized_email is null) then
    raise exception 'invalid customer' using errcode = '22023';
  end if;

  v_ws := commercial.customer_actor_workspace(p_actor_id);

  select *
    into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id
    and r.key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_hash is distinct from p_request_hash
      or v_existing.route is distinct from v_route then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' and v_existing.response_json is not null then
      return query
        select
          (v_existing.response_json->>'id')::uuid,
          v_existing.response_json->>'name',
          v_existing.response_json->>'email',
          v_existing.response_json->>'phone',
          v_existing.response_json->'billing_address_json',
          (v_existing.response_json->>'archived_at')::timestamptz,
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          true;
      return;
    end if;
  end if;

  select * into v_customer
  from commercial.customers c
  where c.workspace_id = v_ws
    and c.id = p_customer_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_customer.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  v_name := case when p_set_name then p_name else v_customer.name end;
  v_email := case when p_set_email then p_email else v_customer.email end;
  v_normalized := case when p_set_email then p_normalized_email else v_customer.normalized_email end;
  v_phone := case when p_set_phone then p_phone else v_customer.phone end;
  v_address := case when p_set_address then p_billing_address else v_customer.billing_address_json end;

  if p_set_email
    and p_normalized_email is not null
    and p_normalized_email is distinct from v_customer.normalized_email
    and p_confirm_duplicate is not true
    and exists (
      select 1
      from commercial.customers c
      where c.workspace_id = v_ws
        and c.normalized_email = p_normalized_email
        and c.id <> p_customer_id
    ) then
    raise exception 'DUPLICATE_CUSTOMER_EMAIL' using errcode = 'P0060';
  end if;

  update commercial.customers c
    set name = v_name,
        email = v_email,
        normalized_email = v_normalized,
        phone = v_phone,
        billing_address_json = v_address,
        version = c.version + 1
    where c.workspace_id = v_ws
      and c.id = p_customer_id
      and c.version = p_expected_version
  returning * into v_customer;
  if not found then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'customer_updated', 'customer', p_customer_id,
    p_request_id, p_expected_version, v_customer.version, '{}'::jsonb
  );

  v_payload := jsonb_build_object(
    'id', v_customer.id,
    'name', v_customer.name,
    'email', v_customer.email,
    'phone', v_customer.phone,
    'billing_address_json', v_customer.billing_address_json,
    'archived_at', v_customer.archived_at,
    'version', v_customer.version,
    'created_at', v_customer.created_at,
    'updated_at', v_customer.updated_at
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, v_route, p_request_hash, gen_random_uuid(),
      'completed', 200, v_payload, now() + interval '30 days', 'ephemeral'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 200,
          response_json = v_payload
      where id = v_existing.id;
  end if;

  return query
    select
      v_customer.id,
      v_customer.name,
      v_customer.email,
      v_customer.phone,
      v_customer.billing_address_json,
      v_customer.archived_at,
      v_customer.version,
      v_customer.created_at,
      v_customer.updated_at,
      false;
end;
$$;

create function commercial.archive_customer(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_customer_id uuid,
  p_archived boolean
)
returns table (
  id uuid,
  name text,
  email text,
  phone text,
  billing_address_json jsonb,
  archived_at timestamptz,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  replayed boolean
)
language plpgsql
security invoker
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_route text;
  v_existing commercial.idempotency_records%rowtype;
  v_customer commercial.customers%rowtype;
  v_changed boolean;
  v_payload jsonb;
begin
  v_route := '/v1/customers/' || p_customer_id::text || '/archive';
  if p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_customer_id is null
    or p_archived is null then
    raise exception 'invalid customer' using errcode = '22023';
  end if;

  v_ws := commercial.customer_actor_workspace(p_actor_id);

  select *
    into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id
    and r.key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_hash is distinct from p_request_hash
      or v_existing.route is distinct from v_route then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' and v_existing.response_json is not null then
      return query
        select
          (v_existing.response_json->>'id')::uuid,
          v_existing.response_json->>'name',
          v_existing.response_json->>'email',
          v_existing.response_json->>'phone',
          v_existing.response_json->'billing_address_json',
          (v_existing.response_json->>'archived_at')::timestamptz,
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          true;
      return;
    end if;
  end if;

  select * into v_customer
  from commercial.customers c
  where c.workspace_id = v_ws
    and c.id = p_customer_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  v_changed := (v_customer.archived_at is not null) is distinct from p_archived;
  if v_changed then
    update commercial.customers c
      set archived_at = case when p_archived then coalesce(c.archived_at, now()) else null end,
          version = c.version + 1
      where c.workspace_id = v_ws
        and c.id = p_customer_id
    returning * into v_customer;

    insert into commercial.audit_events (
      workspace_id, actor_type, actor_id, action, entity_type, entity_id,
      request_id, after_version, safe_metadata_json
    ) values (
      v_ws, 'owner', p_actor_id,
      case when p_archived then 'customer_archived' else 'customer_restored' end,
      'customer', p_customer_id, p_request_id, v_customer.version, '{}'::jsonb
    );
  end if;

  v_payload := jsonb_build_object(
    'id', v_customer.id,
    'name', v_customer.name,
    'email', v_customer.email,
    'phone', v_customer.phone,
    'billing_address_json', v_customer.billing_address_json,
    'archived_at', v_customer.archived_at,
    'version', v_customer.version,
    'created_at', v_customer.created_at,
    'updated_at', v_customer.updated_at
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, v_route, p_request_hash, gen_random_uuid(),
      'completed', 200, v_payload, now() + interval '30 days', 'ephemeral'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 200,
          response_json = v_payload
      where id = v_existing.id;
  end if;

  return query
    select
      v_customer.id,
      v_customer.name,
      v_customer.email,
      v_customer.phone,
      v_customer.billing_address_json,
      v_customer.archived_at,
      v_customer.version,
      v_customer.created_at,
      v_customer.updated_at,
      false;
end;
$$;

create function commercial.delete_customer(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_customer_id uuid
)
returns table (
  deleted boolean,
  replayed boolean
)
language plpgsql
security invoker
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_route text;
  v_existing commercial.idempotency_records%rowtype;
  v_customer commercial.customers%rowtype;
begin
  v_route := '/v1/customers/' || p_customer_id::text;
  if p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_customer_id is null then
    raise exception 'invalid customer' using errcode = '22023';
  end if;

  v_ws := commercial.customer_actor_workspace(p_actor_id);

  select *
    into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id
    and r.key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_hash is distinct from p_request_hash
      or v_existing.route is distinct from v_route then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' and v_existing.response_json is not null then
      return query select true, true;
      return;
    end if;
  end if;

  select * into v_customer
  from commercial.customers c
  where c.workspace_id = v_ws
    and c.id = p_customer_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  if exists (
    select 1
    from commercial.jobs j
    where j.workspace_id = v_ws
      and j.customer_id = p_customer_id
  ) then
    raise exception 'CUSTOMER_REFERENCED' using errcode = 'P0061';
  end if;

  delete from commercial.customers c
  where c.workspace_id = v_ws
    and c.id = p_customer_id;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'customer_deleted', 'customer', p_customer_id,
    p_request_id, v_customer.version, '{}'::jsonb
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, v_route, p_request_hash, gen_random_uuid(),
      'completed', 200, jsonb_build_object('deleted', true), now() + interval '30 days', 'ephemeral'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 200,
          response_json = jsonb_build_object('deleted', true)
      where id = v_existing.id;
  end if;

  return query select true, false;
end;
$$;

create function commercial.create_job_for_customer(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid,
  p_customer_id uuid,
  p_title text,
  p_site_address jsonb,
  p_no_site boolean,
  p_internal_notes text,
  p_mode text,
  p_related_job_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  customer_id uuid,
  customer_name text,
  title text,
  site_address_json jsonb,
  no_site boolean,
  lifecycle text,
  mode text,
  internal_notes text,
  related_job_id uuid,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  replayed boolean
)
language plpgsql
security invoker
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_alias uuid;
  v_existing commercial.idempotency_records%rowtype;
  v_customer commercial.customers%rowtype;
  v_related commercial.jobs%rowtype;
  v_notes text;
  v_payload jsonb;
  v_analytics_mode text;
  v_job commercial.jobs%rowtype;
begin
  if p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_job_id is null
    or p_customer_id is null
    or p_title is null
    or p_no_site is null
    or p_mode is null then
    raise exception 'invalid job create' using errcode = '22023';
  end if;
  if p_mode not in ('quote', 'direct_invoice') then
    raise exception 'invalid job mode' using errcode = '23514';
  end if;
  if p_related_job_id is not null and p_related_job_id = p_job_id then
    raise exception 'RELATED_JOB_UNAVAILABLE' using errcode = 'P0054';
  end if;

  v_ws := commercial.customer_actor_workspace(p_actor_id);

  select u.analytics_alias_id
    into v_alias
  from identity.app_users u
  where u.id = p_actor_id;

  select *
    into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id
    and r.key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_hash is distinct from p_request_hash
      or v_existing.route is distinct from '/v1/jobs' then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' and v_existing.response_json is not null then
      return query
        select
          (v_existing.response_json->>'id')::uuid,
          (v_existing.response_json->>'workspace_id')::uuid,
          (v_existing.response_json->>'customer_id')::uuid,
          v_existing.response_json->>'customer_name',
          v_existing.response_json->>'title',
          v_existing.response_json->'site_address_json',
          (v_existing.response_json->>'no_site')::boolean,
          v_existing.response_json->>'lifecycle',
          v_existing.response_json->>'mode',
          v_existing.response_json->>'internal_notes',
          (v_existing.response_json->>'related_job_id')::uuid,
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          true;
      return;
    end if;
  end if;

  select * into v_customer
  from commercial.customers c
  where c.workspace_id = v_ws
    and c.id = p_customer_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_customer.archived_at is not null then
    raise exception 'CUSTOMER_ARCHIVED' using errcode = 'P0062';
  end if;

  if p_related_job_id is not null then
    select * into v_related
    from commercial.jobs j
    where j.workspace_id = v_ws
      and j.id = p_related_job_id
    for update;
    if not found or v_related.lifecycle is distinct from 'canceled' then
      raise exception 'RELATED_JOB_UNAVAILABLE' using errcode = 'P0054';
    end if;
  end if;

  v_notes := coalesce(p_internal_notes, '');
  insert into commercial.jobs (
    workspace_id, id, customer_id, title, site_address_json, no_site,
    lifecycle, internal_notes, mode, related_job_id
  ) values (
    v_ws, p_job_id, p_customer_id, p_title, p_site_address, p_no_site,
    'draft', v_notes, p_mode, p_related_job_id
  )
  returning * into v_job;

  v_analytics_mode := case when p_mode = 'direct_invoice' then 'direct' else 'quote' end;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'job_created', 'job', p_job_id,
    p_request_id, v_job.version,
    jsonb_build_object('mode', v_analytics_mode, 'linked', (p_related_job_id is not null))
  );

  insert into commercial.analytics_events (
    workspace_id, event_id, event_name, schema_version, occurred_at,
    pseudonymous_owner_id, job_id, safe_properties_json
  ) values (
    v_ws, gen_random_uuid(), 'job_created', 1, now(), v_alias, p_job_id,
    jsonb_build_object('mode', v_analytics_mode)
  );

  v_payload := jsonb_build_object(
    'id', v_job.id,
    'workspace_id', v_job.workspace_id,
    'customer_id', v_job.customer_id,
    'customer_name', v_customer.name,
    'title', v_job.title,
    'site_address_json', v_job.site_address_json,
    'no_site', v_job.no_site,
    'lifecycle', v_job.lifecycle,
    'mode', v_job.mode,
    'internal_notes', v_job.internal_notes,
    'related_job_id', v_job.related_job_id,
    'version', v_job.version,
    'created_at', v_job.created_at,
    'updated_at', v_job.updated_at
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/jobs', p_request_hash, gen_random_uuid(),
      'completed', 200, v_payload, now() + interval '30 days', 'ephemeral'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 200,
          response_json = v_payload
      where id = v_existing.id;
  end if;

  return query
    select
      v_job.id,
      v_job.workspace_id,
      v_job.customer_id,
      v_customer.name,
      v_job.title,
      v_job.site_address_json,
      v_job.no_site,
      v_job.lifecycle,
      v_job.mode,
      v_job.internal_notes,
      v_job.related_job_id,
      v_job.version,
      v_job.created_at,
      v_job.updated_at,
      false;
end;
$$;

comment on function commercial.customer_actor_workspace(uuid) is
  'Resolves the workspace from transaction-local identity. Rejects a mismatched actor id. No workspace argument.';
comment on function commercial.create_customer(uuid, uuid, text, uuid, uuid, text, text, text, text, jsonb, boolean) is
  'Creates a customer in the transaction-local workspace. Duplicate email without confirmation raises P0060 and stores nothing.';
comment on function commercial.archive_customer(uuid, uuid, text, uuid, uuid, boolean) is
  'Archive or restore. No If-Match. Version increments only when archived_at changes.';
comment on function commercial.delete_customer(uuid, uuid, text, uuid, uuid) is
  'Deletes an unreferenced customer. A job reference raises P0061 and stores nothing.';
comment on function commercial.create_job_for_customer(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, boolean, text, text, uuid) is
  'Creates a draft job for an active customer. Does not insert a customer. Archived customers raise P0062.';

revoke all on function commercial.customer_actor_workspace(uuid) from public;
grant execute on function commercial.customer_actor_workspace(uuid) to api_app;
revoke all on function commercial.customer_actor_workspace(uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.create_customer(uuid, uuid, text, uuid, uuid, text, text, text, text, jsonb, boolean) from public;
grant execute on function commercial.create_customer(uuid, uuid, text, uuid, uuid, text, text, text, text, jsonb, boolean) to api_app;
revoke all on function commercial.create_customer(uuid, uuid, text, uuid, uuid, text, text, text, text, jsonb, boolean)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.update_customer(uuid, uuid, text, uuid, uuid, integer, boolean, text, boolean, text, text, boolean, text, boolean, jsonb, boolean) from public;
grant execute on function commercial.update_customer(uuid, uuid, text, uuid, uuid, integer, boolean, text, boolean, text, text, boolean, text, boolean, jsonb, boolean) to api_app;
revoke all on function commercial.update_customer(uuid, uuid, text, uuid, uuid, integer, boolean, text, boolean, text, text, boolean, text, boolean, jsonb, boolean)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.archive_customer(uuid, uuid, text, uuid, uuid, boolean) from public;
grant execute on function commercial.archive_customer(uuid, uuid, text, uuid, uuid, boolean) to api_app;
revoke all on function commercial.archive_customer(uuid, uuid, text, uuid, uuid, boolean)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.delete_customer(uuid, uuid, text, uuid, uuid) from public;
grant execute on function commercial.delete_customer(uuid, uuid, text, uuid, uuid) to api_app;
revoke all on function commercial.delete_customer(uuid, uuid, text, uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.create_job_for_customer(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, boolean, text, text, uuid) from public;
grant execute on function commercial.create_job_for_customer(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, boolean, text, text, uuid) to api_app;
revoke all on function commercial.create_job_for_customer(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, boolean, text, text, uuid)
  from worker_app, purge_app, anon, authenticated;

grant delete on commercial.customers to api_app;

reset role;
