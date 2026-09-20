-- S12 owner request controls: resend, withdraw, replace-link (NTF04, EMAIL08, APR03, ACC02A, QA17, QA21).

alter table commercial.delivery_attempts
  drop constraint if exists delivery_attempts_template_id_check;

alter table commercial.delivery_attempts
  drop constraint if exists delivery_attempts_template_check;

alter table commercial.delivery_attempts
  add constraint delivery_attempts_template_check
  check (template_id in ('EMAIL01', 'EMAIL03', 'EMAIL04', 'EMAIL05', 'EMAIL08'));

create or replace function identity.consume_action_grant(
  p_user_id uuid,
  p_action text,
  p_token_hash bytea
)
returns uuid
language plpgsql
security definer
set search_path = identity, pg_temp
as $$
declare
  v_grant identity.action_grants%rowtype;
begin
  if p_user_id is null
    or p_action is null
    or p_action not in ('export', 'deletion', 'email_change', 'replace_link')
    or p_token_hash is null
    or octet_length(p_token_hash) is distinct from 32 then
    raise exception 'ACTION_GRANT_INVALID' using errcode = 'P0041';
  end if;

  select * into v_grant
  from identity.action_grants g
  where g.token_hash = p_token_hash
  for update;

  if not found
    or v_grant.user_id is distinct from p_user_id
    or v_grant.action is distinct from p_action
    or v_grant.used_at is not null
    or v_grant.expires_at <= now() then
    raise exception 'ACTION_GRANT_INVALID' using errcode = 'P0041';
  end if;

  update identity.action_grants
    set used_at = now()
    where id = v_grant.id
      and used_at is null
    returning * into v_grant;

  if not found then
    raise exception 'ACTION_GRANT_INVALID' using errcode = 'P0041';
  end if;

  return v_grant.id;
end;
$$;

revoke all on function identity.consume_action_grant(uuid, text, bytea) from public;
grant execute on function identity.consume_action_grant(uuid, text, bytea) to api_app;
revoke all on function identity.consume_action_grant(uuid, text, bytea)
  from worker_app, purge_app, anon, authenticated;

create or replace function commercial.resend_cap_state(p_workspace_id uuid, p_request_id uuid)
returns table (
  resends_used_today integer,
  resend_available_at timestamptz,
  can_resend boolean,
  retry_after_seconds integer
)
language plpgsql
stable
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_used integer;
  v_last timestamptz;
  v_available timestamptz;
  v_retry integer := 0;
begin
  select count(*)::integer, max(da.created_at)
    into v_used, v_last
  from commercial.delivery_attempts da
  where da.workspace_id = p_workspace_id
    and da.request_id = p_request_id
    and da.template_id = 'EMAIL01'
    and da.effect_key like '%:EMAIL01:resend:%'
    and da.created_at > now() - interval '24 hours';

  v_used := coalesce(v_used, 0);
  if v_used >= 3 then
    select min(da.created_at) + interval '24 hours'
      into v_available
    from commercial.delivery_attempts da
    where da.workspace_id = p_workspace_id
      and da.request_id = p_request_id
      and da.template_id = 'EMAIL01'
      and da.effect_key like '%:EMAIL01:resend:%'
      and da.created_at > now() - interval '24 hours';
    v_retry := greatest(1, ceil(extract(epoch from (v_available - now())))::integer);
    return query select v_used, v_available, false, v_retry;
    return;
  end if;

  if v_last is not null and v_last > now() - interval '10 minutes' then
    v_available := v_last + interval '10 minutes';
    v_retry := greatest(1, ceil(extract(epoch from (v_available - now())))::integer);
    return query select v_used, v_available, false, v_retry;
    return;
  end if;

  return query select v_used, null::timestamptz, true, 0;
end;
$$;

