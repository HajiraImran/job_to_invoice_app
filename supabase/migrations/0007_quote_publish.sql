-- Quote publication (S11 / TX01). Official numbers, immutable snapshots, slot consumption,
-- and a queued original-PDF outbox row. Email delivery and approval links are not created here.

set role migrator;

alter table commercial.document_drafts
  add column preview_hash text,
  add column preview_canonical_bytes bytea,
  add column preview_snapshot_json jsonb,
  add column preview_expires_at timestamptz,
  add column preview_draft_version integer;

alter table commercial.document_drafts
  add constraint document_drafts_preview_hash_check check (
    preview_hash is null or preview_hash ~ '^[0-9a-f]{64}$'
  );

alter table commercial.document_drafts
  add constraint document_drafts_preview_complete_check check (
    (
      preview_hash is null
      and preview_canonical_bytes is null
      and preview_snapshot_json is null
      and preview_expires_at is null
      and preview_draft_version is null
    )
    or (
      preview_hash is not null
      and preview_canonical_bytes is not null
      and jsonb_typeof(preview_snapshot_json) = 'object'
      and preview_expires_at is not null
      and preview_draft_version >= 1
    )
  );

create or replace function commercial.protect_document_draft_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if current_user not in ('migrator', 'purge_app') then
      if new.kind is distinct from 'quote'
        or new.draft_state is distinct from 'editing'
        or new.parent_document_id is not null
        or new.schema_version is distinct from 1
        or new.preview_hash is not null then
        raise exception 'only editing quote drafts can be inserted' using errcode = '23001';
      end if;
    end if;
    return new;
  end if;

  if new.job_id is distinct from old.job_id
    or new.kind is distinct from old.kind then
    raise exception 'document draft identity is immutable' using errcode = '23001';
  end if;

  if current_user not in ('migrator', 'purge_app') then
    if old.draft_state is distinct from 'editing' then
      raise exception 'only editing drafts can be updated' using errcode = '23001';
    end if;
    if new.draft_state is distinct from 'editing'
      or new.parent_document_id is distinct from old.parent_document_id
      or new.preview_hash is distinct from old.preview_hash
      or new.preview_canonical_bytes is distinct from old.preview_canonical_bytes
      or new.preview_snapshot_json is distinct from old.preview_snapshot_json
      or new.preview_expires_at is distinct from old.preview_expires_at
      or new.preview_draft_version is distinct from old.preview_draft_version then
      raise exception 'draft publication fields are server-assigned' using errcode = '23001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function commercial.protect_job_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if current_user not in ('migrator', 'purge_app') then
      if new.lifecycle is distinct from 'draft'
        or new.completion_right is distinct from false
        or new.first_published_at is not null
        or new.current_quote_id is not null
        or new.active_invoice_id is not null
        or new.entitlement_origin is not null
        or new.scope_version is distinct from 0
        or new.archived_from_state is not null then
        raise exception 'job publication fields are server-assigned' using errcode = '23001';
      end if;
    end if;
    return new;
  end if;

  if new.completion_right is distinct from old.completion_right and new.completion_right = false then
    if current_user <> 'purge_app' then
      raise exception 'completion_right is write-once' using errcode = '23001';
    end if;
  end if;

  if current_user in ('api_app', 'worker_app', 'anon', 'authenticated') then
    if new.lifecycle is distinct from old.lifecycle
      or new.current_quote_id is distinct from old.current_quote_id
      or new.active_invoice_id is distinct from old.active_invoice_id
      or new.first_published_at is distinct from old.first_published_at
      or new.entitlement_origin is distinct from old.entitlement_origin
      or new.completion_right is distinct from old.completion_right
      or new.scope_version is distinct from old.scope_version
      or new.archived_from_state is distinct from old.archived_from_state then
      raise exception 'job publication fields are server-assigned' using errcode = '23001';
    end if;
  end if;
  return new;
end;
$$;

