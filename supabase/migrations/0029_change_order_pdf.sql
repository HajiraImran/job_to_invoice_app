-- Change-order original PDFs (CHG / DOC01).
-- 0018 queues generate_original_pdf for kind = 'change', but the claim and
-- source functions from 0015 only accepted quote, invoice, and credit, so the
-- claim dead-lettered every change-order task as VALIDATION_FAILED before the
-- worker ran. This accepts change documents on the whole PDF worker path,
-- records the change template version on completion, and lets the review link
-- (portal_pdf_download -> original_pdf_download) serve the ready change PDF.
-- Forward-only. Do not edit 0001–0028. Grants on the replaced functions are
-- preserved by CREATE OR REPLACE.

set role migrator;

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
  if not found or v_doc.kind not in ('quote', 'invoice', 'credit', 'change') then
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
  if not found or v_doc.kind not in ('quote', 'invoice', 'credit', 'change') then
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
    when 'change' then 'change-original-v1'
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
  where workspace_id = p_workspace_id and id = p_document_id and kind in ('quote', 'invoice', 'change');
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

reset role;
