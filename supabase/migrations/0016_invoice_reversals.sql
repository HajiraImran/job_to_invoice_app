-- Owner ledger reversals (S16 / BIL07 / TX04 reverse).
-- Forward-only. Do not edit 0001–0015.

set role migrator;

create function commercial.record_invoice_reversal(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_entry_id uuid,
  p_reason text
)
returns table (
  id uuid,
  invoice_id uuid,
  job_id uuid,
  type text,
  amount_cents bigint,
  effective_date date,
  method text,
  reference text,
  note text,
  payment_status text,
  invoice_issued_cents bigint,
  credits_cents bigint,
  effective_payments_cents bigint,
  effective_refunds_cents bigint,
  net_received_cents bigint,
  balance_cents bigint,
  amount_due_cents bigint,
  amount_to_refund_cents bigint,
  settlement text,
  replayed boolean,
  reverses_entry_id uuid
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
  v_original commercial.ledger_entries%rowtype;
  v_doc commercial.documents%rowtype;
  v_job commercial.jobs%rowtype;
  v_tz text;
  v_today date;
  v_credits bigint;
  v_payments bigint;
  v_refunds bigint;
  v_balance bigint;
  v_entry commercial.ledger_entries%rowtype;
  v_payload jsonb;
  v_status_text text;
  v_due bigint;
  v_refund_due bigint;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_entry_id is null
    or p_reason is null then
    raise exception 'invalid ledger reversal' using errcode = '22023';
  end if;
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then
    raise exception 'invalid ledger reversal' using errcode = '22023';
  end if;

  select u.status
    into v_status
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at, w.timezone
    into v_ws, v_setup, v_tz
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
          (v_existing.response_json->>'invoice_id')::uuid,
          (v_existing.response_json->>'job_id')::uuid,
          v_existing.response_json->>'type',
          (v_existing.response_json->>'amount_cents')::bigint,
          (v_existing.response_json->>'effective_date')::date,
          v_existing.response_json->>'method',
          v_existing.response_json->>'reference',
          v_existing.response_json->>'note',
          v_existing.response_json->>'payment_status',
          (v_existing.response_json->>'invoice_issued_cents')::bigint,
          (v_existing.response_json->>'credits_cents')::bigint,
          (v_existing.response_json->>'effective_payments_cents')::bigint,
          (v_existing.response_json->>'effective_refunds_cents')::bigint,
          (v_existing.response_json->>'net_received_cents')::bigint,
          (v_existing.response_json->>'balance_cents')::bigint,
          (v_existing.response_json->>'amount_due_cents')::bigint,
          (v_existing.response_json->>'amount_to_refund_cents')::bigint,
          v_existing.response_json->>'settlement',
          true,
          (v_existing.response_json->>'reverses_entry_id')::uuid;
      return;
    end if;
  end if;

  select * into v_original
  from commercial.ledger_entries e
  where e.workspace_id = v_ws and e.id = p_entry_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_original.type = 'reversal' then
    raise exception 'invalid ledger reversal' using errcode = '22023';
  end if;
  if exists (
    select 1 from commercial.ledger_entries r
    where r.workspace_id = v_ws
      and r.type = 'reversal'
      and r.reverses_entry_id = v_original.id
  ) then
    raise exception 'ENTRY_ALREADY_REVERSED' using errcode = 'P0048';
  end if;
  if v_original.type = 'payment' and exists (
    select 1
    from commercial.ledger_refund_allocations a
    where a.workspace_id = v_ws
      and a.payment_entry_id = v_original.id
      and not exists (
        select 1 from commercial.ledger_entries r
        where r.workspace_id = v_ws
          and r.type = 'reversal'
          and r.reverses_entry_id = a.refund_entry_id
      )
  ) then
    raise exception 'DEPENDENT_REFUNDS' using errcode = 'P0049';
  end if;

  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = v_original.invoice_id
  for update;
  if not found or v_doc.kind is distinct from 'invoice' then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
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

  v_today := (timezone(v_tz, now()))::date;

  begin
    insert into commercial.ledger_entries (
      workspace_id, id, invoice_id, type, amount_cents, effective_date, method,
      reference, note, reverses_entry_id, created_by, operation_id
    ) values (
      v_ws, gen_random_uuid(), v_doc.id, 'reversal', v_original.amount_cents, v_today, null,
      null, p_reason, v_original.id, p_actor_id, gen_random_uuid()
    )
    returning * into v_entry;
  exception
    when unique_violation then
      raise exception 'ENTRY_ALREADY_REVERSED' using errcode = 'P0048';
  end;

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
  if v_balance < 0 then
    v_status_text := 'refund_due';
  elsif v_balance = 0 then
    v_status_text := 'settled';
  elsif v_doc.due_date is not null and v_doc.due_date < v_today then
    v_status_text := 'overdue';
  elsif v_payments > 0 then
    v_status_text := 'partially_paid';
  else
    v_status_text := 'issued_unpaid';
  end if;
  v_due := case when v_balance > 0 then v_balance else 0 end;
  v_refund_due := case when v_balance < 0 then -v_balance else 0 end;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'ledger_reversed', 'ledger_entry', v_entry.id,
    p_request_id, jsonb_build_object('original_type', v_original.type)
  );

  v_payload := jsonb_build_object(
    'id', v_entry.id,
    'invoice_id', v_doc.id,
    'job_id', v_job.id,
    'type', 'reversal',
    'amount_cents', v_entry.amount_cents,
    'effective_date', v_entry.effective_date,
    'method', v_entry.method,
    'reference', v_entry.reference,
    'note', v_entry.note,
    'payment_status', v_status_text,
    'invoice_issued_cents', v_doc.total_cents,
    'credits_cents', v_credits,
    'effective_payments_cents', v_payments,
    'effective_refunds_cents', v_refunds,
    'net_received_cents', v_payments - v_refunds,
    'balance_cents', v_balance,
    'amount_due_cents', v_due,
    'amount_to_refund_cents', v_refund_due,
    'settlement', null,
    'reverses_entry_id', v_original.id
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/ledger/' || p_entry_id::text || '/reverse',
      p_request_hash, v_entry.operation_id,
      'completed', 200, v_payload, null, 'financial'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 200,
          response_json = v_payload,
          permanence = 'financial',
          expires_at = null,
          operation_id = v_entry.operation_id
      where id = v_existing.id;
  end if;

  return query
    select
      v_entry.id,
      v_doc.id,
      v_job.id,
      'reversal'::text,
      v_entry.amount_cents,
      v_entry.effective_date,
      v_entry.method,
      v_entry.reference,
      v_entry.note,
      v_status_text,
      v_doc.total_cents,
      v_credits,
      v_payments,
      v_refunds,
      v_payments - v_refunds,
      v_balance,
      v_due,
      v_refund_due,
      null::text,
      false,
      v_original.id;
end;
$$;

revoke all on function commercial.record_invoice_reversal(uuid, uuid, text, uuid, uuid, text) from public;
grant execute on function commercial.record_invoice_reversal(uuid, uuid, text, uuid, uuid, text) to api_app;
revoke all on function commercial.record_invoice_reversal(uuid, uuid, text, uuid, uuid, text)
  from worker_app, purge_app, anon, authenticated;

reset role;
