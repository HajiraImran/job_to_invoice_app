-- Workspace setup completion: constraints, allowances, audit, idempotency, and definer command.
-- GET /me already provisions one empty workspace. POST /v1/workspace completes that row.

set role migrator;

alter table commercial.workspaces
  add constraint workspaces_timezone_format_check
  check (timezone ~ '^[A-Za-z0-9_+\-/]+$' and char_length(timezone) between 1 and 64);

alter table commercial.workspaces
  add constraint workspaces_completed_setup_check check (
    setup_completed_at is null
    or (
      char_length(btrim(business_name)) between 2 and 100
      and char_length(btrim(legal_name)) between 2 and 150
      and char_length(btrim(contact_name)) between 2 and 100
      and char_length(contact_email) between 3 and 254
      and char_length(default_terms) <= 4000
      and currency = 'USD'
      and jsonb_typeof(address_json) = 'object'
      and char_length(coalesce(address_json->>'line1', '')) between 1 and 150
      and char_length(coalesce(address_json->>'line2', '')) <= 150
      and char_length(coalesce(address_json->>'city', '')) between 1 and 80
      and coalesce(address_json->>'state', '') ~ '^[A-Z]{2}$'
      and coalesce(address_json->>'postal_code', '') ~ '^[0-9]{5}(-[0-9]{4})?$'
    )
  );

create or replace function commercial.protect_workspace_server_fields()
returns trigger
language plpgsql
as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'owner_user_id is immutable' using errcode = '23001';
  end if;
  if new.currency is distinct from 'USD' then
    raise exception 'currency must remain USD' using errcode = '23514';
  end if;
  if current_user <> 'migrator' then
    if new.setup_completed_at is distinct from old.setup_completed_at then
      raise exception 'setup_completed_at is server-assigned' using errcode = '23001';
    end if;
  end if;
  return new;
end;
$$;

create trigger workspaces_protect_server_fields
  before update on commercial.workspaces
  for each row
  execute function commercial.protect_workspace_server_fields();

create table commercial.job_allowances (
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  free_jobs_consumed integer not null default 0,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_jobs_consumed integer not null default 0,
  retained_bytes bigint not null default 0,
  constraint job_allowances_pkey primary key (workspace_id),
  constraint job_allowances_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint job_allowances_version_check check (version >= 1),
  constraint job_allowances_free_check check (free_jobs_consumed >= 0),
  constraint job_allowances_trial_check check (trial_jobs_consumed >= 0),
  constraint job_allowances_bytes_check check (retained_bytes >= 0)
);

create table commercial.audit_events (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_type text not null,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  occurred_at timestamptz not null default now(),
  request_id uuid not null,
  before_version integer,
  after_version integer,
  reason text,
  safe_metadata_json jsonb not null default '{}'::jsonb,
  constraint audit_events_pkey primary key (id),
  constraint audit_events_tenant_id_key unique (workspace_id, id),
  constraint audit_events_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint audit_events_actor_type_check check (actor_type in ('owner', 'system'))
);

create table commercial.idempotency_records (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_scope uuid not null,
  key uuid not null,
  route text not null,
  request_hash text not null,
  operation_id uuid not null,
  status text not null,
  response_code integer,
  response_json jsonb,
  expires_at timestamptz,
  permanence text not null,
  constraint idempotency_records_pkey primary key (id),
  constraint idempotency_records_tenant_id_key unique (workspace_id, id),
  constraint idempotency_records_actor_key unique (actor_scope, key),
  constraint idempotency_records_operation_id_key unique (operation_id),
  constraint idempotency_records_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint idempotency_records_status_check check (status in ('pending', 'completed')),
  constraint idempotency_records_permanence_check check (permanence in ('financial', 'ephemeral'))
);

create unique index analytics_events_onboarding_completed_once
  on commercial.analytics_events (workspace_id)
  where event_name = 'onboarding_completed';

alter table commercial.job_allowances enable row level security;
alter table commercial.job_allowances force row level security;
select identity.install_migrator_force_rls_policy('commercial.job_allowances');
alter table commercial.audit_events enable row level security;
alter table commercial.audit_events force row level security;
select identity.install_migrator_force_rls_policy('commercial.audit_events');
alter table commercial.idempotency_records enable row level security;
alter table commercial.idempotency_records force row level security;
select identity.install_migrator_force_rls_policy('commercial.idempotency_records');

create policy job_allowances_select on commercial.job_allowances
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = job_allowances.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy job_allowances_insert on commercial.job_allowances
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = job_allowances.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy job_allowances_update on commercial.job_allowances
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = job_allowances.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (
    workspace_id = identity.current_workspace_id()
  );