revoke all on function commercial.resend_cap_state(uuid, uuid) from public;
grant execute on function commercial.resend_cap_state(uuid, uuid) to api_app;
revoke all on function commercial.resend_cap_state(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

drop function if exists commercial.owner_job_request(uuid, uuid);

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
  updated_at timestamptz,
  request_state text,
  decided_at timestamptz,
  resends_used_today integer,
  resend_available_at timestamptz,
  can_resend boolean,
  can_withdraw boolean,
  can_replace_link boolean
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
  perform commercial.expire_due_job_approvals(p_workspace_id, p_job_id);
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
      da.updated_at,
      ar.state,
      ar.decided_at,
      coalesce(cap.resends_used_today, 0),
      cap.resend_available_at,
      (ar.state = 'pending' and ar.expires_at > now() and coalesce(cap.can_resend, false)),
      (ar.state = 'pending' and ar.expires_at > now()),
      (ar.state = 'pending' and ar.expires_at > now())
    from commercial.approval_requests ar
    join commercial.documents d
      on d.workspace_id = ar.workspace_id and d.id = ar.document_id
    join lateral (
      select da0.*
      from commercial.delivery_attempts da0
      where da0.workspace_id = ar.workspace_id
        and da0.request_id = ar.id
        and da0.template_id = 'EMAIL01'
      order by da0.created_at desc, da0.id desc
      limit 1
    ) da on true
    left join lateral commercial.resend_cap_state(ar.workspace_id, ar.id) cap on true
    where ar.workspace_id = p_workspace_id
      and ar.job_id = p_job_id
      and ar.purpose = 'approval'
    order by ar.created_at desc, ar.id desc
    limit 1;
end;
$$;

revoke all on function commercial.owner_job_request(uuid, uuid) from public;
grant execute on function commercial.owner_job_request(uuid, uuid) to api_app;
revoke all on function commercial.owner_job_request(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

create function commercial.withdraw_approval_request(
  p_actor_id uuid,
  p_request_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text,
  p_email_encrypted bytea,
  p_algorithm text,
  p_key_version integer,
  p_nonce bytea,
  p_ciphertext bytea
)
returns table (
  request_id uuid,
  document_id uuid,
  job_id uuid,
  request_state text,
  decided_at timestamptz,
  number text,
  revision_no integer,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws commercial.workspaces%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_doc commercial.documents%rowtype;
  v_existing commercial.idempotency_records%rowtype;
  v_scope uuid;
  v_operation uuid := gen_random_uuid();
  v_effect text;
  v_response jsonb;
begin
  if p_actor_id is null or p_request_id is null or p_idempotency_key is null
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_reason is null or char_length(btrim(p_reason)) not between 1 and 500
    or p_email_encrypted is null or p_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_nonce) is distinct from 12 or octet_length(p_ciphertext) < 17 then
    raise exception 'invalid withdraw' using errcode = '22023';
  end if;

  select * into v_ws from commercial.workspaces w where w.owner_user_id = p_actor_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  v_scope := p_actor_id;

  select * into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = v_scope and r.key = p_idempotency_key;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' then
      return query
        select
          (v_existing.response_json->>'request_id')::uuid,
          (v_existing.response_json->>'document_id')::uuid,
          (v_existing.response_json->>'job_id')::uuid,
          v_existing.response_json->>'request_state',
          (v_existing.response_json->>'decided_at')::timestamptz,
          v_existing.response_json->>'number',
          (v_existing.response_json->>'revision_no')::integer,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, id, actor_scope, key, route, request_hash, operation_id, status, permanence
    ) values (
      v_ws.workspace_id, gen_random_uuid(), v_scope, p_idempotency_key,
      '/v1/requests/' || p_request_id::text || '/withdraw', p_request_hash, v_operation, 'pending', 'financial'
    );
  end if;

  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws.workspace_id and ar.id = p_request_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;

  if v_request.state in ('approved', 'declined') then
    raise exception 'ALREADY_DECIDED' using errcode = 'P0022';
  end if;
  if v_request.state <> 'pending' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  if v_request.expires_at <= now() then
    update commercial.approval_requests set state = 'expired' where id = v_request.id and state = 'pending';
    update commercial.documents
      set lifecycle = 'expired'
      where workspace_id = v_request.workspace_id and id = v_request.document_id and lifecycle = 'issued';
    raise exception 'REQUEST_EXPIRED' using errcode = 'P0021';
  end if;

  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id
  for update;

  update commercial.approval_requests
    set state = 'withdrawn',
        decided_at = now(),
        updated_at = now()
    where id = v_request.id and state = 'pending'
    returning * into v_request;
  if not found then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update commercial.documents
    set lifecycle = 'withdrawn'
    where workspace_id = v_doc.workspace_id and id = v_doc.id and lifecycle = 'issued';

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

  v_effect := v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL08:withdraw:' || v_operation::text;
  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL08', v_effect,
    coalesce((
      select da.recipient_email_encrypted
      from commercial.delivery_attempts da
      where da.workspace_id = v_request.workspace_id
        and da.request_id = v_request.id
        and da.template_id = 'EMAIL01'
      order by da.created_at desc, da.id desc
      limit 1
    ), p_email_encrypted),
    p_algorithm, p_key_version, p_nonce, p_ciphertext
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_request.workspace_id, 'owner', p_actor_id, 'request_withdrawn', 'approval_request', v_request.id,
    v_request.id, 0, 0, jsonb_build_object('reason_len', char_length(btrim(p_reason)))
  );

  v_response := jsonb_build_object(
    'request_id', v_request.id,
    'document_id', v_doc.id,
    'job_id', v_request.job_id,
    'request_state', v_request.state,
    'decided_at', v_request.decided_at,
    'number', v_doc.number,
    'revision_no', v_doc.revision_no
  );
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 200,
        response_json = v_response,
        expires_at = now() + interval '7 days'
    where actor_scope = v_scope and key = p_idempotency_key;

  return query
    select v_request.id, v_doc.id, v_request.job_id, v_request.state, v_request.decided_at,
           v_doc.number, v_doc.revision_no, false;
