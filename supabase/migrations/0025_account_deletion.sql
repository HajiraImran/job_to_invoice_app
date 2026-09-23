-- Account deletion lock, EMAIL11, and purge_app live-record purge (PRV03–PRV06).
-- Forward-only. Do not edit 0001–0024.

set role migrator;

create table commercial.deletion_requests (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  owner_id uuid not null,
  operation_id uuid not null,
  requested_at timestamptz not null default now(),
  verified_at timestamptz not null,
  status text not null,
  purge_after timestamptz not null,
  purge_deadline timestamptz not null,
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  retained_categories_json jsonb not null default '[]'::jsonb,
  constraint deletion_requests_pkey primary key (id),
  constraint deletion_requests_tenant_id_key unique (workspace_id, id),
  constraint deletion_requests_workspace_key unique (workspace_id),
  constraint deletion_requests_operation_key unique (operation_id),
  constraint deletion_requests_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint deletion_requests_owner_fk
    foreign key (owner_id) references identity.app_users (id) on delete restrict,
  constraint deletion_requests_status_check check (
    status in ('locked', 'purging', 'completed', 'exception')
  ),
  constraint deletion_requests_retained_array_check check (
    jsonb_typeof(retained_categories_json) = 'array'
  )
);

create trigger deletion_requests_touch_updated_at
  before update on commercial.deletion_requests
  for each row execute function identity.touch_updated_at();

create trigger deletion_requests_reject_key_change
  before update on commercial.deletion_requests
  for each row execute function commercial.reject_tenant_key_change();

alter table commercial.deletion_requests enable row level security;
alter table commercial.deletion_requests force row level security;
select identity.install_migrator_force_rls_policy('commercial.deletion_requests');

create policy deletion_requests_select on commercial.deletion_requests
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = deletion_requests.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create function commercial.account_purge_allowed()
returns boolean
language sql
stable
as $$
  select coalesce(current_user = 'purge_app', false)
    or coalesce(current_setting('job_to_invoice.account_purge', true), '') = '1';
$$;

create or replace function commercial.protect_issued_document()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if not commercial.account_purge_allowed() then
      raise exception 'issued documents cannot be deleted' using errcode = '23001';
    end if;
    return old;
  end if;
  if current_user = 'purge_app' or commercial.account_purge_allowed() then
    return new;
  end if;
  if current_user = 'migrator'
    and old.lifecycle = 'issued'
    and new.lifecycle in ('accepted', 'declined', 'superseded', 'withdrawn', 'expired', 'voided')
    and new.workspace_id is not distinct from old.workspace_id
    and new.id is not distinct from old.id
    and new.created_at is not distinct from old.created_at
    and new.created_by is not distinct from old.created_by
    and new.job_id is not distinct from old.job_id
    and new.kind is not distinct from old.kind
    and new.number is not distinct from old.number
    and new.revision_no is not distinct from old.revision_no
    and new.prior_document_id is not distinct from old.prior_document_id
    and new.issued_at is not distinct from old.issued_at
    and new.issue_date is not distinct from old.issue_date
    and new.due_date is not distinct from old.due_date
    and new.currency is not distinct from old.currency
    and new.net_cents is not distinct from old.net_cents
    and new.tax_cents is not distinct from old.tax_cents
    and new.total_cents is not distinct from old.total_cents
    and new.snapshot_json is not distinct from old.snapshot_json
    and new.canonical_snapshot_bytes is not distinct from old.canonical_snapshot_bytes
    and new.schema_version is not distinct from old.schema_version
    and new.snapshot_sha256 is not distinct from old.snapshot_sha256
    and new.scope_version is not distinct from old.scope_version
    and (
      new.lifecycle is distinct from 'voided'
        and new.void_reason is not distinct from old.void_reason
      or new.lifecycle = 'voided'
        and old.void_reason is null
        and new.void_reason is not null
    ) then
    return new;
  end if;
  raise exception 'issued documents are immutable' using errcode = '23001';
end;
$$;

create or replace function commercial.protect_artifact_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if not commercial.account_purge_allowed() then
      raise exception 'artifacts cannot be deleted' using errcode = '23001';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if not commercial.account_purge_allowed() then
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

create or replace function commercial.protect_ledger_row()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if not commercial.account_purge_allowed() then
      raise exception 'ledger rows are append-only' using errcode = '23001';
    end if;
    return old;
  end if;
  if not commercial.account_purge_allowed() then
    raise exception 'ledger rows are append-only' using errcode = '23001';
  end if;
  return new;
