-- Quote-based invoice issue (TX03 / S15 / S16 / EMAIL06).
-- Forward-only. Do not edit 0001–0012.

set role migrator;

alter table commercial.jobs
  add constraint jobs_active_invoice_fk
  foreign key (workspace_id, active_invoice_id)
  references commercial.documents (workspace_id, id)
  on delete restrict;

create unique index documents_one_active_invoice
  on commercial.documents (workspace_id, job_id)
  where kind = 'invoice' and lifecycle is distinct from 'voided';

create unique index document_drafts_one_editing_invoice
  on commercial.document_drafts (workspace_id, job_id)
  where kind = 'invoice' and draft_state = 'editing';

alter table commercial.delivery_attempts
  drop constraint if exists delivery_attempts_template_id_check;

alter table commercial.delivery_attempts
  drop constraint if exists delivery_attempts_template_check;

alter table commercial.delivery_attempts
  add constraint delivery_attempts_template_check
  check (template_id in ('EMAIL01', 'EMAIL03', 'EMAIL04', 'EMAIL05', 'EMAIL06', 'EMAIL08'));

create or replace function commercial.claim_generate_original_pdf()
returns table (
  id uuid,
  workspace_id uuid,
  aggregate_id uuid,
  payload_json jsonb,
  attempts integer,
  created_by uuid,
  number text,
  revision_no integer
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_task commercial.outbox_tasks%rowtype;
  v_doc commercial.documents%rowtype;
begin
  select o.*
    into v_task
  from commercial.outbox_tasks o
  where o.task_type = 'generate_original_pdf'
    and o.attempts < 5
    and (
      (o.status = 'pending' and o.available_at <= now())
      or (o.status = 'running' and o.lease_until is not null and o.lease_until < now())
    )
  order by o.available_at, o.id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;

  select d.*
    into v_doc
  from commercial.documents d
  where d.workspace_id = v_task.workspace_id
    and d.id = v_task.aggregate_id
  for update;
  if not found or v_doc.kind not in ('quote', 'invoice') then
    update commercial.outbox_tasks
      set status = 'dead',
          last_error_code = 'VALIDATION_FAILED',
          lease_until = null
      where outbox_tasks.id = v_task.id;
    return;
  end if;

  update commercial.outbox_tasks
    set status = 'running',
        attempts = outbox_tasks.attempts + 1,
        lease_until = now() + interval '60 seconds'
    where outbox_tasks.id = v_task.id
    returning * into v_task;

  return query
    select
      v_task.id,
      v_task.workspace_id,
      v_task.aggregate_id,
      v_task.payload_json,
      v_task.attempts,
      v_doc.created_by,
      v_doc.number,
      v_doc.revision_no;
end;
$$;

create or replace function commercial.load_original_pdf_source(p_task_id uuid)
returns table (
  workspace_id uuid,
  document_id uuid,
  created_by uuid,
  number text,
  revision_no integer,
  snapshot_json jsonb,
  net_cents bigint,
  tax_cents bigint,
  total_cents bigint,
  lines_json jsonb
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_task commercial.outbox_tasks%rowtype;
  v_doc commercial.documents%rowtype;
  v_lines jsonb;
begin
  if p_task_id is null then
    raise exception 'invalid pdf source' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id and task_type = 'generate_original_pdf';
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  select * into v_doc
  from commercial.documents
  where workspace_id = v_task.workspace_id and id = v_task.aggregate_id;
  if not found or v_doc.kind not in ('quote', 'invoice') then
    raise exception 'VALIDATION_FAILED' using errcode = 'P0006';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'position', l.position,
    'description', l.description,
    'quantity', l.quantity,
    'unit', l.unit,
    'unit_price_cents', l.unit_price_cents,
    'discount_cents', l.discount_cents,
    'net_cents', l.net_cents,
    'tax_bp', l.tax_bp,
    'tax_cents', l.tax_cents,
    'total_cents', l.total_cents
  ) order by l.position, l.id), '[]'::jsonb)
    into v_lines
  from commercial.document_lines l
  where l.workspace_id = v_doc.workspace_id and l.document_id = v_doc.id;
  return query
    select
      v_doc.workspace_id,
      v_doc.id,
      v_doc.created_by,
      v_doc.number,
      v_doc.revision_no,
      v_doc.snapshot_json,
      v_doc.net_cents,
      v_doc.tax_cents,
      v_doc.total_cents,
      v_lines;
end;
$$;