end;
$$;

revoke all on function commercial.withdraw_approval_request(uuid, uuid, text, uuid, text, bytea, text, integer, bytea, bytea) from public;
grant execute on function commercial.withdraw_approval_request(uuid, uuid, text, uuid, text, bytea, text, integer, bytea, bytea) to api_app;
revoke all on function commercial.withdraw_approval_request(uuid, uuid, text, uuid, text, bytea, text, integer, bytea, bytea)
  from worker_app, purge_app, anon, authenticated;

create function commercial.resend_approval_request(
  p_actor_id uuid,
  p_request_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_token_hash text,
  p_token_key_version integer,
  p_email_encrypted bytea,
  p_algorithm text,
  p_key_version integer,
  p_nonce bytea,
  p_ciphertext bytea
)
returns table (
  request_id uuid,
  document_id uuid,
  job_id uuid,
  request_state text,
  token_rotated_at timestamptz,
  delivery_state text,
  number text,
  revision_no integer,
  resends_used_today integer,
  resend_available_at timestamptz,
  can_resend boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws commercial.workspaces%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_doc commercial.documents%rowtype;
  v_existing commercial.idempotency_records%rowtype;
  v_cap record;
  v_scope uuid;
  v_operation uuid := gen_random_uuid();
  v_effect text;
  v_response jsonb;
begin
  if p_actor_id is null or p_request_id is null or p_idempotency_key is null
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_key_version is null or p_token_key_version < 1
    or p_email_encrypted is null or p_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_nonce) is distinct from 12 or octet_length(p_ciphertext) < 17 then
    raise exception 'invalid resend' using errcode = '22023';
  end if;

  select * into v_ws from commercial.workspaces w where w.owner_user_id = p_actor_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  v_scope := p_actor_id;

  select * into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = v_scope and r.key = p_idempotency_key;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' then
      return query
        select
          (v_existing.response_json->>'request_id')::uuid,
          (v_existing.response_json->>'document_id')::uuid,
          (v_existing.response_json->>'job_id')::uuid,
          v_existing.response_json->>'request_state',
          (v_existing.response_json->>'token_rotated_at')::timestamptz,
          v_existing.response_json->>'delivery_state',
          v_existing.response_json->>'number',
          (v_existing.response_json->>'revision_no')::integer,
          (v_existing.response_json->>'resends_used_today')::integer,
          (v_existing.response_json->>'resend_available_at')::timestamptz,
          (v_existing.response_json->>'can_resend')::boolean,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, id, actor_scope, key, route, request_hash, operation_id, status, permanence
    ) values (
      v_ws.workspace_id, gen_random_uuid(), v_scope, p_idempotency_key,
      '/v1/requests/' || p_request_id::text || '/resend', p_request_hash, v_operation, 'pending', 'ephemeral'
    );
  end if;

  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws.workspace_id and ar.id = p_request_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_request.state <> 'pending' or v_request.expires_at <= now() then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;

  select * into v_cap from commercial.resend_cap_state(v_request.workspace_id, v_request.id);
  if not v_cap.can_resend then
    raise exception 'RESEND_LIMITED' using errcode = 'P0040', hint = coalesce(v_cap.retry_after_seconds, 1)::text;
  end if;

  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id
  for update;

  update commercial.approval_requests
    set token_hash = p_token_hash,
        token_key_version = p_token_key_version,
        token_rotated_at = now(),
        updated_at = now()
    where id = v_request.id and state = 'pending'
    returning * into v_request;
  if not found then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

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

  v_effect := v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL01:resend:' || v_operation::text;
  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL01', v_effect,
    coalesce((
      select da.recipient_email_encrypted
      from commercial.delivery_attempts da
      where da.workspace_id = v_request.workspace_id
        and da.request_id = v_request.id
        and da.template_id = 'EMAIL01'
      order by da.created_at desc, da.id desc
      limit 1
    ), p_email_encrypted),
    p_algorithm, p_key_version, p_nonce, p_ciphertext
  );

  select * into v_cap from commercial.resend_cap_state(v_request.workspace_id, v_request.id);

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_request.workspace_id, 'owner', p_actor_id, 'request_resent', 'approval_request', v_request.id,
    v_request.id, 0, 0, jsonb_build_object('resends_used_today', v_cap.resends_used_today)
  );

  v_response := jsonb_build_object(
    'request_id', v_request.id,
    'document_id', v_doc.id,
    'job_id', v_request.job_id,
    'request_state', v_request.state,
    'token_rotated_at', v_request.token_rotated_at,
    'delivery_state', 'queued',
    'number', v_doc.number,
    'revision_no', v_doc.revision_no,
    'resends_used_today', v_cap.resends_used_today,
    'resend_available_at', v_cap.resend_available_at,
    'can_resend', v_cap.can_resend
  );
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 202,
        response_json = v_response,
        expires_at = now() + interval '24 hours'
    where actor_scope = v_scope and key = p_idempotency_key;

  return query
    select v_request.id, v_doc.id, v_request.job_id, v_request.state, v_request.token_rotated_at,
           'queued'::text, v_doc.number, v_doc.revision_no,
           v_cap.resends_used_today, v_cap.resend_available_at, v_cap.can_resend, false;