end;
$$;

create or replace function commercial.reject_audit_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and commercial.account_purge_allowed() then
    return old;
  end if;
  raise exception 'audit_events are append-only' using errcode = '23001';
end;
$$;

create or replace function commercial.reject_scope_entry_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and commercial.account_purge_allowed() then
    return old;
  end if;
  raise exception 'scope entries are append-only' using errcode = '23001';
end;
$$;

create or replace function commercial.reject_decision_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and commercial.account_purge_allowed() then
    return old;
  end if;
  raise exception 'approval decisions are immutable' using errcode = '23001';
end;
$$;

revoke all on function commercial.account_purge_allowed() from public;
revoke all on function commercial.account_purge_allowed()
  from api_app, worker_app, purge_app, anon, authenticated;
alter function commercial.account_purge_allowed() owner to migrator;
alter function commercial.protect_issued_document() owner to migrator;
alter function commercial.protect_artifact_write() owner to migrator;
alter function commercial.protect_ledger_row() owner to migrator;
alter function commercial.reject_audit_change() owner to migrator;
alter function commercial.reject_scope_entry_mutation() owner to migrator;
alter function commercial.reject_decision_mutation() owner to migrator;

create unique index if not exists outbox_tasks_deletion_receipt_once
  on commercial.outbox_tasks (workspace_id, aggregate_id)
  where task_type = 'send_email'
    and payload_json->>'template_id' = 'EMAIL11';

create function commercial.request_account_deletion(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_grant_token_hash bytea,
  p_confirmed boolean
)
returns table (
  id uuid,
  workspace_id uuid,
  status text,
  requested_at timestamptz,
  verified_at timestamptz,
  purge_after timestamptz,
  purge_deadline timestamptz,
  completed_at timestamptz,
  retained_categories_json jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_status text;
  v_ws uuid;
  v_setup timestamptz;
  v_existing commercial.idempotency_records%rowtype;
  v_row commercial.deletion_requests%rowtype;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null
    or p_request_id is null or p_confirmed is not true then
    raise exception 'VALIDATION_FAILED' using errcode = '22023';
  end if;

  select u.status into v_status
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_status in ('deleting', 'deleted') then
    select * into v_row
    from commercial.deletion_requests d
    where d.owner_id = p_actor_id
    limit 1;
    if found then
      select * into v_existing
      from commercial.idempotency_records r
      where r.actor_scope = p_actor_id
        and r.key = p_idempotency_key;
      if found and v_existing.request_hash is distinct from p_request_hash then
        raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
      end if;
      if found and v_existing.status = 'completed' then
        return query select
          v_row.id, v_row.workspace_id, v_row.status, v_row.requested_at, v_row.verified_at,
          v_row.purge_after, v_row.purge_deadline, v_row.completed_at,
          v_row.retained_categories_json, true;
        return;
      end if;
    end if;
    raise exception 'ACCOUNT_DELETING' using errcode = 'P0059';
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

  select * into v_existing
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
          (v_existing.response_json->>'workspace_id')::uuid,
          v_existing.response_json->>'status',
          (v_existing.response_json->>'requested_at')::timestamptz,
          (v_existing.response_json->>'verified_at')::timestamptz,
          (v_existing.response_json->>'purge_after')::timestamptz,
          (v_existing.response_json->>'purge_deadline')::timestamptz,
          (v_existing.response_json->>'completed_at')::timestamptz,
          coalesce(v_existing.response_json->'retained_categories_json', '[]'::jsonb),
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, 'POST /v1/account/deletion',
      p_request_hash, p_request_id, 'pending', 'financial'
    );
  end if;

  perform identity.consume_action_grant(p_actor_id, 'deletion', p_grant_token_hash);

  update identity.app_users
    set status = 'deleting',
        deletion_requested_at = now(),
        updated_at = now(),
        version = version + 1
    where id = p_actor_id;

  insert into commercial.deletion_requests (
    workspace_id, id, owner_id, operation_id, requested_at, verified_at,
    status, purge_after, purge_deadline, retained_categories_json
  ) values (
    v_ws, gen_random_uuid(), p_actor_id, p_request_id, now(), now(),
    'locked', now(), now() + interval '30 days', '[]'::jsonb
  )
  returning * into v_row;

  update commercial.approval_sessions
    set revoked_at = now()
    where workspace_id = v_ws
      and revoked_at is null;

  update commercial.approval_challenges
    set consumed_at = coalesce(consumed_at, now())
    where workspace_id = v_ws
      and consumed_at is null;

  update commercial.approval_requests
    set state = 'withdrawn',
        updated_at = now()
    where workspace_id = v_ws
      and state = 'pending';

  update commercial.outbox_tasks
    set status = 'dead',
        last_error_code = 'ACCOUNT_DELETING',
        lease_until = null
    where workspace_id = v_ws
      and status in ('pending', 'running')
      and not (
        task_type = 'send_email'
        and payload_json->>'template_id' = 'EMAIL11'
      );

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json,
    available_at, attempts, status, effect_key
  ) values (
    v_ws, gen_random_uuid(), gen_random_uuid(), 'send_email', v_row.id,
    jsonb_build_object('template_id', 'EMAIL11'),
    now(), 0, 'pending',
    'deletion-receipt:' || v_row.id::text
  )
  on conflict do nothing;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'account_deletion_requested', 'deletion_requests', v_row.id,
    p_request_id, null, 1,
    jsonb_build_object('retained_category_count', 0)
  );

  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = jsonb_build_object(
          'id', v_row.id,
          'workspace_id', v_row.workspace_id,
          'status', v_row.status,
          'requested_at', v_row.requested_at,
          'verified_at', v_row.verified_at,
          'purge_after', v_row.purge_after,
          'purge_deadline', v_row.purge_deadline,
          'completed_at', v_row.completed_at,
          'retained_categories_json', v_row.retained_categories_json
        )
    where actor_scope = p_actor_id and key = p_idempotency_key;

  return query select
    v_row.id, v_row.workspace_id, v_row.status, v_row.requested_at, v_row.verified_at,
    v_row.purge_after, v_row.purge_deadline, v_row.completed_at,
    v_row.retained_categories_json, false;
