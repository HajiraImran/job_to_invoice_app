-- SUB03 app-managed 14-day trial. Forward-only. Do not edit 0001–0022.

set role migrator;

create unique index if not exists analytics_events_trial_started_once
  on commercial.analytics_events (workspace_id)
  where event_name = 'trial_started';

create unique index if not exists outbox_tasks_trial_ending_once
  on commercial.outbox_tasks (workspace_id)
  where task_type = 'send_email'
    and payload_json->>'template_id' = 'EMAIL09';

create function commercial.allocate_first_publication_slot(p_workspace_id uuid)
returns text
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_allow commercial.job_allowances%rowtype;
begin
  if p_workspace_id is null then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;
  select * into v_allow
  from commercial.job_allowances a
  where a.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;
  if v_allow.trial_started_at is not null
    and v_allow.trial_ends_at is not null
    and now() < v_allow.trial_ends_at
    and v_allow.trial_jobs_consumed < 20 then
    update commercial.job_allowances
      set trial_jobs_consumed = trial_jobs_consumed + 1,
          updated_at = now(),
          version = version + 1
      where workspace_id = p_workspace_id;
    return 'trial';
  end if;
  if v_allow.free_jobs_consumed < 3 then
    update commercial.job_allowances
      set free_jobs_consumed = free_jobs_consumed + 1,
          updated_at = now(),
          version = version + 1
      where workspace_id = p_workspace_id;
    return 'free';
  end if;
  raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
end;
$$;

comment on function commercial.allocate_first_publication_slot(uuid) is
  'Consumes a trial slot while the app-managed trial is active, otherwise a lifetime free slot (SUB02/SUB03).';

