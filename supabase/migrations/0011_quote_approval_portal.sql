-- Customer portal OTP, TX02 decisions, and quote revision supersession (S25–S27 / D-018).
-- Forward-only. Do not edit 0001–0010.

set role migrator;

create or replace function identity.current_request_id()
returns uuid
language sql
stable
parallel safe
as $$
  select nullif(current_setting('app.request_id', true), '')::uuid;
$$;

create or replace function identity.set_local_portal_context(p_workspace_id uuid, p_request_id uuid)
returns void
language plpgsql
as $$
begin
  if p_workspace_id is null or p_request_id is null then
    raise exception 'portal context requires workspace_id and request_id'
      using errcode = '22023';
  end if;
  perform set_config('app.workspace_id', p_workspace_id::text, true);
  perform set_config('app.request_id', p_request_id::text, true);
  perform set_config('app.actor_id', '', true);
end;
$$;

comment on function identity.set_local_portal_context(uuid, uuid) is
  'SET LOCAL portal GUC from hashed token/session. Session SET is forbidden.';

create or replace function commercial.protect_issued_document()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_user <> 'purge_app' then
      raise exception 'issued documents cannot be deleted' using errcode = '23001';
    end if;
    return old;
  end if;
  if current_user = 'purge_app' then
    return new;
  end if;
  if current_user = 'migrator'
    and old.lifecycle = 'issued'
    and new.lifecycle in ('accepted', 'declined', 'superseded', 'withdrawn', 'expired')
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
    and new.void_reason is not distinct from old.void_reason then
    return new;
  end if;
  raise exception 'issued documents are immutable' using errcode = '23001';
end;
$$;

alter table commercial.documents drop constraint documents_lifecycle_check;
alter table commercial.documents
  add constraint documents_lifecycle_check check (
    lifecycle in ('issued', 'accepted', 'declined', 'withdrawn', 'superseded', 'voided', 'expired')
  );

create table commercial.approval_challenges (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  request_id uuid not null,
  code_hash text not null,
  secret_key_version integer not null,
  expires_at timestamptz not null,
  failed_attempts integer not null default 0,
  last_sent_at timestamptz not null,
  consumed_at timestamptz,
  constraint approval_challenges_pkey primary key (id),
  constraint approval_challenges_tenant_id_key unique (workspace_id, id),
  constraint approval_challenges_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint approval_challenges_request_fk
    foreign key (workspace_id, request_id)
    references commercial.approval_requests (workspace_id, id)
    on delete restrict,
  constraint approval_challenges_hash_check check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint approval_challenges_key_version_check check (secret_key_version >= 1),
  constraint approval_challenges_attempts_check check (failed_attempts >= 0 and failed_attempts <= 5)
);

create unique index approval_challenges_active_request_key
  on commercial.approval_challenges (workspace_id, request_id)
  where consumed_at is null;

create table commercial.approval_sessions (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  request_id uuid not null,
  session_hash text not null,
  verified_email text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  token_generation integer not null default 0,
  constraint approval_sessions_pkey primary key (id),
  constraint approval_sessions_tenant_id_key unique (workspace_id, id),
  constraint approval_sessions_session_hash_key unique (session_hash),
  constraint approval_sessions_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint approval_sessions_request_fk
    foreign key (workspace_id, request_id)
    references commercial.approval_requests (workspace_id, id)
    on delete restrict,
  constraint approval_sessions_hash_check check (session_hash ~ '^[0-9a-f]{64}$'),
  constraint approval_sessions_email_len check (char_length(verified_email) between 3 and 254),
  constraint approval_sessions_generation_check check (token_generation >= 0)
);

create table commercial.approval_decisions (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  request_id uuid not null,
  document_id uuid not null,
  decision text not null,
  signer_name text not null,
  verified_email text not null,
  decided_at timestamptz not null,
  snapshot_sha256 text not null,
  consent_version text not null,
  consent_text text not null,
  comment text,
  encrypted_evidence_json jsonb,
  evidence_key_version integer,
  operation_id uuid not null,
  constraint approval_decisions_pkey primary key (id),
  constraint approval_decisions_tenant_id_key unique (workspace_id, id),
  constraint approval_decisions_request_key unique (workspace_id, request_id),
  constraint approval_decisions_operation_key unique (operation_id),
  constraint approval_decisions_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint approval_decisions_request_fk
    foreign key (workspace_id, request_id)
    references commercial.approval_requests (workspace_id, id)
    on delete restrict,
  constraint approval_decisions_document_fk
    foreign key (workspace_id, document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint approval_decisions_decision_check check (decision in ('approve', 'decline')),
  constraint approval_decisions_hash_check check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  constraint approval_decisions_name_len check (char_length(signer_name) between 1 and 120),
  constraint approval_decisions_email_len check (char_length(verified_email) between 3 and 254),
  constraint approval_decisions_comment_len check (comment is null or char_length(comment) <= 1000),
  constraint approval_decisions_evidence_version_check check (evidence_key_version is null or evidence_key_version >= 1)
);

create table commercial.scope_entries (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  job_id uuid not null,
  source_line_id uuid not null,
  accepted_document_id uuid not null,
  scope_version integer not null,
  event_kind text not null,
  net_delta_cents bigint not null,
  tax_delta_cents bigint not null,
  constraint scope_entries_pkey primary key (id),
  constraint scope_entries_tenant_id_key unique (workspace_id, id),
  constraint scope_entries_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint scope_entries_job_fk
    foreign key (workspace_id, job_id)
    references commercial.jobs (workspace_id, id)
    on delete restrict,
  constraint scope_entries_source_fk
    foreign key (workspace_id, source_line_id)
    references commercial.document_lines (workspace_id, id)
    on delete restrict,
  constraint scope_entries_document_fk
    foreign key (workspace_id, accepted_document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint scope_entries_kind_check check (event_kind in ('add', 'reduce')),
  constraint scope_entries_version_check check (scope_version >= 1)
);

create trigger approval_challenges_touch_updated_at
  before update on commercial.approval_challenges
  for each row execute function identity.touch_updated_at();
create trigger approval_sessions_touch_updated_at
  before update on commercial.approval_sessions
  for each row execute function identity.touch_updated_at();
create trigger approval_challenges_reject_key_change
  before update on commercial.approval_challenges
  for each row execute function commercial.reject_tenant_key_change();
create trigger approval_sessions_reject_key_change
  before update on commercial.approval_sessions
  for each row execute function commercial.reject_tenant_key_change();
create trigger approval_decisions_reject_key_change
  before update on commercial.approval_decisions
  for each row execute function commercial.reject_tenant_key_change();
create trigger scope_entries_reject_key_change
  before update on commercial.scope_entries
  for each row execute function commercial.reject_tenant_key_change();

create or replace function commercial.reject_scope_entry_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'scope entries are append-only' using errcode = '23001';
end;
$$;

create trigger scope_entries_protect
  before update or delete on commercial.scope_entries
  for each row execute function commercial.reject_scope_entry_mutation();

create or replace function commercial.reject_decision_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'approval decisions are immutable' using errcode = '23001';
end;
$$;

create trigger approval_decisions_protect
  before update or delete on commercial.approval_decisions
  for each row execute function commercial.reject_decision_mutation();

alter table commercial.approval_challenges enable row level security;
alter table commercial.approval_challenges force row level security;
select identity.install_migrator_force_rls_policy('commercial.approval_challenges');
alter table commercial.approval_sessions enable row level security;
alter table commercial.approval_sessions force row level security;
select identity.install_migrator_force_rls_policy('commercial.approval_sessions');
alter table commercial.approval_decisions enable row level security;
alter table commercial.approval_decisions force row level security;
select identity.install_migrator_force_rls_policy('commercial.approval_decisions');
alter table commercial.scope_entries enable row level security;
alter table commercial.scope_entries force row level security;
select identity.install_migrator_force_rls_policy('commercial.scope_entries');

create policy approval_challenges_select on commercial.approval_challenges
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and request_id = identity.current_request_id()
  );
create policy approval_sessions_select on commercial.approval_sessions
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and request_id = identity.current_request_id()
  );
