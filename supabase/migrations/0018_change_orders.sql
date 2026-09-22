-- Pre-invoice change orders (S13/S14 / CHG01–CHG05 / QA27–QA28).
-- Forward-only. Do not edit 0001–0017.

set role migrator;

create unique index if not exists document_drafts_one_editing_change
  on commercial.document_drafts (workspace_id, job_id)
  where kind = 'change' and draft_state = 'editing';

alter table commercial.delivery_attempts
  drop constraint if exists delivery_attempts_template_check;

alter table commercial.delivery_attempts
  add constraint delivery_attempts_template_check
  check (template_id in ('EMAIL01', 'EMAIL02', 'EMAIL03', 'EMAIL04', 'EMAIL05', 'EMAIL06', 'EMAIL07', 'EMAIL08'));

create function commercial.open_change_draft(
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
  v_alias uuid;
  v_tax integer;
  v_existing commercial.idempotency_records%rowtype;
  v_job commercial.jobs%rowtype;
  v_quote commercial.documents%rowtype;
  v_draft commercial.document_drafts%rowtype;
  v_payload jsonb;
  v_created boolean := false;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_job_id is null then
    raise exception 'invalid change draft open' using errcode = '22023';
  end if;

  select u.status, u.analytics_alias_id into v_status, v_alias
  from identity.app_users u where u.id = p_actor_id for update;
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

  select * into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id and r.key = p_idempotency_key
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

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = p_job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle is distinct from 'active' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if exists (
    select 1 from commercial.documents d
    where d.workspace_id = v_ws and d.job_id = v_job.id and d.kind = 'invoice'
  ) then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select * into v_quote
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = v_job.current_quote_id
  for update;
  if not found or v_quote.kind is distinct from 'quote' or v_quote.lifecycle is distinct from 'accepted' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'change'
    and d.draft_state = 'editing'
  order by d.created_at asc, d.id asc
  limit 1
  for update;

  if not found then
    insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, parent_document_id, base_scope_version, payload_json,
      schema_version, draft_state
    ) values (
      v_ws, gen_random_uuid(), v_job.id, 'change', v_quote.id, v_job.scope_version,
      jsonb_build_object(
        'reason', '',
        'expected_scope_version', v_job.scope_version,
        'expiry_days', 14,
        'additions', '[]'::jsonb,
        'reductions', '[]'::jsonb
      ),
      1, 'editing'
    )
    returning * into v_draft;
    v_created := true;
  end if;

  if v_created then
    insert into commercial.audit_events (
      workspace_id, actor_type, actor_id, action, entity_type, entity_id,
      request_id, before_version, after_version, safe_metadata_json
    ) values (
      v_ws, 'owner', p_actor_id, 'change_started', 'draft', v_draft.id,
      p_request_id, v_job.version, v_job.version,
      jsonb_build_object('kind', 'change')
    );
    begin
      insert into commercial.analytics_events (
        workspace_id, event_id, event_name, schema_version, occurred_at,
        pseudonymous_owner_id, job_id, safe_properties_json
      ) values (
        v_ws, gen_random_uuid(), 'change_started', 1, now(), v_alias, v_job.id,
        jsonb_build_object('origin', 'addition')
      );
    exception
      when unique_violation then
        null;
    end;
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
      v_ws, p_actor_id, p_idempotency_key, '/v1/jobs/' || p_job_id::text || '/changes',
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
      v_draft.id, v_draft.workspace_id, v_draft.job_id, v_draft.kind, v_draft.draft_state,
      v_draft.schema_version, v_draft.payload_json, v_draft.version, v_draft.created_at,
      v_draft.updated_at, coalesce(v_tax, 0), false;
end;
$$;