create function commercial.subscription_state(p_actor_id uuid)
returns table (
  workspace_id uuid,
  source text,
  can_publish boolean,
  can_start_trial boolean,
  free_jobs_consumed integer,
  free_jobs_remaining integer,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_jobs_consumed integer,
  trial_jobs_remaining integer,
  trial_active boolean,
  trial_used boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_ws uuid;
  v_setup timestamptz;
  v_allow commercial.job_allowances%rowtype;
  v_active boolean;
  v_free_remaining integer;
  v_trial_remaining integer;
begin
  if p_actor_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
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
  select * into v_allow
  from commercial.job_allowances a
  where a.workspace_id = v_ws
  for update;
  if not found then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;
  v_active := v_allow.trial_started_at is not null
    and v_allow.trial_ends_at is not null
    and now() < v_allow.trial_ends_at
    and v_allow.trial_jobs_consumed < 20;
  v_free_remaining := greatest(0, 3 - v_allow.free_jobs_consumed);
  v_trial_remaining := case
    when v_allow.trial_started_at is null then 20
    else greatest(0, 20 - v_allow.trial_jobs_consumed)
  end;
  return query select
    v_ws,
    case when v_active then 'trial' else 'free' end,
    (v_free_remaining > 0 or v_active),
    v_allow.trial_started_at is null,
    v_allow.free_jobs_consumed,
    v_free_remaining,
    v_allow.trial_started_at,
    v_allow.trial_ends_at,
    v_allow.trial_jobs_consumed,
    case when v_allow.trial_started_at is null then 20 else v_trial_remaining end,
    v_active,
    v_allow.trial_started_at is not null;
end;
$$;

create function commercial.start_trial(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_acknowledged boolean
)
returns table (
  workspace_id uuid,
  source text,
  can_publish boolean,
  can_start_trial boolean,
  free_jobs_consumed integer,
  free_jobs_remaining integer,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_jobs_consumed integer,
  trial_jobs_remaining integer,
  trial_active boolean,
  trial_used boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_status text;
  v_alias uuid;
  v_ws uuid;
  v_setup timestamptz;
  v_existing commercial.idempotency_records%rowtype;
  v_allow commercial.job_allowances%rowtype;
  v_started timestamptz;
  v_ends timestamptz;
  v_state record;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_request_id is null
    or p_acknowledged is distinct from true then
    raise exception 'invalid trial start' using errcode = '22023';
  end if;

  select u.status, u.analytics_alias_id
    into v_status, v_alias
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_status is distinct from 'active' then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
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
          (v_existing.response_json->>'workspace_id')::uuid,
          v_existing.response_json->>'source',
          (v_existing.response_json->>'can_publish')::boolean,
          (v_existing.response_json->>'can_start_trial')::boolean,
          (v_existing.response_json->>'free_jobs_consumed')::integer,
          (v_existing.response_json->>'free_jobs_remaining')::integer,
          (v_existing.response_json->>'trial_started_at')::timestamptz,
          (v_existing.response_json->>'trial_ends_at')::timestamptz,
          (v_existing.response_json->>'trial_jobs_consumed')::integer,
          (v_existing.response_json->>'trial_jobs_remaining')::integer,
          (v_existing.response_json->>'trial_active')::boolean,
          (v_existing.response_json->>'trial_used')::boolean,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, permanence, expires_at
    ) values (
      v_ws, p_actor_id, p_idempotency_key, 'POST /v1/subscription/trial',
      p_request_hash, p_request_id, 'pending', 'ephemeral', now() + interval '24 hours'
    );
  end if;

  select * into v_allow
  from commercial.job_allowances a
  where a.workspace_id = v_ws
  for update;
  if not found then
    raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
  end if;
  if v_allow.trial_started_at is not null then
    raise exception 'TRIAL_ALREADY_STARTED' using errcode = 'P0057';
  end if;

  v_started := now();
  v_ends := v_started + interval '14 days';
  update commercial.job_allowances
    set trial_started_at = v_started,
        trial_ends_at = v_ends,
        trial_jobs_consumed = 0,
        updated_at = now(),
        version = version + 1
    where workspace_id = v_ws;

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json,
    available_at, attempts, status, effect_key
  ) values (
    v_ws, gen_random_uuid(), gen_random_uuid(), 'send_email', v_ws,
    jsonb_build_object(
      'template_id', 'EMAIL09',
      'remaining_free_slots', greatest(0, 3 - v_allow.free_jobs_consumed)
    ),
    v_ends - interval '2 days',
    0, 'pending',
    'trial-ending:' || v_ws::text
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'trial_started', 'job_allowances', v_ws,
    p_request_id, v_allow.version, v_allow.version + 1,
    jsonb_build_object('remaining_free_slots', greatest(0, 3 - v_allow.free_jobs_consumed))
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'trial_started', 1, now(), v_alias, null,
      jsonb_build_object('remaining_free_slots', greatest(0, 3 - v_allow.free_jobs_consumed))
    );
  exception
    when unique_violation then
      null;
  end;

  select * into v_state from commercial.subscription_state(p_actor_id);
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = jsonb_build_object(
          'workspace_id', v_state.workspace_id,
          'source', v_state.source,
          'can_publish', v_state.can_publish,
          'can_start_trial', v_state.can_start_trial,
          'free_jobs_consumed', v_state.free_jobs_consumed,
          'free_jobs_remaining', v_state.free_jobs_remaining,
          'trial_started_at', v_state.trial_started_at,
          'trial_ends_at', v_state.trial_ends_at,
          'trial_jobs_consumed', v_state.trial_jobs_consumed,
          'trial_jobs_remaining', v_state.trial_jobs_remaining,
          'trial_active', v_state.trial_active,
          'trial_used', v_state.trial_used
        )
    where actor_scope = p_actor_id and key = p_idempotency_key;

  return query select
    v_state.workspace_id,
    v_state.source,
    v_state.can_publish,
    v_state.can_start_trial,
    v_state.free_jobs_consumed,
    v_state.free_jobs_remaining,
    v_state.trial_started_at,
    v_state.trial_ends_at,
    v_state.trial_jobs_consumed,
    v_state.trial_jobs_remaining,
    v_state.trial_active,
    v_state.trial_used,
    false;
