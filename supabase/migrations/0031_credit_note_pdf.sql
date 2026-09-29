-- Credit-note original PDFs (BIL04 / DOC01 / EMAIL07).
-- 0015 queues generate_original_pdf for kind = 'credit', and 0029 restored
-- change documents on the worker path, but original_pdf_download only listed
-- quote, invoice, and change. Owner GET /documents/{id}/download and portal
-- GET /portal/download therefore returned no row for a ready CN PDF while
-- get_portal_document still showed pdf_state = ready from the artifact.
-- Forward-only. Do not edit 0001–0030. Grants on the replaced functions are
-- preserved by CREATE OR REPLACE.

set role migrator;

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
    when 'credit' then 'credit-original-v1'
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
  where workspace_id = p_workspace_id
    and id = p_document_id
    and kind in ('quote', 'invoice', 'credit', 'change');
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