revoke all on function commercial.open_change_draft(uuid, uuid, text, uuid, uuid) from public;
grant execute on function commercial.open_change_draft(uuid, uuid, text, uuid, uuid) to api_app;
revoke all on function commercial.open_change_draft(uuid, uuid, text, uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

create function commercial.save_change_draft(
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
  v_tax integer;
  v_existing commercial.idempotency_records%rowtype;
  v_job commercial.jobs%rowtype;
  v_draft commercial.document_drafts%rowtype;
  v_payload jsonb;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_draft_id is null or p_expected_version is null or p_payload is null then
    raise exception 'invalid change draft save' using errcode = '22023';
  end if;
  if p_expected_version < 1 or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid change draft save' using errcode = '22023';
  end if;

  select u.status into v_status from identity.app_users u where u.id = p_actor_id for update;
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

  select * into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id and r.key = p_idempotency_key
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

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws and d.id = p_draft_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_draft.kind is distinct from 'change' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle is distinct from 'active' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  update commercial.document_drafts
    set payload_json = p_payload,
        version = version + 1,
        base_scope_version = v_job.scope_version
    where workspace_id = v_ws and id = p_draft_id
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
      v_draft.id, v_draft.workspace_id, v_draft.job_id, v_draft.kind, v_draft.draft_state,
      v_draft.schema_version, v_draft.payload_json, v_draft.version, v_draft.created_at,
      v_draft.updated_at, coalesce(v_tax, 0), false;
end;
$$;

revoke all on function commercial.save_change_draft(uuid, uuid, text, uuid, uuid, integer, jsonb) from public;
grant execute on function commercial.save_change_draft(uuid, uuid, text, uuid, uuid, integer, jsonb) to api_app;
revoke all on function commercial.save_change_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)
  from worker_app, purge_app, anon, authenticated;

create function commercial.freeze_change_preview(
  p_actor_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
  p_preview_hash text,
  p_canonical_bytes bytea,
  p_snapshot jsonb,
  p_expires_at timestamptz
)
returns table (
  id uuid,
  workspace_id uuid,
  job_id uuid,
  version integer,
  preview_hash text,
  preview_expires_at timestamptz,
  snapshot_json jsonb
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
  v_job commercial.jobs%rowtype;
  v_draft commercial.document_drafts%rowtype;
begin
  if p_actor_id is null or p_draft_id is null or p_expected_version is null
    or p_preview_hash is null or p_canonical_bytes is null or p_snapshot is null or p_expires_at is null then
    raise exception 'invalid change preview' using errcode = '22023';
  end if;
  if p_expected_version < 1 or p_preview_hash !~ '^[0-9a-f]{64}$' or (p_snapshot->>'kind') is distinct from 'change' then
    raise exception 'invalid change preview' using errcode = '22023';
  end if;

  select u.status into v_status from identity.app_users u where u.id = p_actor_id for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at into v_ws, v_setup
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  if v_setup is null then
    raise exception 'SETUP_INCOMPLETE' using errcode = 'P0003';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws and d.id = p_draft_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_draft.kind is distinct from 'change' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle is distinct from 'active' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if (p_snapshot->>'expected_scope_version')::integer is distinct from v_job.scope_version then
    raise exception 'SCOPE_CHANGED' using errcode = 'P0034';
  end if;

  update commercial.document_drafts
    set preview_hash = p_preview_hash,
        preview_canonical_bytes = p_canonical_bytes,
        preview_snapshot_json = p_snapshot,
        preview_expires_at = p_expires_at,
        preview_draft_version = v_draft.version
    where workspace_id = v_ws and id = p_draft_id
    returning * into v_draft;

  return query
    select
      v_draft.id, v_draft.workspace_id, v_draft.job_id, v_draft.version,
      v_draft.preview_hash, v_draft.preview_expires_at, v_draft.preview_snapshot_json;
end;
$$;

revoke all on function commercial.freeze_change_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz) from public;
grant execute on function commercial.freeze_change_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz) to api_app;
revoke all on function commercial.freeze_change_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz)
  from worker_app, purge_app, anon, authenticated;

