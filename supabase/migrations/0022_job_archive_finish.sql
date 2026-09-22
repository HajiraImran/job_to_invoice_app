-- JOB01 leftover: archive/restore visibility and finish after settlement.
-- Forward-only. Do not edit 0001–0021.

set role migrator;

create function commercial.archive_job(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid,
  p_archived boolean
)
returns table (
  id uuid,
  lifecycle text,
  archived_from_state text,
  version integer,
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
  v_existing commercial.idempotency_records%rowtype;
  v_job commercial.jobs%rowtype;
  v_from text;
  v_payload jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_request_id is null
    or p_job_id is null
    or p_archived is null then
    raise exception 'invalid job archive' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at
    into v_ws, v_setup
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
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
          v_existing.response_json->>'lifecycle',
          v_existing.response_json->>'archived_from_state',
          (v_existing.response_json->>'version')::integer,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, permanence, expires_at
    ) values (
      v_ws, p_actor_id, p_idempotency_key,
      '/v1/jobs/' || p_job_id::text || '/archive', p_request_hash, gen_random_uuid(),
      'pending', 'ephemeral', now() + interval '30 days'
    );
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = p_job_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  perform commercial.expire_due_job_approvals(v_ws, p_job_id);

  if p_archived then
    if v_job.lifecycle in ('draft', 'archived') then
      raise exception 'JOB_NOT_ARCHIVABLE' using errcode = 'P0055';
    end if;
    if exists (
      select 1
      from commercial.approval_requests ar
      where ar.workspace_id = v_ws
        and ar.job_id = p_job_id
        and ar.purpose = 'approval'
        and ar.state = 'pending'
    ) then
      raise exception 'APPROVAL_PENDING' using errcode = 'P0012';
    end if;

    v_from := v_job.lifecycle;
    update commercial.jobs
      set lifecycle = 'archived',
          archived_from_state = v_from,
          version = version + 1
      where workspace_id = v_ws and id = p_job_id and lifecycle = v_from
      returning * into v_job;
    if not found then
      raise exception 'JOB_NOT_ARCHIVABLE' using errcode = 'P0055';
    end if;

    insert into commercial.audit_events (
      workspace_id, actor_type, actor_id, action, entity_type, entity_id,
      request_id, before_version, after_version, safe_metadata_json
    ) values (
      v_ws, 'owner', p_actor_id, 'job_archived', 'job', p_job_id,
      p_request_id, v_job.version - 1, v_job.version,
      jsonb_build_object('from_state', v_from)
    );
  else
    if v_job.lifecycle is distinct from 'archived' or v_job.archived_from_state is null then
      raise exception 'JOB_NOT_ARCHIVABLE' using errcode = 'P0055';
    end if;

    v_from := v_job.archived_from_state;
    update commercial.jobs
      set lifecycle = v_from,
          archived_from_state = null,
          version = version + 1
      where workspace_id = v_ws and id = p_job_id and lifecycle = 'archived'
      returning * into v_job;
    if not found then
      raise exception 'JOB_NOT_ARCHIVABLE' using errcode = 'P0055';
    end if;

    insert into commercial.audit_events (
      workspace_id, actor_type, actor_id, action, entity_type, entity_id,
      request_id, before_version, after_version, safe_metadata_json
    ) values (
      v_ws, 'owner', p_actor_id, 'job_restored', 'job', p_job_id,
      p_request_id, v_job.version - 1, v_job.version,
      jsonb_build_object('to_state', v_from)
    );
  end if;

  v_payload := jsonb_build_object(
    'id', v_job.id,
    'lifecycle', v_job.lifecycle,
    'archived_from_state', v_job.archived_from_state,
    'version', v_job.version
  );
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = v_payload
    where actor_scope = p_actor_id and key = p_idempotency_key;

  return query
    select v_job.id, v_job.lifecycle, v_job.archived_from_state, v_job.version, false;
end;
$$;

comment on function commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean) is
  'Archives or restores a non-draft job. Blocked while an approval request is pending. Does not change financial status (JOB01).';

revoke all on function commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean) from public;
grant execute on function commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean) to api_app;
revoke all on function commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean)
  from worker_app, purge_app, anon, authenticated;

create function commercial.finish_job(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid
)
returns table (
  id uuid,
  lifecycle text,
  version integer,
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
  v_existing commercial.idempotency_records%rowtype;
  v_job commercial.jobs%rowtype;
  v_doc commercial.documents%rowtype;
  v_credits bigint;
  v_payments bigint;
  v_refunds bigint;
  v_balance bigint;
  v_payload jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_request_id is null
    or p_job_id is null then
    raise exception 'invalid job finish' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at
    into v_ws, v_setup
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
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
          v_existing.response_json->>'lifecycle',
          (v_existing.response_json->>'version')::integer,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key,
      '/v1/jobs/' || p_job_id::text || '/finish', p_request_hash, gen_random_uuid(),
      'pending', 'financial'
    );
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = p_job_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  if v_job.lifecycle is distinct from 'invoiced' or v_job.active_invoice_id is null then
    raise exception 'JOB_NOT_FINISHABLE' using errcode = 'P0056';
  end if;

  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = v_job.active_invoice_id
  for update;
  if not found or v_doc.kind is distinct from 'invoice' or v_doc.lifecycle is distinct from 'issued' then
    raise exception 'JOB_NOT_FINISHABLE' using errcode = 'P0056';
  end if;

  v_credits := commercial.issued_credit_total(v_ws, v_doc.id);

  select coalesce(sum(e.amount_cents) filter (where e.type = 'payment'), 0),
         coalesce(sum(e.amount_cents) filter (where e.type = 'refund'), 0)
    into v_payments, v_refunds
  from commercial.ledger_entries e
  where e.workspace_id = v_ws
    and e.invoice_id = v_doc.id
    and e.type in ('payment', 'refund')
    and not exists (
      select 1 from commercial.ledger_entries r
      where r.workspace_id = v_ws and r.type = 'reversal' and r.reverses_entry_id = e.id
    );

  v_balance := v_doc.total_cents - v_credits - v_payments + v_refunds;
  if v_balance is distinct from 0 then
    raise exception 'JOB_NOT_FINISHABLE' using errcode = 'P0056';
  end if;

  update commercial.jobs
    set lifecycle = 'finished',
        version = version + 1
    where workspace_id = v_ws and id = p_job_id and lifecycle = 'invoiced'
    returning * into v_job;
  if not found then
    raise exception 'JOB_NOT_FINISHABLE' using errcode = 'P0056';
  end if;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'job_finished', 'job', p_job_id,
    p_request_id, v_job.version - 1, v_job.version,
    jsonb_build_object('settled', true)
  );

  v_payload := jsonb_build_object(
    'id', v_job.id,
    'lifecycle', v_job.lifecycle,
    'version', v_job.version
  );
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = v_payload
    where actor_scope = p_actor_id and key = p_idempotency_key;

  return query select v_job.id, v_job.lifecycle, v_job.version, false;
end;
$$;

comment on function commercial.finish_job(uuid, uuid, text, uuid, uuid) is
  'Finishes an invoiced job after the active invoice ledger balance is zero. Never deletes records (JOB01).';

revoke all on function commercial.finish_job(uuid, uuid, text, uuid, uuid) from public;
grant execute on function commercial.finish_job(uuid, uuid, text, uuid, uuid) to api_app;
revoke all on function commercial.finish_job(uuid, uuid, text, uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

alter function commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean) owner to migrator;
alter function commercial.finish_job(uuid, uuid, text, uuid, uuid) owner to migrator;

reset role;