end;
$$;

comment on function commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean) is
  'Locks the owner account, revokes portal access, queues EMAIL11, and schedules purge_app cleanup. No v1 cancel.';

create function commercial.get_account_deletion(p_actor_id uuid)
returns table (
  id uuid,
  workspace_id uuid,
  status text,
  requested_at timestamptz,
  verified_at timestamptz,
  purge_after timestamptz,
  purge_deadline timestamptz,
  completed_at timestamptz,
  retained_categories_json jsonb
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  return query
    select
      d.id, d.workspace_id, d.status, d.requested_at, d.verified_at,
      d.purge_after, d.purge_deadline, d.completed_at, d.retained_categories_json
    from commercial.deletion_requests d
    where d.owner_id = p_actor_id
    order by d.requested_at desc, d.id desc
    limit 1;
end;
$$;

create function commercial.claim_deletion_receipt_email()
returns table (
  id uuid,
  workspace_id uuid,
  template_id text,
  effect_key text,
  attempts integer,
  created_by uuid,
  recipient_email text,
  requested_at timestamptz,
  purge_deadline timestamptz,
  provider_message_id text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_task commercial.outbox_tasks%rowtype;
  v_req commercial.deletion_requests%rowtype;
  v_email text;
begin
  select o.* into v_task
  from commercial.outbox_tasks o
  where o.task_type = 'send_email'
    and coalesce(o.payload_json->>'template_id', '') = 'EMAIL11'
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

  update commercial.outbox_tasks
    set status = 'running',
        attempts = attempts + 1,
        lease_until = now() + interval '2 minutes'
    where id = v_task.id
    returning * into v_task;

  select * into v_req
  from commercial.deletion_requests d
  where d.workspace_id = v_task.workspace_id
    and d.id = v_task.aggregate_id;

  select u.display_email into v_email
  from identity.app_users u
  where u.id = v_req.owner_id
    and u.status = 'deleting';

  return query select
    v_task.id,
    v_task.workspace_id,
    'EMAIL11'::text,
    v_task.effect_key,
    v_task.attempts,
    v_req.owner_id,
    v_email,
    v_req.requested_at,
    v_req.purge_deadline,
    null::text;
end;
$$;

create function commercial.complete_deletion_receipt_email(p_task_id uuid, p_provider_message_id text)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  update commercial.outbox_tasks
    set status = 'done',
        lease_until = null
    where id = p_task_id
      and task_type = 'send_email'
      and payload_json->>'template_id' = 'EMAIL11';
end;
$$;

create function commercial.fail_deletion_receipt_email(p_task_id uuid, p_error_code text, p_dead boolean)
returns text
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_status text;
begin
  v_status := case when p_dead then 'dead' else 'pending' end;
  update commercial.outbox_tasks
    set status = v_status,
        available_at = case
          when p_dead then available_at
          when attempts = 1 then now() + interval '1 minute'
          when attempts = 2 then now() + interval '5 minutes'
          when attempts = 3 then now() + interval '30 minutes'
          when attempts = 4 then now() + interval '2 hours'
          else now() + interval '8 hours'
        end,
        lease_until = null,
        last_error_code = left(coalesce(p_error_code, 'UNAVAILABLE'), 80)
    where id = p_task_id
      and task_type = 'send_email'
      and payload_json->>'template_id' = 'EMAIL11';
  return v_status;
end;
$$;

create function commercial.claim_purge_account()
returns table (
  id uuid,
  workspace_id uuid,
  owner_id uuid,
  object_keys text[]
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_row commercial.deletion_requests%rowtype;
  v_keys text[];
begin
  select d.* into v_row
  from commercial.deletion_requests d
  where (
      (d.status = 'locked' and d.purge_after <= now())
      or (d.status = 'purging' and d.updated_at < now() - interval '30 minutes')
    )
    and d.purge_deadline >= now()
    and (
      not exists (
        select 1
        from commercial.outbox_tasks o
        where o.workspace_id = d.workspace_id
          and o.aggregate_id = d.id
          and o.task_type = 'send_email'
          and o.payload_json->>'template_id' = 'EMAIL11'
          and o.status in ('pending', 'running')
      )
      or d.requested_at <= now() - interval '24 hours'
    )
  order by d.requested_at, d.id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;

  update commercial.deletion_requests
    set status = 'purging',
        error_code = null
    where id = v_row.id
    returning * into v_row;

  select coalesce(array_agg(distinct key), '{}')
    into v_keys
  from (
    select a.object_key as key
    from commercial.artifacts a
    where a.workspace_id = v_row.workspace_id
      and a.object_key is not null
    union
    select e.object_key
    from commercial.exports e
    where e.workspace_id = v_row.workspace_id
      and e.object_key is not null
    union
    select s.bucket_key
    from commercial.assets s
    where s.workspace_id = v_row.workspace_id
      and s.bucket_key is not null
  ) keys;

  return query select v_row.id, v_row.workspace_id, v_row.owner_id, v_keys;
end;
$$;

create function commercial.complete_purge_account(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_row commercial.deletion_requests%rowtype;
  v_alias text;
begin
  select * into v_row
  from commercial.deletion_requests d
  where d.id = p_request_id
  for update;
  if not found or v_row.status is distinct from 'purging' then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  perform set_config('job_to_invoice.account_purge', '1', true);

  delete from commercial.encrypted_delivery_payloads where workspace_id = v_row.workspace_id;
  delete from commercial.delivery_attempts where workspace_id = v_row.workspace_id;
  delete from commercial.provider_events where workspace_id = v_row.workspace_id;
  delete from commercial.approval_challenges where workspace_id = v_row.workspace_id;
  delete from commercial.approval_sessions where workspace_id = v_row.workspace_id;
  delete from commercial.approval_decisions where workspace_id = v_row.workspace_id;
  delete from commercial.approval_requests where workspace_id = v_row.workspace_id;
  delete from commercial.scope_entries where workspace_id = v_row.workspace_id;
  delete from commercial.credit_allocations where workspace_id = v_row.workspace_id;
  delete from commercial.ledger_refund_allocations where workspace_id = v_row.workspace_id;
  delete from commercial.ledger_entries where workspace_id = v_row.workspace_id;
  delete from commercial.outbox_tasks
    where workspace_id = v_row.workspace_id
      and not (
        task_type = 'send_email'
        and payload_json->>'template_id' = 'EMAIL11'
      );
  update commercial.artifacts set export_id = null where workspace_id = v_row.workspace_id;
  update commercial.exports set artifact_id = null, object_key = null where workspace_id = v_row.workspace_id;
  delete from commercial.artifacts where workspace_id = v_row.workspace_id;
  delete from commercial.exports where workspace_id = v_row.workspace_id;
  delete from commercial.document_lines where workspace_id = v_row.workspace_id;
  update commercial.workspaces
    set logo_asset_id = null
    where id = v_row.workspace_id;
  delete from commercial.assets where workspace_id = v_row.workspace_id;
  update commercial.document_drafts set parent_document_id = null where workspace_id = v_row.workspace_id;
  update commercial.jobs
    set current_quote_id = null,
        active_invoice_id = null,
        related_job_id = null
    where workspace_id = v_row.workspace_id;
  delete from commercial.document_drafts where workspace_id = v_row.workspace_id;
  delete from commercial.documents where workspace_id = v_row.workspace_id;
  delete from commercial.document_counters where workspace_id = v_row.workspace_id;
  delete from commercial.jobs where workspace_id = v_row.workspace_id;
  delete from commercial.customers where workspace_id = v_row.workspace_id;
  delete from commercial.catalogue_items where workspace_id = v_row.workspace_id;
  delete from commercial.analytics_events where workspace_id = v_row.workspace_id;
  delete from commercial.audit_events where workspace_id = v_row.workspace_id;
  delete from commercial.idempotency_records
    where workspace_id = v_row.workspace_id
      and permanence = 'ephemeral';
  delete from commercial.job_allowances where workspace_id = v_row.workspace_id;
  delete from identity.action_grants where user_id = v_row.owner_id;

  v_alias := 'deleted+' || replace(v_row.owner_id::text, '-', '') || '@invalid.invalid';
  update identity.app_users
    set status = 'deleted',
        display_email = 'deleted',
        normalized_email = v_alias,
        updated_at = now(),
        version = version + 1
    where id = v_row.owner_id;

  update commercial.workspaces
    set business_name = 'deleted',
        legal_name = 'deleted',
        contact_name = 'deleted',
        contact_email = v_alias,
        contact_phone = null,
        address_json = '{}'::jsonb,
        default_terms = '',
        setup_completed_at = null,
        updated_at = now(),
        version = version + 1
    where id = v_row.workspace_id;

  update commercial.deletion_requests
    set status = 'completed',
        completed_at = now(),
        error_code = null
    where id = v_row.id;
end;
$$;

create function commercial.fail_purge_account(p_request_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  update commercial.deletion_requests
    set status = 'exception',
        failed_at = now(),
        error_code = left(coalesce(p_error_code, 'UNAVAILABLE'), 80)
    where id = p_request_id
      and status in ('locked', 'purging');
end;
$$;

revoke all on function commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean) from public;
grant execute on function commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean) to api_app;
revoke all on function commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.get_account_deletion(uuid) from public;
grant execute on function commercial.get_account_deletion(uuid) to api_app;
revoke all on function commercial.get_account_deletion(uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_deletion_receipt_email() from public;
grant execute on function commercial.claim_deletion_receipt_email() to worker_app;
revoke all on function commercial.claim_deletion_receipt_email()
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.complete_deletion_receipt_email(uuid, text) from public;
grant execute on function commercial.complete_deletion_receipt_email(uuid, text) to worker_app;
revoke all on function commercial.complete_deletion_receipt_email(uuid, text)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.fail_deletion_receipt_email(uuid, text, boolean) from public;
grant execute on function commercial.fail_deletion_receipt_email(uuid, text, boolean) to worker_app;
revoke all on function commercial.fail_deletion_receipt_email(uuid, text, boolean)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_purge_account() from public;
grant execute on function commercial.claim_purge_account() to purge_app;
revoke all on function commercial.claim_purge_account()
  from api_app, worker_app, anon, authenticated;

revoke all on function commercial.complete_purge_account(uuid) from public;
grant execute on function commercial.complete_purge_account(uuid) to purge_app;
revoke all on function commercial.complete_purge_account(uuid)
  from api_app, worker_app, anon, authenticated;

revoke all on function commercial.fail_purge_account(uuid, text) from public;
grant execute on function commercial.fail_purge_account(uuid, text) to purge_app;
revoke all on function commercial.fail_purge_account(uuid, text)
  from api_app, worker_app, anon, authenticated;

alter function commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean) owner to migrator;
alter function commercial.get_account_deletion(uuid) owner to migrator;
alter function commercial.claim_deletion_receipt_email() owner to migrator;
alter function commercial.complete_deletion_receipt_email(uuid, text) owner to migrator;
alter function commercial.fail_deletion_receipt_email(uuid, text, boolean) owner to migrator;
alter function commercial.claim_purge_account() owner to migrator;
alter function commercial.complete_purge_account(uuid) owner to migrator;
alter function commercial.fail_purge_account(uuid, text) owner to migrator;

reset role;