create function commercial.publish_change_draft(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
  p_preview_hash text,
  p_recipient_email text,
  p_recipient_name text,
  p_token_hash text,
  p_token_key_version integer,
  p_encrypted_email bytea,
  p_token_ciphertext bytea,
  p_token_nonce bytea,
  p_delivery_algorithm text,
  p_delivery_key_version integer,
  p_expires_at timestamptz,
  p_access_until timestamptz
)
returns table (
  id uuid,
  workspace_id uuid,
  job_id uuid,
  draft_id uuid,
  kind text,
  number text,
  revision_no integer,
  lifecycle text,
  issued_at timestamptz,
  issue_date date,
  due_date date,
  currency text,
  net_cents bigint,
  tax_cents bigint,
  total_cents bigint,
  snapshot_json jsonb,
  schema_version integer,
  snapshot_sha256 text,
  pdf_state text,
  request_id uuid,
  delivery_state text,
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
  v_job commercial.jobs%rowtype;
  v_draft commercial.document_drafts%rowtype;
  v_pending uuid;
  v_seq integer;
  v_number text;
  v_doc commercial.documents%rowtype;
  v_line jsonb;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_effect text;
  v_payload jsonb;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_draft_id is null or p_expected_version is null
    or p_preview_hash is null or p_recipient_email is null or p_token_hash is null
    or p_token_key_version is null or p_encrypted_email is null
    or p_token_ciphertext is null or p_token_nonce is null
    or p_delivery_algorithm is null or p_delivery_key_version is null
    or p_expires_at is null or p_access_until is null then
    raise exception 'invalid change publish' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$' or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_key_version < 1 or p_delivery_key_version < 1
    or p_delivery_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_token_nonce) is distinct from 12
    or octet_length(p_token_ciphertext) < 17 then
    raise exception 'invalid change publish' using errcode = '22023';
  end if;

  select u.status, u.analytics_alias_id into v_status, v_alias
  from identity.app_users u where u.id = p_actor_id for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at into v_ws, v_setup
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  if v_setup is null then
    raise exception 'SETUP_INCOMPLETE' using errcode = 'P0003';
  end if;

  select * into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = p_actor_id and r.key = p_idempotency_key
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
          (v_existing.response_json->>'draft_id')::uuid,
          v_existing.response_json->>'kind',
          v_existing.response_json->>'number',
          (v_existing.response_json->>'revision_no')::integer,
          v_existing.response_json->>'lifecycle',
          (v_existing.response_json->>'issued_at')::timestamptz,
          (v_existing.response_json->>'issue_date')::date,
          (v_existing.response_json->>'due_date')::date,
          v_existing.response_json->>'currency',
          (v_existing.response_json->>'net_cents')::bigint,
          (v_existing.response_json->>'tax_cents')::bigint,
          (v_existing.response_json->>'total_cents')::bigint,
          v_existing.response_json->'snapshot_json',
          (v_existing.response_json->>'schema_version')::integer,
          v_existing.response_json->>'snapshot_sha256',
          v_existing.response_json->>'pdf_state',
          (v_existing.response_json->>'request_id')::uuid,
          v_existing.response_json->>'delivery_state',
          true;
      return;
    end if;
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws and d.id = p_draft_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_draft.kind is distinct from 'change' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  if v_draft.preview_hash is distinct from p_preview_hash
    or v_draft.preview_expires_at is null
    or v_draft.preview_expires_at <= now()
    or v_draft.preview_canonical_bytes is null
    or v_draft.preview_snapshot_json is null
    or (v_draft.preview_snapshot_json->>'kind') is distinct from 'change' then
    raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle is distinct from 'active' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;
  if (v_draft.preview_snapshot_json->>'expected_scope_version')::integer is distinct from v_job.scope_version then
    raise exception 'SCOPE_CHANGED' using errcode = 'P0034';
  end if;

  select ar.id into v_pending
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws
    and ar.job_id = v_job.id
    and ar.state = 'pending'
    and ar.purpose = 'approval'
  for update;
  if v_pending is not null then
    raise exception 'APPROVAL_PENDING' using errcode = 'P0012';
  end if;

  insert into commercial.document_counters as c (workspace_id, type, next_value)
  values (v_ws, 'change', 1)
  on conflict (workspace_id, type)
  do update set next_value = c.next_value + 1, version = c.version + 1
  returning next_value into v_seq;
  v_number := 'CO-' || lpad(v_seq::text, 6, '0');

  insert into commercial.documents (
    workspace_id, id, created_by, job_id, kind, number, revision_no, prior_document_id,
    lifecycle, issued_at, issue_date, due_date, currency, net_cents, tax_cents, total_cents,
    snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256, scope_version
  ) values (
    v_ws, gen_random_uuid(), p_actor_id, v_job.id, 'change', v_number, 1, v_job.current_quote_id,
    'issued', now(), (v_draft.preview_snapshot_json->>'issue_date')::date, null, 'USD',
    (v_draft.preview_snapshot_json->>'net_cents')::bigint,
    (v_draft.preview_snapshot_json->>'tax_cents')::bigint,
    (v_draft.preview_snapshot_json->>'total_cents')::bigint,
    v_draft.preview_snapshot_json, v_draft.preview_canonical_bytes,
    coalesce((v_draft.preview_snapshot_json->>'schema_version')::integer, 1),
    v_draft.preview_hash, v_job.scope_version
  )
  returning * into v_doc;

  for v_line in
    select value from jsonb_array_elements(coalesce(v_draft.preview_snapshot_json->'additions', '[]'::jsonb))
  loop
    insert into commercial.document_lines (
      workspace_id, id, document_id, position, line_kind, description, quantity, unit,
      unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
    ) values (
      v_ws, gen_random_uuid(), v_doc.id,
      (v_line->>'position')::integer, 'source', v_line->>'description',
      (v_line->>'quantity')::numeric, v_line->>'unit',
      (v_line->>'unit_price_cents')::bigint, (v_line->>'discount_cents')::bigint,
      (v_line->>'net_cents')::bigint, (v_line->>'tax_bp')::integer,
      (v_line->>'tax_cents')::bigint, (v_line->>'total_cents')::bigint
    );
  end loop;

  for v_line in
    select value from jsonb_array_elements(coalesce(v_draft.preview_snapshot_json->'reductions', '[]'::jsonb))
  loop
    insert into commercial.document_lines (
      workspace_id, id, document_id, position, line_kind, source_line_id, description,
      quantity, unit, unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
    ) values (
      v_ws, gen_random_uuid(), v_doc.id,
      (v_line->>'position')::integer, 'reduction', (v_line->>'source_line_id')::uuid, v_line->>'description',
      1, 'item', 0, 0,
      (v_line->>'net_reduction_cents')::bigint, 0,
      (v_line->>'tax_reduction_cents')::bigint, (v_line->>'total_reduction_cents')::bigint
    );
  end loop;

  update commercial.document_drafts
    set draft_state = 'published',
        parent_document_id = v_doc.id
    where workspace_id = v_ws and id = v_draft.id;

  update commercial.jobs
    set version = version + 1
    where workspace_id = v_ws and id = v_job.id;

  insert into commercial.approval_requests (
    workspace_id, id, job_id, document_id, purpose, recipient_name, recipient_email,
    token_hash, token_key_version, state, expected_scope_version, expires_at, access_until
  ) values (
    v_ws, gen_random_uuid(), v_job.id, v_doc.id, 'approval',
    coalesce(p_recipient_name, v_draft.preview_snapshot_json#>>'{customer,name}', ''),
    p_recipient_email,
    p_token_hash, p_token_key_version, 'pending', v_job.scope_version,
    coalesce((v_draft.preview_snapshot_json->>'expires_at')::timestamptz, p_expires_at),
    p_access_until
  )
  returning * into v_request;

  v_effect := v_ws::text || ':' || v_doc.id::text || ':EMAIL02:' || v_request.id::text;

  insert into commercial.delivery_attempts (
    workspace_id, id, document_id, request_id, template_id, recipient_email_encrypted,
    state, effect_key, last_event_at, retry_count
  ) values (
    v_ws, gen_random_uuid(), v_doc.id, v_request.id, 'EMAIL02', p_encrypted_email,
    'queued', v_effect, now(), 0
  )
  returning * into v_attempt;

  insert into commercial.encrypted_delivery_payloads (
    workspace_id, id, delivery_attempt_id, algorithm, key_version, nonce, ciphertext
  ) values (
    v_ws, gen_random_uuid(), v_attempt.id, p_delivery_algorithm, p_delivery_key_version,
    p_token_nonce, p_token_ciphertext
  );

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json, schema_version,
    available_at, attempts, status, effect_key
  ) values (
    v_ws, gen_random_uuid(), gen_random_uuid(), 'generate_original_pdf', v_doc.id,
    jsonb_build_object('document_id', v_doc.id, 'kind', 'change'),
    1, now(), 0, 'pending',
    v_ws::text || ':' || v_doc.id::text || ':original_pdf'
  );

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json, schema_version,
    available_at, attempts, status, effect_key
  ) values (
    v_ws, gen_random_uuid(), gen_random_uuid(), 'send_email', v_request.id,
    jsonb_build_object('document_id', v_doc.id, 'request_id', v_request.id, 'template_id', 'EMAIL02'),
    1, now(), 0, 'pending', v_effect
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'document_published', 'document', v_doc.id,
    p_request_id, v_job.version, v_job.version + 1,
    jsonb_build_object('kind', 'change')
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'document_published', 1, now(), v_alias, v_job.id,
      jsonb_build_object('kind', 'change', 'entitlement_origin', coalesce(v_job.entitlement_origin, 'free'), 'line_count_bucket', '1')
    );
  exception
    when unique_violation then
      null;
  end;

  v_payload := jsonb_build_object(
    'id', v_doc.id,
    'workspace_id', v_doc.workspace_id,
    'job_id', v_doc.job_id,
    'draft_id', v_draft.id,
    'kind', v_doc.kind,
    'number', v_doc.number,
    'revision_no', v_doc.revision_no,
    'lifecycle', v_doc.lifecycle,
    'issued_at', v_doc.issued_at,
    'issue_date', v_doc.issue_date,
    'due_date', v_doc.due_date,
    'currency', v_doc.currency,
    'net_cents', v_doc.net_cents,
    'tax_cents', v_doc.tax_cents,
    'total_cents', v_doc.total_cents,
    'snapshot_json', v_doc.snapshot_json,
    'schema_version', v_doc.schema_version,
    'snapshot_sha256', v_doc.snapshot_sha256,
    'pdf_state', 'preparing',
    'request_id', v_request.id,
    'delivery_state', 'queued'
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/drafts/' || p_draft_id::text || '/publish',
      p_request_hash, gen_random_uuid(),
      'completed', 202, v_payload, null, 'financial'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 202,
          response_json = v_payload,
          permanence = 'financial',
          expires_at = null
      where id = v_existing.id;
  end if;

  return query
    select
      v_doc.id, v_doc.workspace_id, v_doc.job_id, v_draft.id, v_doc.kind, v_doc.number,
      v_doc.revision_no, v_doc.lifecycle, v_doc.issued_at, v_doc.issue_date, v_doc.due_date,
      v_doc.currency, v_doc.net_cents, v_doc.tax_cents, v_doc.total_cents, v_doc.snapshot_json,
      v_doc.schema_version, v_doc.snapshot_sha256, 'preparing'::text, v_request.id, 'queued'::text, false;
end;
$$;

revoke all on function commercial.publish_change_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz) from public;
grant execute on function commercial.publish_change_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz) to api_app;
revoke all on function commercial.publish_change_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz)
  from worker_app, purge_app, anon, authenticated;

