-- Quote drafts (S09). Line items live in payload_json until publish snapshots exist.
-- Do not create documents, document_lines, or allocate official quote numbers here.

set role migrator;

create table commercial.document_drafts (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  job_id uuid not null,
  kind text not null,
  parent_document_id uuid,
  base_scope_version integer not null default 0,
  payload_json jsonb not null,
  schema_version integer not null default 1,
  draft_state text not null default 'editing',
  constraint document_drafts_pkey primary key (id),
  constraint document_drafts_tenant_id_key unique (workspace_id, id),
  constraint document_drafts_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint document_drafts_job_fk
    foreign key (workspace_id, job_id)
    references commercial.jobs (workspace_id, id)
    on delete restrict,
  constraint document_drafts_version_check check (version >= 1),
  constraint document_drafts_schema_version_check check (schema_version >= 1),
  constraint document_drafts_base_scope_check check (base_scope_version >= 0),
  constraint document_drafts_kind_check check (kind in ('quote', 'change', 'invoice', 'credit')),
  constraint document_drafts_state_check check (draft_state in ('editing', 'discarded', 'published')),
  constraint document_drafts_payload_object_check check (jsonb_typeof(payload_json) = 'object')
);

comment on column commercial.document_drafts.parent_document_id is
  'Nullable published-document pointer. Composite FK lands with documents.';
comment on column commercial.document_drafts.payload_json is
  'Mutable quote/change/invoice/credit draft. Calculated totals are not stored; server recomputes on read and write.';

create unique index document_drafts_one_editing_quote
  on commercial.document_drafts (workspace_id, job_id)
  where kind = 'quote' and draft_state = 'editing';

create index document_drafts_job_idx
  on commercial.document_drafts (workspace_id, job_id, updated_at desc, id desc);

alter table commercial.assets
  add constraint assets_draft_fk
  foreign key (workspace_id, draft_id)
  references commercial.document_drafts (workspace_id, id)
  on delete restrict;

create or replace function commercial.protect_document_draft_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if current_user not in ('migrator', 'purge_app') then
      if new.kind is distinct from 'quote'
        or new.draft_state is distinct from 'editing'
        or new.parent_document_id is not null
        or new.schema_version is distinct from 1 then
        raise exception 'only editing quote drafts can be inserted' using errcode = '23001';
      end if;
    end if;
    return new;
  end if;

  if new.job_id is distinct from old.job_id
    or new.kind is distinct from old.kind then
    raise exception 'document draft identity is immutable' using errcode = '23001';
  end if;

  if current_user not in ('migrator', 'purge_app') then
    if old.draft_state is distinct from 'editing' then
      raise exception 'only editing drafts can be updated' using errcode = '23001';
    end if;
    if new.draft_state is distinct from 'editing'
      or new.parent_document_id is distinct from old.parent_document_id then
      raise exception 'draft publication fields are server-assigned' using errcode = '23001';
    end if;
  end if;
  return new;
end;
$$;

create trigger document_drafts_touch_updated_at
  before update on commercial.document_drafts
  for each row execute function identity.touch_updated_at();

create trigger document_drafts_reject_key_change
  before update on commercial.document_drafts
  for each row execute function commercial.reject_tenant_key_change();

create trigger document_drafts_protect_write
  before insert or update on commercial.document_drafts
  for each row execute function commercial.protect_document_draft_write();

alter table commercial.document_drafts enable row level security;
alter table commercial.document_drafts force row level security;
select identity.install_migrator_force_rls_policy('commercial.document_drafts');

create policy document_drafts_select on commercial.document_drafts
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = document_drafts.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy document_drafts_insert on commercial.document_drafts
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = document_drafts.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy document_drafts_update on commercial.document_drafts
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = document_drafts.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (workspace_id = identity.current_workspace_id());

