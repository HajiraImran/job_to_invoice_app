-- Manual payment and refund recording (S17 / TX04 payment+refund).
-- Forward-only. Do not edit 0001–0013.

set role migrator;

create table commercial.ledger_entries (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  invoice_id uuid not null,
  type text not null,
  amount_cents bigint not null,
  effective_date date not null,
  method text,
  reference text,
  note text,
  reverses_entry_id uuid,
  created_by uuid not null,
  operation_id uuid not null,
  constraint ledger_entries_pkey primary key (id),
  constraint ledger_entries_tenant_id_key unique (workspace_id, id),
  constraint ledger_entries_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint ledger_entries_invoice_fk
    foreign key (workspace_id, invoice_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint ledger_entries_reverse_fk
    foreign key (workspace_id, reverses_entry_id)
    references commercial.ledger_entries (workspace_id, id)
    on delete restrict,
  constraint ledger_entries_created_by_fk
    foreign key (created_by) references identity.app_users (id) on delete restrict,
  constraint ledger_entries_type_check check (type in ('payment', 'refund', 'reversal')),
  constraint ledger_entries_amount_check check (amount_cents >= 1 and amount_cents <= 999999999),
  constraint ledger_entries_method_check check (
    method is null
    or method in ('cash', 'check', 'bank_transfer', 'external_card', 'other')
  ),
  constraint ledger_entries_reference_len check (reference is null or char_length(reference) between 1 and 100),
  constraint ledger_entries_note_len check (note is null or char_length(note) between 1 and 500),
  constraint ledger_entries_reversal_shape check (
    (type = 'reversal' and reverses_entry_id is not null and method is null)
    or (type <> 'reversal' and reverses_entry_id is null and method is not null)
  )
);

create unique index ledger_entries_operation_id_key
  on commercial.ledger_entries (operation_id);

create unique index ledger_entries_reverses_once
  on commercial.ledger_entries (workspace_id, reverses_entry_id)
  where reverses_entry_id is not null;

create index ledger_entries_invoice_created
  on commercial.ledger_entries (workspace_id, invoice_id, created_at desc, id desc);

create table commercial.ledger_refund_allocations (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  refund_entry_id uuid not null,
  payment_entry_id uuid not null,
  amount_cents bigint not null,
  constraint ledger_refund_allocations_pkey primary key (id),
  constraint ledger_refund_allocations_tenant_id_key unique (workspace_id, id),
  constraint ledger_refund_allocations_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint ledger_refund_allocations_refund_fk
    foreign key (workspace_id, refund_entry_id)
    references commercial.ledger_entries (workspace_id, id)
    on delete restrict,
  constraint ledger_refund_allocations_payment_fk
    foreign key (workspace_id, payment_entry_id)
    references commercial.ledger_entries (workspace_id, id)
    on delete restrict,
  constraint ledger_refund_allocations_amount_check check (amount_cents >= 1),
  constraint ledger_refund_allocations_distinct check (refund_entry_id is distinct from payment_entry_id)
);

create unique index ledger_refund_allocations_pair
  on commercial.ledger_refund_allocations (workspace_id, refund_entry_id, payment_entry_id);

create index ledger_refund_allocations_payment
  on commercial.ledger_refund_allocations (workspace_id, payment_entry_id);

create function commercial.protect_ledger_row()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_user <> 'purge_app' then
      raise exception 'ledger rows are append-only' using errcode = '23001';
    end if;
    return old;
  end if;
  if current_user <> 'purge_app' then
    raise exception 'ledger rows are append-only' using errcode = '23001';
  end if;
  return new;
end;
$$;

create trigger ledger_entries_protect
  before update or delete on commercial.ledger_entries
  for each row execute function commercial.protect_ledger_row();

create trigger ledger_refund_allocations_protect
  before update or delete on commercial.ledger_refund_allocations
  for each row execute function commercial.protect_ledger_row();

create trigger ledger_entries_reject_key_change
  before update on commercial.ledger_entries
  for each row execute function commercial.reject_tenant_key_change();

create trigger ledger_refund_allocations_reject_key_change
  before update on commercial.ledger_refund_allocations
  for each row execute function commercial.reject_tenant_key_change();

alter table commercial.ledger_entries enable row level security;
alter table commercial.ledger_entries force row level security;
select identity.install_migrator_force_rls_policy('commercial.ledger_entries');
alter table commercial.ledger_refund_allocations enable row level security;
alter table commercial.ledger_refund_allocations force row level security;
select identity.install_migrator_force_rls_policy('commercial.ledger_refund_allocations');

create policy ledger_entries_select on commercial.ledger_entries
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = ledger_entries.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy ledger_refund_allocations_select on commercial.ledger_refund_allocations
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = ledger_refund_allocations.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create function commercial.record_invoice_payment(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_effective_date date,
  p_method text,
  p_reference text,
  p_note text,
  p_confirm_overpayment boolean
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
  v_doc commercial.documents%rowtype;
  v_job commercial.jobs%rowtype;
  v_tz text;
  v_today date;
  v_payments bigint;
  v_refunds bigint;
  v_next_payments bigint;
  v_balance bigint;
  v_entry commercial.ledger_entries%rowtype;
  v_payload jsonb;
  v_status_text text;
  v_settlement text;
  v_due bigint;
  v_refund_due bigint;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_invoice_id is null
    or p_amount_cents is null
    or p_effective_date is null
    or p_method is null
    or p_confirm_overpayment is null then
    raise exception 'invalid ledger payment' using errcode = '22023';
  end if;
  if p_amount_cents < 1 or p_amount_cents > 999999999
    or p_method not in ('cash', 'check', 'bank_transfer', 'external_card', 'other')
    or (p_reference is not null and char_length(p_reference) not between 1 and 100)
    or (p_note is not null and char_length(p_note) not between 1 and 500) then
    raise exception 'invalid ledger payment' using errcode = '22023';
  end if;

  select u.status, u.analytics_alias_id
    into v_status, v_alias
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
  if p_effective_date > v_today or p_effective_date < (v_today - interval '5 years')::date then
    raise exception 'invalid ledger payment' using errcode = '22023';
  end if;

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

  v_next_payments := v_payments + p_amount_cents;
  v_balance := v_doc.total_cents - v_next_payments + v_refunds;
  if v_balance < 0 and p_confirm_overpayment is not true then
    raise exception 'invalid ledger payment' using errcode = '22023';
  end if;

  insert into commercial.ledger_entries (
    workspace_id, id, invoice_id, type, amount_cents, effective_date, method,
    reference, note, created_by, operation_id
  ) values (
    v_ws, gen_random_uuid(), v_doc.id, 'payment', p_amount_cents, p_effective_date, p_method,
    p_reference, p_note, p_actor_id, gen_random_uuid()
  )
  returning * into v_entry;

  if v_balance < 0 then
    v_status_text := 'refund_due';
    v_settlement := 'overpaid';
  elsif v_balance = 0 then
    v_status_text := 'settled';
    v_settlement := 'full';
  elsif v_doc.due_date is not null and v_doc.due_date < v_today then
    v_status_text := 'overdue';
    v_settlement := 'partial';
  else
    v_status_text := 'partially_paid';
    v_settlement := 'partial';
  end if;
  v_due := case when v_balance > 0 then v_balance else 0 end;
  v_refund_due := case when v_balance < 0 then -v_balance else 0 end;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'payment_recorded', 'ledger_entry', v_entry.id,
    p_request_id, jsonb_build_object('settlement', v_settlement)
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'payment_recorded', 1, now(), v_alias, v_job.id,
      jsonb_build_object('settlement', v_settlement)
    );
  exception
    when unique_violation then
      null;
  end;

  v_payload := jsonb_build_object(
    'id', v_entry.id,
    'invoice_id', v_doc.id,
    'job_id', v_job.id,
    'type', 'payment',
    'amount_cents', v_entry.amount_cents,
    'effective_date', v_entry.effective_date,
    'method', v_entry.method,
    'reference', v_entry.reference,
    'note', v_entry.note,
    'payment_status', v_status_text,
    'invoice_issued_cents', v_doc.total_cents,
    'credits_cents', 0,
    'effective_payments_cents', v_next_payments,
    'effective_refunds_cents', v_refunds,
    'net_received_cents', v_next_payments - v_refunds,
    'balance_cents', v_balance,
    'amount_due_cents', v_due,
    'amount_to_refund_cents', v_refund_due,
    'settlement', v_settlement
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/invoices/' || p_invoice_id::text || '/payments',
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
      'payment'::text,
      v_entry.amount_cents,
      v_entry.effective_date,
      v_entry.method,
      v_entry.reference,
      v_entry.note,
      v_status_text,
      v_doc.total_cents,
      0::bigint,
      v_next_payments,
      v_refunds,
      v_next_payments - v_refunds,
      v_balance,
      v_due,
      v_refund_due,
      v_settlement,
      false;
end;
$$;

create function commercial.record_invoice_refund(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_effective_date date,
  p_method text,
  p_reference text,
  p_note text
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
  v_tz text;
  v_today date;
  v_payments bigint;
  v_refunds bigint;
  v_balance bigint;
  v_next_refunds bigint;
  v_next_balance bigint;
  v_entry commercial.ledger_entries%rowtype;
  v_payload jsonb;
  v_status_text text;
  v_due bigint;
  v_refund_due bigint;
  v_remaining bigint;
  v_pay record;
  v_take bigint;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_invoice_id is null
    or p_amount_cents is null
    or p_effective_date is null
    or p_method is null then
    raise exception 'invalid ledger refund' using errcode = '22023';
  end if;
  if p_amount_cents < 1 or p_amount_cents > 999999999
    or p_method not in ('cash', 'check', 'bank_transfer', 'external_card', 'other')
    or (p_reference is not null and char_length(p_reference) not between 1 and 100)
    or (p_note is not null and char_length(p_note) not between 1 and 500) then
    raise exception 'invalid ledger refund' using errcode = '22023';
  end if;

  select u.status into v_status from identity.app_users u where u.id = p_actor_id for update;
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
  if p_effective_date > v_today or p_effective_date < (v_today - interval '5 years')::date then
    raise exception 'invalid ledger refund' using errcode = '22023';
  end if;

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

  v_balance := v_doc.total_cents - v_payments + v_refunds;
  if v_payments <= 0 or v_balance >= 0 then
    raise exception 'REFUND_EXCEEDS_BALANCE' using errcode = 'P0046';
  end if;
  if p_amount_cents > -v_balance or p_amount_cents > (v_payments - v_refunds) then
    raise exception 'REFUND_EXCEEDS_BALANCE' using errcode = 'P0046';
  end if;

  insert into commercial.ledger_entries (
    workspace_id, id, invoice_id, type, amount_cents, effective_date, method,
    reference, note, created_by, operation_id
  ) values (
    v_ws, gen_random_uuid(), v_doc.id, 'refund', p_amount_cents, p_effective_date, p_method,
    p_reference, p_note, p_actor_id, gen_random_uuid()
  )
  returning * into v_entry;

  v_remaining := p_amount_cents;
  for v_pay in
    select e.id,
           e.amount_cents - coalesce((
             select sum(a.amount_cents)
             from commercial.ledger_refund_allocations a
             join commercial.ledger_entries r
               on r.workspace_id = a.workspace_id and r.id = a.refund_entry_id
             where a.workspace_id = v_ws
               and a.payment_entry_id = e.id
               and not exists (
                 select 1 from commercial.ledger_entries rev
                 where rev.workspace_id = v_ws and rev.type = 'reversal' and rev.reverses_entry_id = r.id
               )
           ), 0) as capacity
    from commercial.ledger_entries e
    where e.workspace_id = v_ws
      and e.invoice_id = v_doc.id
      and e.type = 'payment'
      and not exists (
        select 1 from commercial.ledger_entries rev
        where rev.workspace_id = v_ws and rev.type = 'reversal' and rev.reverses_entry_id = e.id
      )
    order by e.created_at, e.id
  loop
    if v_pay.capacity is null or v_pay.capacity <= 0 then
      continue;
    end if;
    v_take := least(v_remaining, v_pay.capacity);
    insert into commercial.ledger_refund_allocations (
      workspace_id, id, refund_entry_id, payment_entry_id, amount_cents
    ) values (
      v_ws, gen_random_uuid(), v_entry.id, v_pay.id, v_take
    );
    v_remaining := v_remaining - v_take;
    exit when v_remaining = 0;
  end loop;
  if v_remaining <> 0 then
    raise exception 'REFUND_EXCEEDS_BALANCE' using errcode = 'P0046';
  end if;

  v_next_refunds := v_refunds + p_amount_cents;
  v_next_balance := v_doc.total_cents - v_payments + v_next_refunds;
  if v_next_balance < 0 then
    v_status_text := 'refund_due';
  elsif v_next_balance = 0 then
    v_status_text := 'settled';
  elsif v_doc.due_date is not null and v_doc.due_date < v_today then
    v_status_text := 'overdue';
  elsif v_payments > 0 then
    v_status_text := 'partially_paid';
  else
    v_status_text := 'issued_unpaid';
  end if;
  v_due := case when v_next_balance > 0 then v_next_balance else 0 end;
  v_refund_due := case when v_next_balance < 0 then -v_next_balance else 0 end;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'refund_recorded', 'ledger_entry', v_entry.id,
    p_request_id, jsonb_build_object('kind', 'refund')
  );

  v_payload := jsonb_build_object(
    'id', v_entry.id,
    'invoice_id', v_doc.id,
    'job_id', v_job.id,
    'type', 'refund',
    'amount_cents', v_entry.amount_cents,
    'effective_date', v_entry.effective_date,
    'method', v_entry.method,
    'reference', v_entry.reference,
    'note', v_entry.note,
    'payment_status', v_status_text,
    'invoice_issued_cents', v_doc.total_cents,
    'credits_cents', 0,
    'effective_payments_cents', v_payments,
    'effective_refunds_cents', v_next_refunds,
    'net_received_cents', v_payments - v_next_refunds,
    'balance_cents', v_next_balance,
    'amount_due_cents', v_due,
    'amount_to_refund_cents', v_refund_due,
    'settlement', null
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/invoices/' || p_invoice_id::text || '/refunds',
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
      'refund'::text,
      v_entry.amount_cents,
      v_entry.effective_date,
      v_entry.method,
      v_entry.reference,
      v_entry.note,
      v_status_text,
      v_doc.total_cents,
      0::bigint,
      v_payments,
      v_next_refunds,
      v_payments - v_next_refunds,
      v_next_balance,
      v_due,
      v_refund_due,
      null::text,
      false;
end;
$$;

revoke all on function commercial.protect_ledger_row() from public;
revoke all on function commercial.record_invoice_payment(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text, boolean) from public;
grant execute on function commercial.record_invoice_payment(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text, boolean) to api_app;
revoke all on function commercial.record_invoice_payment(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text, boolean)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.record_invoice_refund(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text) from public;
grant execute on function commercial.record_invoice_refund(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text) to api_app;
revoke all on function commercial.record_invoice_refund(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text)
  from worker_app, purge_app, anon, authenticated;

grant select on commercial.ledger_entries to api_app;
grant select on commercial.ledger_refund_allocations to api_app;
revoke insert, update, delete on commercial.ledger_entries from api_app;
revoke insert, update, delete on commercial.ledger_refund_allocations from api_app;
revoke all on commercial.ledger_entries from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.ledger_refund_allocations from public, anon, authenticated, worker_app, purge_app;

reset role;