create policy approval_decisions_select on commercial.approval_decisions
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and (
      request_id = identity.current_request_id()
      or exists (
        select 1 from commercial.memberships m
        where m.workspace_id = approval_decisions.workspace_id
          and m.user_id = identity.current_actor_id()
          and m.status = 'active'
      )
    )
  );
create policy scope_entries_select on commercial.scope_entries
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = scope_entries.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

alter table commercial.delivery_attempts
  drop constraint delivery_attempts_template_check;
alter table commercial.delivery_attempts
  add constraint delivery_attempts_template_check
  check (template_id in ('EMAIL01', 'EMAIL03', 'EMAIL04', 'EMAIL05'));

create or replace function commercial.mask_recipient_email(p_email text)
returns text
language sql
immutable
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then '***'
    else left(split_part(p_email, '@', 1), 1) || '***@' || split_part(p_email, '@', 2)
  end;
$$;

create or replace function commercial.portal_access_state(p_request commercial.approval_requests)
returns text
language plpgsql
stable
as $$
begin
  if p_request.state in ('revoked', 'withdrawn') then
    return 'unavailable';
  end if;
  if p_request.state = 'superseded' then
    return 'superseded';
  end if;
  if p_request.state in ('approved', 'declined') then
    return 'decided';
  end if;
  if p_request.state = 'expired' or (p_request.state = 'pending' and p_request.expires_at <= now()) then
    return 'expired';
  end if;
  if p_request.state = 'pending' then
    return 'pending';
  end if;
  return 'unavailable';
end;
$$;

create or replace function commercial.expire_due_job_approvals(p_workspace_id uuid, p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_request commercial.approval_requests%rowtype;
begin
  if p_workspace_id is null then
    return;
  end if;
  for v_request in
    select *
    from commercial.approval_requests ar
    where ar.workspace_id = p_workspace_id
      and (p_job_id is null or ar.job_id = p_job_id)
      and ar.state = 'pending'
      and ar.purpose = 'approval'
      and ar.expires_at <= now()
    for update
  loop
    update commercial.approval_requests
      set state = 'expired'
      where id = v_request.id and state = 'pending';
    update commercial.documents
      set lifecycle = 'expired'
      where workspace_id = v_request.workspace_id
        and id = v_request.document_id
        and lifecycle = 'issued';
    update commercial.approval_sessions
      set revoked_at = now()
      where workspace_id = v_request.workspace_id
        and request_id = v_request.id
        and revoked_at is null;
    update commercial.approval_challenges
      set consumed_at = now()
      where workspace_id = v_request.workspace_id
        and request_id = v_request.id
        and consumed_at is null;
  end loop;
  update commercial.documents d
    set lifecycle = 'expired'
    from commercial.approval_requests ar
    where ar.workspace_id = p_workspace_id
      and (p_job_id is null or ar.job_id = p_job_id)
      and ar.document_id = d.id
      and ar.workspace_id = d.workspace_id
      and ar.state = 'expired'
      and d.lifecycle = 'issued';
end;
$$;

create or replace function commercial.queue_portal_email(
  p_ws uuid,
  p_request_id uuid,
  p_document_id uuid,
  p_template text,
  p_effect_key text,
  p_encrypted_email bytea,
  p_algorithm text,
  p_key_version integer,
  p_nonce bytea,
  p_ciphertext bytea
)
returns void
language plpgsql
as $$
declare
  v_attempt uuid;
begin
  insert into commercial.delivery_attempts (
    workspace_id, id, document_id, request_id, template_id, recipient_email_encrypted,
    state, effect_key, last_event_at, retry_count
  ) values (
    p_ws, gen_random_uuid(), p_document_id, p_request_id, p_template, p_encrypted_email,
    'queued', p_effect_key, now(), 0
  )
  returning id into v_attempt;
  insert into commercial.encrypted_delivery_payloads (
    workspace_id, id, delivery_attempt_id, algorithm, key_version, nonce, ciphertext
  ) values (
    p_ws, gen_random_uuid(), v_attempt, p_algorithm, p_key_version, p_nonce, p_ciphertext
  );
  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json, schema_version,
    available_at, attempts, status, effect_key
  ) values (
    p_ws, gen_random_uuid(), gen_random_uuid(), 'send_email', p_request_id,
    jsonb_build_object('request_id', p_request_id, 'document_id', p_document_id, 'template_id', p_template),
    1, now(), 0, 'pending', p_effect_key
  );
