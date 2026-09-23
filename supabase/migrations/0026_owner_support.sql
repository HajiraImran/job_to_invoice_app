-- Owner support case intake (DEC13 / S22 / POST /support/cases).
-- Staff console, staff_users, and staff_access_grants remain blocked.
-- Forward-only. Do not edit 0001–0025.

set role migrator;

create table commercial.support_cases (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  owner_id uuid not null,
  operation_id uuid not null,
  category text not null,
  message text not null,
  state text not null,
  content_access_granted_at timestamptz,
  content_access_expires_at timestamptz,
  assigned_staff_id uuid,
  constraint support_cases_pkey primary key (id),
  constraint support_cases_tenant_id_key unique (workspace_id, id),
  constraint support_cases_operation_key unique (operation_id),
  constraint support_cases_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint support_cases_owner_fk
    foreign key (owner_id) references identity.app_users (id) on delete restrict,
  constraint support_cases_category_check check (
    category in ('account', 'billing', 'documents', 'access', 'other')
  ),
  constraint support_cases_state_check check (state in ('open', 'closed')),
  constraint support_cases_message_check check (
    char_length(message) between 10 and 2000
  ),
  constraint support_cases_grant_pair_check check (
    (content_access_granted_at is null and content_access_expires_at is null)
    or (
      content_access_granted_at is not null
      and content_access_expires_at is not null
      and content_access_expires_at = content_access_granted_at + interval '24 hours'
    )
  )
);

create index support_cases_workspace_created_idx
  on commercial.support_cases (workspace_id, created_at desc, id desc);

create trigger support_cases_touch_updated_at
  before update on commercial.support_cases
  for each row execute function identity.touch_updated_at();

create trigger support_cases_reject_key_change
  before update on commercial.support_cases
  for each row execute function commercial.reject_tenant_key_change();

alter table commercial.support_cases enable row level security;
alter table commercial.support_cases force row level security;
select identity.install_migrator_force_rls_policy('commercial.support_cases');

create policy support_cases_select on commercial.support_cases
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = support_cases.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

grant select on commercial.support_cases to api_app;
revoke all on commercial.support_cases from anon, authenticated;

create function commercial.create_support_case(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_category text,
  p_message text,
  p_grant_content_access boolean
)
returns table (
  id uuid,
  category text,
  state text,
  content_access_granted boolean,
  content_access_expires_at timestamptz,
  created_at timestamptz,
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
  v_now timestamptz := now();
  v_granted_at timestamptz;
  v_expires_at timestamptz;
  v_id uuid := gen_random_uuid();
begin
  if p_category not in ('account', 'billing', 'documents', 'access', 'other') then
    raise exception 'VALIDATION_FAILED' using errcode = '22023';
  end if;
  if p_message is null or char_length(p_message) < 10 or char_length(p_message) > 2000 then
    raise exception 'VALIDATION_FAILED' using errcode = '22023';
  end if;

  select u.status, u.analytics_alias_id
    into v_status, v_alias
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_status not in ('active', 'deleting') then
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
  if v_setup is null and v_status is distinct from 'deleting' then
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
          v_existing.response_json->>'category',
          v_existing.response_json->>'state',
          (v_existing.response_json->>'content_access_granted')::boolean,
          (v_existing.response_json->>'content_access_expires_at')::timestamptz,
          (v_existing.response_json->>'created_at')::timestamptz,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, permanence, expires_at
    ) values (
      v_ws, p_actor_id, p_idempotency_key, 'POST /v1/support/cases',
      p_request_hash, p_request_id, 'pending', 'ephemeral', now() + interval '30 days'
    );
  end if;

  if coalesce(p_grant_content_access, false) then
    v_granted_at := v_now;
    v_expires_at := v_now + interval '24 hours';
  end if;

  insert into commercial.support_cases (
    workspace_id, id, owner_id, operation_id, category, message, state,
    content_access_granted_at, content_access_expires_at
  ) values (
    v_ws, v_id, p_actor_id, p_request_id, p_category, p_message, 'open',
    v_granted_at, v_expires_at
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'support_case_opened', 'support_cases', v_id,
    p_request_id,
    jsonb_build_object(
      'category', p_category,
      'grant_content_access', coalesce(p_grant_content_access, false)
    )
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_ws, gen_random_uuid(), 'support_opened', 1, v_now, v_alias, null,
      jsonb_build_object('category', p_category)
    );
  exception
    when unique_violation then
      null;
  end;

  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = jsonb_build_object(
          'id', v_id,
          'category', p_category,
          'state', 'open',
          'content_access_granted', coalesce(p_grant_content_access, false),
          'content_access_expires_at', v_expires_at,
          'created_at', v_now
        )
    where actor_scope = p_actor_id
      and key = p_idempotency_key;

  return query
    select v_id, p_category, 'open'::text, coalesce(p_grant_content_access, false),
           v_expires_at, v_now, false;
end;
$$;

revoke all on function commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean) from public;
grant execute on function commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean) to api_app;
revoke all on function commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean)
  from worker_app, purge_app, anon, authenticated;

alter function commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean) owner to migrator;

create or replace function commercial.complete_purge_account(p_request_id uuid)
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
  delete from commercial.support_cases where workspace_id = v_row.workspace_id;
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

alter function commercial.complete_purge_account(uuid) owner to migrator;

reset role;
