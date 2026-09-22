-- Direct invoice without quote (JRN06 / API04 / QA44).
-- Forward-only. Do not edit 0001–0018.

set role migrator;

create function commercial.open_direct_invoice_draft(
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
  v_tax integer;
  v_existing commercial.idempotency_records%rowtype;
  v_job commercial.jobs%rowtype;
  v_draft commercial.document_drafts%rowtype;
  v_payload jsonb;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_job_id is null then
    raise exception 'invalid direct invoice draft open' using errcode = '22023';
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

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = p_job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.mode is distinct from 'direct_invoice' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.lifecycle is distinct from 'draft' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if exists (
    select 1 from commercial.documents d
    where d.workspace_id = v_ws and d.job_id = v_job.id and d.kind = 'invoice'
  ) then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'invoice'
    and d.draft_state = 'editing'
  order by d.created_at asc, d.id asc
  limit 1
  for update;

  if not found then
    insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, parent_document_id, base_scope_version, payload_json,
      schema_version, draft_state
    ) values (
      v_ws, gen_random_uuid(), v_job.id, 'invoice', null, v_job.scope_version,
      jsonb_build_object(
        'direct_invoice', true,
        'issue_acknowledgement', false,
        'due_date', null,
        'payment_instructions', '',
        'notes', '',
        'customer_email', null,
        'lines', '[]'::jsonb
      ),
      1, 'editing'
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
      v_ws, p_actor_id, p_idempotency_key, '/v1/jobs/' || p_job_id::text || '/direct-invoice',
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

revoke all on function commercial.open_direct_invoice_draft(uuid, uuid, text, uuid, uuid) from public;
grant execute on function commercial.open_direct_invoice_draft(uuid, uuid, text, uuid, uuid) to api_app;
revoke all on function commercial.open_direct_invoice_draft(uuid, uuid, text, uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

create function commercial.save_direct_invoice_draft(
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
    raise exception 'invalid direct invoice draft save' using errcode = '22023';
  end if;
  if p_expected_version < 1 or jsonb_typeof(p_payload) is distinct from 'object'
    or (p_payload->>'direct_invoice') is distinct from 'true' then
    raise exception 'invalid direct invoice draft save' using errcode = '22023';
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
  if v_draft.kind is distinct from 'invoice' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'direct_invoice' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.lifecycle is distinct from 'draft' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  update commercial.document_drafts
    set payload_json = p_payload,
        version = version + 1
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

revoke all on function commercial.save_direct_invoice_draft(uuid, uuid, text, uuid, uuid, integer, jsonb) from public;
grant execute on function commercial.save_direct_invoice_draft(uuid, uuid, text, uuid, uuid, integer, jsonb) to api_app;
revoke all on function commercial.save_direct_invoice_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)
  from worker_app, purge_app, anon, authenticated;

create function commercial.freeze_direct_invoice_preview(
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
    raise exception 'invalid direct invoice preview' using errcode = '22023';
  end if;
  if p_expected_version < 1 or p_preview_hash !~ '^[0-9a-f]{64}$'
    or (p_snapshot->>'kind') is distinct from 'invoice'
    or (p_snapshot->>'origin') is distinct from 'direct'
    or (p_snapshot->>'no_prior_approval') is distinct from 'true' then
    raise exception 'invalid direct invoice preview' using errcode = '22023';
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
  if v_draft.kind is distinct from 'invoice' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  if (v_draft.payload_json->>'issue_acknowledgement') is distinct from 'true'
    or (v_draft.payload_json->>'direct_invoice') is distinct from 'true'
    or nullif(btrim(coalesce(v_draft.payload_json->>'due_date', '')), '') is null
    or nullif(btrim(coalesce(v_draft.payload_json->>'payment_instructions', '')), '') is null then
    raise exception 'invalid direct invoice preview' using errcode = '22023';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'direct_invoice' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.lifecycle is distinct from 'draft' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
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

revoke all on function commercial.freeze_direct_invoice_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz) from public;
grant execute on function commercial.freeze_direct_invoice_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz) to api_app;
revoke all on function commercial.freeze_direct_invoice_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz)
  from worker_app, purge_app, anon, authenticated;