create table commercial.documents (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  job_id uuid not null,
  kind text not null,
  number text not null,
  revision_no integer not null,
  prior_document_id uuid,
  lifecycle text not null,
  issued_at timestamptz not null,
  issue_date date not null,
  due_date date,
  currency text not null,
  net_cents bigint not null,
  tax_cents bigint not null,
  total_cents bigint not null,
  snapshot_json jsonb not null,
  canonical_snapshot_bytes bytea not null,
  schema_version integer not null,
  snapshot_sha256 text not null,
  scope_version integer not null default 0,
  void_reason text,
  constraint documents_pkey primary key (id),
  constraint documents_tenant_id_key unique (workspace_id, id),
  constraint documents_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint documents_job_fk
    foreign key (workspace_id, job_id)
    references commercial.jobs (workspace_id, id)
    on delete restrict,
  constraint documents_prior_fk
    foreign key (workspace_id, prior_document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint documents_kind_check check (kind in ('quote', 'change', 'invoice', 'credit')),
  constraint documents_lifecycle_check check (
    lifecycle in ('issued', 'accepted', 'declined', 'withdrawn', 'superseded', 'voided')
  ),
  constraint documents_currency_check check (currency = 'USD'),
  constraint documents_revision_check check (revision_no >= 1),
  constraint documents_schema_version_check check (schema_version >= 1),
  constraint documents_scope_version_check check (scope_version >= 0),
  constraint documents_cents_check check (
    net_cents >= 0 and tax_cents >= 0 and total_cents >= 0 and total_cents <= 999999999
  ),
  constraint documents_hash_check check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  constraint documents_snapshot_object_check check (jsonb_typeof(snapshot_json) = 'object'),
  constraint documents_number_len check (char_length(number) between 3 and 20)
);

comment on column commercial.documents.canonical_snapshot_bytes is
  'QUO02A frozen commercial snapshot. Official number and revision live on number/revision_no.';

create unique index documents_number_revision_key
  on commercial.documents (workspace_id, kind, number, revision_no);

create index documents_job_idx
  on commercial.documents (workspace_id, job_id, created_at desc, id desc);

create table commercial.document_lines (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  document_id uuid not null,
  position integer not null,
  line_kind text not null,
  source_line_id uuid,
  description text not null,
  quantity numeric(12, 3),
  unit text,
  unit_price_cents bigint,
  discount_cents bigint not null default 0,
  net_cents bigint not null,
  tax_bp integer not null,
  tax_cents bigint not null,
  total_cents bigint not null,
  original_source_id uuid,
  constraint document_lines_pkey primary key (id),
  constraint document_lines_tenant_id_key unique (workspace_id, id),
  constraint document_lines_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint document_lines_document_fk
    foreign key (workspace_id, document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint document_lines_source_fk
    foreign key (workspace_id, source_line_id)
    references commercial.document_lines (workspace_id, id)
    on delete restrict,
  constraint document_lines_original_fk
    foreign key (workspace_id, original_source_id)
    references commercial.document_lines (workspace_id, id)
    on delete restrict,
  constraint document_lines_kind_check check (line_kind in ('source', 'reduction', 'credit')),
  constraint document_lines_position_check check (position >= 1),
  constraint document_lines_tax_bp_check check (tax_bp between 0 and 2500),
  constraint document_lines_cents_check check (
    discount_cents >= 0 and net_cents >= 0 and tax_cents >= 0 and total_cents >= 0
  )
);

create unique index document_lines_position_key
  on commercial.document_lines (workspace_id, document_id, position);

create table commercial.document_counters (
  workspace_id uuid not null,
  type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  next_value integer not null,
  constraint document_counters_pkey primary key (workspace_id, type),
  constraint document_counters_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint document_counters_type_check check (type in ('quote', 'change', 'invoice', 'credit')),
  constraint document_counters_next_check check (next_value >= 1),
  constraint document_counters_version_check check (version >= 1)
);

create table commercial.outbox_tasks (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  event_id uuid not null,
  task_type text not null,
  aggregate_id uuid not null,
  payload_json jsonb not null,
  schema_version integer not null default 1,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  attempts integer not null default 0,
  status text not null,
  effect_key text not null,
  last_error_code text,
  constraint outbox_tasks_pkey primary key (id),
  constraint outbox_tasks_tenant_id_key unique (workspace_id, id),
  constraint outbox_tasks_event_id_key unique (event_id),
  constraint outbox_tasks_effect_key_key unique (effect_key),
  constraint outbox_tasks_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint outbox_tasks_status_check check (status in ('pending', 'running', 'done', 'dead')),
  constraint outbox_tasks_attempts_check check (attempts >= 0),
  constraint outbox_tasks_schema_version_check check (schema_version >= 1),
  constraint outbox_tasks_payload_object_check check (jsonb_typeof(payload_json) = 'object')
);

create index outbox_tasks_claim_idx
  on commercial.outbox_tasks (status, available_at);

create table commercial.artifacts (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  document_id uuid,
  export_id uuid,
  type text not null,
  object_key text not null,
  sha256 text not null,
  bytes bigint not null,
  template_version text not null,
  generated_at timestamptz not null,
  state text not null,
  constraint artifacts_pkey primary key (id),
  constraint artifacts_tenant_id_key unique (workspace_id, id),
  constraint artifacts_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint artifacts_document_fk
    foreign key (workspace_id, document_id)
    references commercial.documents (workspace_id, id)
    on delete restrict,
  constraint artifacts_type_check check (
    type in ('original_pdf', 'status_pdf', 'receipt_pdf', 'statement_pdf', 'export_zip')
  ),
  constraint artifacts_state_check check (state in ('ready', 'failed')),
  constraint artifacts_hash_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint artifacts_bytes_check check (bytes >= 0)
);

alter table commercial.jobs
  add constraint jobs_current_quote_fk
  foreign key (workspace_id, current_quote_id)
  references commercial.documents (workspace_id, id)
  on delete restrict;

alter table commercial.document_drafts
  add constraint document_drafts_parent_document_fk
  foreign key (workspace_id, parent_document_id)
  references commercial.documents (workspace_id, id)
  on delete restrict;

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
  if current_user <> 'purge_app' then
    raise exception 'issued documents are immutable' using errcode = '23001';
  end if;
  return new;
end;
$$;

create trigger documents_protect_issued
  before update or delete on commercial.documents
  for each row execute function commercial.protect_issued_document();

create trigger document_lines_protect_issued
  before update or delete on commercial.document_lines
  for each row execute function commercial.protect_issued_document();

create trigger documents_reject_key_change
  before update on commercial.documents
  for each row execute function commercial.reject_tenant_key_change();

create trigger document_lines_reject_key_change
  before update on commercial.document_lines
  for each row execute function commercial.reject_tenant_key_change();

create or replace function commercial.reject_document_counter_key_change()
returns trigger
language plpgsql
as $$
begin
  if new.workspace_id is distinct from old.workspace_id or new.type is distinct from old.type then
    raise exception 'tenant keys are immutable' using errcode = '23001';
  end if;
  return new;
end;
$$;

create trigger document_counters_touch_updated_at
  before update on commercial.document_counters
  for each row execute function identity.touch_updated_at();

create trigger document_counters_reject_key_change
  before update on commercial.document_counters
  for each row execute function commercial.reject_document_counter_key_change();

alter table commercial.documents enable row level security;
alter table commercial.documents force row level security;
select identity.install_migrator_force_rls_policy('commercial.documents');
alter table commercial.document_lines enable row level security;
alter table commercial.document_lines force row level security;
select identity.install_migrator_force_rls_policy('commercial.document_lines');
alter table commercial.document_counters enable row level security;
alter table commercial.document_counters force row level security;
select identity.install_migrator_force_rls_policy('commercial.document_counters');
alter table commercial.outbox_tasks enable row level security;
alter table commercial.outbox_tasks force row level security;
select identity.install_migrator_force_rls_policy('commercial.outbox_tasks');
alter table commercial.artifacts enable row level security;
alter table commercial.artifacts force row level security;
select identity.install_migrator_force_rls_policy('commercial.artifacts');

create policy documents_select on commercial.documents
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = documents.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy document_lines_select on commercial.document_lines
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = document_lines.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy artifacts_select on commercial.artifacts
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = artifacts.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy document_counters_select on commercial.document_counters
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = document_counters.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy outbox_tasks_select on commercial.outbox_tasks
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = outbox_tasks.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create function commercial.freeze_quote_preview(
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
  if v_job.lifecycle is distinct from 'draft' then
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

create function commercial.publish_quote_draft(
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
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_draft_id is null
    or p_expected_version is null
    or p_preview_hash is null then
    raise exception 'invalid quote publish' using errcode = '22023';
  end if;
  if p_expected_version < 1 or p_preview_hash !~ '^[0-9a-f]{64}$' then
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

  insert into commercial.outbox_tasks (
    workspace_id, id, event_id, task_type, aggregate_id, payload_json, schema_version,
    available_at, attempts, status, effect_key
  ) values (
    v_ws, gen_random_uuid(), gen_random_uuid(), 'generate_original_pdf', v_doc.id,
    jsonb_build_object('document_id', v_doc.id, 'kind', 'quote'),
    1, now(), 0, 'pending',
    v_ws::text || ':' || v_doc.id::text || ':original_pdf'
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
    jsonb_build_object('kind', 'quote', 'revision_no', 1)
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
    'pdf_state', 'preparing'
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
      false;
end;
$$;

comment on function commercial.freeze_quote_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz) is
  'Stores a 10-minute QUO02A preview freeze on an editing quote draft.';

comment on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text) is
  'TX01: allocate Q-number, insert immutable snapshot, consume one free slot, queue original PDF.';

revoke all on function commercial.freeze_quote_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz) from public;
grant execute on function commercial.freeze_quote_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz) to api_app;
revoke all on function commercial.freeze_quote_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text) from public;
grant execute on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text) to api_app;
revoke all on function commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.protect_issued_document() from public;
revoke all on function commercial.protect_issued_document()
  from api_app, worker_app, purge_app, anon, authenticated;

revoke all on function commercial.reject_document_counter_key_change() from public;
revoke all on function commercial.reject_document_counter_key_change()
  from api_app, worker_app, purge_app, anon, authenticated;

grant select on commercial.documents to api_app;
grant select on commercial.document_lines to api_app;
grant select on commercial.artifacts to api_app;
revoke insert, update, delete on commercial.documents from api_app;
revoke insert, update, delete on commercial.document_lines from api_app;
revoke insert, update, delete on commercial.artifacts from api_app;
revoke all on commercial.documents from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.document_lines from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.document_counters from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.outbox_tasks from public, anon, authenticated, api_app, worker_app, purge_app;
revoke all on commercial.artifacts from public, anon, authenticated, worker_app, purge_app;

reset role;
