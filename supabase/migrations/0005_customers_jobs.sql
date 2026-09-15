-- Customers and jobs (JOB01). Document pointer FKs wait for documents.
-- Screens in this slice: list, create, read-only detail. New jobs are draft.

set role migrator;

create table commercial.customers (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  name text not null,
  email text,
  normalized_email text,
  phone text,
  billing_address_json jsonb,
  archived_at timestamptz,
  constraint customers_pkey primary key (id),
  constraint customers_tenant_id_key unique (workspace_id, id),
  constraint customers_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint customers_version_check check (version >= 1),
  constraint customers_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint customers_email_len check (email is null or char_length(email) between 3 and 254),
  constraint customers_normalized_email_len check (
    normalized_email is null or char_length(normalized_email) between 3 and 254
  )
);

create table commercial.jobs (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  customer_id uuid not null,
  title text not null,
  site_address_json jsonb,
  no_site boolean not null,
  lifecycle text not null default 'draft',
  archived_from_state text,
  current_quote_id uuid,
  active_invoice_id uuid,
  scope_version integer not null default 0,
  first_published_at timestamptz,
  entitlement_origin text,
  completion_right boolean not null default false,
  internal_notes text not null default '',
  related_job_id uuid,
  mode text not null,
  constraint jobs_pkey primary key (id),
  constraint jobs_tenant_id_key unique (workspace_id, id),
  constraint jobs_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint jobs_customer_fk
    foreign key (workspace_id, customer_id)
    references commercial.customers (workspace_id, id)
    on delete restrict,
  constraint jobs_related_job_fk
    foreign key (workspace_id, related_job_id)
    references commercial.jobs (workspace_id, id)
    on delete restrict,
  constraint jobs_version_check check (version >= 1),
  constraint jobs_title_len check (char_length(btrim(title)) between 1 and 120),
  constraint jobs_notes_len check (char_length(internal_notes) <= 4000),
  constraint jobs_lifecycle_check check (
    lifecycle in ('draft', 'active', 'invoiced', 'finished', 'canceled', 'archived')
  ),
  constraint jobs_mode_check check (mode in ('quote', 'direct_invoice')),
  constraint jobs_scope_version_check check (scope_version >= 0),
  constraint jobs_entitlement_origin_check check (
    entitlement_origin is null or entitlement_origin in ('free', 'trial', 'paid')
  ),
  constraint jobs_archive_state_check check (
    (
      lifecycle <> 'archived'
      and archived_from_state is null
    )
    or (
      lifecycle = 'archived'
      and archived_from_state in ('active', 'invoiced', 'finished', 'canceled')
    )
  ),
  constraint jobs_site_xor_check check (
    (no_site = true and site_address_json is null)
    or (
      no_site = false
      and jsonb_typeof(site_address_json) = 'object'
      and char_length(coalesce(site_address_json->>'line1', '')) between 1 and 150
      and char_length(coalesce(site_address_json->>'line2', '')) <= 150
      and char_length(coalesce(site_address_json->>'city', '')) between 1 and 80
      and coalesce(site_address_json->>'state', '') ~ '^[A-Z]{2}$'
      and coalesce(site_address_json->>'postal_code', '') ~ '^[0-9]{5}(-[0-9]{4})?$'
    )
  )
);

comment on column commercial.jobs.current_quote_id is
  'Nullable document pointer. Composite FK lands with documents.';
comment on column commercial.jobs.active_invoice_id is
  'Nullable document pointer. Composite FK lands with documents.';
comment on column commercial.jobs.mode is
  'quote or direct_invoice. Stored for later publish/issue; this slice does not create drafts.';

alter table commercial.assets
  add constraint assets_job_fk
  foreign key (workspace_id, job_id)
  references commercial.jobs (workspace_id, id)
  on delete restrict;

create index customers_list_idx
  on commercial.customers (workspace_id, updated_at desc, id desc);

create index jobs_list_idx
  on commercial.jobs (workspace_id, updated_at desc, id desc);

create index jobs_customer_idx
  on commercial.jobs (workspace_id, customer_id);

create or replace function commercial.protect_job_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if current_user not in ('migrator', 'purge_app') then
      if new.lifecycle is distinct from 'draft'
        or new.completion_right is distinct from false
        or new.first_published_at is not null
        or new.current_quote_id is not null
        or new.active_invoice_id is not null
        or new.entitlement_origin is not null
        or new.scope_version is distinct from 0
        or new.archived_from_state is not null then
        raise exception 'job publication fields are server-assigned' using errcode = '23001';
      end if;
    end if;
    return new;
  end if;

  if new.completion_right is distinct from old.completion_right and new.completion_right = false then
    if current_user <> 'purge_app' then
      raise exception 'completion_right is write-once' using errcode = '23001';
    end if;
  end if;
  return new;
