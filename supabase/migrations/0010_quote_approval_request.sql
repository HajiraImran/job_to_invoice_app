-- Quote approval-request delivery (EMAIL01 / S12 / D-017).
-- Forward-only. Do not edit 0001–0009.

set role migrator;

create table commercial.approval_requests (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  job_id uuid not null,
  document_id uuid not null,
  purpose text not null,
  recipient_name text,
  recipient_email text not null,
  token_hash text not null,
  token_key_version integer not null,
  state text not null,
  expected_scope_version integer not null,
  expires_at timestamptz not null,
  access_until timestamptz not null,
  token_rotated_at timestamptz,
  decided_at timestamptz,
  constraint approval_requests_pkey primary key (id),
  constraint approval_requests_tenant_id_key unique (workspace_id, id),
  constraint approval_requests_token_hash_key unique (token_hash),
  constraint approval_requests_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint approval_requests_job_fk
    foreign key (workspace_id, job_id)
    references commercial.jobs (workspace_id, id)
    on delete restrict,
  constraint approval_requests_document_fk
    foreign key (workspace_id, document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint approval_requests_purpose_check check (purpose in ('approval', 'view_only')),
  constraint approval_requests_state_check check (
    state in ('pending', 'approved', 'declined', 'withdrawn', 'expired', 'superseded', 'revoked')
  ),
  constraint approval_requests_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint approval_requests_token_key_version_check check (token_key_version >= 1),
  constraint approval_requests_scope_version_check check (expected_scope_version >= 0),
  constraint approval_requests_email_len check (char_length(recipient_email) between 3 and 254)
);

create unique index approval_requests_pending_approval_key
  on commercial.approval_requests (workspace_id, job_id)
  where state = 'pending' and purpose = 'approval';

create index approval_requests_hash_idx
  on commercial.approval_requests (token_hash);

create index approval_requests_state_expiry_idx
  on commercial.approval_requests (workspace_id, state, expires_at);

create table commercial.delivery_attempts (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  document_id uuid not null,
  request_id uuid not null,
  template_id text not null,
  recipient_email_encrypted bytea not null,
  state text not null,
  provider_message_id text,
  effect_key text not null,
  last_event_at timestamptz not null default now(),
  retry_count integer not null default 0,
  constraint delivery_attempts_pkey primary key (id),
  constraint delivery_attempts_tenant_id_key unique (workspace_id, id),
  constraint delivery_attempts_effect_key_key unique (effect_key),
  constraint delivery_attempts_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint delivery_attempts_document_fk
    foreign key (workspace_id, document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint delivery_attempts_request_fk
    foreign key (workspace_id, request_id)
    references commercial.approval_requests (workspace_id, id)
    on delete restrict,
  constraint delivery_attempts_template_check check (template_id = 'EMAIL01'),
  constraint delivery_attempts_state_check check (
    state in (
      'queued',
      'submitting',
      'accepted_by_provider',
      'delivered',
      'bounced',
      'complained',
      'failed'
    )
  ),
  constraint delivery_attempts_retry_check check (retry_count >= 0)
);

create unique index delivery_attempts_provider_message_id_key
  on commercial.delivery_attempts (provider_message_id)
  where provider_message_id is not null;

create index delivery_attempts_request_idx
  on commercial.delivery_attempts (workspace_id, request_id, updated_at desc, id desc);

create table commercial.encrypted_delivery_payloads (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  delivery_attempt_id uuid not null,
  algorithm text not null,
  key_version integer not null,
  nonce bytea not null,
  ciphertext bytea not null,
  purge_after timestamptz,
  purged_at timestamptz,
  constraint encrypted_delivery_payloads_pkey primary key (id),
  constraint encrypted_delivery_payloads_tenant_id_key unique (workspace_id, id),
  constraint encrypted_delivery_payloads_attempt_key unique (delivery_attempt_id),
  constraint encrypted_delivery_payloads_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint encrypted_delivery_payloads_attempt_fk
    foreign key (workspace_id, delivery_attempt_id)
    references commercial.delivery_attempts (workspace_id, id)
    on delete restrict,
  constraint encrypted_delivery_payloads_algorithm_check check (algorithm = 'aes-256-gcm'),
  constraint encrypted_delivery_payloads_key_version_check check (key_version >= 1),
  constraint encrypted_delivery_payloads_nonce_check check (octet_length(nonce) = 12),
  constraint encrypted_delivery_payloads_ciphertext_check check (octet_length(ciphertext) >= 17)
);

create table commercial.provider_events (
  workspace_id uuid,
  id uuid not null,
  created_at timestamptz not null default now(),
  provider text not null,
  external_event_id text not null,
  received_at timestamptz not null default now(),
  processing_state text not null,
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error_code text,
  constraint provider_events_pkey primary key (id),
  constraint provider_events_provider_event_key unique (provider, external_event_id),
  constraint provider_events_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint provider_events_provider_check check (provider = 'resend'),
  constraint provider_events_state_check check (
    processing_state in ('received', 'applied', 'ignored')
  ),
  constraint provider_events_attempts_check check (attempts >= 0),
  constraint provider_events_external_id_len check (char_length(external_event_id) between 1 and 200)
);

create trigger approval_requests_touch_updated_at
  before update on commercial.approval_requests
  for each row execute function identity.touch_updated_at();

create trigger delivery_attempts_touch_updated_at
  before update on commercial.delivery_attempts
  for each row execute function identity.touch_updated_at();

create trigger approval_requests_reject_key_change
  before update on commercial.approval_requests
  for each row execute function commercial.reject_tenant_key_change();

create trigger delivery_attempts_reject_key_change
  before update on commercial.delivery_attempts
  for each row execute function commercial.reject_tenant_key_change();

create trigger encrypted_delivery_payloads_reject_key_change
  before update on commercial.encrypted_delivery_payloads
  for each row execute function commercial.reject_tenant_key_change();

alter table commercial.approval_requests enable row level security;
alter table commercial.approval_requests force row level security;
select identity.install_migrator_force_rls_policy('commercial.approval_requests');
alter table commercial.delivery_attempts enable row level security;
alter table commercial.delivery_attempts force row level security;
select identity.install_migrator_force_rls_policy('commercial.delivery_attempts');
alter table commercial.encrypted_delivery_payloads enable row level security;
alter table commercial.encrypted_delivery_payloads force row level security;
select identity.install_migrator_force_rls_policy('commercial.encrypted_delivery_payloads');
alter table commercial.provider_events enable row level security;
alter table commercial.provider_events force row level security;
select identity.install_migrator_force_rls_policy('commercial.provider_events');

create policy approval_requests_select on commercial.approval_requests
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = approval_requests.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy delivery_attempts_select on commercial.delivery_attempts
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = delivery_attempts.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create function commercial.email_retry_delay_for_attempt(p_attempts integer)
returns interval
language sql
immutable
as $$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts = 2 then interval '5 minutes'
    when p_attempts = 3 then interval '30 minutes'
    when p_attempts = 4 then interval '2 hours'
    else interval '8 hours'
  end;
$$;

create or replace function commercial.publish_quote_draft(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
  p_preview_hash text
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
  currency text,
  net_cents bigint,
  tax_cents bigint,
  total_cents bigint,
  snapshot_json jsonb,
  schema_version integer,
  snapshot_sha256 text,
  pdf_state text,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  raise exception 'recipient_email is required' using errcode = '22023';
end;
$$;

create function commercial.publish_quote_draft(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
  p_preview_hash text,
  p_recipient_email text,
  p_recipient_name text,
  p_token_hash text,
  p_token_key_version integer,
  p_encrypted_email bytea,
  p_token_ciphertext bytea,
  p_token_nonce bytea,
  p_delivery_algorithm text,
  p_delivery_key_version integer,
  p_expires_at timestamptz,
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
  v_seq integer;
  v_number text;
  v_doc commercial.documents%rowtype;
  v_line jsonb;
  v_origin text;
  v_first boolean := false;
  v_count integer;
  v_bucket text;
  v_payload jsonb;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_pending uuid;
  v_effect text;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_draft_id is null
    or p_expected_version is null
    or p_preview_hash is null
    or p_recipient_email is null
    or p_token_hash is null
    or p_token_key_version is null
    or p_encrypted_email is null
    or p_token_ciphertext is null
    or p_token_nonce is null
    or p_delivery_algorithm is null
    or p_delivery_key_version is null
    or p_expires_at is null
    or p_access_until is null then
    raise exception 'invalid quote publish' using errcode = '22023';
  end if;
  if p_expected_version < 1
    or p_preview_hash !~ '^[0-9a-f]{64}$'
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_key_version < 1
    or p_delivery_key_version < 1
    or p_delivery_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_token_nonce) is distinct from 12
    or octet_length(p_token_ciphertext) < 17
    or char_length(p_recipient_email) not between 3 and 254 then
    raise exception 'invalid quote publish' using errcode = '22023';
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

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws and d.id = p_draft_id
  for update;
  if not found then
    raise exception 'DRAFT_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_draft.kind is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_draft.draft_state is distinct from 'editing' then
    raise exception 'ALREADY_PUBLISHED' using errcode = 'P0010';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle is distinct from 'draft' then
    raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
  end if;

  select ar.id into v_pending
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws
    and ar.job_id = v_job.id
    and ar.state = 'pending'
    and ar.purpose = 'approval'
  for update;
  if v_pending is not null then
    raise exception 'PENDING_APPROVAL' using errcode = 'P0012';
  end if;

  if v_draft.preview_hash is distinct from p_preview_hash
    or v_draft.preview_expires_at is null
    or v_draft.preview_expires_at <= now()
    or v_draft.preview_draft_version is distinct from v_draft.version
    or v_draft.preview_canonical_bytes is null
    or v_draft.preview_snapshot_json is null then
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

  insert into commercial.document_counters as c (workspace_id, type, next_value)
  values (v_ws, 'quote', 1)
  on conflict (workspace_id, type)
  do update set next_value = c.next_value + 1, version = c.version + 1
  returning next_value into v_seq;
  v_number := 'Q-' || lpad(v_seq::text, 6, '0');

  insert into commercial.documents (
    workspace_id, id, created_by, job_id, kind, number, revision_no, prior_document_id,
    lifecycle, issued_at, issue_date, due_date, currency, net_cents, tax_cents, total_cents,
    snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256, scope_version
  ) values (
    v_ws, gen_random_uuid(), p_actor_id, v_draft.job_id, 'quote', v_number, 1, null,
    'issued', now(), (v_draft.preview_snapshot_json->>'issue_date')::date, null, 'USD',
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
      workspace_id, id, document_id, position, line_kind, description, quantity, unit,
      unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
    ) values (
      v_ws, gen_random_uuid(), v_doc.id,
      (v_line->>'position')::integer, 'source', v_line->>'description',
      (v_line->>'quantity')::numeric, v_line->>'unit',
      (v_line->>'unit_price_cents')::bigint, (v_line->>'discount_cents')::bigint,
      (v_line->>'net_cents')::bigint, (v_line->>'tax_bp')::integer,
      (v_line->>'tax_cents')::bigint, (v_line->>'total_cents')::bigint
    );
  end loop;

  update commercial.document_drafts
    set draft_state = 'published',
        parent_document_id = v_doc.id
    where workspace_id = v_ws and id = p_draft_id;

  update commercial.jobs
    set lifecycle = 'active',
        current_quote_id = v_doc.id,
        first_published_at = case when v_first then now() else first_published_at end,
        completion_right = true,
        entitlement_origin = coalesce(entitlement_origin, v_origin),
        version = version + 1
    where workspace_id = v_ws and id = v_job.id;

  insert into commercial.approval_requests (
    workspace_id, id, job_id, document_id, purpose, recipient_name, recipient_email,
    token_hash, token_key_version, state, expected_scope_version, expires_at, access_until
  ) values (
    v_ws, gen_random_uuid(), v_job.id, v_doc.id, 'approval',
    coalesce(p_recipient_name, v_draft.preview_snapshot_json#>>'{customer,name}'),
    p_recipient_email,
    p_token_hash, p_token_key_version, 'pending', v_job.scope_version,
    coalesce((v_draft.preview_snapshot_json->>'expires_at')::timestamptz, p_expires_at),
    p_access_until
  )
  returning * into v_request;

  v_effect := v_ws::text || ':' || v_doc.id::text || ':EMAIL01:' || v_request.id::text;

  insert into commercial.delivery_attempts (
    workspace_id, id, document_id, request_id, template_id, recipient_email_encrypted,
    state, effect_key, last_event_at, retry_count
  ) values (
    v_ws, gen_random_uuid(), v_doc.id, v_request.id, 'EMAIL01', p_encrypted_email,
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
    jsonb_build_object('document_id', v_doc.id, 'kind', 'quote'),
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
      'template_id', 'EMAIL01'
    ),
    1, now(), 0, 'pending',
    v_effect
  );

  v_count := jsonb_array_length(coalesce(v_doc.snapshot_json->'lines', '[]'::jsonb));
  v_bucket := case
    when v_count <= 1 then '1'
    when v_count <= 5 then '2_to_5'
    when v_count <= 20 then '6_to_20'
    else '21_to_100'
  end;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'document_published', 'document', v_doc.id,
    p_request_id, v_job.version, v_job.version + 1,
    jsonb_build_object('kind', 'quote', 'revision_no', 1, 'template_id', 'EMAIL01')
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'document_published', 1, now(), v_alias, v_job.id,
      jsonb_build_object(
        'kind', 'quote',
        'entitlement_origin', coalesce(v_origin, 'free'),
        'line_count_bucket', v_bucket
      )
    );
  exception
    when unique_violation then
      null;
  end;

  v_payload := jsonb_build_object(
    'id', v_doc.id,
    'workspace_id', v_doc.workspace_id,
    'job_id', v_doc.job_id,
    'draft_id', p_draft_id,
    'kind', v_doc.kind,
    'number', v_doc.number,
    'revision_no', v_doc.revision_no,
    'lifecycle', v_doc.lifecycle,
    'issued_at', v_doc.issued_at,
    'issue_date', v_doc.issue_date,
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
      v_ws, p_actor_id, p_idempotency_key, '/v1/drafts/' || p_draft_id::text || '/publish',
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
      p_draft_id,
      v_doc.kind,
      v_doc.number,
      v_doc.revision_no,
      v_doc.lifecycle,
      v_doc.issued_at,
      v_doc.issue_date,
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

create function commercial.owner_job_request(p_workspace_id uuid, p_job_id uuid)
returns table (
  request_id uuid,
  document_id uuid,
  job_id uuid,
  number text,
  revision_no integer,
  template_id text,
  delivery_state text,
  recipient_email text,
  last_event_at timestamptz,
  retry_count integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
begin
  if p_workspace_id is null or p_job_id is null then
    raise exception 'invalid request lookup' using errcode = '22023';
  end if;
  return query
    select
      ar.id,
      ar.document_id,
      ar.job_id,
      d.number,
      d.revision_no,
      da.template_id,
      da.state,
      ar.recipient_email,
      da.last_event_at,
      da.retry_count,
      ar.created_at,
      da.updated_at
    from commercial.approval_requests ar
    join commercial.documents d
      on d.workspace_id = ar.workspace_id and d.id = ar.document_id
    join commercial.delivery_attempts da
      on da.workspace_id = ar.workspace_id and da.request_id = ar.id
    where ar.workspace_id = p_workspace_id
      and ar.job_id = p_job_id
      and ar.purpose = 'approval'
    order by ar.created_at desc, ar.id desc
    limit 1;
end;
$$;

create function commercial.claim_send_email()
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
    and exists (
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
  where da.workspace_id = v_request.workspace_id and da.request_id = v_request.id
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

  if not v_pdf_ready and v_pdf_dead then
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

  if not v_pdf_ready then
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
      v_payload.algorithm,
      v_payload.key_version,
      v_payload.nonce,
      v_payload.ciphertext,
      false,
      v_attempt.provider_message_id;
end;
$$;

create function commercial.complete_send_email(p_task_id uuid, p_provider_message_id text)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_task commercial.outbox_tasks%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
begin
  if p_task_id is null or p_provider_message_id is null or char_length(p_provider_message_id) < 1 then
    raise exception 'invalid email complete' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id and task_type = 'send_email'
  for update;
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  select * into v_attempt
  from commercial.delivery_attempts
  where workspace_id = v_task.workspace_id and request_id = v_task.aggregate_id
  for update;
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_attempt.provider_message_id is not null
    and v_attempt.provider_message_id is distinct from p_provider_message_id then
    raise exception 'PROVIDER_CONFLICT' using errcode = 'P0011';
  end if;
  update commercial.delivery_attempts
    set provider_message_id = p_provider_message_id
    where id = v_attempt.id;
  update commercial.delivery_attempts
    set state = case
          when state in ('delivered', 'bounced', 'complained', 'failed') then state
          else 'accepted_by_provider'
        end,
        last_event_at = now()
    where id = v_attempt.id;
  update commercial.outbox_tasks
    set status = 'done', lease_until = null, last_error_code = null
    where id = p_task_id;
end;
$$;

create function commercial.fail_send_email(p_task_id uuid, p_error_code text, p_permanent boolean)
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
    raise exception 'invalid email fail' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id and task_type = 'send_email'
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
    update commercial.delivery_attempts
      set state = 'failed',
          last_event_at = now(),
          retry_count = v_task.attempts
      where workspace_id = v_task.workspace_id and request_id = v_task.aggregate_id
        and state not in ('delivered', 'bounced', 'complained');
    update commercial.encrypted_delivery_payloads p
      set purge_after = now() + interval '24 hours'
      from commercial.delivery_attempts a
      where a.workspace_id = v_task.workspace_id
        and a.request_id = v_task.aggregate_id
        and p.delivery_attempt_id = a.id
        and p.purged_at is null;
  else
    v_status := 'pending';
    update commercial.outbox_tasks
      set status = 'pending',
          last_error_code = left(p_error_code, 64),
          available_at = now() + commercial.email_retry_delay_for_attempt(v_task.attempts),
          lease_until = null
      where id = p_task_id;
    update commercial.delivery_attempts
      set retry_count = v_task.attempts,
          last_event_at = now(),
          state = case when state = 'queued' then 'submitting' else state end
      where workspace_id = v_task.workspace_id and request_id = v_task.aggregate_id;
  end if;
  return v_status;
end;
$$;

create function commercial.apply_resend_email_event(
  p_external_event_id text,
  p_event_type text,
  p_provider_message_id text
)
returns table (
  applied boolean,
  duplicate boolean,
  delivery_state text,
  template_id text,
  workspace_id uuid,
  analytics_alias_id uuid
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_event commercial.provider_events%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_alias uuid;
  v_next text;
  v_terminal boolean := false;
begin
  if p_external_event_id is null or char_length(p_external_event_id) < 1 or p_event_type is null then
    raise exception 'invalid provider event' using errcode = '22023';
  end if;

  insert into commercial.provider_events (
    id, provider, external_event_id, received_at, processing_state, attempts
  ) values (
    gen_random_uuid(), 'resend', p_external_event_id, now(), 'received', 0
  )
  on conflict (provider, external_event_id)
  do update set attempts = commercial.provider_events.attempts + 1
  returning * into v_event;

  if v_event.processing_state = 'applied' or v_event.processing_state = 'ignored' then
    return query select false, true, null::text, null::text, v_event.workspace_id, null::uuid;
    return;
  end if;

  if p_event_type in ('email.opened', 'email.clicked', 'ping')
    or p_provider_message_id is null then
    update commercial.provider_events
      set processing_state = 'ignored', processed_at = now()
      where id = v_event.id;
    return query select false, false, null::text, null::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_attempt
  from commercial.delivery_attempts
  where provider_message_id = p_provider_message_id
  for update;
  if not found then
    update commercial.provider_events
      set processing_state = 'ignored', processed_at = now()
      where id = v_event.id;
    return query select false, false, null::text, null::text, null::uuid, null::uuid;
    return;
  end if;

  v_next := v_attempt.state;
  if p_event_type = 'email.sent' then
    if v_attempt.state in ('queued', 'submitting') then
      v_next := 'accepted_by_provider';
    end if;
  elsif p_event_type = 'email.delivered' then
    v_next := 'delivered';
    v_terminal := true;
  elsif p_event_type = 'email.bounced' then
    v_next := 'bounced';
    v_terminal := true;
  elsif p_event_type = 'email.complained' then
    v_next := 'complained';
    v_terminal := true;
  elsif p_event_type = 'email.delivery_delayed' then
    v_next := v_attempt.state;
  else
    update commercial.provider_events
      set processing_state = 'ignored', processed_at = now(), workspace_id = v_attempt.workspace_id
      where id = v_event.id;
    return query select false, false, v_attempt.state, v_attempt.template_id, v_attempt.workspace_id, null::uuid;
    return;
  end if;

  update commercial.delivery_attempts
    set state = v_next,
        last_event_at = now()
    where id = v_attempt.id;

  if v_terminal then
    update commercial.encrypted_delivery_payloads
      set purge_after = coalesce(purge_after, now() + interval '24 hours')
      where delivery_attempt_id = v_attempt.id and purged_at is null;
  end if;

  select u.analytics_alias_id into v_alias
  from commercial.workspaces w
  join identity.app_users u on u.id = w.owner_user_id
  where w.workspace_id = v_attempt.workspace_id;

  if p_event_type in ('email.sent', 'email.delivered', 'email.bounced', 'email.complained') then
    begin
      insert into commercial.analytics_events (
        workspace_id, event_id, event_name, schema_version, occurred_at,
        pseudonymous_owner_id, job_id, safe_properties_json
      )
      select
        v_attempt.workspace_id,
        gen_random_uuid(),
        'request_delivery_result',
        1,
        now(),
        v_alias,
        ar.job_id,
        jsonb_build_object('result', v_next, 'template_id', v_attempt.template_id)
      from commercial.approval_requests ar
      where ar.workspace_id = v_attempt.workspace_id and ar.id = v_attempt.request_id;
    exception
      when unique_violation then
        null;
    end;
  end if;

  update commercial.provider_events
    set processing_state = 'applied',
        processed_at = now(),
        workspace_id = v_attempt.workspace_id
    where id = v_event.id;

  return query select true, false, v_next, v_attempt.template_id, v_attempt.workspace_id, v_alias;
end;
$$;

create function commercial.purge_expired_delivery_payloads()
returns integer
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_count integer;
begin
  update commercial.encrypted_delivery_payloads p
    set ciphertext = '\x'::bytea,
        nonce = decode('000000000000000000000000', 'hex'),
        purged_at = now()
  from commercial.delivery_attempts a
  where p.delivery_attempt_id = a.id
    and p.purged_at is null
    and p.purge_after is not null
    and p.purge_after <= now()
    and a.state in ('delivered', 'bounced', 'complained', 'failed');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table commercial.encrypted_delivery_payloads
  drop constraint encrypted_delivery_payloads_ciphertext_check;

alter table commercial.encrypted_delivery_payloads
  add constraint encrypted_delivery_payloads_ciphertext_check check (
    (purged_at is null and octet_length(ciphertext) >= 17)
    or (purged_at is not null and octet_length(ciphertext) = 0)
  );

comment on table commercial.approval_requests is
  'Hashed customer approval tokens. Raw tokens never persist. D-017.';
comment on table commercial.delivery_attempts is
  'EMAIL01 delivery state. Accepted by provider is not delivered.';
comment on table commercial.encrypted_delivery_payloads is
  'AES-256-GCM ciphertext for the temporary delivery token. API cannot read after insert.';
comment on table commercial.provider_events is
  'Verified Resend event ids for replay deduplication. No raw payloads or signatures.';
comment on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text) is
  'Legacy 7-argument TX01 entry. Fails closed: recipient_email is required.';
comment on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz) is
  'TX01: publish quote, insert hashed approval request, queue original PDF and EMAIL01.';
comment on function commercial.claim_send_email() is
  'Claim EMAIL01 only after the original PDF is ready, or fail without send if PDF is dead.';
comment on function commercial.owner_job_request(uuid, uuid) is
  'Owner S12 read model. Does not return token, hash, ciphertext, or href.';
comment on function commercial.apply_resend_email_event(text, text, text) is
  'Apply a verified Resend event by provider_message_id only.';
comment on function commercial.purge_expired_delivery_payloads() is
  'Remove terminal EMAIL01 ciphertext 24 hours after terminal delivery state.';

revoke all on function commercial.email_retry_delay_for_attempt(integer) from public;
revoke all on function commercial.email_retry_delay_for_attempt(integer)
  from api_app, worker_app, purge_app, anon, authenticated;

revoke all on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz) from public;
grant execute on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz) to api_app;
revoke all on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.owner_job_request(uuid, uuid) from public;
grant execute on function commercial.owner_job_request(uuid, uuid) to api_app;
revoke all on function commercial.owner_job_request(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_send_email() from public;
grant execute on function commercial.claim_send_email() to worker_app;
revoke all on function commercial.claim_send_email()
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.complete_send_email(uuid, text) from public;
grant execute on function commercial.complete_send_email(uuid, text) to worker_app;
revoke all on function commercial.complete_send_email(uuid, text)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.fail_send_email(uuid, text, boolean) from public;
grant execute on function commercial.fail_send_email(uuid, text, boolean) to worker_app;
revoke all on function commercial.fail_send_email(uuid, text, boolean)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.apply_resend_email_event(text, text, text) from public;
grant execute on function commercial.apply_resend_email_event(text, text, text) to api_app;
revoke all on function commercial.apply_resend_email_event(text, text, text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.purge_expired_delivery_payloads() from public;
grant execute on function commercial.purge_expired_delivery_payloads() to purge_app;
revoke all on function commercial.purge_expired_delivery_payloads()
  from api_app, worker_app, anon, authenticated;

revoke all on commercial.approval_requests from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.delivery_attempts from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.encrypted_delivery_payloads from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.provider_events from public, anon, authenticated, api_app, worker_app, purge_app;

reset role;