end;
$$;

create function commercial.exchange_approval_token(
  p_token_hash text,
  p_session_hash text
)
returns table (
  workspace_id uuid,
  request_id uuid,
  purpose text,
  access_state text,
  business_name text,
  document_type text,
  recipient_email_masked text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_request commercial.approval_requests%rowtype;
  v_ws commercial.workspaces%rowtype;
  v_state text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request
  from commercial.approval_requests ar
  where ar.token_hash = p_token_hash
  for update;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  perform commercial.expire_due_job_approvals(v_request.workspace_id, v_request.job_id);
  select * into v_request
  from commercial.approval_requests ar
  where ar.id = v_request.id
  for update;
  v_state := commercial.portal_access_state(v_request);
  if v_state = 'unavailable' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_ws from commercial.workspaces w where w.workspace_id = v_request.workspace_id;
  if v_state in ('pending', 'decided') then
    insert into commercial.approval_sessions (
      workspace_id, id, request_id, session_hash, verified_email, expires_at, token_generation
    ) values (
      v_request.workspace_id, gen_random_uuid(), v_request.id, p_session_hash,
      v_request.recipient_email, now() + interval '20 minutes', 0
    );
  end if;
  return query
    select
      v_request.workspace_id,
      v_request.id,
      v_request.purpose,
      v_state,
      v_ws.business_name,
      'quote'::text,
      commercial.mask_recipient_email(v_request.recipient_email);
end;
$$;

create function commercial.send_portal_code(
  p_session_hash text,
  p_code_hash text,
  p_key_version integer,
  p_encrypted_email bytea,
  p_algorithm text,
  p_delivery_key_version integer,
  p_nonce bytea,
  p_ciphertext bytea
)
returns table (retry_after_sec integer)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_sends integer;
  v_challenge uuid;
  v_effect text;
  v_wait integer;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$'
    or p_key_version is null or p_key_version < 1
    or p_encrypted_email is null or p_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_nonce) is distinct from 12 or octet_length(p_ciphertext) < 17 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.session_hash = p_session_hash
  for update;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation <> 0 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_session.workspace_id and ar.id = v_session.request_id
  for update;
  if not found or commercial.portal_access_state(v_request) not in ('pending', 'decided') then
    if commercial.portal_access_state(v_request) = 'expired' then
      raise exception 'REQUEST_EXPIRED' using errcode = 'P0021';
    end if;
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select count(*)::integer into v_sends
  from commercial.approval_challenges c
  where c.workspace_id = v_request.workspace_id
    and c.request_id = v_request.id
    and c.last_sent_at > now() - interval '1 hour';
  if v_sends >= 5 then
    raise exception 'OTP_RATE_LIMITED' using errcode = 'P0027';
  end if;
  select c.id, greatest(0, ceil(extract(epoch from (c.last_sent_at + interval '60 seconds' - now()))))::integer
    into v_challenge, v_wait
  from commercial.approval_challenges c
  where c.workspace_id = v_request.workspace_id
    and c.request_id = v_request.id
    and c.consumed_at is null
  for update;
  if found and v_wait > 0 then
    raise exception 'OTP_COOLDOWN' using errcode = 'P0026';
  end if;
  if found then
    update commercial.approval_challenges
      set consumed_at = now()
      where id = v_challenge;
  end if;
  insert into commercial.approval_challenges (
    workspace_id, id, request_id, code_hash, secret_key_version, expires_at, failed_attempts, last_sent_at
  ) values (
    v_request.workspace_id, gen_random_uuid(), v_request.id, p_code_hash, p_key_version,
    now() + interval '10 minutes', 0, now()
  )
  returning id into v_challenge;
  v_effect := v_request.workspace_id::text || ':' || v_request.id::text || ':EMAIL03:' || v_challenge::text;
  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_request.document_id, 'EMAIL03', v_effect,
    p_encrypted_email, p_algorithm, p_delivery_key_version, p_nonce, p_ciphertext
  );
  return query select 60;
end;
$$;

create function commercial.verify_portal_code(p_session_hash text, p_code_hash text)
returns table (workspace_id uuid, request_id uuid, access_state text, error_code text)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_challenge commercial.approval_challenges%rowtype;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.session_hash = p_session_hash
  for update;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  if v_session.token_generation >= 1 then
    select * into v_request from commercial.approval_requests where id = v_session.request_id;
    return query select v_session.workspace_id, v_session.request_id, commercial.portal_access_state(v_request), null::text;
    return;
  end if;
  select * into v_request
  from commercial.approval_requests ar
  where ar.id = v_session.request_id
  for update;
  select * into v_challenge
  from commercial.approval_challenges c
  where c.workspace_id = v_session.workspace_id
    and c.request_id = v_session.request_id
    and c.consumed_at is null
  for update;
  if not found then
    return query select v_session.workspace_id, v_session.request_id, commercial.portal_access_state(v_request), 'P0024'::text;
    return;
  end if;
  if v_challenge.failed_attempts >= 5 then
    return query select v_session.workspace_id, v_session.request_id, commercial.portal_access_state(v_request), 'P0025'::text;
    return;
  end if;
  if v_challenge.expires_at <= now() then
    update commercial.approval_challenges set consumed_at = now() where id = v_challenge.id;
    return query select v_session.workspace_id, v_session.request_id, commercial.portal_access_state(v_request), 'P0024'::text;
    return;
  end if;
  if v_challenge.code_hash is distinct from p_code_hash then
    update commercial.approval_challenges
      set failed_attempts = failed_attempts + 1,
          consumed_at = case when failed_attempts + 1 >= 5 then now() else consumed_at end
      where id = v_challenge.id;
    if v_challenge.failed_attempts + 1 >= 5 then
      return query select v_session.workspace_id, v_session.request_id, commercial.portal_access_state(v_request), 'P0025'::text;
      return;
    end if;
    return query select v_session.workspace_id, v_session.request_id, commercial.portal_access_state(v_request), 'P0023'::text;
    return;
  end if;
  update commercial.approval_challenges set consumed_at = now() where id = v_challenge.id;
  update commercial.approval_sessions
    set token_generation = 1,
        expires_at = now() + interval '1 hour'
    where id = v_session.id;
  return query select v_session.workspace_id, v_session.request_id, commercial.portal_access_state(v_request), null::text;
