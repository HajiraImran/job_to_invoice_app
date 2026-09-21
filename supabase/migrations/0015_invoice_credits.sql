-- Owner-issued credit notes (S18 / BIL04 / EMAIL07).
-- Forward-only. Do not edit 0001–0014.

set role migrator;

create table commercial.credit_allocations (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  credit_document_id uuid not null,
  invoice_line_id uuid not null,
  net_credit_cents bigint not null,
  tax_credit_cents bigint not null,
  constraint credit_allocations_pkey primary key (id),
  constraint credit_allocations_tenant_id_key unique (workspace_id, id),
  constraint credit_allocations_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint credit_allocations_credit_fk
    foreign key (workspace_id, credit_document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint credit_allocations_line_fk
    foreign key (workspace_id, invoice_line_id)
    references commercial.document_lines (workspace_id, id)
    on delete restrict,
  constraint credit_allocations_amount_check check (net_credit_cents >= 1 and tax_credit_cents >= 0)
);

create unique index credit_allocations_credit_line
  on commercial.credit_allocations (workspace_id, credit_document_id, invoice_line_id);

create index credit_allocations_invoice_line
  on commercial.credit_allocations (workspace_id, invoice_line_id);

create trigger credit_allocations_protect
  before update or delete on commercial.credit_allocations
  for each row execute function commercial.protect_ledger_row();

create trigger credit_allocations_reject_key_change
  before update on commercial.credit_allocations
  for each row execute function commercial.reject_tenant_key_change();

alter table commercial.credit_allocations enable row level security;
alter table commercial.credit_allocations force row level security;
select identity.install_migrator_force_rls_policy('commercial.credit_allocations');

create policy credit_allocations_select on commercial.credit_allocations
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = credit_allocations.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create unique index document_drafts_one_editing_credit
  on commercial.document_drafts (workspace_id, parent_document_id)
  where kind = 'credit' and draft_state = 'editing' and parent_document_id is not null;

alter table commercial.delivery_attempts
  drop constraint if exists delivery_attempts_template_check;

alter table commercial.delivery_attempts
  add constraint delivery_attempts_template_check
  check (template_id in ('EMAIL01', 'EMAIL03', 'EMAIL04', 'EMAIL05', 'EMAIL06', 'EMAIL07', 'EMAIL08'));

create function commercial.issued_credit_total(p_workspace_id uuid, p_invoice_id uuid)
returns bigint
language sql
stable
security definer
set search_path = identity, commercial, pg_temp
as $$
  select coalesce(sum(d.total_cents), 0)
  from commercial.documents d
  where d.workspace_id = p_workspace_id
    and d.kind = 'credit'
    and d.lifecycle = 'issued'
    and d.prior_document_id = p_invoice_id;
$$;

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
  if not found or v_doc.kind not in ('quote', 'invoice', 'credit') then
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
  if not found or v_doc.kind not in ('quote', 'invoice', 'credit') then
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

create function commercial.round_half_up_div(p_numerator bigint, p_denominator bigint)
returns bigint
language plpgsql
immutable
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_q bigint;
  v_r bigint;
begin
  if p_denominator is null or p_denominator <= 0 or p_numerator is null or p_numerator < 0 then
    raise exception 'invalid money division' using errcode = '22023';
  end if;
  v_q := p_numerator / p_denominator;
  v_r := p_numerator % p_denominator;
  if v_r * 2 >= p_denominator then
    return v_q + 1;
  end if;
  return v_q;
end;
$$;

create function commercial.tax_reduction_cents(
  p_original_net bigint,
  p_original_tax bigint,
  p_prior bigint,
  p_next bigint
)
returns bigint
language plpgsql
immutable
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  if p_original_net is null or p_original_net <= 0 or p_original_tax is null or p_original_tax < 0
    or p_prior is null or p_prior < 0 or p_next is null or p_next <= 0 then
    raise exception 'invalid tax reduction' using errcode = '22023';
  end if;
  if p_prior + p_next > p_original_net then
    raise exception 'CREDIT_EXCEEDS_SOURCE' using errcode = 'P0047';
  end if;
  return commercial.round_half_up_div(p_original_tax * (p_prior + p_next), p_original_net)
    - commercial.round_half_up_div(p_original_tax * p_prior, p_original_net);
end;
$$;

create function commercial.freeze_credit_preview(
  p_actor_id uuid,
  p_invoice_id uuid,
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
  v_doc commercial.documents%rowtype;
  v_job commercial.jobs%rowtype;
  v_draft commercial.document_drafts%rowtype;
begin
  if p_actor_id is null or p_invoice_id is null or p_preview_hash is null
    or p_canonical_bytes is null or p_snapshot is null or p_expires_at is null then
    raise exception 'invalid credit preview' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$' or (p_snapshot->>'kind') is distinct from 'credit' then
    raise exception 'invalid credit preview' using errcode = '22023';
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
  if (p_snapshot->>'invoice_id') is distinct from v_doc.id::text then
    raise exception 'invalid credit preview' using errcode = '22023';
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

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.parent_document_id = v_doc.id
    and d.kind = 'credit'
    and d.draft_state = 'editing'
  for update;

  if found then
    update commercial.document_drafts
      set payload_json = jsonb_build_object('reason', p_snapshot->>'reason'),
          version = v_draft.version + 1,
          preview_hash = p_preview_hash,
          preview_canonical_bytes = p_canonical_bytes,
          preview_snapshot_json = p_snapshot,
          preview_expires_at = p_expires_at,
          preview_draft_version = v_draft.version + 1,
          job_id = v_job.id
      where workspace_id = v_ws and id = v_draft.id
      returning * into v_draft;
  else
    insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, parent_document_id, base_scope_version, payload_json,
      schema_version, draft_state, preview_hash, preview_canonical_bytes, preview_snapshot_json,
      preview_expires_at, preview_draft_version
    ) values (
      v_ws, gen_random_uuid(), v_job.id, 'credit', v_doc.id, v_job.scope_version,
      jsonb_build_object('reason', p_snapshot->>'reason'),
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

create function commercial.issue_credit(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_invoice_id uuid,
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
  v_existing commercial.idempotency_records%rowtype;
  v_invoice commercial.documents%rowtype;
  v_job commercial.jobs%rowtype;
  v_draft commercial.document_drafts%rowtype;
  v_seq integer;
  v_number text;
  v_doc commercial.documents%rowtype;
  v_line jsonb;
  v_invoice_line commercial.document_lines%rowtype;
  v_prior bigint;
  v_tax bigint;
  v_net bigint;
  v_payload jsonb;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_effect text;
  v_issue date;
  v_email text;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_invoice_id is null or p_preview_hash is null
    or p_token_hash is null or p_token_key_version is null or p_encrypted_email is null
    or p_token_ciphertext is null or p_token_nonce is null or p_delivery_algorithm is null
    or p_delivery_key_version is null or p_access_until is null then
    raise exception 'invalid credit issue' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$'
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_key_version < 1
    or p_delivery_key_version < 1
    or p_delivery_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_token_nonce) is distinct from 12
    or octet_length(p_token_ciphertext) < 17 then
    raise exception 'invalid credit issue' using errcode = '22023';
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
          true;
      return;
    end if;
  end if;

  select * into v_invoice
  from commercial.documents d
  where d.workspace_id = v_ws and d.id = p_invoice_id
  for update;
  if not found or v_invoice.kind is distinct from 'invoice' then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_invoice.lifecycle is distinct from 'issued' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_invoice.job_id
  for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_job.completion_right is not true then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.parent_document_id = v_invoice.id
    and d.kind = 'credit'
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
    or (v_draft.preview_snapshot_json->>'kind') is distinct from 'credit'
    or (v_draft.preview_snapshot_json->>'invoice_id') is distinct from v_invoice.id::text then
    raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
  end if;

  v_issue := (v_draft.preview_snapshot_json->>'issue_date')::date;
  v_email := nullif(btrim(v_draft.preview_snapshot_json#>>'{customer,email}'), '');
  if v_issue is null or v_email is null then
    raise exception 'invalid credit issue' using errcode = '22023';
  end if;

  for v_line in
    select value from jsonb_array_elements(coalesce(v_draft.preview_snapshot_json->'lines', '[]'::jsonb))
  loop
    select * into v_invoice_line
    from commercial.document_lines l
    where l.workspace_id = v_ws
      and l.id = (v_line->>'invoice_line_id')::uuid
      and l.document_id = v_invoice.id
    for update;
    if not found then
      raise exception 'invalid credit issue' using errcode = '22023';
    end if;
    select coalesce(sum(a.net_credit_cents), 0)
      into v_prior
    from commercial.credit_allocations a
    where a.workspace_id = v_ws and a.invoice_line_id = v_invoice_line.id;
    v_net := (v_line->>'net_credit_cents')::bigint;
    if v_net is null or v_net < 1 then
      raise exception 'invalid credit issue' using errcode = '22023';
    end if;
    v_tax := commercial.tax_reduction_cents(v_invoice_line.net_cents, v_invoice_line.tax_cents, v_prior, v_net);
    if v_tax is distinct from (v_line->>'tax_credit_cents')::bigint
      or (v_net + v_tax) is distinct from (v_line->>'total_cents')::bigint then
      raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
    end if;
  end loop;

  if (v_draft.preview_snapshot_json->>'net_cents')::bigint is distinct from (
       select coalesce(sum((value->>'net_credit_cents')::bigint), 0)
       from jsonb_array_elements(v_draft.preview_snapshot_json->'lines')
     )
    or (v_draft.preview_snapshot_json->>'tax_cents')::bigint is distinct from (
       select coalesce(sum((value->>'tax_credit_cents')::bigint), 0)
       from jsonb_array_elements(v_draft.preview_snapshot_json->'lines')
     )
    or (v_draft.preview_snapshot_json->>'total_cents')::bigint
         is distinct from (v_draft.preview_snapshot_json->>'net_cents')::bigint
                          + (v_draft.preview_snapshot_json->>'tax_cents')::bigint then
    raise exception 'PREVIEW_CHANGED' using errcode = 'P0008';
  end if;

  insert into commercial.document_counters as c (workspace_id, type, next_value)
  values (v_ws, 'credit', 1)
  on conflict (workspace_id, type)
  do update set next_value = c.next_value + 1, version = c.version + 1
  returning next_value into v_seq;
  v_number := 'CN-' || lpad(v_seq::text, 6, '0');

  insert into commercial.documents (
    workspace_id, id, created_by, job_id, kind, number, revision_no, prior_document_id,
    lifecycle, issued_at, issue_date, due_date, currency, net_cents, tax_cents, total_cents,
    snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256, scope_version
  ) values (
    v_ws, gen_random_uuid(), p_actor_id, v_job.id, 'credit', v_number, 1, v_invoice.id,
    'issued', now(), v_issue, null, 'USD',
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
    select * into v_invoice_line
    from commercial.document_lines l
    where l.workspace_id = v_ws and l.id = (v_line->>'invoice_line_id')::uuid;
    insert into commercial.document_lines (
      workspace_id, id, document_id, position, line_kind, source_line_id, description, quantity, unit,
      unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
    ) values (
      v_ws, gen_random_uuid(), v_doc.id,
      (v_line->>'position')::integer, 'credit', v_invoice_line.id, v_line->>'description',
      1, coalesce(v_invoice_line.unit, 'item'),
      (v_line->>'net_credit_cents')::bigint, 0,
      (v_line->>'net_credit_cents')::bigint, v_invoice_line.tax_bp,
      (v_line->>'tax_credit_cents')::bigint, (v_line->>'total_cents')::bigint
    );
    insert into commercial.credit_allocations (
      workspace_id, id, credit_document_id, invoice_line_id, net_credit_cents, tax_credit_cents
    ) values (
      v_ws, gen_random_uuid(), v_doc.id, v_invoice_line.id,
      (v_line->>'net_credit_cents')::bigint, (v_line->>'tax_credit_cents')::bigint
    );
  end loop;

  update commercial.document_drafts
    set draft_state = 'published',
        parent_document_id = v_invoice.id
    where workspace_id = v_ws and id = v_draft.id;

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

  v_effect := v_ws::text || ':' || v_doc.id::text || ':EMAIL07:' || v_request.id::text;

  insert into commercial.delivery_attempts (
    workspace_id, id, document_id, request_id, template_id, recipient_email_encrypted,
    state, effect_key, last_event_at, retry_count
  ) values (
    v_ws, gen_random_uuid(), v_doc.id, v_request.id, 'EMAIL07', p_encrypted_email,
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
    jsonb_build_object('document_id', v_doc.id, 'kind', 'credit'),
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
      'template_id', 'EMAIL07'
    ),
    1, now(), 0, 'pending',
    v_effect
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'credit_issued', 'document', v_doc.id,
    p_request_id, v_job.version, v_job.version,
    jsonb_build_object('kind', 'credit', 'invoice_id', v_invoice.id)
  );

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
      v_ws, p_actor_id, p_idempotency_key, '/v1/invoices/' || p_invoice_id::text || '/credits',
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

create function commercial.credit_email_facts(p_document_id uuid)
returns table (
  invoice_number text,
  total_cents bigint,
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
    raise exception 'invalid credit email facts' using errcode = '22023';
  end if;
  select * into v_doc from commercial.documents where id = p_document_id;
  if not found or v_doc.kind is distinct from 'credit' then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  return query
    select
      coalesce(v_doc.snapshot_json->>'invoice_number', ''),
      v_doc.total_cents,
      v_doc.issue_date;
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

  v_wait_pdf := v_attempt.template_id in ('EMAIL01', 'EMAIL04', 'EMAIL06', 'EMAIL07');
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

create or replace function commercial.document_delivery_status(p_workspace_id uuid, p_document_id uuid)
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
      and a.template_id = case
        when v_kind = 'invoice' then 'EMAIL06'
        when v_kind = 'credit' then 'EMAIL07'
        else 'EMAIL01'
      end
    order by a.created_at desc, a.id desc
    limit 1;
end;
$$;

create or replace function commercial.record_invoice_payment(
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
  v_credits bigint;
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

  v_next_payments := v_payments + p_amount_cents;
  v_balance := v_doc.total_cents - v_credits - v_next_payments + v_refunds;
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
    'credits_cents', v_credits,
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
      v_credits,
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

create or replace function commercial.record_invoice_refund(
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
  v_credits bigint;
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
  v_next_balance := v_doc.total_cents - v_credits - v_payments + v_next_refunds;
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
    'credits_cents', v_credits,
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
      v_credits,
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

revoke all on function commercial.issued_credit_total(uuid, uuid) from public;
revoke all on function commercial.round_half_up_div(bigint, bigint) from public;
revoke all on function commercial.tax_reduction_cents(bigint, bigint, bigint, bigint) from public;

revoke all on function commercial.freeze_credit_preview(uuid, uuid, text, bytea, jsonb, timestamptz) from public;
grant execute on function commercial.freeze_credit_preview(uuid, uuid, text, bytea, jsonb, timestamptz) to api_app;
revoke all on function commercial.freeze_credit_preview(uuid, uuid, text, bytea, jsonb, timestamptz)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.issue_credit(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) from public;
grant execute on function commercial.issue_credit(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) to api_app;
revoke all on function commercial.issue_credit(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.credit_email_facts(uuid) from public;
grant execute on function commercial.credit_email_facts(uuid) to worker_app;
revoke all on function commercial.credit_email_facts(uuid)
  from api_app, purge_app, anon, authenticated;

grant select on commercial.credit_allocations to api_app;
revoke insert, update, delete on commercial.credit_allocations from api_app;
revoke all on commercial.credit_allocations from public, anon, authenticated, worker_app, purge_app;

reset role;