create or replace function commercial.complete_original_pdf(
  p_task_id uuid,
  p_artifact_id uuid,
  p_object_key text,
  p_sha256 text,
  p_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_task commercial.outbox_tasks%rowtype;
  v_existing commercial.artifacts%rowtype;
  v_kind text;
  v_template text;
begin
  if p_task_id is null or p_artifact_id is null or p_object_key is null or p_sha256 is null or p_bytes is null then
    raise exception 'invalid pdf complete' using errcode = '22023';
  end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' or p_bytes < 1 then
    raise exception 'invalid pdf complete' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id and task_type = 'generate_original_pdf'
  for update;
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;

  select * into v_existing
  from commercial.artifacts
  where workspace_id = v_task.workspace_id
    and document_id = v_task.aggregate_id
    and type = 'original_pdf';
  if found then
    if v_existing.id is distinct from p_artifact_id
      or v_existing.object_key is distinct from p_object_key then
      raise exception 'ORIGINAL_CONFLICT' using errcode = 'P0011';
    end if;
    update commercial.outbox_tasks
      set status = 'done', lease_until = null, last_error_code = null
      where id = p_task_id;
    return true;
  end if;

  select kind into v_kind
  from commercial.documents
  where workspace_id = v_task.workspace_id and id = v_task.aggregate_id;
  v_template := case v_kind
    when 'invoice' then 'invoice-original-v1'
    else 'quote-original-v1'
  end;

  insert into commercial.artifacts (
    workspace_id, id, document_id, type, object_key, sha256, bytes,
    template_version, generated_at, state
  ) values (
    v_task.workspace_id, p_artifact_id, v_task.aggregate_id, 'original_pdf',
    p_object_key, p_sha256, p_bytes, v_template, now(), 'ready'
  );

  update commercial.outbox_tasks
    set status = 'done', lease_until = null, last_error_code = null
    where id = p_task_id;
  return false;
end;
$$;

create or replace function commercial.original_pdf_download(p_workspace_id uuid, p_document_id uuid)
returns table (
  download_state text,
  object_key text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_doc commercial.documents%rowtype;
  v_art commercial.artifacts%rowtype;
  v_dead boolean;
begin
  if p_workspace_id is null or p_document_id is null then
    raise exception 'invalid pdf download' using errcode = '22023';
  end if;
  select * into v_doc
  from commercial.documents
  where workspace_id = p_workspace_id and id = p_document_id and kind in ('quote', 'invoice');
  if not found then
    return;
  end if;
  select * into v_art
  from commercial.artifacts
  where workspace_id = p_workspace_id
    and document_id = p_document_id
    and type = 'original_pdf'
    and state = 'ready';
  if found then
    return query select 'ready'::text, v_art.object_key;
    return;
  end if;
  select exists (
    select 1
    from commercial.outbox_tasks
    where workspace_id = p_workspace_id
      and aggregate_id = p_document_id
      and task_type = 'generate_original_pdf'
      and status = 'dead'
  ) into v_dead;
  if v_dead then
    return query select 'failed'::text, null::text;
    return;
  end if;
  return query select 'preparing'::text, null::text;
end;
$$;

create or replace function commercial.claim_send_email()
returns table (
  id uuid,
  workspace_id uuid,
  request_id uuid,
  document_id uuid,
  delivery_attempt_id uuid,
  template_id text,
  effect_key text,
  attempts integer,
  created_by uuid,
  recipient_email text,
  business_name text,
  number text,
  revision_no integer,
  algorithm text,
  key_version integer,
  nonce bytea,
  ciphertext bytea,
  fail_without_send boolean,
  provider_message_id text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_task commercial.outbox_tasks%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_payload commercial.encrypted_delivery_payloads%rowtype;
  v_doc commercial.documents%rowtype;
  v_ws commercial.workspaces%rowtype;
  v_pdf_ready boolean;
  v_pdf_dead boolean;
  v_wait_pdf boolean;
  v_recipient text;
begin
  select o.*
    into v_task
  from commercial.outbox_tasks o
  where o.task_type = 'send_email'
    and o.attempts < 5
    and (
      (o.status = 'pending' and o.available_at <= now())
      or (o.status = 'running' and o.lease_until is not null and o.lease_until < now())
    )
    and (
      coalesce(o.payload_json->>'template_id', '') in ('EMAIL03', 'EMAIL05')
      or exists (
        select 1
        from commercial.approval_requests ar
        join commercial.documents d
          on d.workspace_id = ar.workspace_id and d.id = ar.document_id
        where ar.workspace_id = o.workspace_id
          and ar.id = o.aggregate_id
          and (
            exists (
              select 1
              from commercial.artifacts a
              where a.workspace_id = d.workspace_id
                and a.document_id = d.id
                and a.type = 'original_pdf'
                and a.state = 'ready'
            )
            or exists (
              select 1
              from commercial.outbox_tasks p
              where p.workspace_id = d.workspace_id
                and p.aggregate_id = d.id
                and p.task_type = 'generate_original_pdf'
                and p.status = 'dead'
            )
          )
      )
    )
  order by o.available_at, o.id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;

  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_task.workspace_id and ar.id = v_task.aggregate_id
  for update;
  if not found then
    update commercial.outbox_tasks
      set status = 'dead', last_error_code = 'VALIDATION_FAILED', lease_until = null
      where outbox_tasks.id = v_task.id;
    return;
  end if;

  select * into v_attempt
  from commercial.delivery_attempts da
  where da.workspace_id = v_request.workspace_id and da.effect_key = v_task.effect_key
  for update;
  if not found then
    update commercial.outbox_tasks
      set status = 'dead', last_error_code = 'VALIDATION_FAILED', lease_until = null
      where outbox_tasks.id = v_task.id;
    return;
  end if;

  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id
  for update;
  if not found then
    update commercial.outbox_tasks
      set status = 'dead', last_error_code = 'VALIDATION_FAILED', lease_until = null
      where outbox_tasks.id = v_task.id;
    return;
  end if;

  v_wait_pdf := v_attempt.template_id in ('EMAIL01', 'EMAIL04', 'EMAIL06');
  select exists (
    select 1
    from commercial.artifacts a
    where a.workspace_id = v_doc.workspace_id
      and a.document_id = v_doc.id
      and a.type = 'original_pdf'
      and a.state = 'ready'
  ) into v_pdf_ready;
  select exists (
    select 1
    from commercial.outbox_tasks p
    where p.workspace_id = v_doc.workspace_id
      and p.aggregate_id = v_doc.id
      and p.task_type = 'generate_original_pdf'
      and p.status = 'dead'
  ) into v_pdf_dead;

  if v_wait_pdf and not v_pdf_ready and v_pdf_dead then
    update commercial.delivery_attempts
      set state = 'failed',
          last_event_at = now()
      where id = v_attempt.id;
    update commercial.encrypted_delivery_payloads
      set purge_after = now() + interval '24 hours'
      where delivery_attempt_id = v_attempt.id and purged_at is null;
    update commercial.outbox_tasks
      set status = 'dead',
          last_error_code = 'PDF_FAILED',
          lease_until = null
      where id = v_task.id;
    select * into v_ws from commercial.workspaces where workspace_id = v_request.workspace_id;
    return query
      select
        v_task.id,
        v_request.workspace_id,
        v_request.id,
        v_request.document_id,
        v_attempt.id,
        v_attempt.template_id,
        v_attempt.effect_key,
        v_task.attempts,
        v_doc.created_by,
        v_request.recipient_email,
        v_ws.business_name,
        v_doc.number,
        v_doc.revision_no,
        null::text,
        null::integer,
        null::bytea,
        null::bytea,
        true,
        v_attempt.provider_message_id;
    return;
  end if;

  if v_wait_pdf and not v_pdf_ready then
    return;
  end if;

  update commercial.outbox_tasks
    set status = 'running',
        attempts = outbox_tasks.attempts + 1,
        lease_until = now() + interval '60 seconds'
    where outbox_tasks.id = v_task.id
    returning * into v_task;

  if v_attempt.state = 'queued' then
    update commercial.delivery_attempts
      set state = 'submitting',
          last_event_at = now()
      where id = v_attempt.id
      returning * into v_attempt;
  end if;

  select * into v_payload
  from commercial.encrypted_delivery_payloads
  where delivery_attempt_id = v_attempt.id and purged_at is null;
  if not found then
    update commercial.outbox_tasks
      set status = 'dead', last_error_code = 'VALIDATION_FAILED', lease_until = null
      where id = v_task.id;
    return;
  end if;

  select * into v_ws from commercial.workspaces where workspace_id = v_request.workspace_id;
  v_recipient := case
    when v_attempt.template_id = 'EMAIL05' then v_ws.contact_email
    else v_request.recipient_email
  end;

  return query
    select
      v_task.id,
      v_request.workspace_id,
      v_request.id,
      v_request.document_id,
      v_attempt.id,
      v_attempt.template_id,
      v_attempt.effect_key,
      v_task.attempts,
      v_doc.created_by,
      v_recipient,
      v_ws.business_name,
      v_doc.number,
      v_doc.revision_no,
      v_payload.algorithm,
      v_payload.key_version,
      v_payload.nonce,
      v_payload.ciphertext,
      false,
      v_attempt.provider_message_id;
end;
$$;

create function commercial.freeze_invoice_preview(
  p_actor_id uuid,
  p_job_id uuid,
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
  v_quote commercial.documents%rowtype;
  v_draft commercial.document_drafts%rowtype;
  v_pending uuid;
  v_change uuid;
begin
  if p_actor_id is null
    or p_job_id is null
    or p_preview_hash is null
    or p_canonical_bytes is null
    or p_snapshot is null
    or p_expires_at is null then
    raise exception 'invalid invoice preview' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$' or (p_snapshot->>'kind') is distinct from 'invoice' then
    raise exception 'invalid invoice preview' using errcode = '22023';
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
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;

  select * into v_quote
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = v_job.current_quote_id
  for update;
  if not found or v_quote.kind is distinct from 'quote' or v_quote.lifecycle is distinct from 'accepted' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select ar.id into v_pending
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws
    and ar.job_id = v_job.id
    and ar.state = 'pending'
    and ar.purpose = 'approval'
  for update;
  if v_pending is not null then
    raise exception 'UNRESOLVED_CHANGES' using errcode = 'P0043';
  end if;

  select d.id into v_change
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'change'
    and d.draft_state = 'editing'
  for update;
  if v_change is not null then
    raise exception 'UNRESOLVED_CHANGES' using errcode = 'P0043';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'invoice'
    and d.draft_state = 'editing'
  for update;

  if found then
    update commercial.document_drafts
      set payload_json = jsonb_build_object(
            'due_date', p_snapshot->>'due_date',
            'payment_instructions', coalesce(p_snapshot->>'payment_instructions', '')
          ),
          version = v_draft.version + 1,
          preview_hash = p_preview_hash,
          preview_canonical_bytes = p_canonical_bytes,
          preview_snapshot_json = p_snapshot,
          preview_expires_at = p_expires_at,
          preview_draft_version = v_draft.version + 1,
          parent_document_id = v_quote.id,
          base_scope_version = v_job.scope_version
      where workspace_id = v_ws and id = v_draft.id
      returning * into v_draft;
  else
    insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, parent_document_id, base_scope_version, payload_json,
      schema_version, draft_state, preview_hash, preview_canonical_bytes, preview_snapshot_json,
      preview_expires_at, preview_draft_version
    ) values (
      v_ws, gen_random_uuid(), v_job.id, 'invoice', v_quote.id, v_job.scope_version,
      jsonb_build_object(
        'due_date', p_snapshot->>'due_date',
        'payment_instructions', coalesce(p_snapshot->>'payment_instructions', '')
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

create function commercial.issue_invoice(
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
  v_quote commercial.documents%rowtype;
  v_seq integer;
  v_number text;
  v_doc commercial.documents%rowtype;
  v_line jsonb;
  v_payload jsonb;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_pending uuid;
  v_change uuid;
  v_effect text;
  v_due date;
  v_issue date;
  v_residual_net bigint;
  v_residual_tax bigint;
  v_email text;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_job_id is null
    or p_preview_hash is null
    or p_token_hash is null
    or p_token_key_version is null
    or p_encrypted_email is null
    or p_token_ciphertext is null
    or p_token_nonce is null
    or p_delivery_algorithm is null
    or p_delivery_key_version is null
    or p_access_until is null then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$'
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_key_version < 1
    or p_delivery_key_version < 1
    or p_delivery_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_token_nonce) is distinct from 12
    or octet_length(p_token_ciphertext) < 17 then
    raise exception 'invalid invoice issue' using errcode = '22023';
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
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;

  select * into v_quote
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = v_job.current_quote_id
  for update;
  if not found or v_quote.kind is distinct from 'quote' or v_quote.lifecycle is distinct from 'accepted' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select ar.id into v_pending
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws
    and ar.job_id = v_job.id
    and ar.state = 'pending'
    and ar.purpose = 'approval'
  for update;
  if v_pending is not null then
    raise exception 'UNRESOLVED_CHANGES' using errcode = 'P0043';
  end if;

  select d.id into v_change
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = v_job.id
    and d.kind = 'change'
    and d.draft_state = 'editing'
  for update;
  if v_change is not null then
    raise exception 'UNRESOLVED_CHANGES' using errcode = 'P0043';
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
    or (v_draft.preview_snapshot_json->>'kind') is distinct from 'invoice' then
    raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
  end if;

  select coalesce(sum(se.net_delta_cents), 0), coalesce(sum(se.tax_delta_cents), 0)
    into v_residual_net, v_residual_tax
  from commercial.scope_entries se
  where se.workspace_id = v_ws and se.job_id = v_job.id;
  if v_residual_net is distinct from (v_draft.preview_snapshot_json->>'net_cents')::bigint
    or v_residual_tax is distinct from (v_draft.preview_snapshot_json->>'tax_cents')::bigint then
    raise exception 'SCOPE_CHANGED' using errcode = 'P0045';
  end if;

  v_issue := (v_draft.preview_snapshot_json->>'issue_date')::date;
  v_due := (v_draft.preview_snapshot_json->>'due_date')::date;
  if v_issue is null or v_due is null or v_due < v_issue or v_due > v_issue + 365 then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;

  v_email := nullif(btrim(v_draft.preview_snapshot_json#>>'{customer,email}'), '');
  if v_email is null then
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
    v_ws, gen_random_uuid(), p_actor_id, v_job.id, 'invoice', v_number, 1, v_quote.id,
    'issued', now(), v_issue, v_due, 'USD',
    (v_draft.preview_snapshot_json->>'net_cents')::bigint,
    (v_draft.preview_snapshot_json->>'tax_cents')::bigint,
    (v_draft.preview_snapshot_json->>'total_cents')::bigint,
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
    jsonb_build_object('kind', 'invoice', 'quote_based', true)
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

revoke all on function commercial.freeze_invoice_preview(uuid, uuid, text, bytea, jsonb, timestamptz) from public;
grant execute on function commercial.freeze_invoice_preview(uuid, uuid, text, bytea, jsonb, timestamptz) to api_app;
revoke all on function commercial.freeze_invoice_preview(uuid, uuid, text, bytea, jsonb, timestamptz)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.issue_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) from public;
grant execute on function commercial.issue_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) to api_app;
revoke all on function commercial.issue_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)
  from worker_app, purge_app, anon, authenticated;

create function commercial.approved_quote_recipient(p_actor_id uuid, p_job_id uuid)
returns text
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_ws uuid;
  v_email text;
begin
  if p_actor_id is null or p_job_id is null then
    raise exception 'invalid recipient lookup' using errcode = '22023';
  end if;
  select w.id into v_ws
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;
  select ar.recipient_email
    into v_email
  from commercial.jobs j
  join commercial.approval_requests ar
    on ar.workspace_id = j.workspace_id
   and ar.document_id = j.current_quote_id
  where j.workspace_id = v_ws
    and j.id = p_job_id
    and ar.purpose = 'approval'
    and ar.state = 'approved'
  order by ar.decided_at desc nulls last, ar.id desc
  limit 1;
  return v_email;
end;
$$;

revoke all on function commercial.approved_quote_recipient(uuid, uuid) from public;
grant execute on function commercial.approved_quote_recipient(uuid, uuid) to api_app;
revoke all on function commercial.approved_quote_recipient(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

create function commercial.document_delivery_status(p_workspace_id uuid, p_document_id uuid)
returns table (
  delivery_state text,
  request_id uuid
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_kind text;
begin
  if p_workspace_id is null or p_document_id is null then
    return;
  end if;
  select kind into v_kind
  from commercial.documents
  where workspace_id = p_workspace_id and id = p_document_id;
  if v_kind is null then
    return;
  end if;
  return query
    select a.state, a.request_id
    from commercial.delivery_attempts a
    where a.workspace_id = p_workspace_id
      and a.document_id = p_document_id
      and a.template_id = case when v_kind = 'invoice' then 'EMAIL06' else 'EMAIL01' end
    order by a.created_at desc, a.id desc
    limit 1;
end;
$$;

revoke all on function commercial.document_delivery_status(uuid, uuid) from public;
grant execute on function commercial.document_delivery_status(uuid, uuid) to api_app;
revoke all on function commercial.document_delivery_status(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

create function commercial.invoice_email_facts(p_document_id uuid)
returns table (
  due_date date,
  total_cents bigint,
  payment_instructions text,
  issue_date date
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_doc commercial.documents%rowtype;
begin
  if p_document_id is null then
    raise exception 'invalid invoice email facts' using errcode = '22023';
  end if;
  select * into v_doc from commercial.documents where id = p_document_id;
  if not found or v_doc.kind is distinct from 'invoice' then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  return query
    select
      v_doc.due_date,
      v_doc.total_cents,
      coalesce(v_doc.snapshot_json->>'payment_instructions', ''),
      v_doc.issue_date;
end;
$$;

revoke all on function commercial.invoice_email_facts(uuid) from public;
grant execute on function commercial.invoice_email_facts(uuid) to worker_app;
revoke all on function commercial.invoice_email_facts(uuid)
  from api_app, purge_app, anon, authenticated;

grant select on commercial.scope_entries to api_app;

reset role;
