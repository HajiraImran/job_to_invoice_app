-- Invoice void and replacement (S16 / BIL03 / QA42 / QA43).
-- Forward-only. Do not edit 0001–0016.

set role migrator;

create or replace function commercial.protect_issued_document()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_user <> 'purge_app' then
      raise exception 'issued documents cannot be deleted' using errcode = '23001';
    end if;
    return old;
  end if;
  if current_user = 'purge_app' then
    return new;
  end if;
  if current_user = 'migrator'
    and old.lifecycle = 'issued'
    and new.lifecycle in ('accepted', 'declined', 'superseded', 'withdrawn', 'expired', 'voided')
    and new.workspace_id is not distinct from old.workspace_id
    and new.id is not distinct from old.id
    and new.created_at is not distinct from old.created_at
    and new.created_by is not distinct from old.created_by
    and new.job_id is not distinct from old.job_id
    and new.kind is not distinct from old.kind
    and new.number is not distinct from old.number
    and new.revision_no is not distinct from old.revision_no
    and new.prior_document_id is not distinct from old.prior_document_id
    and new.issued_at is not distinct from old.issued_at
    and new.issue_date is not distinct from old.issue_date
    and new.due_date is not distinct from old.due_date
    and new.currency is not distinct from old.currency
    and new.net_cents is not distinct from old.net_cents
    and new.tax_cents is not distinct from old.tax_cents
    and new.total_cents is not distinct from old.total_cents
    and new.snapshot_json is not distinct from old.snapshot_json
    and new.canonical_snapshot_bytes is not distinct from old.canonical_snapshot_bytes
    and new.schema_version is not distinct from old.schema_version
    and new.snapshot_sha256 is not distinct from old.snapshot_sha256
    and new.scope_version is not distinct from old.scope_version
    and (
      new.lifecycle is distinct from 'voided'
        and new.void_reason is not distinct from old.void_reason
      or new.lifecycle = 'voided'
        and old.void_reason is null
        and new.void_reason is not null
    ) then
    return new;
  end if;
  raise exception 'issued documents are immutable' using errcode = '23001';
end;
$$;