end;
$$;

create function commercial.resolve_portal_session(p_session_hash text)
returns table (
  workspace_id uuid,
  request_id uuid,
  session_id uuid,
  token_generation integer,
  access_state text,
  purpose text,
  recipient_email text,
  owner_email text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
  declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_owner text;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request from commercial.approval_requests ar where ar.id = v_session.request_id;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  if commercial.portal_access_state(v_request) = 'expired' and v_request.state = 'pending' then
    update commercial.approval_requests
      set state = 'expired'
      where id = v_request.id and state = 'pending';
    v_request.state := 'expired';
  end if;
  select w.contact_email into v_owner from commercial.workspaces w where w.workspace_id = v_request.workspace_id;
  return query
    select
      v_session.workspace_id,
      v_session.request_id,
      v_session.id,
      v_session.token_generation,
      commercial.portal_access_state(v_request),
      v_request.purpose,
      v_request.recipient_email,
      v_owner;
end;
$$;

create function commercial.get_portal_document(p_session_hash text)
returns table (
  workspace_id uuid,
  request_id uuid,
  document_id uuid,
  purpose text,
  access_state text,
  business_name text,
  number text,
  revision_no integer,
  lifecycle text,
  snapshot_json jsonb,
  snapshot_sha256 text,
  pdf_state text,
  object_key text,
  consent_version text,
  consent_text text,
  allowed_actions text[]
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_doc commercial.documents%rowtype;
  v_ws commercial.workspaces%rowtype;
  v_state text;
  v_pdf text;
  v_key text;
  v_actions text[];
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request from commercial.approval_requests ar where ar.id = v_session.request_id for update;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  v_state := commercial.portal_access_state(v_request);
  if v_state = 'expired' and v_request.state = 'pending' then
    update commercial.approval_requests set state = 'expired' where id = v_request.id and state = 'pending';
    v_request.state := 'expired';
    v_state := 'expired';
  end if;
  if v_state = 'unavailable' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_doc from commercial.documents d where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id;
  select * into v_ws from commercial.workspaces w where w.workspace_id = v_request.workspace_id;
  select a.object_key into v_key
  from commercial.artifacts a
  where a.workspace_id = v_request.workspace_id
    and a.document_id = v_request.document_id
    and a.type = 'original_pdf'
    and a.state = 'ready'
  limit 1;
  if v_key is not null then
    v_pdf := 'ready';
  elsif exists (
    select 1 from commercial.outbox_tasks p
    where p.workspace_id = v_request.workspace_id
      and p.aggregate_id = v_request.document_id
      and p.task_type = 'generate_original_pdf'
      and p.status = 'dead'
  ) then
    v_pdf := 'failed';
  else
    v_pdf := 'preparing';
  end if;
  v_actions := array['report']::text[];
  if v_state in ('pending', 'decided') and v_pdf = 'ready' then
    v_actions := v_actions || 'download'::text;
  end if;
  if v_state = 'pending' and v_request.purpose = 'approval' and v_pdf = 'ready' then
    v_actions := v_actions || array['approve', 'decline']::text[];
  end if;
  return query
    select
      v_request.workspace_id,
      v_request.id,
      v_request.document_id,
      v_request.purpose,
      v_state,
      v_ws.business_name,
      v_doc.number,
      v_doc.revision_no,
      v_doc.lifecycle,
      v_doc.snapshot_json,
      v_doc.snapshot_sha256,
      v_pdf,
      v_key,
      'apr04.v1'::text,
      'I confirm I have reviewed this quote, including the PDF, and I am authorized to approve or decline it. This is not a payment.'::text,
      v_actions;
end;
$$;

create function commercial.get_portal_receipt(p_session_hash text)
returns table (
  workspace_id uuid,
  request_id uuid,
  document_id uuid,
  access_state text,
  decision text,
  decided_at timestamptz,
  number text,
  revision_no integer,
  signer_name text,
  comment text
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_decision commercial.approval_decisions%rowtype;
  v_doc commercial.documents%rowtype;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session from commercial.approval_sessions s where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request from commercial.approval_requests ar where ar.id = v_session.request_id;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_decision
  from commercial.approval_decisions d
  where d.workspace_id = v_request.workspace_id and d.request_id = v_request.id;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_doc from commercial.documents doc where doc.id = v_request.document_id;
  return query
    select
      v_request.workspace_id,
      v_request.id,
      v_request.document_id,
      commercial.portal_access_state(v_request),
      v_decision.decision,
      v_decision.decided_at,
      v_doc.number,
      v_doc.revision_no,
      v_decision.signer_name,
      v_decision.comment;
end;
$$;

create function commercial.portal_pdf_download(p_session_hash text)
returns table (download_state text, object_key text, document_id uuid)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_row record;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session from commercial.approval_sessions s where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request from commercial.approval_requests ar where ar.id = v_session.request_id;
  if not found or commercial.portal_access_state(v_request) = 'unavailable' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  if v_request.expires_at <= now() and v_request.state = 'pending' then
    raise exception 'REQUEST_EXPIRED' using errcode = 'P0021';
  end if;
  select download_state, object_key into v_row
  from commercial.original_pdf_download(v_request.workspace_id, v_request.document_id);
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  return query select v_row.download_state, v_row.object_key, v_request.document_id;
end;
$$;

create function commercial.report_portal_abuse(p_session_hash text, p_reason text)
returns void
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
declare
  v_session commercial.approval_sessions%rowtype;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  if p_reason is null or p_reason not in ('unexpected', 'wrong_recipient', 'suspicious') then
    raise exception 'invalid portal report' using errcode = '22023';
  end if;
  select * into v_session from commercial.approval_sessions s where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_session.workspace_id, 'system', null, 'portal_report', 'approval_request', v_session.request_id,
    v_session.request_id, 0, 0, jsonb_build_object('reason', p_reason)
  );
end;
$$;

create function commercial.decide_portal_quote(
  p_session_hash text,
  p_operation_id uuid,
  p_decision text,
  p_signer_name text,
  p_consent_version text,
  p_consent_text text,
  p_consent_accepted boolean,
  p_snapshot_sha256 text,
  p_comment text,
  p_encrypted_evidence jsonb,
  p_evidence_key_version integer,
  p_email04_encrypted bytea,
  p_email04_algorithm text,
  p_email04_key_version integer,
  p_email04_nonce bytea,
  p_email04_ciphertext bytea,
  p_email05_encrypted bytea,
  p_email05_algorithm text,
  p_email05_key_version integer,
  p_email05_nonce bytea,
  p_email05_ciphertext bytea
)
returns table (
  request_id uuid,
  document_id uuid,
  decision text,
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
  v_session commercial.approval_sessions%rowtype;
  v_request commercial.approval_requests%rowtype;
  v_job commercial.jobs%rowtype;
  v_doc commercial.documents%rowtype;
  v_existing commercial.approval_decisions%rowtype;
  v_decision commercial.approval_decisions%rowtype;
  v_line commercial.document_lines%rowtype;
  v_next_scope integer;
  v_elapsed double precision;
  v_bucket text;
  v_alias uuid;
  v_pdf_ready boolean;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_operation_id is null
    or p_decision not in ('approve', 'decline')
    or p_signer_name is null or char_length(btrim(p_signer_name)) not between 1 and 120
    or p_consent_version is distinct from 'apr04.v1'
    or p_consent_text is null
    or p_snapshot_sha256 is null or p_snapshot_sha256 !~ '^[0-9a-f]{64}$'
    or (p_comment is not null and char_length(p_comment) > 1000)
    or p_email04_encrypted is null or p_email04_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_email04_nonce) is distinct from 12 or octet_length(p_email04_ciphertext) < 17
    or p_email05_encrypted is null or p_email05_algorithm is distinct from 'aes-256-gcm'
    or octet_length(p_email05_nonce) is distinct from 12 or octet_length(p_email05_ciphertext) < 17 then
    raise exception 'invalid portal decision' using errcode = '22023';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.session_hash = p_session_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_request
  from commercial.approval_requests ar
  where ar.workspace_id = v_session.workspace_id and ar.id = v_session.request_id
  for update;
  if not found then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_session
  from commercial.approval_sessions s
  where s.id = v_session.id
  for update;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or v_session.token_generation < 1 then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  select * into v_existing
  from commercial.approval_decisions d
  where d.workspace_id = v_request.workspace_id and d.request_id = v_request.id;
  if found then
    if v_existing.operation_id = p_operation_id then
      select * into v_doc from commercial.documents where id = v_existing.document_id;
      return query
        select v_request.id, v_existing.document_id, v_existing.decision, v_existing.decided_at,
               v_doc.number, v_doc.revision_no, true;
      return;
    end if;
    raise exception 'ALREADY_DECIDED' using errcode = 'P0022';
  end if;
  if v_request.purpose is distinct from 'approval' then
    raise exception 'VIEW_ONLY_FORBIDDEN' using errcode = 'P0032';
  end if;
  if v_request.state = 'superseded' then
    raise exception 'REQUEST_UNAVAILABLE' using errcode = 'P0020';
  end if;
  if v_request.state <> 'pending' or v_request.expires_at <= now() then
    if v_request.state = 'pending' then
      update commercial.approval_requests set state = 'expired' where id = v_request.id and state = 'pending';
      update commercial.documents
        set lifecycle = 'expired'
        where workspace_id = v_request.workspace_id and id = v_request.document_id and lifecycle = 'issued';
    end if;
    if v_request.state in ('approved', 'declined') then
      raise exception 'ALREADY_DECIDED' using errcode = 'P0022';
    end if;
    raise exception 'REQUEST_EXPIRED' using errcode = 'P0021';
  end if;
  select * into v_job
  from commercial.jobs j
  where j.workspace_id = v_request.workspace_id and j.id = v_request.job_id
  for update;
  select * into v_doc
  from commercial.documents d
  where d.workspace_id = v_request.workspace_id and d.id = v_request.document_id
  for update;
  if v_doc.snapshot_sha256 is distinct from p_snapshot_sha256 then
    raise exception 'SNAPSHOT_MISMATCH' using errcode = 'P0033';
  end if;
  if v_request.expected_scope_version is distinct from v_job.scope_version then
    raise exception 'SCOPE_CHANGED' using errcode = 'P0034';
  end if;
  select exists (
    select 1 from commercial.artifacts a
    where a.workspace_id = v_doc.workspace_id
      and a.document_id = v_doc.id
      and a.type = 'original_pdf'
      and a.state = 'ready'
  ) into v_pdf_ready;
  if not v_pdf_ready then
    raise exception 'PDF_NOT_READY' using errcode = 'P0030';
  end if;
  if p_decision = 'approve' and p_consent_accepted is not true then
    raise exception 'CONSENT_REQUIRED' using errcode = 'P0031';
  end if;

  begin
    insert into commercial.approval_decisions (
      workspace_id, id, request_id, document_id, decision, signer_name, verified_email,
      decided_at, snapshot_sha256, consent_version, consent_text, comment,
      encrypted_evidence_json, evidence_key_version, operation_id
    ) values (
      v_request.workspace_id, gen_random_uuid(), v_request.id, v_doc.id, p_decision,
      btrim(p_signer_name), v_session.verified_email, now(), p_snapshot_sha256,
      p_consent_version, p_consent_text, nullif(btrim(coalesce(p_comment, '')), ''),
      p_encrypted_evidence, p_evidence_key_version, p_operation_id
    )
    returning * into v_decision;
  exception
    when unique_violation then
      raise exception 'CONCURRENT_DECISION' using errcode = 'P0028';
  end;

  if p_decision = 'approve' then
    v_next_scope := v_job.scope_version + 1;
    for v_line in
      select * from commercial.document_lines l
      where l.workspace_id = v_doc.workspace_id and l.document_id = v_doc.id
      order by l.position
    loop
      insert into commercial.scope_entries (
        workspace_id, id, job_id, source_line_id, accepted_document_id, scope_version,
        event_kind, net_delta_cents, tax_delta_cents
      ) values (
        v_request.workspace_id, gen_random_uuid(), v_job.id, v_line.id, v_doc.id, v_next_scope,
        'add', v_line.net_cents, v_line.tax_cents
      );
    end loop;
    update commercial.jobs
      set scope_version = v_next_scope,
          version = version + 1
      where workspace_id = v_job.workspace_id and id = v_job.id;
    update commercial.documents
      set lifecycle = 'accepted'
      where workspace_id = v_doc.workspace_id and id = v_doc.id;
    update commercial.approval_requests
      set state = 'approved',
          decided_at = v_decision.decided_at
      where id = v_request.id;
  else
    update commercial.documents
      set lifecycle = 'declined'
      where workspace_id = v_doc.workspace_id and id = v_doc.id;
    update commercial.approval_requests
      set state = 'declined',
          decided_at = v_decision.decided_at
      where id = v_request.id;
  end if;

  update commercial.approval_sessions
    set revoked_at = now()
    where workspace_id = v_request.workspace_id
      and request_id = v_request.id
      and id <> v_session.id
      and revoked_at is null;

  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL04',
    v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL04:' || v_decision.id::text,
    p_email04_encrypted, p_email04_algorithm, p_email04_key_version, p_email04_nonce, p_email04_ciphertext
  );
  perform commercial.queue_portal_email(
    v_request.workspace_id, v_request.id, v_doc.id, 'EMAIL05',
    v_request.workspace_id::text || ':' || v_doc.id::text || ':EMAIL05:' || v_decision.id::text,
    p_email05_encrypted, p_email05_algorithm, p_email05_key_version, p_email05_nonce, p_email05_ciphertext
  );

  v_elapsed := extract(epoch from (v_decision.decided_at - v_request.created_at));
  v_bucket := case
    when v_elapsed < 3600 then 'lt_1h'
    when v_elapsed < 86400 then '1_to_24h'
    when v_elapsed < 604800 then '1_to_7d'
    else 'gt_7d'
  end;
  select u.analytics_alias_id into v_alias
  from commercial.workspaces w
  join identity.app_users u on u.id = w.owner_user_id
  where w.workspace_id = v_request.workspace_id;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, before_version, after_version, safe_metadata_json
  ) values (
    v_request.workspace_id, 'system', null, 'approval_completed', 'document', v_doc.id,
    v_request.id, v_job.version, v_job.version + 1,
    jsonb_build_object('decision', p_decision, 'kind', 'quote')
  );

  begin
    insert into commercial.analytics_events (
      workspace_id, event_id, event_name, schema_version, occurred_at,
      pseudonymous_owner_id, job_id, safe_properties_json
    ) values (
      v_request.workspace_id, gen_random_uuid(), 'approval_completed', 1, now(), v_alias, v_job.id,
      jsonb_build_object(
        'decision', p_decision,
        'document_kind', 'quote',
        'elapsed_bucket', v_bucket
      )
    );
  exception
    when unique_violation then
      null;
  end;

  return query
    select v_request.id, v_doc.id, v_decision.decision, v_decision.decided_at,
           v_doc.number, v_doc.revision_no, false;
