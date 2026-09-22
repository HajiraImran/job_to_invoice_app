-- JOB02: draft-only delete, cancel with reason, linked new job.
-- Forward-only. Do not edit 0001–0020.

set role migrator;

create function commercial.create_job(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid,
  p_customer_name text,
  p_title text,
  p_site_address jsonb,
  p_no_site boolean,
  p_internal_notes text,
  p_mode text,
  p_related_job_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  customer_id uuid,
  customer_name text,
  title text,
  site_address_json jsonb,
  no_site boolean,
  lifecycle text,
  mode text,
  internal_notes text,
  related_job_id uuid,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
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
  v_customer uuid;
  v_notes text;
  v_payload jsonb;
  v_analytics_mode text;
  v_job commercial.jobs%rowtype;
  v_related commercial.jobs%rowtype;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_job_id is null
    or p_customer_name is null
    or p_title is null
    or p_no_site is null
    or p_mode is null then
    raise exception 'invalid job create' using errcode = '22023';
  end if;

  if p_mode not in ('quote', 'direct_invoice') then
    raise exception 'invalid job mode' using errcode = '23514';
  end if;

  if p_related_job_id is not null and p_related_job_id = p_job_id then
    raise exception 'RELATED_JOB_UNAVAILABLE' using errcode = 'P0054';
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

  if p_related_job_id is not null then
    select * into v_related
    from commercial.jobs j
    where j.workspace_id = v_ws and j.id = p_related_job_id
    for update;
    if not found or v_related.lifecycle is distinct from 'canceled' then
      raise exception 'RELATED_JOB_UNAVAILABLE' using errcode = 'P0054';
    end if;
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
          (v_existing.response_json->>'workspace_id')::uuid,
          (v_existing.response_json->>'customer_id')::uuid,
          v_existing.response_json->>'customer_name',
          v_existing.response_json->>'title',
          v_existing.response_json->'site_address_json',
          (v_existing.response_json->>'no_site')::boolean,
          v_existing.response_json->>'lifecycle',
          v_existing.response_json->>'mode',
          v_existing.response_json->>'internal_notes',
          (v_existing.response_json->>'related_job_id')::uuid,
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          true;
      return;
    end if;
  end if;

  v_customer := gen_random_uuid();
  v_notes := coalesce(p_internal_notes, '');

  insert into commercial.customers (
    workspace_id, id, name
  ) values (
    v_ws, v_customer, p_customer_name
  );

  insert into commercial.jobs (
    workspace_id, id, customer_id, title, site_address_json, no_site,
    lifecycle, internal_notes, mode, related_job_id
  ) values (
    v_ws, p_job_id, v_customer, p_title, p_site_address, p_no_site,
    'draft', v_notes, p_mode, p_related_job_id
  )
  returning * into v_job;

  v_analytics_mode := case when p_mode = 'direct_invoice' then 'direct' else 'quote' end;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'job_created', 'job', p_job_id,
    p_request_id, v_job.version,
    jsonb_build_object(
      'mode', v_analytics_mode,
      'linked', (p_related_job_id is not null)
    )
  );

  insert into commercial.analytics_events (
    workspace_id, event_id, event_name, schema_version, occurred_at,
    pseudonymous_owner_id, job_id, safe_properties_json
  ) values (
    v_ws, gen_random_uuid(), 'job_created', 1, now(), v_alias, p_job_id,
    jsonb_build_object('mode', v_analytics_mode)
  );

  v_payload := jsonb_build_object(
    'id', v_job.id,
    'workspace_id', v_job.workspace_id,
    'customer_id', v_job.customer_id,
    'customer_name', p_customer_name,
    'title', v_job.title,
    'site_address_json', v_job.site_address_json,
    'no_site', v_job.no_site,
    'lifecycle', v_job.lifecycle,
    'mode', v_job.mode,
    'internal_notes', v_job.internal_notes,
    'related_job_id', v_job.related_job_id,
    'version', v_job.version,
    'created_at', v_job.created_at,
    'updated_at', v_job.updated_at
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/jobs', p_request_hash, gen_random_uuid(),
      'completed', 200, v_payload, now() + interval '30 days', 'ephemeral'
    );
  else
    update commercial.idempotency_records
      set status = 'completed',
          response_code = 200,
          response_json = v_payload
      where id = v_existing.id;
  end if;

  return query
    select
      v_job.id,
      v_job.workspace_id,
      v_job.customer_id,
      p_customer_name,
      v_job.title,
      v_job.site_address_json,
      v_job.no_site,
      v_job.lifecycle,
      v_job.mode,
      v_job.internal_notes,
      v_job.related_job_id,
      v_job.version,
      v_job.created_at,
      v_job.updated_at,
      false;
end;
$$;

comment on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text, uuid
) is
  'Creates a draft job. Optional related_job_id must reference a canceled job in the same workspace (JOB02).';

revoke all on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text, uuid
) from public;
grant execute on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text, uuid
) to api_app;
revoke all on function commercial.create_job(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text, uuid
) from worker_app, purge_app, anon, authenticated;