end;
$$;

revoke all on function commercial.resend_approval_request(uuid, uuid, uuid, text, text, integer, bytea, text, integer, bytea, bytea) from public;
grant execute on function commercial.resend_approval_request(uuid, uuid, uuid, text, text, integer, bytea, text, integer, bytea, bytea) to api_app;
revoke all on function commercial.resend_approval_request(uuid, uuid, uuid, text, text, integer, bytea, text, integer, bytea, bytea)
  from worker_app, purge_app, anon, authenticated;

create function commercial.replace_link_approval_request(
  p_actor_id uuid,
  p_request_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_grant_token_hash bytea,
  p_token_hash text,
  p_token_key_version integer,
  p_email_encrypted bytea,
  p_algorithm text,
  p_key_version integer,
  p_nonce bytea,
  p_ciphertext bytea
)
returns table (
  request_id uuid,
  document_id uuid,
  job_id uuid,
  request_state text,
  token_rotated_at timestamptz,
  delivery_state text,
  number text,
  revision_no integer,
  replayed boolean
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws commercial.workspaces%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_doc commercial.documents%rowtype;
  v_existing commercial.idempotency_records%rowtype;
  v_scope uuid;
  v_operation uuid := gen_random_uuid();
  v_effect text;
  v_response jsonb;
  v_grant_id uuid;
begin
  if p_actor_id is null or p_request_id is null or p_idempotency_key is null
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_grant_token_hash is null or octet_length(p_grant_token_hash) is distinct from 32
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_token_key_version is null or p_token_key_version < 1
    or p_email_encrypted is null or p_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_nonce) is distinct from 12 or octet_length(p_ciphertext) < 17 then
    raise exception 'invalid replace-link' using errcode = '22023';
  end if;

  select * into v_ws from commercial.workspaces w where w.owner_user_id = p_actor_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  v_scope := p_actor_id;

  select * into v_existing
  from commercial.idempotency_records r
  where r.actor_scope = v_scope and r.key = p_idempotency_key;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0004';
    end if;
    if v_existing.status = 'completed' then
      return query
        select
          (v_existing.response_json->>'request_id')::uuid,
          (v_existing.response_json->>'document_id')::uuid,
          (v_existing.response_json->>'job_id')::uuid,
          v_existing.response_json->>'request_state',
          (v_existing.response_json->>'token_rotated_at')::timestamptz,
          v_existing.response_json->>'delivery_state',
          v_existing.response_json->>'number',
          (v_existing.response_json->>'revision_no')::integer,
          true;
      return;
    end if;
  else
    insert into commercial.idempotency_records (
      workspace_id, id, actor_scope, key, route, request_hash, operation_id, status, permanence
    ) values (
      v_ws.workspace_id, gen_random_uuid(), v_scope, p_idempotency_key,
      '/v1/requests/' || p_request_id::text || '/replace-link', p_request_hash, v_operation, 'pending', 'financial'
    );
  end if;

  -- Consume grant only on first execution (idempotent replay skips)
  v_grant_id := identity.consume_action_grant(p_actor_id, 'replace_link', p_grant_token_hash);

  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_ws.workspace_id and ar.id = p_request_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_request.state <> 'pending' or v_request.expires_at <= now() then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;

  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id
  for update;

  update commercial.approval_requests
    set token_hash = p_token_hash,
        token_key_version = p_token_key_version,
        token_rotated_at = now(),
        updated_at = now()
    where id = v_request.id and state = 'pending'
    returning * into v_request;
  if not found then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

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

  v_effect := v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL08:replace:' || v_operation::text;
  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL08', v_effect,
    coalesce((
      select da.recipient_email_encrypted
      from commercial.delivery_attempts da
      where da.workspace_id = v_request.workspace_id
        and da.request_id = v_request.id
        and da.template_id = 'EMAIL01'
      order by da.created_at desc, da.id desc
      limit 1
    ), p_email_encrypted),
    p_algorithm, p_key_version, p_nonce, p_ciphertext
  );

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_request.workspace_id, 'owner', p_actor_id, 'request_link_replaced', 'approval_request', v_request.id,
    v_request.id, 0, 0, jsonb_build_object('grant_consumed', true)
  );

  v_response := jsonb_build_object(
    'request_id', v_request.id,
    'document_id', v_doc.id,
    'job_id', v_request.job_id,
    'request_state', v_request.state,
    'token_rotated_at', v_request.token_rotated_at,
    'delivery_state', 'queued',
    'number', v_doc.number,
    'revision_no', v_doc.revision_no
  );
  update commercial.idempotency_records
    set status = 'completed',
        response_code = 202,
        response_json = v_response,
        expires_at = now() + interval '7 days'
    where actor_scope = v_scope and key = p_idempotency_key;

  return query
    select v_request.id, v_doc.id, v_request.job_id, v_request.state, v_request.token_rotated_at,
           'queued'::text, v_doc.number, v_doc.revision_no, false;
