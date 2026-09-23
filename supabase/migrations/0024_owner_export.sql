-- Owner workspace export (EXP01/EXP02/EMAIL10/S24). Forward-only. Do not edit 0001–0023.

set role migrator;

create table commercial.exports (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null,
  operation_id uuid not null,
  newer boolean not null default false,
  cutoff_at timestamptz not null,
  status text not null,
  schema_version integer not null default 1,
  part_count integer not null default 1,
  job_count integer,
  artifact_id uuid,
  object_key text,
  sha256 text,
  bytes bigint,
  manifest_json jsonb,
  download_until timestamptz,
  delete_after timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  purged_at timestamptz,
  error_code text,
  constraint exports_pkey primary key (id),
  constraint exports_tenant_id_key unique (workspace_id, id),
  constraint exports_operation_key unique (operation_id),
  constraint exports_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint exports_created_by_fk
    foreign key (created_by) references identity.app_users (id) on delete restrict,
  constraint exports_status_check check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  constraint exports_schema_version_check check (schema_version >= 1),
  constraint exports_part_count_check check (part_count >= 1),
  constraint exports_job_count_check check (job_count is null or job_count >= 0),
  constraint exports_bytes_check check (bytes is null or bytes >= 0),
  constraint exports_hash_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint exports_manifest_object_check check (
    manifest_json is null or jsonb_typeof(manifest_json) = 'object'
  )
);

create index exports_workspace_created_idx
  on commercial.exports (workspace_id, created_at desc);

create trigger exports_touch_updated_at
  before update on commercial.exports
  for each row execute function identity.touch_updated_at();

create trigger exports_reject_key_change
  before update on commercial.exports
  for each row execute function commercial.reject_tenant_key_change();

alter table commercial.exports enable row level security;
alter table commercial.exports force row level security;
select identity.install_migrator_force_rls_policy('commercial.exports');

create policy exports_select on commercial.exports
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = exports.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy exports_insert on commercial.exports
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = exports.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy exports_update on commercial.exports
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = exports.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = exports.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

alter table commercial.artifacts
  add constraint artifacts_export_fk
  foreign key (workspace_id, export_id)
  references commercial.exports (workspace_id, id)
  on delete restrict;

create unique index if not exists outbox_tasks_export_ready_once
  on commercial.outbox_tasks (workspace_id, aggregate_id)
  where task_type = 'send_email'
    and payload_json->>'template_id' = 'EMAIL10';