end;
$$;

create or replace function commercial.open_quote_draft(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_job_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  job_id uuid,
  kind text,
  draft_state text,
  schema_version integer,
  payload_json jsonb,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  default_tax_bp integer,
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
  v_job commercial.jobs%rowtype;
  v_quote commercial.documents%rowtype;
  v_has_quote boolean := false;
  v_terms text;
  v_tax integer;
  v_draft commercial.document_drafts%rowtype;
  v_payload jsonb;
  v_lines jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_job_id is null then
    raise exception 'invalid quote draft open' using errcode = '22023';
  end if;

  select u.status into v_status from identity.app_users u where u.id = p_actor_id for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at, w.default_terms, w.default_tax_bp
    into v_ws, v_setup, v_terms, v_tax
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
          v_existing.response_json->>'kind',
          v_existing.response_json->>'draft_state',
          (v_existing.response_json->>'schema_version')::integer,
          v_existing.response_json->'payload_json',
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          (v_existing.response_json->>'default_tax_bp')::integer,
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
  if v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle = 'active' then
    select * into v_quote
    from commercial.documents d
    where d.workspace_id = v_ws and d.id = v_job.current_quote_id;
    if not found then
      raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
    end if;
    v_has_quote := true;
    if v_quote.lifecycle = 'accepted' then
      raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0010';
    end if;
  elsif v_job.lifecycle is distinct from 'draft' then
    raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
  end if;

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.job_id = p_job_id
    and d.kind = 'quote'
    and d.draft_state = 'editing'
  for update;

  if not found then
    if v_has_quote then
      select coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'client_line_id', coalesce(line->>'client_line_id', gen_random_uuid()::text),
            'description', coalesce(line->>'description', ''),
            'unit', coalesce(line->>'unit', 'item'),
            'custom_unit_label', line->>'custom_unit_label',
            'quantity', coalesce(line->>'quantity', '1'),
            'unit_price_cents', coalesce((line->>'unit_price_cents')::bigint, 0),
            'discount_cents', coalesce((line->>'discount_cents')::bigint, 0),
            'tax_bp', coalesce((line->>'tax_bp')::integer, 0)
          )
          order by coalesce((line->>'position')::integer, 0)
        )
        from jsonb_array_elements(coalesce(v_quote.snapshot_json->'lines', '[]'::jsonb)) as line
      ), '[]'::jsonb) into v_lines;
      v_payload := jsonb_build_object(
        'notes', coalesce(v_quote.snapshot_json->>'notes', ''),
        'terms', coalesce(v_quote.snapshot_json->>'terms', ''),
        'expiry_days', coalesce((v_quote.snapshot_json->>'expiry_days')::integer, 14),
        'lines', v_lines
      );
    else
      v_payload := jsonb_build_object(
        'notes', '',
        'terms', coalesce(v_terms, ''),
        'expiry_days', 14,
        'lines', '[]'::jsonb
      );
    end if;
    insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, parent_document_id, base_scope_version,
      payload_json, schema_version, draft_state
    ) values (
      v_ws, gen_random_uuid(), p_job_id, 'quote', case when v_has_quote then v_quote.id else null end, v_job.scope_version,
      v_payload, 1, 'editing'
    )
    returning * into v_draft;
  end if;

  v_payload := jsonb_build_object(
    'id', v_draft.id,
    'workspace_id', v_draft.workspace_id,
    'job_id', v_draft.job_id,
    'kind', v_draft.kind,
    'draft_state', v_draft.draft_state,
    'schema_version', v_draft.schema_version,
    'payload_json', v_draft.payload_json,
    'version', v_draft.version,
    'created_at', v_draft.created_at,
    'updated_at', v_draft.updated_at,
    'default_tax_bp', coalesce(v_tax, 0)
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/jobs/' || p_job_id::text || '/quote',
      p_request_hash, gen_random_uuid(),
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
      v_draft.id,
      v_draft.workspace_id,
      v_draft.job_id,
      v_draft.kind,
      v_draft.draft_state,
      v_draft.schema_version,
      v_draft.payload_json,
      v_draft.version,
      v_draft.created_at,
      v_draft.updated_at,
      coalesce(v_tax, 0),
      false;
end;
$$;

drop function if exists commercial.publish_quote_draft(
  uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz
);

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

  v_wait_pdf := v_attempt.template_id in ('EMAIL01', 'EMAIL04');
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

create or replace function commercial.complete_send_email(p_task_id uuid, p_provider_message_id text)
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
  where workspace_id = v_task.workspace_id and effect_key = v_task.effect_key
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

create or replace function commercial.fail_send_email(p_task_id uuid, p_error_code text, p_permanent boolean)
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
      where workspace_id = v_task.workspace_id
        and effect_key = v_task.effect_key
        and state not in ('delivered', 'bounced', 'complained');
    update commercial.encrypted_delivery_payloads p
      set purge_after = now() + interval '24 hours'
      from commercial.delivery_attempts a
      where a.workspace_id = v_task.workspace_id
        and a.effect_key = v_task.effect_key
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
      where workspace_id = v_task.workspace_id and effect_key = v_task.effect_key;
  end if;
  return v_status;
end;
$$;

drop function if exists commercial.owner_job_request(uuid, uuid);

create or replace function commercial.save_quote_draft(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
  p_payload jsonb
)
returns table (
  id uuid,
  workspace_id uuid,
  job_id uuid,
  kind text,
  draft_state text,
  schema_version integer,
  payload_json jsonb,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  default_tax_bp integer,
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
  v_job commercial.jobs%rowtype;
  v_quote commercial.documents%rowtype;
  v_tax integer;
  v_draft commercial.document_drafts%rowtype;
  v_payload jsonb;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_draft_id is null
    or p_expected_version is null
    or p_payload is null then
    raise exception 'invalid quote draft save' using errcode = '22023';
  end if;
  if p_expected_version < 1 then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid quote draft payload' using errcode = '22023';
  end if;

  select u.status
    into v_status
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.id, w.setup_completed_at, w.default_tax_bp
    into v_ws, v_setup, v_tax
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
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
          (v_existing.response_json->>'workspace_id')::uuid,
          (v_existing.response_json->>'job_id')::uuid,
          v_existing.response_json->>'kind',
          v_existing.response_json->>'draft_state',
          (v_existing.response_json->>'schema_version')::integer,
          v_existing.response_json->'payload_json',
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          (v_existing.response_json->>'default_tax_bp')::integer,
          true;
      return;
    end if;
  end if;

  select *
    into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws
    and d.id = p_draft_id
  for update;
  if not found then
    raise exception 'DRAFT_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_draft.kind is distinct from 'quote' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'DRAFT_NOT_EDITABLE' using errcode = 'P0007';
  end if;
  if v_draft.version is distinct from p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select *
    into v_job
  from commercial.jobs j
  where j.workspace_id = v_ws
    and j.id = v_draft.job_id
  for update;
  if not found or v_job.mode is distinct from 'quote' then
    raise exception 'QUOTE_MODE_REQUIRED' using errcode = 'P0006';
  end if;
  if v_job.lifecycle = 'active' then
    select * into v_quote
    from commercial.documents d
    where d.workspace_id = v_ws and d.id = v_job.current_quote_id;
    if not found then
      raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
    end if;
    if v_quote.lifecycle = 'accepted' then
      raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0010';
    end if;
  elsif v_job.lifecycle is distinct from 'draft' then
    raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
  end if;

  update commercial.document_drafts
    set payload_json = p_payload,
        version = version + 1
    where workspace_id = v_ws
      and id = p_draft_id
    returning * into v_draft;

  v_payload := jsonb_build_object(
    'id', v_draft.id,
    'workspace_id', v_draft.workspace_id,
    'job_id', v_draft.job_id,
    'kind', v_draft.kind,
    'draft_state', v_draft.draft_state,
    'schema_version', v_draft.schema_version,
    'payload_json', v_draft.payload_json,
    'version', v_draft.version,
    'created_at', v_draft.created_at,
    'updated_at', v_draft.updated_at,
    'default_tax_bp', coalesce(v_tax, 0)
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/drafts/' || p_draft_id::text,
      p_request_hash, gen_random_uuid(),
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
      v_draft.id,
      v_draft.workspace_id,
      v_draft.job_id,
      v_draft.kind,
      v_draft.draft_state,
      v_draft.schema_version,
      v_draft.payload_json,
      v_draft.version,
      v_draft.created_at,
      v_draft.updated_at,
      coalesce(v_tax, 0),
      false;
end;
$$;

create or replace function commercial.freeze_quote_preview(
  p_actor_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
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
  v_job commercial.jobs%rowtype;
  v_quote commercial.documents%rowtype;
  v_draft commercial.document_drafts%rowtype;
begin
  if p_actor_id is null
    or p_draft_id is null
    or p_expected_version is null
    or p_preview_hash is null
    or p_canonical_bytes is null
    or p_snapshot is null
    or p_expires_at is null then
    raise exception 'invalid quote preview' using errcode = '22023';
  end if;
  if p_expected_version < 1 or p_preview_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid quote preview' using errcode = '22023';
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

  select * into v_draft
  from commercial.document_drafts d
  where d.workspace_id = v_ws and d.id = p_draft_id
  for update;
  if not found then
    raise exception 'DRAFT_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_draft.kind is distinct from 'quote' or v_draft.draft_state is distinct from 'editing' then
    raise exception 'DRAFT_NOT_EDITABLE' using errcode = 'P0007';
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
    select * into v_quote
    from commercial.documents d
    where d.workspace_id = v_ws and d.id = v_job.current_quote_id;
    if not found then
      raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
    end if;
    if v_quote.lifecycle = 'accepted' then
      raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0010';
    end if;
  elsif v_job.lifecycle is distinct from 'draft' then
    raise exception 'JOB_NOT_EDITABLE' using errcode = 'P0007';
  end if;

  update commercial.document_drafts
    set preview_hash = p_preview_hash,
        preview_canonical_bytes = p_canonical_bytes,
        preview_snapshot_json = p_snapshot,
        preview_expires_at = p_expires_at,
        preview_draft_version = v_draft.version
    where workspace_id = v_ws and id = p_draft_id
    returning * into v_draft;

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
  decided_at timestamptz
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
      ar.decided_at
    from commercial.approval_requests ar
    join commercial.documents d
      on d.workspace_id = ar.workspace_id and d.id = ar.document_id
    join commercial.delivery_attempts da
      on da.workspace_id = ar.workspace_id and da.request_id = ar.id and da.template_id = 'EMAIL01'
    where ar.workspace_id = p_workspace_id
      and ar.job_id = p_job_id
      and ar.purpose = 'approval'
    order by ar.created_at desc, ar.id desc
    limit 1;
end;
$$;

revoke all on function identity.current_request_id() from public;
grant execute on function identity.current_request_id() to api_app;
revoke all on function identity.current_request_id() from worker_app, purge_app, anon, authenticated;

revoke all on function identity.set_local_portal_context(uuid, uuid) from public;
grant execute on function identity.set_local_portal_context(uuid, uuid) to api_app;
revoke all on function identity.set_local_portal_context(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.expire_due_job_approvals(uuid, uuid) from public;
grant execute on function commercial.expire_due_job_approvals(uuid, uuid) to api_app;
revoke all on function commercial.expire_due_job_approvals(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.queue_portal_email(uuid, uuid, uuid, text, text, bytea, text, integer, bytea, bytea) from public;
revoke all on function commercial.queue_portal_email(uuid, uuid, uuid, text, text, bytea, text, integer, bytea, bytea)
  from api_app, worker_app, purge_app, anon, authenticated;

revoke all on function commercial.exchange_approval_token(text, text) from public;
grant execute on function commercial.exchange_approval_token(text, text) to api_app;
revoke all on function commercial.exchange_approval_token(text, text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.send_portal_code(text, text, integer, bytea, text, integer, bytea, bytea) from public;
grant execute on function commercial.send_portal_code(text, text, integer, bytea, text, integer, bytea, bytea) to api_app;
revoke all on function commercial.send_portal_code(text, text, integer, bytea, text, integer, bytea, bytea)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.verify_portal_code(text, text) from public;
grant execute on function commercial.verify_portal_code(text, text) to api_app;
revoke all on function commercial.verify_portal_code(text, text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.resolve_portal_session(text) from public;
grant execute on function commercial.resolve_portal_session(text) to api_app;
revoke all on function commercial.resolve_portal_session(text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.get_portal_document(text) from public;
grant execute on function commercial.get_portal_document(text) to api_app;
revoke all on function commercial.get_portal_document(text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.get_portal_receipt(text) from public;
grant execute on function commercial.get_portal_receipt(text) to api_app;
revoke all on function commercial.get_portal_receipt(text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.portal_pdf_download(text) from public;
grant execute on function commercial.portal_pdf_download(text) to api_app;
revoke all on function commercial.portal_pdf_download(text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.report_portal_abuse(text, text) from public;
grant execute on function commercial.report_portal_abuse(text, text) to api_app;
revoke all on function commercial.report_portal_abuse(text, text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.decide_portal_quote(text, uuid, text, text, text, text, boolean, text, text, jsonb, integer, bytea, text, integer, bytea, bytea, bytea, text, integer, bytea, bytea) from public;
grant execute on function commercial.decide_portal_quote(text, uuid, text, text, text, text, boolean, text, text, jsonb, integer, bytea, text, integer, bytea, bytea, bytea, text, integer, bytea, bytea) to api_app;
revoke all on function commercial.decide_portal_quote(text, uuid, text, text, text, text, boolean, text, text, jsonb, integer, bytea, text, integer, bytea, bytea, bytea, text, integer, bytea, bytea)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid) from public;
grant execute on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid) to api_app;
revoke all on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.owner_job_request(uuid, uuid) from public;
grant execute on function commercial.owner_job_request(uuid, uuid) to api_app;
revoke all on function commercial.owner_job_request(uuid, uuid)
  from worker_app, purge_app, anon, authenticated;

revoke all on commercial.approval_challenges from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.approval_sessions from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.approval_decisions from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.scope_entries from public, anon, authenticated, api_app, worker_app, purge_app;

reset role;