create policy audit_events_select on commercial.audit_events
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = audit_events.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy audit_events_insert on commercial.audit_events
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = audit_events.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy idempotency_records_select on commercial.idempotency_records
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = idempotency_records.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy idempotency_records_insert on commercial.idempotency_records
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = idempotency_records.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy idempotency_records_update on commercial.idempotency_records
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = idempotency_records.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (workspace_id = identity.current_workspace_id());

create trigger job_allowances_touch_updated_at
  before update on commercial.job_allowances
  for each row execute function identity.touch_updated_at();

create or replace function commercial.reject_audit_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events are append-only' using errcode = '23001';
end;
$$;

create trigger audit_events_no_update
  before update or delete on commercial.audit_events
  for each row execute function commercial.reject_audit_change();

drop function if exists identity.provision_owner(uuid, text, text);

create function identity.provision_owner(
  p_auth_user_id uuid,
  p_display_email text,
  p_normalized_email text
)
returns table (
  actor_id uuid,
  workspace_id uuid,
  account_status text,
  display_email text,
  setup_completed boolean,
  first_sign_in boolean,
  analytics_alias_id uuid,
  workspace_version integer
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid;
  v_ws uuid;
  v_status text;
  v_email text;
  v_alias uuid;
  v_setup boolean;
  v_first boolean := false;
  v_version integer := 1;
begin
  if p_auth_user_id is null or p_display_email is null or p_normalized_email is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select u.id, u.status, u.display_email, u.analytics_alias_id
    into v_actor, v_status, v_email, v_alias
  from identity.app_users u
  where u.auth_user_id = p_auth_user_id
  for update;

  if v_actor is null then
    begin
      v_actor := gen_random_uuid();
      v_alias := gen_random_uuid();
      insert into identity.app_users (
        id, auth_user_id, normalized_email, display_email, status,
        last_authenticated_at, terms_version, privacy_version, analytics_alias_id
      ) values (
        v_actor, p_auth_user_id, p_normalized_email, p_display_email, 'active',
        now(), '1', '1', v_alias
      );
      v_status := 'active';
      v_email := p_display_email;
      v_first := true;
    exception
      when unique_violation then
        select u.id, u.status, u.display_email, u.analytics_alias_id
          into v_actor, v_status, v_email, v_alias
        from identity.app_users u
        where u.auth_user_id = p_auth_user_id;
        if v_actor is null then
          raise;
        end if;
        v_first := false;
        update identity.app_users
          set last_authenticated_at = now()
          where id = v_actor;
    end;
  else
    update identity.app_users
      set last_authenticated_at = now(),
          display_email = case when status = 'active' then p_display_email else display_email end,
          normalized_email = case when status = 'active' then p_normalized_email else normalized_email end
      where id = v_actor
      returning status, display_email, analytics_alias_id
        into v_status, v_email, v_alias;
  end if;

  select w.id, (w.setup_completed_at is not null), w.version
    into v_ws, v_setup, v_version
  from commercial.workspaces w
  where w.owner_user_id = v_actor
  for update;

  if v_ws is null then
    begin
      v_ws := gen_random_uuid();
      insert into commercial.workspaces (
        workspace_id, id, owner_user_id, business_name, legal_name, contact_name,
        contact_email, timezone, trade, default_terms, setup_completed_at
      ) values (
        v_ws, v_ws, v_actor, '', '', '', p_display_email, 'UTC', 'other', '', null
      );
      insert into commercial.memberships (workspace_id, id, user_id, role, status)
      values (v_ws, gen_random_uuid(), v_actor, 'owner', 'active');
      insert into commercial.job_allowances (workspace_id) values (v_ws);
      v_setup := false;
      v_version := 1;
    exception
      when unique_violation then
        select w.id, (w.setup_completed_at is not null), w.version
          into v_ws, v_setup, v_version
        from commercial.workspaces w
        where w.owner_user_id = v_actor;
        if v_ws is null then
          raise;
        end if;
    end;
  end if;

  insert into commercial.job_allowances (workspace_id)
  values (v_ws)
  on conflict (workspace_id) do nothing;

  if v_first and v_status = 'active' then
    begin
      insert into commercial.analytics_events (
        workspace_id, event_id, event_name, schema_version, occurred_at,
        pseudonymous_owner_id, safe_properties_json
      )
      values (
        v_ws, gen_random_uuid(), 'signup_verified', 1, now(), v_alias,
        jsonb_build_object('acquisition_source', 'unknown')
      );
    exception
      when unique_violation then
        null;
    end;
  end if;

  return query
    select v_actor, v_ws, v_status, v_email, coalesce(v_setup, false), v_first, v_alias, coalesce(v_version, 1);
end;
$$;

comment on function identity.provision_owner(uuid, text, text) is
  'Maps a verified Auth subject to app identity and one workspace. Callers must not pass workspace_id.';

create or replace function commercial.complete_workspace_setup(
  p_actor_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_business_name text,
  p_legal_name text,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text,
  p_address jsonb,
  p_timezone text,
  p_trade text,
  p_default_tax_bp integer,
  p_default_due_days integer,
  p_default_terms text
)
returns table (
  actor_id uuid,
  workspace_id uuid,
  account_status text,
  display_email text,
  setup_completed boolean,
  first_sign_in boolean,
  analytics_alias_id uuid,
  workspace_version integer,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_version integer;
  v_setup timestamptz;
  v_status text;
  v_email text;
  v_alias uuid;
  v_created timestamptz;
  v_existing commercial.idempotency_records%rowtype;
  v_payload jsonb;
  v_duration text;
  v_after integer;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null or p_request_id is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select u.status, u.display_email, u.analytics_alias_id
    into v_status, v_email, v_alias
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.version, w.setup_completed_at, w.created_at
    into v_ws, v_version, v_setup, v_created
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select *
    into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id
    and r.key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_hash is distinct from p_request_hash then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' and v_existing.response_json is not null then
      return query
        select
          (v_existing.response_json->>'actor_id')::uuid,
          (v_existing.response_json->>'workspace_id')::uuid,
          v_existing.response_json->>'account_status',
          v_existing.response_json->>'display_email',
          (v_existing.response_json->>'setup_completed')::boolean,
          false,
          (v_existing.response_json->>'analytics_alias_id')::uuid,
          (v_existing.response_json->>'workspace_version')::integer,
          true;
      return;
    end if;
  end if;

  if v_version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  if v_setup is not null then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update commercial.workspaces
    set business_name = p_business_name,
        legal_name = p_legal_name,
        contact_name = p_contact_name,
        contact_email = p_contact_email,
        contact_phone = p_contact_phone,
        address_json = p_address,
        timezone = p_timezone,
        trade = p_trade,
        default_tax_bp = p_default_tax_bp,
        default_due_days = p_default_due_days,
        default_terms = p_default_terms,
        setup_completed_at = now(),
        version = version + 1
    where id = v_ws
      and owner_user_id = p_actor_id
      and version = p_expected_version
    returning version into v_after;

  if v_after is null then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  insert into commercial.job_allowances (workspace_id)
  values (v_ws)
  on conflict (workspace_id) do nothing;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'workspace_setup_completed', 'workspace', v_ws,
    p_request_id, p_expected_version, v_after,
    jsonb_build_object('trade', p_trade, 'tax_bp', p_default_tax_bp, 'due_days', p_default_due_days)
  );

  v_duration := case
    when now() - v_created < interval '5 minutes' then 'under_5m'
    when now() - v_created < interval '15 minutes' then '5_to_15m'
    else 'over_15m'
  end;

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'onboarding_completed', 1, now(), v_alias,
      jsonb_build_object('trade', p_trade, 'setup_duration_bucket', v_duration)
    );
  exception
    when unique_violation then
      null;
  end;

  v_payload := jsonb_build_object(
    'actor_id', p_actor_id,
    'workspace_id', v_ws,
    'account_status', v_status,
    'display_email', v_email,
    'setup_completed', true,
    'analytics_alias_id', v_alias,
    'workspace_version', v_after
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/workspace', p_request_hash, gen_random_uuid(),
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
    select p_actor_id, v_ws, v_status, v_email, true, false, v_alias, v_after, false;
end;
$$;

comment on function commercial.complete_workspace_setup(
  uuid, integer, uuid, text, uuid, text, text, text, text, text, jsonb, text, text, integer, integer, text
) is
  'Completes the caller''s provisioned workspace. Derives workspace from owner identity. Never accepts workspace_id as authorization.';

revoke all on function identity.provision_owner(uuid, text, text) from public;
grant execute on function identity.provision_owner(uuid, text, text) to api_app;
revoke all on function commercial.complete_workspace_setup(
  uuid, integer, uuid, text, uuid, text, text, text, text, text, jsonb, text, text, integer, integer, text
) from public;
grant execute on function commercial.complete_workspace_setup(
  uuid, integer, uuid, text, uuid, text, text, text, text, text, jsonb, text, text, integer, integer, text
) to api_app;

grant select, insert, update on commercial.job_allowances to api_app;
grant select, insert on commercial.audit_events to api_app;
grant select, insert, update on commercial.idempotency_records to api_app;

revoke all on commercial.job_allowances from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.audit_events from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.idempotency_records from public, anon, authenticated, worker_app, purge_app;

reset role;