create function commercial.delete_draft_job(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid
)
returns table (
  id uuid,
  deleted boolean,
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
  v_response jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_request_id is null
    or p_job_id is null then
    raise exception 'invalid job delete' using errcode = '22023';
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
          (v_existing.response_json->>'deleted')::boolean,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, permanence, expires_at
    ) values (
      v_ws, p_actor_id, p_idempotency_key,
      '/v1/jobs/' || p_job_id::text, p_request_hash, gen_random_uuid(),
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

  if v_job.lifecycle is distinct from 'draft'
    or v_job.first_published_at is not null
    or exists (
      select 1 from commercial.documents d
      where d.workspace_id = v_ws and d.job_id = p_job_id
    )
    or exists (
      select 1 from commercial.assets a
      where a.workspace_id = v_ws and a.job_id = p_job_id
    ) then
    raise exception 'JOB_NOT_DELETABLE' using errcode = 'P0052';
  end if;

  delete from commercial.document_drafts
  where workspace_id = v_ws and job_id = p_job_id;

  delete from commercial.jobs
  where workspace_id = v_ws and id = p_job_id;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'job_deleted', 'job', p_job_id,
    p_request_id, v_job.version, v_job.version,
    jsonb_build_object('mode', case when v_job.mode = 'direct_invoice' then 'direct' else 'quote' end)
  );

  v_response := jsonb_build_object('id', p_job_id, 'deleted', true);
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = v_response
    where actor_scope = p_actor_id and key = p_idempotency_key;

  return query select p_job_id, true, false;
end;
$$;

comment on function commercial.delete_draft_job(uuid, uuid, text, uuid, uuid) is
  'Deletes a draft job that has no published document. Published jobs cannot be deleted (JOB02).';

revoke all on function commercial.delete_draft_job(uuid, uuid, text, uuid, uuid) from public;
grant execute on function commercial.delete_draft_job(uuid, uuid, text, uuid, uuid) to api_app;
revoke all on function commercial.delete_draft_job(uuid, uuid, text, uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

create function commercial.cancel_job(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid,
  p_reason text,
  p_email_encrypted bytea,
  p_algorithm text,
  p_key_version integer,
  p_nonce bytea,
  p_ciphertext bytea
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
  v_request commercial.approval_requests%rowtype;
  v_doc commercial.documents%rowtype;
  v_operation uuid := gen_random_uuid();
  v_effect text;
  v_email bytea;
  v_payload jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_request_id is null
    or p_job_id is null
    or p_reason is null
    or char_length(btrim(p_reason)) not between 1 and 500
    or p_email_encrypted is null
    or p_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_nonce) is distinct from 12
    or octet_length(p_ciphertext) < 17 then
    raise exception 'invalid job cancel' using errcode = '22023';
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
      '/v1/jobs/' || p_job_id::text || '/cancel', p_request_hash, v_operation,
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

  if v_job.lifecycle not in ('active', 'invoiced') then
    raise exception 'JOB_NOT_CANCELABLE' using errcode = 'P0053';
  end if;

  perform commercial.expire_due_job_approvals(v_ws, p_job_id);

  for v_request in
    select *
    from commercial.approval_requests ar
    where ar.workspace_id = v_ws
      and ar.job_id = p_job_id
      and ar.purpose = 'approval'
      and ar.state = 'pending'
    for update
  loop
    update commercial.approval_requests
      set state = 'withdrawn',
          decided_at = now(),
          updated_at = now()
      where id = v_request.id and state = 'pending'
      returning * into v_request;
    if not found then
      continue;
    end if;

    select * into v_doc
    from commercial.documents d
    where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id
    for update;

    update commercial.documents
      set lifecycle = 'withdrawn'
      where workspace_id = v_doc.workspace_id
        and id = v_doc.id
        and lifecycle = 'issued';

    update commercial.approval_sessions
      set revoked_at = now()
      where workspace_id = v_request.workspace_id
        and request_id = v_request.id
        and revoked_at is null;

    update commercial.approval_challenges
      set consumed_at = coalesce(consumed_at, now())
      where workspace_id = v_request.workspace_id
        and request_id = v_request.id
        and consumed_at is null;

    v_email := coalesce((
      select da.recipient_email_encrypted
      from commercial.delivery_attempts da
      where da.workspace_id = v_request.workspace_id
        and da.request_id = v_request.id
        and da.template_id in ('EMAIL01', 'EMAIL02')
      order by da.created_at desc, da.id desc
      limit 1
    ), p_email_encrypted);

    v_effect := v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL08:withdraw:' || v_operation::text;
    perform commercial.queue_portal_email(
      v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL08', v_effect,
      v_email, p_algorithm, p_key_version, p_nonce, p_ciphertext
    );
  end loop;

  update commercial.jobs
    set lifecycle = 'canceled',
        version = version + 1
    where workspace_id = v_ws and id = p_job_id and lifecycle in ('active', 'invoiced')
    returning * into v_job;
  if not found then
    raise exception 'JOB_NOT_CANCELABLE' using errcode = 'P0053';
  end if;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'job_canceled', 'job', p_job_id,
    p_request_id, v_job.version - 1, v_job.version,
    jsonb_build_object('reason_len', char_length(btrim(p_reason)))
  );

  v_payload := jsonb_build_object(
    'id', v_job.id,
    'lifecycle', v_job.lifecycle,
    'version', v_job.version
  );
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = v_payload,
        expires_at = now() + interval '7 days'
    where actor_scope = p_actor_id and key = p_idempotency_key;

  return query select v_job.id, v_job.lifecycle, v_job.version, false;
end;
$$;

comment on function commercial.cancel_job(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea) is
  'Cancels an active or invoiced job. Withdraws pending approvals with EMAIL08. Does not reopen. Does not change accepted snapshots.';

revoke all on function commercial.cancel_job(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea) from public;
grant execute on function commercial.cancel_job(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea) to api_app;
revoke all on function commercial.cancel_job(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea)
  from worker_app, purge_app, anon, authenticated;

alter function commercial.create_job(uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text, uuid) owner to migrator;
alter function commercial.delete_draft_job(uuid, uuid, text, uuid, uuid) owner to migrator;
alter function commercial.cancel_job(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea) owner to migrator;

reset role;