end;
$$;

revoke all on function commercial.replace_link_approval_request(uuid, uuid, uuid, text, bytea, text, integer, bytea, text, integer, bytea, bytea) from public;
grant execute on function commercial.replace_link_approval_request(uuid, uuid, uuid, text, bytea, text, integer, bytea, text, integer, bytea, bytea) to api_app;
revoke all on function commercial.replace_link_approval_request(uuid, uuid, uuid, text, bytea, text, integer, bytea, text, integer, bytea, bytea)
  from worker_app, purge_app, anon, authenticated;

-- Ensure security-definer commercial mutations run as migrator so
-- protect_issued_document allows lifecycle terminal transitions.
alter function commercial.withdraw_approval_request(uuid, uuid, text, uuid, text, bytea, text, integer, bytea, bytea) owner to migrator;
alter function commercial.resend_approval_request(uuid, uuid, uuid, text, text, integer, bytea, text, integer, bytea, bytea) owner to migrator;
alter function commercial.replace_link_approval_request(uuid, uuid, uuid, text, bytea, text, integer, bytea, text, integer, bytea, bytea) owner to migrator;
alter function commercial.owner_job_request(uuid, uuid) owner to migrator;
alter function commercial.resend_cap_state(uuid, uuid) owner to migrator;
alter function identity.consume_action_grant(uuid, text, bytea) owner to migrator;