create function commercial.open_quote_draft(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  job_id uuid,
  kind text,
  draft_state text,
  schema_version integer,
  payload_json jsonb,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  default_tax_bp integer,
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
  v_existing commercial.idempotency_records%rowtype;
  v_job commercial.jobs%rowtype;
  v_terms text;
  v_tax integer;
  v_draft commercial.document_drafts%rowtype;
  v_payload jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_job_id is null then
    raise exception 'invalid quote draft open' using errcode = '22023';
  end if;

  select u.status
    into v_status
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at, w.default_terms, w.default_tax_bp
    into v_ws, v_setup, v_terms, v_tax
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
          (v_existing.response_json->>'job_id')::uuid,
          v_existing.response_json->>'kind',
          v_existing.response_json->>'draft_state',
          (v_existing.response_json->>'schema_version')::integer,
          v_existing.response_json->'payload_json',
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          (v_existing.response_json->>'default_tax_bp')::integer,
          true;
      return;
    end if;
  end if;

  select *
    into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws
    and j.id = p_job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle is distinct from 'draft' then
    raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
  end if;

  select *
    into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = p_job_id
    and d.kind = 'quote'
    and d.draft_state = 'editing'
  for update;

  if not found then
    v_payload := jsonb_build_object(
      'notes', '',
      'terms', coalesce(v_terms, ''),
      'expiry_days', 14,
      'lines', '[]'::jsonb
    );
    insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, parent_document_id, base_scope_version,
      payload_json, schema_version, draft_state
    ) values (
      v_ws, gen_random_uuid(), p_job_id, 'quote', null, v_job.scope_version,
      v_payload, 1, 'editing'
    )
    returning * into v_draft;
  end if;

  v_payload := jsonb_build_object(
    'id', v_draft.id,
    'workspace_id', v_draft.workspace_id,
    'job_id', v_draft.job_id,
    'kind', v_draft.kind,
    'draft_state', v_draft.draft_state,
    'schema_version', v_draft.schema_version,
    'payload_json', v_draft.payload_json,
    'version', v_draft.version,
    'created_at', v_draft.created_at,
    'updated_at', v_draft.updated_at,
    'default_tax_bp', coalesce(v_tax, 0)
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/jobs/' || p_job_id::text || '/quote',
      p_request_hash, gen_random_uuid(),
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
      v_draft.id,
      v_draft.workspace_id,
      v_draft.job_id,
      v_draft.kind,
      v_draft.draft_state,
      v_draft.schema_version,
      v_draft.payload_json,
      v_draft.version,
      v_draft.created_at,
      v_draft.updated_at,
      coalesce(v_tax, 0),
      false;
end;
$$;

create function commercial.save_quote_draft(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
  p_payload jsonb
)
returns table (
  id uuid,
  workspace_id uuid,
  job_id uuid,
  kind text,
  draft_state text,
  schema_version integer,
  payload_json jsonb,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  default_tax_bp integer,
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
  v_existing commercial.idempotency_records%rowtype;
  v_job commercial.jobs%rowtype;
  v_tax integer;
  v_draft commercial.document_drafts%rowtype;
  v_payload jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_draft_id is null
    or p_expected_version is null
    or p_payload is null then
    raise exception 'invalid quote draft save' using errcode = '22023';
  end if;
  if p_expected_version < 1 then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid quote draft payload' using errcode = '22023';
  end if;

  select u.status
    into v_status
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at, w.default_tax_bp
    into v_ws, v_setup, v_tax
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
          (v_existing.response_json->>'job_id')::uuid,
          v_existing.response_json->>'kind',
          v_existing.response_json->>'draft_state',
          (v_existing.response_json->>'schema_version')::integer,
          v_existing.response_json->'payload_json',
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          (v_existing.response_json->>'default_tax_bp')::integer,
          true;
      return;
    end if;
  end if;

  select *
    into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.id = p_draft_id
  for update;
  if not found then
    raise exception 'DRAFT_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_draft.kind is distinct from 'quote' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'DRAFT_NOT_EDITABLE' using errcode = 'P0007';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select *
    into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws
    and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle is distinct from 'draft' then
    raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
  end if;

  update commercial.document_drafts
    set payload_json = p_payload,
        version = version + 1
    where workspace_id = v_ws
      and id = p_draft_id
    returning * into v_draft;

  v_payload := jsonb_build_object(
    'id', v_draft.id,
    'workspace_id', v_draft.workspace_id,
    'job_id', v_draft.job_id,
    'kind', v_draft.kind,
    'draft_state', v_draft.draft_state,
    'schema_version', v_draft.schema_version,
    'payload_json', v_draft.payload_json,
    'version', v_draft.version,
    'created_at', v_draft.created_at,
    'updated_at', v_draft.updated_at,
    'default_tax_bp', coalesce(v_tax, 0)
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/drafts/' || p_draft_id::text,
      p_request_hash, gen_random_uuid(),
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
      v_draft.id,
      v_draft.workspace_id,
      v_draft.job_id,
      v_draft.kind,
      v_draft.draft_state,
      v_draft.schema_version,
      v_draft.payload_json,
      v_draft.version,
      v_draft.created_at,
      v_draft.updated_at,
      coalesce(v_tax, 0),
      false;
end;
$$;

comment on function commercial.open_quote_draft(uuid, uuid, text, uuid, uuid) is
  'Creates or returns the current editing quote draft for a quote-mode draft job. Derives workspace from owner identity.';

comment on function commercial.save_quote_draft(uuid, uuid, text, uuid, uuid, integer, jsonb) is
  'Replaces an editing quote draft payload when If-Match matches version. Calculated totals are not persisted.';

revoke all on function commercial.open_quote_draft(uuid, uuid, text, uuid, uuid) from public;
grant execute on function commercial.open_quote_draft(uuid, uuid, text, uuid, uuid) to api_app;
revoke all on function commercial.open_quote_draft(uuid, uuid, text, uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.save_quote_draft(uuid, uuid, text, uuid, uuid, integer, jsonb) from public;
grant execute on function commercial.save_quote_draft(uuid, uuid, text, uuid, uuid, integer, jsonb) to api_app;
revoke all on function commercial.save_quote_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.protect_document_draft_write() from public;
revoke all on function commercial.protect_document_draft_write()
  from api_app, worker_app, purge_app, anon, authenticated;

grant select, insert, update on commercial.document_drafts to api_app;
revoke all on commercial.document_drafts from public, anon, authenticated, worker_app, purge_app;

reset role;