create function commercial.export_workspace_payload(p_workspace_id uuid, p_cutoff timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_timezone text;
begin
  if p_workspace_id is null or p_cutoff is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  select w.timezone into v_timezone
  from commercial.workspaces w
  where w.id = p_workspace_id;
  if v_timezone is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'timezone', v_timezone,
    'cutoff_at', p_cutoff,
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'email', c.email,
        'phone', c.phone,
        'billing_address_json', c.billing_address_json,
        'archived_at', c.archived_at,
        'created_at', c.created_at
      ) order by c.created_at, c.id)
      from commercial.customers c
      where c.workspace_id = p_workspace_id
        and c.created_at <= p_cutoff
    ), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', j.id,
        'customer_id', j.customer_id,
        'title', j.title,
        'site_address_json', j.site_address_json,
        'no_site', j.no_site,
        'lifecycle', j.lifecycle,
        'mode', j.mode,
        'first_published_at', j.first_published_at,
        'archived_from_state', j.archived_from_state,
        'related_job_id', j.related_job_id,
        'created_at', j.created_at,
        'updated_at', j.updated_at
      ) order by j.created_at, j.id)
      from commercial.jobs j
      where j.workspace_id = p_workspace_id
        and j.created_at <= p_cutoff
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id,
        'job_id', d.job_id,
        'kind', d.kind,
        'number', d.number,
        'revision_no', d.revision_no,
        'lifecycle', d.lifecycle,
        'issued_at', d.issued_at,
        'issue_date', d.issue_date,
        'due_date', d.due_date,
        'currency', d.currency,
        'net_cents', d.net_cents,
        'tax_cents', d.tax_cents,
        'total_cents', d.total_cents,
        'snapshot_json', d.snapshot_json,
        'snapshot_sha256', d.snapshot_sha256,
        'schema_version', d.schema_version
      ) order by d.issued_at, d.id)
      from commercial.documents d
      where d.workspace_id = p_workspace_id
        and d.issued_at <= p_cutoff
    ), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'invoice_id', e.invoice_id,
        'type', e.type,
        'amount_cents', e.amount_cents,
        'effective_date', e.effective_date,
        'method', e.method,
        'reference', e.reference,
        'note', e.note,
        'reverses_entry_id', e.reverses_entry_id,
        'created_at', e.created_at
      ) order by e.created_at, e.id)
      from commercial.ledger_entries e
      where e.workspace_id = p_workspace_id
        and e.created_at <= p_cutoff
    ), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'document_id', a.document_id,
        'decision', a.decision,
        'signer_name', a.signer_name,
        'verified_email', a.verified_email,
        'decided_at', a.decided_at,
        'snapshot_sha256', a.snapshot_sha256,
        'consent_version', a.consent_version,
        'comment', a.comment
      ) order by a.decided_at, a.id)
      from commercial.approval_decisions a
      where a.workspace_id = p_workspace_id
        and a.decided_at <= p_cutoff
    ), '[]'::jsonb),
    'artifacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'document_id', t.document_id,
        'type', t.type,
        'object_key', t.object_key,
        'sha256', t.sha256,
        'bytes', t.bytes,
        'state', t.state,
        'generated_at', t.generated_at
      ) order by t.generated_at, t.id)
      from commercial.artifacts t
      where t.workspace_id = p_workspace_id
        and t.generated_at <= p_cutoff
        and t.type <> 'export_zip'
    ), '[]'::jsonb),
    'images', '[]'::jsonb
  );
end;
$$;

comment on function commercial.export_workspace_payload(uuid, timestamptz) is
  'Consistent-cutoff owner export snapshot. Excludes internal notes, secrets, and approval evidence ciphertext.';

