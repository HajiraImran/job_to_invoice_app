-- Original quote PDF worker (DOC01 / DOC05 / D-016).
-- Claim, lease, retry, and artifact finalization through migrator-owned
-- SECURITY DEFINER functions. No worker table DML grants.

set role migrator;

create unique index artifacts_one_original_pdf
  on commercial.artifacts (workspace_id, document_id)
  where type = 'original_pdf';

create unique index artifacts_object_key_key
  on commercial.artifacts (object_key);

create or replace function commercial.protect_artifact_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_user <> 'purge_app' then
      raise exception 'artifacts cannot be deleted' using errcode = '23001';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if current_user <> 'purge_app' then
      raise exception 'artifacts are immutable' using errcode = '23001';
    end if;
    return new;
  end if;
  if current_user not in ('migrator', 'purge_app') then
    raise exception 'artifacts are server-assigned' using errcode = '23001';
  end if;
  return new;
end;
$$;

create trigger artifacts_protect_write
  before insert or update or delete on commercial.artifacts
  for each row execute function commercial.protect_artifact_write();

create or replace function commercial.retry_delay_for_attempt(p_attempts integer)
returns interval
language sql
immutable
as $$
  select case
    when p_attempts <= 1 then interval '30 seconds'
    when p_attempts = 2 then interval '2 minutes'
    when p_attempts = 3 then interval '10 minutes'
    else interval '30 minutes'
  end;
$$;

create function commercial.claim_generate_original_pdf()
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
  if not found or v_doc.kind is distinct from 'quote' then
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

create function commercial.heartbeat_outbox_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  if p_task_id is null then
    raise exception 'invalid outbox heartbeat' using errcode = '22023';
  end if;
  update commercial.outbox_tasks
    set lease_until = now() + interval '60 seconds'
    where id = p_task_id and status = 'running';
end;
$$;

create function commercial.reserve_original_pdf_artifact(p_task_id uuid)
returns uuid
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_task commercial.outbox_tasks%rowtype;
  v_id uuid;
begin
  if p_task_id is null then
    raise exception 'invalid artifact reserve' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id and task_type = 'generate_original_pdf'
  for update;
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_task.payload_json ? 'artifact_id'
    and (v_task.payload_json->>'artifact_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return (v_task.payload_json->>'artifact_id')::uuid;
  end if;
  v_id := gen_random_uuid();
  update commercial.outbox_tasks
    set payload_json = payload_json || jsonb_build_object('artifact_id', v_id)
    where id = p_task_id;
  return v_id;
end;
$$;

create function commercial.load_original_pdf_source(p_task_id uuid)
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
  if not found or v_doc.kind is distinct from 'quote' then
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

create function commercial.complete_original_pdf(
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

  insert into commercial.artifacts (
    workspace_id, id, document_id, type, object_key, sha256, bytes,
    template_version, generated_at, state
  ) values (
    v_task.workspace_id, p_artifact_id, v_task.aggregate_id, 'original_pdf',
    p_object_key, p_sha256, p_bytes, 'quote-original-v1', now(), 'ready'
  );

  update commercial.outbox_tasks
    set status = 'done', lease_until = null, last_error_code = null
    where id = p_task_id;
  return false;
end;
$$;

create function commercial.fail_original_pdf(
  p_task_id uuid,
  p_error_code text,
  p_permanent boolean
)
returns text
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_task commercial.outbox_tasks%rowtype;
  v_status text;
begin
  if p_task_id is null or p_error_code is null then
    raise exception 'invalid pdf fail' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id and task_type = 'generate_original_pdf'
  for update;
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  if p_permanent or v_task.attempts >= 5 then
    v_status := 'dead';
    update commercial.outbox_tasks
      set status = 'dead',
          last_error_code = left(p_error_code, 64),
          lease_until = null
      where id = p_task_id;
  else
    v_status := 'pending';
    update commercial.outbox_tasks
      set status = 'pending',
          last_error_code = left(p_error_code, 64),
          available_at = now() + commercial.retry_delay_for_attempt(v_task.attempts),
          lease_until = null
      where id = p_task_id;
  end if;
  return v_status;
end;
$$;

revoke all on function commercial.retry_delay_for_attempt(integer) from public;
revoke all on function commercial.retry_delay_for_attempt(integer)
  from api_app, worker_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_generate_original_pdf() from public;
grant execute on function commercial.claim_generate_original_pdf() to worker_app;
revoke all on function commercial.claim_generate_original_pdf()
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.heartbeat_outbox_task(uuid) from public;
grant execute on function commercial.heartbeat_outbox_task(uuid) to worker_app;
revoke all on function commercial.heartbeat_outbox_task(uuid)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.reserve_original_pdf_artifact(uuid) from public;
grant execute on function commercial.reserve_original_pdf_artifact(uuid) to worker_app;
revoke all on function commercial.reserve_original_pdf_artifact(uuid)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.load_original_pdf_source(uuid) from public;
grant execute on function commercial.load_original_pdf_source(uuid) to worker_app;
revoke all on function commercial.load_original_pdf_source(uuid)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.complete_original_pdf(uuid, uuid, text, text, bigint) from public;
grant execute on function commercial.complete_original_pdf(uuid, uuid, text, text, bigint) to worker_app;
revoke all on function commercial.complete_original_pdf(uuid, uuid, text, text, bigint)
  from api_app, purge_app, anon, authenticated;

create function commercial.original_pdf_download(p_workspace_id uuid, p_document_id uuid)
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
  where workspace_id = p_workspace_id and id = p_document_id and kind = 'quote';
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

revoke all on function commercial.fail_original_pdf(uuid, text, boolean) from public;
grant execute on function commercial.fail_original_pdf(uuid, text, boolean) to worker_app;
revoke all on function commercial.fail_original_pdf(uuid, text, boolean)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.original_pdf_download(uuid, uuid) from public;
grant execute on function commercial.original_pdf_download(uuid, uuid) to api_app;
revoke all on function commercial.original_pdf_download(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.protect_artifact_write() from public;
revoke all on function commercial.protect_artifact_write()
  from api_app, worker_app, purge_app, anon, authenticated;

reset role;