create function commercial.issue_direct_invoice(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid,
  p_preview_hash text,
  p_token_hash text,
  p_token_key_version integer,
  p_encrypted_email bytea,
  p_token_ciphertext bytea,
  p_token_nonce bytea,
  p_delivery_algorithm text,
  p_delivery_key_version integer,
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
  v_allow commercial.job_allowances%rowtype;
  v_origin text;
  v_first boolean := false;
  v_seq integer;
  v_number text;
  v_doc commercial.documents%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_payload jsonb;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_effect text;
  v_due date;
  v_issue date;
  v_email text;
  v_has_delivery boolean := false;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_job_id is null or p_preview_hash is null then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;
  v_has_delivery := p_token_hash is not null;
  if v_has_delivery then
    if p_token_hash !~ '^[0-9a-f]{64}$'
      or p_token_key_version is null or p_token_key_version < 1
      or p_encrypted_email is null or p_token_ciphertext is null or p_token_nonce is null
      or p_delivery_algorithm is distinct from 'aes-256-gcm'
      or p_delivery_key_version is null or p_delivery_key_version < 1
      or octet_length(p_token_nonce) is distinct from 12
      or octet_length(p_token_ciphertext) < 17
      or p_access_until is null then
      raise exception 'invalid invoice issue' using errcode = '22023';
    end if;
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

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = p_job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.mode is distinct from 'direct_invoice' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.lifecycle is distinct from 'draft' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'invoice'
    and d.draft_state = 'editing'
  for update;
  if not found then
    raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
  end if;
  if v_draft.preview_hash is distinct from p_preview_hash
    or v_draft.preview_expires_at is null
    or v_draft.preview_expires_at <= now()
    or v_draft.preview_canonical_bytes is null
    or v_draft.preview_snapshot_json is null
    or (v_draft.preview_snapshot_json->>'kind') is distinct from 'invoice'
    or (v_draft.preview_snapshot_json->>'origin') is distinct from 'direct'
    or (v_draft.payload_json->>'issue_acknowledgement') is distinct from 'true' then
    raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
  end if;

  select * into v_allow
  from commercial.job_allowances a
  where a.workspace_id = v_ws
  for update;
  if not found then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;
  if v_job.first_published_at is null then
    if v_allow.free_jobs_consumed >= 3 then
      raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
    end if;
    update commercial.job_allowances
      set free_jobs_consumed = free_jobs_consumed + 1,
          version = version + 1
      where workspace_id = v_ws;
    v_origin := 'free';
    v_first := true;
  else
    if v_job.completion_right is not true then
      raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
    end if;
    v_origin := v_job.entitlement_origin;
  end if;

  v_issue := (v_draft.preview_snapshot_json->>'issue_date')::date;
  v_due := (v_draft.preview_snapshot_json->>'due_date')::date;
  if v_issue is null or v_due is null or v_due < v_issue or v_due > v_issue + 365 then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;

  v_email := nullif(btrim(v_draft.preview_snapshot_json#>>'{customer,email}'), '');
  if v_email is not null and not v_has_delivery then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;

  insert into commercial.document_counters as c (workspace_id, type, next_value)
  values (v_ws, 'invoice', 1)
  on conflict (workspace_id, type)
  do update set next_value = c.next_value + 1, version = c.version + 1
  returning next_value into v_seq;
  v_number := 'INV-' || lpad(v_seq::text, 6, '0');

  insert into commercial.documents (
    workspace_id, id, created_by, job_id, kind, number, revision_no, prior_document_id,
    lifecycle, issued_at, issue_date, due_date, currency, net_cents, tax_cents, total_cents,
    snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256, scope_version
  ) values (
    v_ws, gen_random_uuid(), p_actor_id, v_job.id, 'invoice', v_number, 1, null,
    'issued', now(), v_issue, v_due, 'USD',
    (v_draft.preview_snapshot_json->>'net_cents')::bigint,
    (v_draft.preview_snapshot_json->>'tax_cents')::bigint,
    (v_draft.preview_snapshot_json->>'total_cents')::bigint,
    v_draft.preview_snapshot_json, v_draft.preview_canonical_bytes,
    coalesce((v_draft.preview_snapshot_json->>'schema_version')::integer, 1),
    v_draft.preview_hash, 1
  )
  returning * into v_doc;

  for v_line in
    select value from jsonb_array_elements(coalesce(v_draft.preview_snapshot_json->'lines', '[]'::jsonb))
  loop
    v_line_id := coalesce(nullif(v_line->>'source_line_id', '')::uuid, gen_random_uuid());
    insert into commercial.document_lines (
      workspace_id, id, document_id, position, line_kind, description, quantity, unit,
      unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
    ) values (
      v_ws, v_line_id, v_doc.id,
      (v_line->>'position')::integer, 'source', v_line->>'description',
      (v_line->>'quantity')::numeric, v_line->>'unit',
      (v_line->>'unit_price_cents')::bigint, (v_line->>'discount_cents')::bigint,
      (v_line->>'net_cents')::bigint, (v_line->>'tax_bp')::integer,
      (v_line->>'tax_cents')::bigint, (v_line->>'total_cents')::bigint
    );
    insert into commercial.scope_entries (
      workspace_id, id, job_id, source_line_id, accepted_document_id, scope_version,
      event_kind, net_delta_cents, tax_delta_cents
    ) values (
      v_ws, gen_random_uuid(), v_job.id, v_line_id, v_doc.id, 1,
      'add', (v_line->>'net_cents')::bigint, (v_line->>'tax_cents')::bigint
    );
  end loop;

  update commercial.document_drafts
    set draft_state = 'published',
        parent_document_id = v_doc.id
    where workspace_id = v_ws and id = v_draft.id;

  update commercial.jobs
    set lifecycle = 'invoiced',
        active_invoice_id = v_doc.id,
        first_published_at = case when v_first then now() else first_published_at end,
        completion_right = true,
        entitlement_origin = coalesce(entitlement_origin, v_origin),
        scope_version = 1,
        version = version + 1
    where workspace_id = v_ws and id = v_job.id;

  if v_email is not null then
    insert into commercial.approval_requests (
      workspace_id, id, job_id, document_id, purpose, recipient_name, recipient_email,
      token_hash, token_key_version, state, expected_scope_version, expires_at, access_until
    ) values (
      v_ws, gen_random_uuid(), v_job.id, v_doc.id, 'view_only',
      coalesce(v_draft.preview_snapshot_json#>>'{customer,name}', ''),
      v_email,
      p_token_hash, p_token_key_version, 'pending', 1,
      p_access_until, p_access_until
    )
    returning * into v_request;

    v_effect := v_ws::text || ':' || v_doc.id::text || ':EMAIL06:' || v_request.id::text;

    insert into commercial.delivery_attempts (
      workspace_id, id, document_id, request_id, template_id, recipient_email_encrypted,
      state, effect_key, last_event_at, retry_count
    ) values (
      v_ws, gen_random_uuid(), v_doc.id, v_request.id, 'EMAIL06', p_encrypted_email,
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
      v_ws, gen_random_uuid(), gen_random_uuid(), 'send_email', v_request.id,
      jsonb_build_object(
        'document_id', v_doc.id,
        'request_id', v_request.id,
        'template_id', 'EMAIL06'
      ),
      1, now(), 0, 'pending',
      v_effect
    );
  end if;

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json, schema_version,
    available_at, attempts, status, effect_key
  ) values (
    v_ws, gen_random_uuid(), gen_random_uuid(), 'generate_original_pdf', v_doc.id,
    jsonb_build_object('document_id', v_doc.id, 'kind', 'invoice'),
    1, now(), 0, 'pending',
    v_ws::text || ':' || v_doc.id::text || ':original_pdf'
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'invoice_issued', 'document', v_doc.id,
    p_request_id, v_job.version, v_job.version + 1,
    jsonb_build_object('kind', 'invoice', 'quote_based', false)
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'invoice_issued', 1, now(), v_alias, v_job.id,
      jsonb_build_object('origin', 'direct', 'has_changes', false)
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
    'delivery_state', case when v_email is null then 'not_requested' else 'queued' end
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/jobs/' || p_job_id::text || '/issue-invoice',
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
      v_doc.schema_version, v_doc.snapshot_sha256, 'preparing'::text, v_request.id,
      case when v_email is null then 'not_requested' else 'queued' end, false;
end;
$$;

revoke all on function commercial.issue_direct_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) from public;
grant execute on function commercial.issue_direct_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) to api_app;
revoke all on function commercial.issue_direct_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)
  from worker_app, purge_app, anon, authenticated;

reset role;