create function commercial.request_export(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_grant_token_hash bytea,
  p_newer boolean
)
returns table (
  id uuid,
  workspace_id uuid,
  status text,
  cutoff_at timestamptz,
  created_at timestamptz,
  download_until timestamptz,
  delete_after timestamptz,
  ready_at timestamptz,
  schema_version integer,
  part_count integer,
  job_count integer,
  bytes bigint,
  sha256 text,
  reused boolean,
  replayed boolean,
  manifest_json jsonb,
  error_code text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_status text;
  v_ws uuid;
  v_setup timestamptz;
  v_existing commercial.idempotency_records%rowtype;
  v_reuse commercial.exports%rowtype;
  v_row commercial.exports%rowtype;
  v_today integer;
begin
  if p_actor_id is null or p_idempotency_key is null or p_request_hash is null or p_request_id is null then
    raise exception 'VALIDATION_FAILED' using errcode = '22023';
  end if;

  select u.status into v_status
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null or v_status is distinct from 'active' then
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
          (v_existing.response_json->>'cutoff_at')::timestamptz,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'download_until')::timestamptz,
          (v_existing.response_json->>'delete_after')::timestamptz,
          (v_existing.response_json->>'ready_at')::timestamptz,
          (v_existing.response_json->>'schema_version')::integer,
          (v_existing.response_json->>'part_count')::integer,
          (v_existing.response_json->>'job_count')::integer,
          (v_existing.response_json->>'bytes')::bigint,
          v_existing.response_json->>'sha256',
          coalesce((v_existing.response_json->>'reused')::boolean, false),
          true,
          v_existing.response_json->'manifest_json',
          v_existing.response_json->>'error_code';
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, permanence, expires_at
    ) values (
      v_ws, p_actor_id, p_idempotency_key, 'POST /v1/exports',
      p_request_hash, p_request_id, 'pending', 'ephemeral', now() + interval '24 hours'
    );
  end if;

  perform identity.consume_action_grant(p_actor_id, 'export', p_grant_token_hash);

  if not coalesce(p_newer, false) then
    select * into v_reuse
    from commercial.exports e
    where e.workspace_id = v_ws
      and e.status in ('queued', 'running', 'ready')
      and e.created_at > now() - interval '24 hours'
      and (e.status <> 'ready' or e.delete_after is null or e.delete_after > now())
    order by e.created_at desc, e.id desc
    limit 1;
    if found then
      v_row := v_reuse;
      update commercial.idempotency_records
        set status = 'completed',
            response_code = 202,
            response_json = jsonb_build_object(
              'id', v_row.id,
              'workspace_id', v_row.workspace_id,
              'status', v_row.status,
              'cutoff_at', v_row.cutoff_at,
              'created_at', v_row.created_at,
              'download_until', v_row.download_until,
              'delete_after', v_row.delete_after,
              'ready_at', v_row.ready_at,
              'schema_version', v_row.schema_version,
              'part_count', v_row.part_count,
              'job_count', v_row.job_count,
              'bytes', v_row.bytes,
              'sha256', v_row.sha256,
              'reused', true,
              'manifest_json', v_row.manifest_json,
              'error_code', v_row.error_code
            )
        where actor_scope = p_actor_id and key = p_idempotency_key;
      return query select
        v_row.id, v_row.workspace_id, v_row.status, v_row.cutoff_at, v_row.created_at,
        v_row.download_until, v_row.delete_after, v_row.ready_at, v_row.schema_version,
        v_row.part_count, v_row.job_count, v_row.bytes, v_row.sha256, true, false,
        v_row.manifest_json, v_row.error_code;
      return;
    end if;
  end if;

  select count(*)::integer into v_today
  from commercial.exports e
  where e.workspace_id = v_ws
    and e.created_at >= date_trunc('day', timezone('utc', now()));
  if v_today >= 2 then
    raise exception 'EXPORT_LIMIT' using errcode = 'P0058';
  end if;

  insert into commercial.exports (
    workspace_id, id, created_by, operation_id, newer, cutoff_at, status
  ) values (
    v_ws, gen_random_uuid(), p_actor_id, p_request_id, coalesce(p_newer, false), now(), 'queued'
  )
  returning * into v_row;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'export_requested', 'exports', v_row.id,
    p_request_id, null, 1,
    jsonb_build_object('newer', coalesce(p_newer, false))
  );

  update commercial.idempotency_records
    set status = 'completed',
        response_code = 202,
        response_json = jsonb_build_object(
          'id', v_row.id,
          'workspace_id', v_row.workspace_id,
          'status', v_row.status,
          'cutoff_at', v_row.cutoff_at,
          'created_at', v_row.created_at,
          'download_until', v_row.download_until,
          'delete_after', v_row.delete_after,
          'ready_at', v_row.ready_at,
          'schema_version', v_row.schema_version,
          'part_count', v_row.part_count,
          'job_count', v_row.job_count,
          'bytes', v_row.bytes,
          'sha256', v_row.sha256,
          'reused', false,
          'manifest_json', v_row.manifest_json,
          'error_code', v_row.error_code
        )
    where actor_scope = p_actor_id and key = p_idempotency_key;

  return query select
    v_row.id, v_row.workspace_id, v_row.status, v_row.cutoff_at, v_row.created_at,
    v_row.download_until, v_row.delete_after, v_row.ready_at, v_row.schema_version,
    v_row.part_count, v_row.job_count, v_row.bytes, v_row.sha256, false, false,
    v_row.manifest_json, v_row.error_code;
end;
$$;

comment on function commercial.request_export(uuid, uuid, text, uuid, bytea, boolean) is
  'Queues an owner export after consuming an export action grant. Reuses a 24h bundle unless newer is true. Caps two new exports per UTC day.';