end;
$$;

create trigger customers_touch_updated_at
  before update on commercial.customers
  for each row execute function identity.touch_updated_at();

create trigger customers_reject_key_change
  before update on commercial.customers
  for each row execute function commercial.reject_tenant_key_change();

create trigger jobs_touch_updated_at
  before update on commercial.jobs
  for each row execute function identity.touch_updated_at();

create trigger jobs_reject_key_change
  before update on commercial.jobs
  for each row execute function commercial.reject_tenant_key_change();

create trigger jobs_protect_write
  before insert or update on commercial.jobs
  for each row execute function commercial.protect_job_write();

alter table commercial.customers enable row level security;
alter table commercial.customers force row level security;
select identity.install_migrator_force_rls_policy('commercial.customers');
alter table commercial.jobs enable row level security;
alter table commercial.jobs force row level security;
select identity.install_migrator_force_rls_policy('commercial.jobs');

create policy customers_select on commercial.customers
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = customers.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy customers_insert on commercial.customers
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = customers.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy customers_update on commercial.customers
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = customers.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (workspace_id = identity.current_workspace_id());

create policy jobs_select on commercial.jobs
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = jobs.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy jobs_insert on commercial.jobs
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = jobs.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy jobs_update on commercial.jobs
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = jobs.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (workspace_id = identity.current_workspace_id());

create function commercial.create_job(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid,
  p_customer_name text,
  p_title text,
  p_site_address jsonb,
  p_no_site boolean,
  p_internal_notes text,
  p_mode text
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
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_setup timestamptz;
  v_status text;
  v_alias uuid;
  v_existing commercial.idempotency_records%rowtype;
  v_customer uuid;
  v_notes text;
  v_payload jsonb;
  v_analytics_mode text;
  v_job commercial.jobs%rowtype;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_job_id is null
    or p_customer_name is null
    or p_title is null
    or p_no_site is null
    or p_mode is null then
    raise exception 'invalid job create' using errcode = '22023';
  end if;

  if p_mode not in ('quote', 'direct_invoice') then
    raise exception 'invalid job mode' using errcode = '23514';
  end if;

  select u.status, u.analytics_alias_id
    into v_status, v_alias
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at
    into v_ws, v_setup
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  if v_setup is null then
    raise exception 'SETUP_INCOMPLETE' using errcode = 'P0003';
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
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          true;
      return;
    end if;
  end if;

  v_customer := gen_random_uuid();
  v_notes := coalesce(p_internal_notes, '');

  insert into commercial.customers (
    workspace_id, id, name
  ) values (
    v_ws, v_customer, p_customer_name
  );

  insert into commercial.jobs (
    workspace_id, id, customer_id, title, site_address_json, no_site,
    lifecycle, internal_notes, mode
  ) values (
    v_ws, p_job_id, v_customer, p_title, p_site_address, p_no_site,
    'draft', v_notes, p_mode
  )
  returning * into v_job;

  v_analytics_mode := case when p_mode = 'direct_invoice' then 'direct' else 'quote' end;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'job_created', 'job', p_job_id,
    p_request_id, v_job.version,
    jsonb_build_object('mode', v_analytics_mode)
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
    'customer_name', p_customer_name,
    'title', v_job.title,
    'site_address_json', v_job.site_address_json,
    'no_site', v_job.no_site,
    'lifecycle', v_job.lifecycle,
    'mode', v_job.mode,
    'internal_notes', v_job.internal_notes,
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
      p_customer_name,
      v_job.title,
      v_job.site_address_json,
      v_job.no_site,
      v_job.lifecycle,
      v_job.mode,
      v_job.internal_notes,
      v_job.version,
      v_job.created_at,
      v_job.updated_at,
      false;
end;
$$;

comment on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text
) is
  'Creates a draft job and the minimum customer row. Derives workspace from owner identity. Never accepts workspace_id as authorization.';

revoke all on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text
) from public;
grant execute on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text
) to api_app;
revoke all on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text
) from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.protect_job_write() from public;
revoke all on function commercial.protect_job_write()
  from api_app, worker_app, purge_app, anon, authenticated;

grant select, insert, update on commercial.customers to api_app;
grant select, insert, update on commercial.jobs to api_app;

revoke all on commercial.customers from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.jobs from public, anon, authenticated, worker_app, purge_app;

-- D-011: restore the bootstrap session role. Supabase CLI records
-- schema_migrations as that role after this file returns; migrator has no catalog access.
reset role;