create function commercial.void_invoice(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_invoice_id uuid,
  p_reason text,
  p_email_encrypted bytea,
  p_algorithm text,
  p_key_version integer,
  p_nonce bytea,
  p_ciphertext bytea
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
  void_reason text,
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
  v_doc commercial.documents%rowtype;
  v_job commercial.jobs%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_effect text;
  v_payload jsonb;
  v_email bytea;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_invoice_id is null
    or p_reason is null
    or p_email_encrypted is null
    or p_algorithm is distinct from 'aes-256-gcm'
    or p_key_version is null
    or p_nonce is null
    or p_ciphertext is null then
    raise exception 'invalid invoice void' using errcode = '22023';
  end if;
  if p_request_hash !~ '^[0-9a-f]{64}$'
    or char_length(p_reason) < 5
    or char_length(p_reason) > 500
    or p_key_version < 1
    or octet_length(p_nonce) is distinct from 12
    or octet_length(p_ciphertext) < 17 then
    raise exception 'invalid invoice void' using errcode = '22023';
  end if;

  select u.status into v_status from identity.app_users u where u.id = p_actor_id for update;
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
          v_existing.response_json->>'void_reason',
          true;
      return;
    end if;
  end if;

  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = p_invoice_id
  for update;
  if not found or v_doc.kind is distinct from 'invoice' then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_doc.lifecycle = 'voided' then
    raise exception 'issued documents are immutable' using errcode = '23001';
  end if;
  if v_doc.lifecycle is distinct from 'issued' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_doc.job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;

  if exists (
    select 1
    from commercial.documents c
    where c.workspace_id = v_ws
      and c.kind = 'credit'
      and c.lifecycle = 'issued'
      and c.prior_document_id = v_doc.id
  ) or exists (
    select 1
    from commercial.ledger_entries e
    where e.workspace_id = v_ws
      and e.invoice_id = v_doc.id
      and e.type in ('payment', 'refund')
      and not exists (
        select 1
        from commercial.ledger_entries r
        where r.workspace_id = v_ws
          and r.type = 'reversal'
          and r.reverses_entry_id = e.id
      )
  ) then
    raise exception 'LEDGER_BLOCKS_VOID' using errcode = 'P0050';
  end if;

  update commercial.documents
    set lifecycle = 'voided',
        void_reason = p_reason
    where workspace_id = v_ws and id = v_doc.id and lifecycle = 'issued'
    returning * into v_doc;
  if not found then
    raise exception 'issued documents are immutable' using errcode = '23001';
  end if;

  update commercial.jobs
    set active_invoice_id = null,
        version = version + 1
    where workspace_id = v_ws and id = v_job.id
    returning * into v_job;

  update commercial.approval_requests
    set state = 'withdrawn',
        decided_at = coalesce(decided_at, now()),
        updated_at = now()
    where workspace_id = v_ws
      and document_id = v_doc.id
      and state = 'pending';

  update commercial.approval_sessions
    set revoked_at = now()
    where workspace_id = v_ws
      and request_id in (
        select ar.id from commercial.approval_requests ar
        where ar.workspace_id = v_ws and ar.document_id = v_doc.id
      )
      and revoked_at is null;

  update commercial.approval_challenges
    set consumed_at = coalesce(consumed_at, now())
    where workspace_id = v_ws
      and request_id in (
        select ar.id from commercial.approval_requests ar
        where ar.workspace_id = v_ws and ar.document_id = v_doc.id
      )
      and consumed_at is null;

  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws and ar.document_id = v_doc.id
  order by ar.created_at desc, ar.id desc
  limit 1;

  v_email := coalesce((
    select da.recipient_email_encrypted
    from commercial.delivery_attempts da
    where da.workspace_id = v_ws
      and da.document_id = v_doc.id
      and da.template_id = 'EMAIL06'
    order by da.created_at desc, da.id desc
    limit 1
  ), p_email_encrypted);

  if v_request.id is not null then
    v_effect := v_ws::text || ':' || v_doc.id::text || ':EMAIL08:void';
    perform commercial.queue_portal_email(
      v_ws, v_request.id, v_doc.id, 'EMAIL08', v_effect,
      v_email, p_algorithm, p_key_version, p_nonce, p_ciphertext
    );
  end if;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'invoice_voided', 'document', v_doc.id,
    p_request_id, v_job.version - 1, v_job.version,
    jsonb_build_object('reason_len', char_length(p_reason), 'number_retained', true)
  );

  v_payload := jsonb_build_object(
    'id', v_doc.id,
    'workspace_id', v_doc.workspace_id,
    'job_id', v_doc.job_id,
    'draft_id', null,
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
    'pdf_state', 'ready',
    'request_id', v_request.id,
    'delivery_state', 'queued',
    'void_reason', v_doc.void_reason
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/invoices/' || p_invoice_id::text || '/void',
      p_request_hash, gen_random_uuid(),
      'completed', 200, v_payload, null, 'financial'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 200,
          response_json = v_payload,
          permanence = 'financial',
          expires_at = null
      where id = v_existing.id;
  end if;

  return query
    select
      v_doc.id,
      v_doc.workspace_id,
      v_doc.job_id,
      null::uuid,
      v_doc.kind,
      v_doc.number,
      v_doc.revision_no,
      v_doc.lifecycle,
      v_doc.issued_at,
      v_doc.issue_date,
      v_doc.due_date,
      v_doc.currency,
      v_doc.net_cents,
      v_doc.tax_cents,
      v_doc.total_cents,
      v_doc.snapshot_json,
      v_doc.schema_version,
      v_doc.snapshot_sha256,
      'ready'::text,
      v_request.id,
      'queued'::text,
      v_doc.void_reason,
      false;
end;
$$;

revoke all on function commercial.void_invoice(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea) from public;
grant execute on function commercial.void_invoice(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea) to api_app;
revoke all on function commercial.void_invoice(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea)
  from worker_app, purge_app, anon, authenticated;

create function commercial.freeze_replacement_preview(
  p_actor_id uuid,
  p_source_invoice_id uuid,
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
  v_source commercial.documents%rowtype;
  v_draft commercial.document_drafts%rowtype;
begin
  if p_actor_id is null
    or p_source_invoice_id is null
    or p_preview_hash is null
    or p_canonical_bytes is null
    or p_snapshot is null
    or p_expires_at is null then
    raise exception 'invalid replacement preview' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$' or (p_snapshot->>'kind') is distinct from 'invoice' then
    raise exception 'invalid replacement preview' using errcode = '22023';
  end if;

  select u.status into v_status from identity.app_users u where u.id = p_actor_id for update;
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

  select * into v_source
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = p_source_invoice_id
  for update;
  if not found or v_source.kind is distinct from 'invoice' then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_source.lifecycle is distinct from 'voided' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_source.job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.lifecycle is distinct from 'invoiced' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;
  if (p_snapshot->>'net_cents')::bigint is distinct from v_source.net_cents
    or (p_snapshot->>'tax_cents')::bigint is distinct from v_source.tax_cents
    or (p_snapshot->>'total_cents')::bigint is distinct from v_source.total_cents then
    raise exception 'invalid replacement preview' using errcode = '22023';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'invoice'
    and d.draft_state = 'editing'
    and d.parent_document_id = v_source.id
  for update;

  if found then
    update commercial.document_drafts
      set payload_json = jsonb_build_object(
            'due_date', p_snapshot->>'due_date',
            'payment_instructions', coalesce(p_snapshot->>'payment_instructions', ''),
            'source_invoice_id', v_source.id
          ),
          version = v_draft.version + 1,
          preview_hash = p_preview_hash,
          preview_canonical_bytes = p_canonical_bytes,
          preview_snapshot_json = p_snapshot,
          preview_expires_at = p_expires_at,
          preview_draft_version = v_draft.version + 1,
          parent_document_id = v_source.id,
          base_scope_version = v_job.scope_version
      where workspace_id = v_ws and id = v_draft.id
      returning * into v_draft;
  else
    insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, parent_document_id, base_scope_version, payload_json,
      schema_version, draft_state, preview_hash, preview_canonical_bytes, preview_snapshot_json,
      preview_expires_at, preview_draft_version
    ) values (
      v_ws, gen_random_uuid(), v_job.id, 'invoice', v_source.id, v_job.scope_version,
      jsonb_build_object(
        'due_date', p_snapshot->>'due_date',
        'payment_instructions', coalesce(p_snapshot->>'payment_instructions', ''),
        'source_invoice_id', v_source.id
      ),
      1, 'editing', p_preview_hash, p_canonical_bytes, p_snapshot, p_expires_at, 1
    )
    returning * into v_draft;
  end if;

  return query
    select
      v_draft.id,
      v_draft.workspace_id,
      v_draft.job_id,
      v_draft.version,
      v_draft.preview_hash,
      v_draft.preview_expires_at,
      v_draft.preview_snapshot_json;
end;
$$;

revoke all on function commercial.freeze_replacement_preview(uuid, uuid, text, bytea, jsonb, timestamptz) from public;
grant execute on function commercial.freeze_replacement_preview(uuid, uuid, text, bytea, jsonb, timestamptz) to api_app;
revoke all on function commercial.freeze_replacement_preview(uuid, uuid, text, bytea, jsonb, timestamptz)
  from worker_app, purge_app, anon, authenticated;

create function commercial.issue_replacement(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_source_invoice_id uuid,
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
  v_source commercial.documents%rowtype;
  v_seq integer;
  v_number text;
  v_doc commercial.documents%rowtype;
  v_line jsonb;
  v_payload jsonb;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_effect text;
  v_due date;
  v_issue date;
  v_email text;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_source_invoice_id is null
    or p_preview_hash is null
    or p_token_hash is null
    or p_token_key_version is null
    or p_encrypted_email is null
    or p_token_ciphertext is null
    or p_token_nonce is null
    or p_delivery_algorithm is null
    or p_delivery_key_version is null
    or p_access_until is null then
    raise exception 'invalid replacement issue' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$'
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_key_version < 1
    or p_delivery_key_version < 1
    or p_delivery_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_token_nonce) is distinct from 12
    or octet_length(p_token_ciphertext) < 17 then
    raise exception 'invalid replacement issue' using errcode = '22023';
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

  select * into v_source
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = p_source_invoice_id
  for update;
  if not found or v_source.kind is distinct from 'invoice' then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_source.lifecycle is distinct from 'voided' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_source.job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.lifecycle is distinct from 'invoiced' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'invoice'
    and d.draft_state = 'editing'
    and d.parent_document_id = v_source.id
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
    or (v_draft.preview_snapshot_json->>'net_cents')::bigint is distinct from v_source.net_cents
    or (v_draft.preview_snapshot_json->>'tax_cents')::bigint is distinct from v_source.tax_cents
    or (v_draft.preview_snapshot_json->>'total_cents')::bigint is distinct from v_source.total_cents then
    raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
  end if;

  v_issue := (v_draft.preview_snapshot_json->>'issue_date')::date;
  v_due := (v_draft.preview_snapshot_json->>'due_date')::date;
  if v_issue is null or v_due is null or v_due < v_issue or v_due > v_issue + 365 then
    raise exception 'invalid replacement issue' using errcode = '22023';
  end if;

  v_email := nullif(btrim(v_draft.preview_snapshot_json#>>'{customer,email}'), '');
  if v_email is null then
    raise exception 'invalid replacement issue' using errcode = '22023';
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
    v_ws, gen_random_uuid(), p_actor_id, v_job.id, 'invoice', v_number, 1, v_source.id,
    'issued', now(), v_issue, v_due, 'USD',
    v_source.net_cents, v_source.tax_cents, v_source.total_cents,
    v_draft.preview_snapshot_json, v_draft.preview_canonical_bytes,
    coalesce((v_draft.preview_snapshot_json->>'schema_version')::integer, 1),
    v_draft.preview_hash, v_job.scope_version
  )
  returning * into v_doc;

  for v_line in
    select value from jsonb_array_elements(coalesce(v_draft.preview_snapshot_json->'lines', '[]'::jsonb))
  loop
    insert into commercial.document_lines (
      workspace_id, id, document_id, position, line_kind, source_line_id, description, quantity, unit,
      unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
    ) values (
      v_ws, gen_random_uuid(), v_doc.id,
      (v_line->>'position')::integer, 'source', (v_line->>'source_line_id')::uuid, v_line->>'description',
      (v_line->>'quantity')::numeric, v_line->>'unit',
      (v_line->>'unit_price_cents')::bigint, (v_line->>'discount_cents')::bigint,
      (v_line->>'net_cents')::bigint, (v_line->>'tax_bp')::integer,
      (v_line->>'tax_cents')::bigint, (v_line->>'total_cents')::bigint
    );
  end loop;

  update commercial.document_drafts
    set draft_state = 'published',
        parent_document_id = v_doc.id
    where workspace_id = v_ws and id = v_draft.id;

  update commercial.jobs
    set lifecycle = 'invoiced',
        active_invoice_id = v_doc.id,
        version = version + 1
    where workspace_id = v_ws and id = v_job.id;

  insert into commercial.approval_requests (
    workspace_id, id, job_id, document_id, purpose, recipient_name, recipient_email,
    token_hash, token_key_version, state, expected_scope_version, expires_at, access_until
  ) values (
    v_ws, gen_random_uuid(), v_job.id, v_doc.id, 'view_only',
    coalesce(v_draft.preview_snapshot_json#>>'{customer,name}', ''),
    v_email,
    p_token_hash, p_token_key_version, 'pending', v_job.scope_version,
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
    v_ws, gen_random_uuid(), gen_random_uuid(), 'generate_original_pdf', v_doc.id,
    jsonb_build_object('document_id', v_doc.id, 'kind', 'invoice'),
    1, now(), 0, 'pending',
    v_ws::text || ':' || v_doc.id::text || ':original_pdf'
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

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'invoice_issued', 'document', v_doc.id,
    p_request_id, v_job.version, v_job.version + 1,
    jsonb_build_object('kind', 'invoice', 'quote_based', true, 'replacement', true)
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'invoice_issued', 1, now(), v_alias, v_job.id,
      jsonb_build_object('origin', 'quote_based', 'has_changes', false)
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
      v_ws, p_actor_id, p_idempotency_key,
      '/v1/invoices/' || p_source_invoice_id::text || '/issue-replacement',
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
      v_doc.id,
      v_doc.workspace_id,
      v_doc.job_id,
      v_draft.id,
      v_doc.kind,
      v_doc.number,
      v_doc.revision_no,
      v_doc.lifecycle,
      v_doc.issued_at,
      v_doc.issue_date,
      v_doc.due_date,
      v_doc.currency,
      v_doc.net_cents,
      v_doc.tax_cents,
      v_doc.total_cents,
      v_doc.snapshot_json,
      v_doc.schema_version,
      v_doc.snapshot_sha256,
      'preparing'::text,
      v_request.id,
      'queued'::text,
      false;
end;
$$;

revoke all on function commercial.issue_replacement(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) from public;
grant execute on function commercial.issue_replacement(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) to api_app;
revoke all on function commercial.issue_replacement(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)
  from worker_app, purge_app, anon, authenticated;

reset role;