end;
$$;

comment on function commercial.start_trial(uuid, uuid, text, uuid, boolean) is
  'Starts the once-only 14-day app-managed trial and queues EMAIL09 two days before expiry.';

create function commercial.claim_trial_ending_email()
returns table (
  id uuid,
  workspace_id uuid,
  template_id text,
  effect_key text,
  attempts integer,
  created_by uuid,
  recipient_email text,
  remaining_free_slots integer,
  trial_ends_at timestamptz,
  provider_message_id text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_task commercial.outbox_tasks%rowtype;
  v_ws commercial.workspaces%rowtype;
  v_allow commercial.job_allowances%rowtype;
begin
  select o.*
    into v_task
  from commercial.outbox_tasks o
  where o.task_type = 'send_email'
    and o.attempts < 5
    and coalesce(o.payload_json->>'template_id', '') = 'EMAIL09'
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

  select * into v_ws
  from commercial.workspaces w
  where w.workspace_id = v_task.workspace_id
  for update;
  if not found then
    update commercial.outbox_tasks
      set status = 'dead', last_error_code = 'VALIDATION_FAILED', lease_until = null
      where outbox_tasks.id = v_task.id;
    return;
  end if;

  select * into v_allow
  from commercial.job_allowances a
  where a.workspace_id = v_task.workspace_id;

  update commercial.outbox_tasks
    set status = 'running',
        attempts = outbox_tasks.attempts + 1,
        lease_until = now() + interval '60 seconds'
    where outbox_tasks.id = v_task.id
    returning * into v_task;

  return query select
    v_task.id,
    v_task.workspace_id,
    'EMAIL09'::text,
    v_task.effect_key,
    v_task.attempts,
    v_ws.owner_user_id,
    v_ws.contact_email,
    coalesce((v_task.payload_json->>'remaining_free_slots')::integer, greatest(0, 3 - coalesce(v_allow.free_jobs_consumed, 0))),
    v_allow.trial_ends_at,
    null::text;
end;
$$;

create function commercial.complete_trial_ending_email(p_task_id uuid, p_provider_message_id text)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_task commercial.outbox_tasks%rowtype;
begin
  if p_task_id is null or p_provider_message_id is null or char_length(p_provider_message_id) < 1 then
    raise exception 'invalid email complete' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id
    and task_type = 'send_email'
    and payload_json->>'template_id' = 'EMAIL09'
  for update;
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  update commercial.outbox_tasks
    set status = 'done', lease_until = null, last_error_code = null
    where id = p_task_id;
end;
$$;

create function commercial.fail_trial_ending_email(p_task_id uuid, p_error_code text, p_permanent boolean)
returns text
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_task commercial.outbox_tasks%rowtype;
  v_status text;
begin
  if p_task_id is null or p_error_code is null or p_permanent is null then
    raise exception 'invalid email fail' using errcode = '22023';
  end if;
  select * into v_task
  from commercial.outbox_tasks
  where id = p_task_id
    and task_type = 'send_email'
    and payload_json->>'template_id' = 'EMAIL09'
  for update;
  if not found then
    raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0005';
  end if;
  v_status := case
    when p_permanent or v_task.attempts >= 5 then 'dead'
    else 'pending'
  end;
  update commercial.outbox_tasks
    set status = v_status,
        last_error_code = p_error_code,
        lease_until = null,
        available_at = case
          when v_status = 'pending' then now() + interval '1 minute'
          else available_at
        end
    where id = p_task_id;
  return v_status;
end;
$$;

create or replace function commercial.publish_quote_draft(
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
  p_access_until timestamptz,
  p_replace_pending_request_id uuid
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
  v_revision integer;
  v_prior commercial.documents%rowtype;
  v_has_prior boolean := false;
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
  if v_job.lifecycle = 'active' then
    select * into v_prior
    from commercial.documents d
    where d.workspace_id = v_ws and d.id = v_job.current_quote_id
    for update;
    if not found then
      raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
    end if;
    v_has_prior := true;
    if v_prior.lifecycle = 'accepted' then
      raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0010';
    end if;
  elsif v_job.lifecycle is distinct from 'draft' then
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
    if p_replace_pending_request_id is distinct from v_pending then
      raise exception 'PENDING_APPROVAL' using errcode = 'P0012';
    end if;
    update commercial.approval_requests
      set state = 'superseded'
      where id = v_pending and state = 'pending';
    update commercial.approval_sessions
      set revoked_at = now()
      where workspace_id = v_ws and request_id = v_pending and revoked_at is null;
    update commercial.approval_challenges
      set consumed_at = now()
      where workspace_id = v_ws and request_id = v_pending and consumed_at is null;
  end if;
  if v_has_prior and v_prior.lifecycle = 'issued' then
    update commercial.documents
      set lifecycle = 'superseded'
      where workspace_id = v_ws and id = v_prior.id and lifecycle = 'issued';
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
    v_origin := commercial.allocate_first_publication_slot(v_ws);
    v_first := true;
  else
    if v_job.completion_right is not true then
      raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
    end if;
    v_origin := v_job.entitlement_origin;
  end if;

  if not v_has_prior then
    insert into commercial.document_counters as c (workspace_id, type, next_value)
    values (v_ws, 'quote', 1)
    on conflict (workspace_id, type)
    do update set next_value = c.next_value + 1, version = c.version + 1
    returning next_value into v_seq;
    v_number := 'Q-' || lpad(v_seq::text, 6, '0');
    v_revision := 1;
  else
    v_number := v_prior.number;
    v_revision := v_prior.revision_no + 1;
  end if;

  insert into commercial.documents (
    workspace_id, id, created_by, job_id, kind, number, revision_no, prior_document_id,
    lifecycle, issued_at, issue_date, due_date, currency, net_cents, tax_cents, total_cents,
    snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256, scope_version
  ) values (
    v_ws, gen_random_uuid(), p_actor_id, v_draft.job_id, 'quote', v_number, v_revision,
    case when v_has_prior then v_prior.id else null end,
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
    jsonb_build_object('kind', 'quote', 'revision_no', v_revision, 'template_id', 'EMAIL01')
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

create or replace function commercial.issue_direct_invoice(
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
  v_allow commercial.job_allowances%rowtype;
  v_origin text;
  v_first boolean := false;
  v_seq integer;
  v_number text;
  v_doc commercial.documents%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_payload jsonb;
  v_request commercial.approval_requests%rowtype;
  v_attempt commercial.delivery_attempts%rowtype;
  v_effect text;
  v_due date;
  v_issue date;
  v_email text;
  v_has_delivery boolean := false;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_job_id is null or p_preview_hash is null then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;
  v_has_delivery := p_token_hash is not null;
  if v_has_delivery then
    if p_token_hash !~ '^[0-9a-f]{64}$'
      or p_token_key_version is null or p_token_key_version < 1
      or p_encrypted_email is null or p_token_ciphertext is null or p_token_nonce is null
      or p_delivery_algorithm is distinct from 'aes-256-gcm'
      or p_delivery_key_version is null or p_delivery_key_version < 1
      or octet_length(p_token_nonce) is distinct from 12
      or octet_length(p_token_ciphertext) < 17
      or p_access_until is null then
      raise exception 'invalid invoice issue' using errcode = '22023';
    end if;
  end if;

  select u.status, u.analytics_alias_id into v_status, v_alias
  from identity.app_users u where u.id = p_actor_id for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at into v_ws, v_setup
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
  if v_job.mode is distinct from 'direct_invoice' then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
  end if;
  if v_job.lifecycle is distinct from 'draft' or v_job.active_invoice_id is not null then
    raise exception 'INVOICE_NOT_ELIGIBLE' using errcode = 'P0044';
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
    or (v_draft.preview_snapshot_json->>'kind') is distinct from 'invoice'
    or (v_draft.preview_snapshot_json->>'origin') is distinct from 'direct'
    or (v_draft.payload_json->>'issue_acknowledgement') is distinct from 'true' then
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
    v_origin := commercial.allocate_first_publication_slot(v_ws);
    v_first := true;
  else
    if v_job.completion_right is not true then
      raise exception 'ENTITLEMENT_REQUIRED' using errcode = 'P0009';
    end if;
    v_origin := v_job.entitlement_origin;
  end if;

  v_issue := (v_draft.preview_snapshot_json->>'issue_date')::date;
  v_due := (v_draft.preview_snapshot_json->>'due_date')::date;
  if v_issue is null or v_due is null or v_due < v_issue or v_due > v_issue + 365 then
    raise exception 'invalid invoice issue' using errcode = '22023';
  end if;

  v_email := nullif(btrim(v_draft.preview_snapshot_json#>>'{customer,email}'), '');
  if v_email is not null and not v_has_delivery then
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
    v_ws, gen_random_uuid(), p_actor_id, v_job.id, 'invoice', v_number, 1, null,
    'issued', now(), v_issue, v_due, 'USD',
    (v_draft.preview_snapshot_json->>'net_cents')::bigint,
    (v_draft.preview_snapshot_json->>'tax_cents')::bigint,
    (v_draft.preview_snapshot_json->>'total_cents')::bigint,
    v_draft.preview_snapshot_json, v_draft.preview_canonical_bytes,
    coalesce((v_draft.preview_snapshot_json->>'schema_version')::integer, 1),
    v_draft.preview_hash, 1
  )
  returning * into v_doc;

  for v_line in
    select value from jsonb_array_elements(coalesce(v_draft.preview_snapshot_json->'lines', '[]'::jsonb))
  loop
    v_line_id := coalesce(nullif(v_line->>'source_line_id', '')::uuid, gen_random_uuid());
    insert into commercial.document_lines (
      workspace_id, id, document_id, position, line_kind, description, quantity, unit,
      unit_price_cents, discount_cents, net_cents, tax_bp, tax_cents, total_cents
    ) values (
      v_ws, v_line_id, v_doc.id,
      (v_line->>'position')::integer, 'source', v_line->>'description',
      (v_line->>'quantity')::numeric, v_line->>'unit',
      (v_line->>'unit_price_cents')::bigint, (v_line->>'discount_cents')::bigint,
      (v_line->>'net_cents')::bigint, (v_line->>'tax_bp')::integer,
      (v_line->>'tax_cents')::bigint, (v_line->>'total_cents')::bigint
    );
    insert into commercial.scope_entries (
      workspace_id, id, job_id, source_line_id, accepted_document_id, scope_version,
      event_kind, net_delta_cents, tax_delta_cents
    ) values (
      v_ws, gen_random_uuid(), v_job.id, v_line_id, v_doc.id, 1,
      'add', (v_line->>'net_cents')::bigint, (v_line->>'tax_cents')::bigint
    );
  end loop;

  update commercial.document_drafts
    set draft_state = 'published',
        parent_document_id = v_doc.id
    where workspace_id = v_ws and id = v_draft.id;

  update commercial.jobs
    set lifecycle = 'invoiced',
        active_invoice_id = v_doc.id,
        first_published_at = case when v_first then now() else first_published_at end,
        completion_right = true,
        entitlement_origin = coalesce(entitlement_origin, v_origin),
        scope_version = 1,
        version = version + 1
    where workspace_id = v_ws and id = v_job.id;

  if v_email is not null then
    insert into commercial.approval_requests (
      workspace_id, id, job_id, document_id, purpose, recipient_name, recipient_email,
      token_hash, token_key_version, state, expected_scope_version, expires_at, access_until
    ) values (
      v_ws, gen_random_uuid(), v_job.id, v_doc.id, 'view_only',
      coalesce(v_draft.preview_snapshot_json#>>'{customer,name}', ''),
      v_email,
      p_token_hash, p_token_key_version, 'pending', 1,
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
      v_ws, gen_random_uuid(), gen_random_uuid(), 'send_email', v_request.id,
      jsonb_build_object(
        'document_id', v_doc.id,
        'request_id', v_request.id,
        'template_id', 'EMAIL06'
      ),
      1, now(), 0, 'pending',
      v_effect
    );
  end if;

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json, schema_version,
    available_at, attempts, status, effect_key
  ) values (
    v_ws, gen_random_uuid(), gen_random_uuid(), 'generate_original_pdf', v_doc.id,
    jsonb_build_object('document_id', v_doc.id, 'kind', 'invoice'),
    1, now(), 0, 'pending',
    v_ws::text || ':' || v_doc.id::text || ':original_pdf'
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'invoice_issued', 'document', v_doc.id,
    p_request_id, v_job.version, v_job.version + 1,
    jsonb_build_object('kind', 'invoice', 'quote_based', false)
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'invoice_issued', 1, now(), v_alias, v_job.id,
      jsonb_build_object('origin', 'direct', 'has_changes', false)
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
    'delivery_state', case when v_email is null then 'not_requested' else 'queued' end
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
      v_doc.id, v_doc.workspace_id, v_doc.job_id, v_draft.id, v_doc.kind, v_doc.number,
      v_doc.revision_no, v_doc.lifecycle, v_doc.issued_at, v_doc.issue_date, v_doc.due_date,
      v_doc.currency, v_doc.net_cents, v_doc.tax_cents, v_doc.total_cents, v_doc.snapshot_json,
      v_doc.schema_version, v_doc.snapshot_sha256, 'preparing'::text, v_request.id,
      case when v_email is null then 'not_requested' else 'queued' end, false;
end;
$$;

revoke all on function commercial.allocate_first_publication_slot(uuid) from public;
grant execute on function commercial.allocate_first_publication_slot(uuid) to api_app;
revoke all on function commercial.allocate_first_publication_slot(uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.subscription_state(uuid) from public;
grant execute on function commercial.subscription_state(uuid) to api_app;
revoke all on function commercial.subscription_state(uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.start_trial(uuid, uuid, text, uuid, boolean) from public;
grant execute on function commercial.start_trial(uuid, uuid, text, uuid, boolean) to api_app;
revoke all on function commercial.start_trial(uuid, uuid, text, uuid, boolean)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_trial_ending_email() from public;
grant execute on function commercial.claim_trial_ending_email() to worker_app;
revoke all on function commercial.claim_trial_ending_email()
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.complete_trial_ending_email(uuid, text) from public;
grant execute on function commercial.complete_trial_ending_email(uuid, text) to worker_app;
revoke all on function commercial.complete_trial_ending_email(uuid, text)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.fail_trial_ending_email(uuid, text, boolean) from public;
grant execute on function commercial.fail_trial_ending_email(uuid, text, boolean) to worker_app;
revoke all on function commercial.fail_trial_ending_email(uuid, text, boolean)
  from api_app, purge_app, anon, authenticated;

alter function commercial.allocate_first_publication_slot(uuid) owner to migrator;
alter function commercial.subscription_state(uuid) owner to migrator;
alter function commercial.start_trial(uuid, uuid, text, uuid, boolean) owner to migrator;
alter function commercial.claim_trial_ending_email() owner to migrator;
alter function commercial.complete_trial_ending_email(uuid, text) owner to migrator;
alter function commercial.fail_trial_ending_email(uuid, text, boolean) owner to migrator;
alter function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid) owner to migrator;
alter function commercial.issue_direct_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz) owner to migrator;

reset role;