create function commercial.get_export(p_actor_id uuid, p_export_id uuid)
returns table (
  id uuid,
  workspace_id uuid,
  status text,
  cutoff_at timestamptz,
  created_at timestamptz,
  download_until timestamptz,
  delete_after timestamptz,
  ready_at timestamptz,
  schema_version integer,
  part_count integer,
  job_count integer,
  bytes bigint,
  sha256 text,
  object_key text,
  download_available boolean,
  manifest_json jsonb,
  error_code text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_ws uuid;
  v_row commercial.exports%rowtype;
begin
  select w.id into v_ws
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id;
  if v_ws is null then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  select * into v_row
  from commercial.exports e
  where e.workspace_id = v_ws
    and e.id = p_export_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  return query select
    v_row.id, v_row.workspace_id, v_row.status, v_row.cutoff_at, v_row.created_at,
    v_row.download_until, v_row.delete_after, v_row.ready_at, v_row.schema_version,
    v_row.part_count, v_row.job_count, v_row.bytes, v_row.sha256, v_row.object_key,
    (v_row.status = 'ready'
      and v_row.object_key is not null
      and v_row.download_until is not null
      and v_row.download_until > now()
      and (v_row.purged_at is null)),
    v_row.manifest_json, v_row.error_code;
end;
$$;

create function commercial.latest_export(p_actor_id uuid)
returns table (
  id uuid,
  workspace_id uuid,
  status text,
  cutoff_at timestamptz,
  created_at timestamptz,
  download_until timestamptz,
  delete_after timestamptz,
  ready_at timestamptz,
  schema_version integer,
  part_count integer,
  job_count integer,
  bytes bigint,
  sha256 text,
  object_key text,
  download_available boolean,
  manifest_json jsonb,
  error_code text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_ws uuid;
  v_latest uuid;
begin
  select w.id into v_ws
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id;
  if v_ws is null then
    return;
  end if;
  select e.id into v_latest
  from commercial.exports e
  where e.workspace_id = v_ws
    and e.status in ('queued', 'running', 'ready')
    and (e.delete_after is null or e.delete_after > now())
  order by e.created_at desc, e.id desc
  limit 1;
  if v_latest is null then
    return;
  end if;
  return query select * from commercial.get_export(p_actor_id, v_latest);
end;
$$;

create function commercial.claim_build_export()
returns table (
  id uuid,
  workspace_id uuid,
  created_by uuid,
  cutoff_at timestamptz,
  timezone text,
  payload jsonb
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_row commercial.exports%rowtype;
  v_timezone text;
begin
  select e.* into v_row
  from commercial.exports e
  where e.status = 'queued'
     or (e.status = 'running' and e.updated_at < now() - interval '30 minutes')
  order by e.created_at, e.id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;

  update commercial.exports
    set status = 'running'
    where id = v_row.id
    returning * into v_row;

  select w.timezone into v_timezone
  from commercial.workspaces w
  where w.id = v_row.workspace_id;

  return query select
    v_row.id,
    v_row.workspace_id,
    v_row.created_by,
    v_row.cutoff_at,
    v_timezone,
    commercial.export_workspace_payload(v_row.workspace_id, v_row.cutoff_at);
end;
$$;

create function commercial.complete_export(
  p_export_id uuid,
  p_object_key text,
  p_sha256 text,
  p_bytes bigint,
  p_manifest jsonb,
  p_job_count integer,
  p_part_count integer
)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_row commercial.exports%rowtype;
  v_artifact_id uuid;
  v_alias uuid;
  v_size_bucket text;
  v_job_bucket text;
begin
  select * into v_row
  from commercial.exports e
  where e.id = p_export_id
  for update;
  if not found or v_row.status is distinct from 'running' then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if p_object_key is null or p_sha256 is null or p_bytes is null or p_manifest is null then
    raise exception 'VALIDATION_FAILED' using errcode = '22023';
  end if;

  v_artifact_id := gen_random_uuid();
  insert into commercial.artifacts (
    workspace_id, id, export_id, type, object_key, sha256, bytes,
    template_version, generated_at, state
  ) values (
    v_row.workspace_id, v_artifact_id, v_row.id, 'export_zip', p_object_key, p_sha256, p_bytes,
    'export-v1', now(), 'ready'
  );

  update commercial.exports
    set status = 'ready',
        artifact_id = v_artifact_id,
        object_key = p_object_key,
        sha256 = p_sha256,
        bytes = p_bytes,
        manifest_json = p_manifest,
        job_count = p_job_count,
        part_count = greatest(coalesce(p_part_count, 1), 1),
        ready_at = now(),
        download_until = now() + interval '24 hours',
        delete_after = now() + interval '7 days',
        error_code = null
    where id = v_row.id
    returning * into v_row;

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json,
    available_at, attempts, status, effect_key
  ) values (
    v_row.workspace_id, gen_random_uuid(), gen_random_uuid(), 'send_email', v_row.id,
    jsonb_build_object('template_id', 'EMAIL10'),
    now(), 0, 'pending',
    'export-ready:' || v_row.id::text
  )
  on conflict do nothing;

  select analytics_alias_id into v_alias
  from identity.app_users
  where id = v_row.created_by;

  v_size_bucket := case
    when p_bytes < 1000000 then '0_1mb'
    when p_bytes < 10000000 then '1_10mb'
    when p_bytes < 100000000 then '10_100mb'
    else '100mb_plus'
  end;
  v_job_bucket := case
    when coalesce(p_job_count, 0) = 0 then '0'
    when p_job_count <= 10 then '1_10'
    when p_job_count <= 50 then '11_50'
    when p_job_count <= 200 then '51_200'
    else '201_plus'
  end;

  insert into commercial.analytics_events (
    workspace_id, event_id, event_name, schema_version, occurred_at,
    pseudonymous_owner_id, job_id, safe_properties_json
  ) values (
    v_row.workspace_id, gen_random_uuid(), 'export_completed', 1, now(),
    v_alias, null,
    jsonb_build_object('size_bucket', v_size_bucket, 'job_count_bucket', v_job_bucket)
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_row.workspace_id, 'system', v_row.created_by, 'export_completed', 'exports', v_row.id,
    v_row.operation_id, 1, 2,
    jsonb_build_object('size_bucket', v_size_bucket, 'job_count_bucket', v_job_bucket)
  );
end;
$$;

create function commercial.fail_export(p_export_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  update commercial.exports
    set status = 'failed',
        failed_at = now(),
        error_code = left(coalesce(p_error_code, 'UNAVAILABLE'), 80)
    where id = p_export_id
      and status in ('queued', 'running');
end;
$$;

create function commercial.claim_export_ready_email()
returns table (
  id uuid,
  workspace_id uuid,
  template_id text,
  effect_key text,
  attempts integer,
  created_by uuid,
  recipient_email text,
  download_until timestamptz,
  provider_message_id text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_task commercial.outbox_tasks%rowtype;
  v_export commercial.exports%rowtype;
  v_email text;
begin
  select o.* into v_task
  from commercial.outbox_tasks o
  where o.task_type = 'send_email'
    and coalesce(o.payload_json->>'template_id', '') = 'EMAIL10'
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

  select * into v_export
  from commercial.exports e
  where e.workspace_id = v_task.workspace_id
    and e.id = v_task.aggregate_id;

  select u.display_email into v_email
  from identity.app_users u
  where u.id = v_export.created_by;

  return query select
    v_task.id,
    v_task.workspace_id,
    'EMAIL10'::text,
    v_task.effect_key,
    v_task.attempts,
    v_export.created_by,
    v_email,
    v_export.download_until,
    null::text;
end;
$$;

create function commercial.complete_export_ready_email(p_task_id uuid, p_provider_message_id text)
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
      and payload_json->>'template_id' = 'EMAIL10';
end;
$$;

create function commercial.fail_export_ready_email(p_task_id uuid, p_error_code text, p_dead boolean)
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
      and payload_json->>'template_id' = 'EMAIL10';
  return v_status;
end;
$$;

create function commercial.claim_purge_exports()
returns table (
  id uuid,
  workspace_id uuid,
  object_key text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_row commercial.exports%rowtype;
begin
  select e.* into v_row
  from commercial.exports e
  where e.status = 'ready'
    and e.delete_after is not null
    and e.delete_after <= now()
    and e.purged_at is null
  order by e.delete_after, e.id
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;
  return query select v_row.id, v_row.workspace_id, v_row.object_key;
end;
$$;

create function commercial.complete_purge_export(p_export_id uuid)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
begin
  update commercial.exports
    set status = 'expired',
        purged_at = now(),
        object_key = null
    where id = p_export_id
      and status = 'ready'
      and purged_at is null;
end;
$$;

revoke all on function commercial.export_workspace_payload(uuid, timestamptz) from public;
grant execute on function commercial.export_workspace_payload(uuid, timestamptz) to worker_app;
revoke all on function commercial.export_workspace_payload(uuid, timestamptz)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.request_export(uuid, uuid, text, uuid, bytea, boolean) from public;
grant execute on function commercial.request_export(uuid, uuid, text, uuid, bytea, boolean) to api_app;
revoke all on function commercial.request_export(uuid, uuid, text, uuid, bytea, boolean)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.get_export(uuid, uuid) from public;
grant execute on function commercial.get_export(uuid, uuid) to api_app;
revoke all on function commercial.get_export(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.latest_export(uuid) from public;
grant execute on function commercial.latest_export(uuid) to api_app;
revoke all on function commercial.latest_export(uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_build_export() from public;
grant execute on function commercial.claim_build_export() to worker_app;
revoke all on function commercial.claim_build_export()
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.complete_export(uuid, text, text, bigint, jsonb, integer, integer) from public;
grant execute on function commercial.complete_export(uuid, text, text, bigint, jsonb, integer, integer) to worker_app;
revoke all on function commercial.complete_export(uuid, text, text, bigint, jsonb, integer, integer)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.fail_export(uuid, text) from public;
grant execute on function commercial.fail_export(uuid, text) to worker_app;
revoke all on function commercial.fail_export(uuid, text)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_export_ready_email() from public;
grant execute on function commercial.claim_export_ready_email() to worker_app;
revoke all on function commercial.claim_export_ready_email()
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.complete_export_ready_email(uuid, text) from public;
grant execute on function commercial.complete_export_ready_email(uuid, text) to worker_app;
revoke all on function commercial.complete_export_ready_email(uuid, text)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.fail_export_ready_email(uuid, text, boolean) from public;
grant execute on function commercial.fail_export_ready_email(uuid, text, boolean) to worker_app;
revoke all on function commercial.fail_export_ready_email(uuid, text, boolean)
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.claim_purge_exports() from public;
grant execute on function commercial.claim_purge_exports() to worker_app;
revoke all on function commercial.claim_purge_exports()
  from api_app, purge_app, anon, authenticated;

revoke all on function commercial.complete_purge_export(uuid) from public;
grant execute on function commercial.complete_purge_export(uuid) to worker_app;
revoke all on function commercial.complete_purge_export(uuid)
  from api_app, purge_app, anon, authenticated;

alter function commercial.export_workspace_payload(uuid, timestamptz) owner to migrator;
alter function commercial.request_export(uuid, uuid, text, uuid, bytea, boolean) owner to migrator;
alter function commercial.get_export(uuid, uuid) owner to migrator;
alter function commercial.latest_export(uuid) owner to migrator;
alter function commercial.claim_build_export() owner to migrator;
alter function commercial.complete_export(uuid, text, text, bigint, jsonb, integer, integer) owner to migrator;
alter function commercial.fail_export(uuid, text) owner to migrator;
alter function commercial.claim_export_ready_email() owner to migrator;
alter function commercial.complete_export_ready_email(uuid, text) owner to migrator;
alter function commercial.fail_export_ready_email(uuid, text, boolean) owner to migrator;
alter function commercial.claim_purge_exports() owner to migrator;
alter function commercial.complete_purge_export(uuid) owner to migrator;

reset role;