create function commercial.change_email_facts(p_document_id uuid)
returns table (
  previous_total_cents bigint,
  change_including_tax_cents bigint,
  new_agreed_total_cents bigint
)
language plpgsql
security definer
set search_path = commercial, pg_temp
as $$
begin
  return query
    select
      (d.snapshot_json->>'previous_total_cents')::bigint,
      (d.snapshot_json->>'change_including_tax_cents')::bigint,
      (d.snapshot_json->>'new_agreed_total_cents')::bigint
    from commercial.documents d
    where d.id = p_document_id and d.kind = 'change';
end;
$$;

revoke all on function commercial.change_email_facts(uuid) from public;
grant execute on function commercial.change_email_facts(uuid) to worker_app;
revoke all on function commercial.change_email_facts(uuid)
  from api_app, purge_app, anon, authenticated;

create or replace function commercial.exchange_approval_token(
  p_token_hash text,
  p_session_hash text
)
returns table (
  workspace_id uuid,
  request_id uuid,
  purpose text,
  access_state text,
  business_name text,
  document_type text,
  recipient_email_masked text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_request commercial.approval_requests%rowtype;
  v_ws commercial.workspaces%rowtype;
  v_state text;
  v_kind text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request
  from commercial.approval_requests ar
  where ar.token_hash = p_token_hash
  for update;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  perform commercial.expire_due_job_approvals(v_request.workspace_id, v_request.job_id);
  select * into v_request
  from commercial.approval_requests ar
  where ar.id = v_request.id
  for update;
  v_state := commercial.portal_access_state(v_request);
  if v_state = 'unavailable' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_ws from commercial.workspaces w where w.workspace_id = v_request.workspace_id;
  select d.kind into v_kind from commercial.documents d
    where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id;
  if v_state in ('pending', 'decided') then
    insert into commercial.approval_sessions (
      workspace_id, id, request_id, session_hash, verified_email, expires_at, token_generation
    ) values (
      v_request.workspace_id, gen_random_uuid(), v_request.id, p_session_hash,
      v_request.recipient_email, now() + interval '20 minutes', 0
    );
  end if;
  return query
    select
      v_request.workspace_id,
      v_request.id,
      v_request.purpose,
      v_state,
      v_ws.business_name,
      case when v_kind = 'change' then 'change' when v_kind = 'invoice' then 'invoice' when v_kind = 'credit' then 'credit' else 'quote' end,
      commercial.mask_recipient_email(v_request.recipient_email);
end;
$$;

create or replace function commercial.get_portal_document(p_session_hash text)
returns table (
  workspace_id uuid,
  request_id uuid,
  document_id uuid,
  purpose text,
  access_state text,
  business_name text,
  number text,
  revision_no integer,
  lifecycle text,
  snapshot_json jsonb,
  snapshot_sha256 text,
  pdf_state text,
  object_key text,
  consent_version text,
  consent_text text,
  allowed_actions text[]
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_doc commercial.documents%rowtype;
  v_ws commercial.workspaces%rowtype;
  v_state text;
  v_pdf text;
  v_key text;
  v_actions text[];
  v_consent text;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request from commercial.approval_requests ar where ar.id = v_session.request_id for update;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  v_state := commercial.portal_access_state(v_request);
  if v_state = 'expired' and v_request.state = 'pending' then
    update commercial.approval_requests set state = 'expired' where id = v_request.id and state = 'pending';
    v_request.state := 'expired';
    v_state := 'expired';
  end if;
  if v_state = 'unavailable' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_doc from commercial.documents d where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id;
  select * into v_ws from commercial.workspaces w where w.workspace_id = v_request.workspace_id;
  select a.object_key into v_key
  from commercial.artifacts a
  where a.workspace_id = v_request.workspace_id
    and a.document_id = v_request.document_id
    and a.type = 'original_pdf'
    and a.state = 'ready'
  limit 1;
  if v_key is not null then
    v_pdf := 'ready';
  elsif exists (
    select 1 from commercial.outbox_tasks p
    where p.workspace_id = v_request.workspace_id
      and p.aggregate_id = v_request.document_id
      and p.task_type = 'generate_original_pdf'
      and p.status = 'dead'
  ) then
    v_pdf := 'failed';
  else
    v_pdf := 'preparing';
  end if;
  v_actions := array['report']::text[];
  if v_state in ('pending', 'decided') and v_pdf = 'ready' then
    v_actions := v_actions || 'download'::text;
  end if;
  if v_state = 'pending' and v_request.purpose = 'approval' and v_pdf = 'ready' then
    v_actions := v_actions || array['approve', 'decline']::text[];
  end if;
  if v_doc.kind = 'change' then
    v_consent := 'I have reviewed this version of the scope and price and approve it. I understand this records my approval electronically.';
  else
    v_consent := 'I confirm I have reviewed this quote, including the PDF, and I am authorized to approve or decline it. This is not a payment.';
  end if;
  return query
    select
      v_request.workspace_id,
      v_request.id,
      v_request.document_id,
      v_request.purpose,
      v_state,
      v_ws.business_name,
      v_doc.number,
      v_doc.revision_no,
      v_doc.lifecycle,
      v_doc.snapshot_json,
      v_doc.snapshot_sha256,
      v_pdf,
      v_key,
      'apr04.v1'::text,
      v_consent,
      v_actions;
end;
$$;

create or replace function commercial.decide_portal_quote(
  p_session_hash text,
  p_operation_id uuid,
  p_decision text,
  p_signer_name text,
  p_consent_version text,
  p_consent_text text,
  p_consent_accepted boolean,
  p_snapshot_sha256 text,
  p_comment text,
  p_encrypted_evidence jsonb,
  p_evidence_key_version integer,
  p_email04_encrypted bytea,
  p_email04_algorithm text,
  p_email04_key_version integer,
  p_email04_nonce bytea,
  p_email04_ciphertext bytea,
  p_email05_encrypted bytea,
  p_email05_algorithm text,
  p_email05_key_version integer,
  p_email05_nonce bytea,
  p_email05_ciphertext bytea
)
returns table (
  request_id uuid,
  document_id uuid,
  decision text,
  decided_at timestamptz,
  number text,
  revision_no integer,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_job commercial.jobs%rowtype;
  v_doc commercial.documents%rowtype;
  v_existing commercial.approval_decisions%rowtype;
  v_decision commercial.approval_decisions%rowtype;
  v_line commercial.document_lines%rowtype;
  v_next_scope integer;
  v_elapsed double precision;
  v_bucket text;
  v_alias uuid;
  v_pdf_ready boolean;
  v_remain_net bigint;
  v_remain_tax bigint;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_operation_id is null
    or p_decision not in ('approve', 'decline')
    or p_signer_name is null or char_length(btrim(p_signer_name)) not between 1 and 120
    or p_consent_version is distinct from 'apr04.v1'
    or p_consent_text is null
    or p_snapshot_sha256 is null or p_snapshot_sha256 !~ '^[0-9a-f]{64}$'
    or (p_comment is not null and char_length(p_comment) > 1000)
    or p_email04_encrypted is null or p_email04_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_email04_nonce) is distinct from 12 or octet_length(p_email04_ciphertext) < 17
    or p_email05_encrypted is null or p_email05_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_email05_nonce) is distinct from 12 or octet_length(p_email05_ciphertext) < 17 then
    raise exception 'invalid portal decision' using errcode = '22023';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_session.workspace_id and ar.id = v_session.request_id
  for update;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.id = v_session.id
  for update;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_existing
  from commercial.approval_decisions d
  where d.workspace_id = v_request.workspace_id and d.request_id = v_request.id;
  if found then
    if v_existing.operation_id = p_operation_id then
      select * into v_doc from commercial.documents where id = v_existing.document_id;
      return query
        select v_request.id, v_existing.document_id, v_existing.decision, v_existing.decided_at,
               v_doc.number, v_doc.revision_no, true;
      return;
    end if;
    raise exception 'ALREADY_DECIDED' using errcode = 'P0022';
  end if;
  if v_request.purpose is distinct from 'approval' then
    raise exception 'VIEW_ONLY_FORBIDDEN' using errcode = 'P0032';
  end if;
  if v_request.state = 'superseded' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  if v_request.state <> 'pending' or v_request.expires_at <= now() then
    if v_request.state = 'pending' then
      update commercial.approval_requests set state = 'expired' where id = v_request.id and state = 'pending';
      update commercial.documents
        set lifecycle = 'expired'
        where workspace_id = v_request.workspace_id and id = v_request.document_id and lifecycle = 'issued';
    end if;
    if v_request.state in ('approved', 'declined') then
      raise exception 'ALREADY_DECIDED' using errcode = 'P0022';
    end if;
    raise exception 'REQUEST_EXPIRED' using errcode = 'P0021';
  end if;
  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_request.workspace_id and j.id = v_request.job_id
  for update;
  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id
  for update;
  if v_doc.snapshot_sha256 is distinct from p_snapshot_sha256 then
    raise exception 'SNAPSHOT_MISMATCH' using errcode = 'P0033';
  end if;
  if v_request.expected_scope_version is distinct from v_job.scope_version then
    raise exception 'SCOPE_CHANGED' using errcode = 'P0034';
  end if;
  select exists (
    select 1 from commercial.artifacts a
    where a.workspace_id = v_doc.workspace_id
      and a.document_id = v_doc.id
      and a.type = 'original_pdf'
      and a.state = 'ready'
  ) into v_pdf_ready;
  if not v_pdf_ready then
    raise exception 'PDF_NOT_READY' using errcode = 'P0030';
  end if;
  if p_decision = 'approve' and p_consent_accepted is not true then
    raise exception 'CONSENT_REQUIRED' using errcode = 'P0031';
  end if;

  begin
    insert into commercial.approval_decisions (
      workspace_id, id, request_id, document_id, decision, signer_name, verified_email,
      decided_at, snapshot_sha256, consent_version, consent_text, comment,
      encrypted_evidence_json, evidence_key_version, operation_id
    ) values (
      v_request.workspace_id, gen_random_uuid(), v_request.id, v_doc.id, p_decision,
      btrim(p_signer_name), v_session.verified_email, now(), p_snapshot_sha256,
      p_consent_version, p_consent_text, nullif(btrim(coalesce(p_comment, '')), ''),
      p_encrypted_evidence, p_evidence_key_version, p_operation_id
    )
    returning * into v_decision;
  exception
    when unique_violation then
      raise exception 'CONCURRENT_DECISION' using errcode = 'P0028';
  end;

  if p_decision = 'approve' then
    v_next_scope := v_job.scope_version + 1;
    for v_line in
      select * from commercial.document_lines l
      where l.workspace_id = v_doc.workspace_id and l.document_id = v_doc.id
      order by l.position, l.id
    loop
      if v_doc.kind = 'change' and v_line.line_kind = 'reduction' then
        select coalesce(sum(se.net_delta_cents), 0), coalesce(sum(se.tax_delta_cents), 0)
          into v_remain_net, v_remain_tax
        from commercial.scope_entries se
        where se.workspace_id = v_doc.workspace_id and se.source_line_id = v_line.source_line_id;
        if v_remain_net < v_line.net_cents then
          raise exception 'CREDIT_EXCEEDS_SOURCE' using errcode = 'P0051';
        end if;
        insert into commercial.scope_entries (
          workspace_id, id, job_id, source_line_id, accepted_document_id, scope_version,
          event_kind, net_delta_cents, tax_delta_cents
        ) values (
          v_request.workspace_id, gen_random_uuid(), v_job.id, v_line.source_line_id, v_doc.id, v_next_scope,
          'reduce', -v_line.net_cents, -v_line.tax_cents
        );
      else
        insert into commercial.scope_entries (
          workspace_id, id, job_id, source_line_id, accepted_document_id, scope_version,
          event_kind, net_delta_cents, tax_delta_cents
        ) values (
          v_request.workspace_id, gen_random_uuid(), v_job.id, v_line.id, v_doc.id, v_next_scope,
          'add', v_line.net_cents, v_line.tax_cents
        );
      end if;
    end loop;
    update commercial.jobs
      set scope_version = v_next_scope,
          version = version + 1
      where workspace_id = v_job.workspace_id and id = v_job.id;
    update commercial.documents
      set lifecycle = 'accepted'
      where workspace_id = v_doc.workspace_id and id = v_doc.id;
    update commercial.approval_requests
      set state = 'approved',
          decided_at = v_decision.decided_at
      where id = v_request.id;
  else
    update commercial.documents
      set lifecycle = 'declined'
      where workspace_id = v_doc.workspace_id and id = v_doc.id;
    update commercial.approval_requests
      set state = 'declined',
          decided_at = v_decision.decided_at
      where id = v_request.id;
  end if;

  update commercial.approval_sessions
    set revoked_at = now()
    where workspace_id = v_request.workspace_id
      and request_id = v_request.id
      and id <> v_session.id
      and revoked_at is null;

  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL04',
    v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL04:' || v_decision.id::text,
    p_email04_encrypted, p_email04_algorithm, p_email04_key_version, p_email04_nonce, p_email04_ciphertext
  );
  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL05',
    v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL05:' || v_decision.id::text,
    p_email05_encrypted, p_email05_algorithm, p_email05_key_version, p_email05_nonce, p_email05_ciphertext
  );

  v_elapsed := extract(epoch from (v_decision.decided_at - v_request.created_at));
  v_bucket := case
    when v_elapsed < 3600 then 'lt_1h'
    when v_elapsed < 86400 then '1_to_24h'
    when v_elapsed < 604800 then '1_to_7d'
    else 'gt_7d'
  end;
  select u.analytics_alias_id into v_alias
  from commercial.workspaces w
  join identity.app_users u on u.id = w.owner_user_id
  where w.workspace_id = v_request.workspace_id;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_request.workspace_id, 'system', null, 'approval_completed', 'document', v_doc.id,
    v_request.id, v_job.version, v_job.version + 1,
    jsonb_build_object('decision', p_decision, 'kind', v_doc.kind)
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_request.workspace_id, gen_random_uuid(), 'approval_completed', 1, now(), v_alias, v_job.id,
      jsonb_build_object(
        'decision', p_decision,
        'document_kind', v_doc.kind,
        'elapsed_bucket', v_bucket
      )
    );
  exception
    when unique_violation then
      null;
  end;

  return query
    select v_request.id, v_doc.id, v_decision.decision, v_decision.decided_at,
           v_doc.number, v_doc.revision_no, false;
end;
$$;

reset role;
