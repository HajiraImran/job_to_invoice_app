-- Identity mapping, workspaces, memberships, action grants, tenant RLS, composite FKs.
-- Assets are created here so workspaces.logo_asset_id can use a composite tenant FK.
-- job_id and draft_id FKs are deferred until jobs and document_drafts exist.

set role migrator;

create or replace function identity.current_workspace_id()
returns uuid
language sql
stable
parallel safe
as $$
  select nullif(current_setting('app.workspace_id', true), '')::uuid;
$$;

create or replace function identity.current_actor_id()
returns uuid
language sql
stable
parallel safe
as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid;
$$;

create or replace function identity.set_local_tenant_context(p_workspace_id uuid, p_actor_id uuid)
returns void
language plpgsql
as $$
begin
  if p_workspace_id is null or p_actor_id is null then
    raise exception 'tenant context requires workspace_id and actor_id'
      using errcode = '22023';
  end if;
  perform set_config('app.workspace_id', p_workspace_id::text, true);
  perform set_config('app.actor_id', p_actor_id::text, true);
end;
$$;

comment on function identity.set_local_tenant_context(uuid, uuid) is
  'SET LOCAL tenant GUC from verified server identity. Session SET is forbidden.';

create function identity.install_migrator_force_rls_policy(p_table regclass)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_nsp text;
  v_relname text;
  v_forced boolean;
  v_policy text;
begin
  select n.nspname, c.relname, c.relforcerowsecurity
    into v_nsp, v_relname, v_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.oid = p_table
    and c.relkind = 'r';

  if v_nsp is null or v_relname is null then
    raise exception 'migrator FORCE RLS policy requires a table'
      using errcode = '22023';
  end if;
  if v_nsp not in ('identity', 'commercial') then
    raise exception 'migrator FORCE RLS policy is only for identity/commercial tables'
      using errcode = '42501';
  end if;
  if v_forced is not true then
    raise exception 'FORCE RLS required before migrator owner policy on %.%', v_nsp, v_relname
      using errcode = '55000';
  end if;

  v_policy := v_nsp || '_' || v_relname || '_migrator_all';

  if not exists (
    select 1
    from pg_policy p
    where p.polrelid = p_table
      and p.polname = v_policy
  ) then
    execute format(
      'create policy %I on %I.%I for all to migrator using (true) with check (true)',
      v_policy,
      v_nsp,
      v_relname
    );
  end if;
end;
$$;

comment on function identity.install_migrator_force_rls_policy(regclass) is
  'Installs the table-scoped migrator FOR ALL policy required under FORCE RLS (D-010).';

create or replace function identity.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function identity.reject_identity_key_change()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'identity primary keys are immutable'
      using errcode = '23001';
  end if;
  return new;
end;
$$;

create or replace function commercial.reject_tenant_key_change()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id then
    raise exception 'tenant keys are immutable'
      using errcode = '23001';
  end if;
  return new;
end;
$$;

create table identity.app_users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  auth_user_id uuid not null,
  normalized_email text not null,
  display_email text not null,
  status text not null,
  last_authenticated_at timestamptz not null,
  deletion_requested_at timestamptz,
  terms_version text not null,
  privacy_version text not null,
  constraint app_users_auth_user_id_key unique (auth_user_id),
  constraint app_users_normalized_email_key unique (normalized_email),
  constraint app_users_status_check check (status in ('active', 'suspended', 'deleting', 'deleted')),
  constraint app_users_version_check check (version >= 1)
);

create table identity.action_grants (
  id uuid primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null,
  action text not null,
  token_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint action_grants_user_fk foreign key (user_id) references identity.app_users (id) on delete restrict,
  constraint action_grants_action_check check (action in ('export', 'deletion', 'email_change', 'replace_link')),
  constraint action_grants_token_hash_key unique (token_hash),
  constraint action_grants_token_hash_len check (octet_length(token_hash) = 32)
);

create table commercial.workspaces (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  owner_user_id uuid not null,
  business_name text not null,
  legal_name text not null,
  contact_name text not null,
  contact_email text not null,
  contact_phone text,
  address_json jsonb not null default '{}'::jsonb,
  timezone text not null,
  currency text not null default 'USD',
  trade text not null,
  logo_asset_id uuid,
  default_tax_bp integer not null default 0,
  default_due_days integer not null default 14,
  default_terms text not null,
  constraint workspaces_pkey primary key (id),
  constraint workspaces_workspace_id_key unique (workspace_id),
  constraint workspaces_tenant_id_key unique (workspace_id, id),
  constraint workspaces_id_matches_workspace check (workspace_id = id),
  constraint workspaces_owner_user_id_key unique (owner_user_id),
  constraint workspaces_owner_fk foreign key (owner_user_id) references identity.app_users (id) on delete restrict,
  constraint workspaces_currency_check check (currency = 'USD'),
  constraint workspaces_trade_check check (trade in ('handyman', 'other')),
  constraint workspaces_tax_bp_check check (default_tax_bp >= 0 and default_tax_bp <= 2500),
  constraint workspaces_due_days_check check (default_due_days >= 0 and default_due_days <= 365),
  constraint workspaces_version_check check (version >= 1)
);

create table commercial.memberships (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  user_id uuid not null,
  role text not null,
  status text not null,
  constraint memberships_pkey primary key (id),
  constraint memberships_tenant_id_key unique (workspace_id, id),
  constraint memberships_workspace_user_key unique (workspace_id, user_id),
  constraint memberships_user_id_key unique (user_id),
  constraint memberships_workspace_fk foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint memberships_user_fk foreign key (user_id) references identity.app_users (id) on delete restrict,
  constraint memberships_role_check check (role = 'owner'),
  constraint memberships_status_check check (status = 'active'),
  constraint memberships_version_check check (version >= 1)
);

create unique index memberships_one_active_owner
  on commercial.memberships (workspace_id)
  where role = 'owner' and status = 'active';

create table commercial.assets (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  job_id uuid,
  draft_id uuid,
  visibility text not null,
  bucket_key text not null,
  upload_state text not null,
  media_type text not null,
  source_size integer not null,
  stored_size integer,
  width integer,
  height integer,
  sha256 bytea,
  rejection_code text,
  uploaded_by uuid not null,
  constraint assets_pkey primary key (id),
  constraint assets_tenant_id_key unique (workspace_id, id),
  constraint assets_workspace_fk foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint assets_uploaded_by_fk foreign key (uploaded_by) references identity.app_users (id) on delete restrict,
  constraint assets_visibility_check check (visibility in ('internal', 'customer')),
  constraint assets_upload_state_check check (upload_state in ('pending', 'processing', 'ready', 'rejected')),
  constraint assets_source_size_check check (source_size >= 0),
  constraint assets_version_check check (version >= 1)
);

alter table commercial.workspaces
  add constraint workspaces_logo_asset_fk
  foreign key (workspace_id, logo_asset_id)
  references commercial.assets (workspace_id, id)
  on delete restrict;

create index workspaces_list_idx
  on commercial.workspaces (updated_at desc, id desc);

create index memberships_list_idx
  on commercial.memberships (workspace_id, updated_at desc, id desc);

create index assets_list_idx
  on commercial.assets (workspace_id, updated_at desc, id desc);

create index action_grants_user_action_idx
  on identity.action_grants (user_id, action, expires_at);

create trigger app_users_touch_updated_at
  before update on identity.app_users
  for each row execute function identity.touch_updated_at();

create trigger app_users_reject_key_change
  before update on identity.app_users
  for each row execute function identity.reject_identity_key_change();

create trigger workspaces_touch_updated_at
  before update on commercial.workspaces
  for each row execute function identity.touch_updated_at();

create trigger workspaces_reject_key_change
  before update on commercial.workspaces
  for each row execute function commercial.reject_tenant_key_change();

create trigger memberships_touch_updated_at
  before update on commercial.memberships
  for each row execute function identity.touch_updated_at();

create trigger memberships_reject_key_change
  before update on commercial.memberships
  for each row execute function commercial.reject_tenant_key_change();

create trigger assets_touch_updated_at
  before update on commercial.assets
  for each row execute function identity.touch_updated_at();

create trigger assets_reject_key_change
  before update on commercial.assets
  for each row execute function commercial.reject_tenant_key_change();

alter table identity.app_users enable row level security;
alter table identity.app_users force row level security;
select identity.install_migrator_force_rls_policy('identity.app_users');
alter table identity.action_grants enable row level security;
alter table identity.action_grants force row level security;
select identity.install_migrator_force_rls_policy('identity.action_grants');
alter table commercial.workspaces enable row level security;
alter table commercial.workspaces force row level security;
select identity.install_migrator_force_rls_policy('commercial.workspaces');
alter table commercial.memberships enable row level security;
alter table commercial.memberships force row level security;
select identity.install_migrator_force_rls_policy('commercial.memberships');
alter table commercial.assets enable row level security;
alter table commercial.assets force row level security;
select identity.install_migrator_force_rls_policy('commercial.assets');

create policy app_users_select on identity.app_users
  for select to api_app
  using (id = identity.current_actor_id());

create policy app_users_insert on identity.app_users
  for insert to api_app
  with check (id = identity.current_actor_id());

create policy app_users_update on identity.app_users
  for update to api_app
  using (id = identity.current_actor_id())
  with check (id = identity.current_actor_id());

create policy action_grants_select on identity.action_grants
  for select to api_app
  using (user_id = identity.current_actor_id());

create policy action_grants_insert on identity.action_grants
  for insert to api_app
  with check (user_id = identity.current_actor_id());

create policy action_grants_update on identity.action_grants
  for update to api_app
  using (user_id = identity.current_actor_id())
  with check (user_id = identity.current_actor_id());

create policy memberships_select on commercial.memberships
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and user_id = identity.current_actor_id()
    and status = 'active'
  );

create policy memberships_insert on commercial.memberships
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and user_id = identity.current_actor_id()
    and role = 'owner'
    and status = 'active'
  );

create policy memberships_update on commercial.memberships
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and user_id = identity.current_actor_id()
  )
  with check (
    workspace_id = identity.current_workspace_id()
    and user_id = identity.current_actor_id()
    and role = 'owner'
    and status = 'active'
  );

create policy workspaces_select on commercial.workspaces
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1
      from commercial.memberships m
      where m.workspace_id = workspaces.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy workspaces_insert on commercial.workspaces
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and id = identity.current_workspace_id()
    and owner_user_id = identity.current_actor_id()
  );

create policy workspaces_update on commercial.workspaces
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1
      from commercial.memberships m
      where m.workspace_id = workspaces.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (
    workspace_id = identity.current_workspace_id()
    and id = identity.current_workspace_id()
    and owner_user_id = identity.current_actor_id()
  );

create policy assets_select on commercial.assets
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1
      from commercial.memberships m
      where m.workspace_id = assets.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy assets_insert on commercial.assets
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and uploaded_by = identity.current_actor_id()
    and exists (
      select 1
      from commercial.memberships m
      where m.workspace_id = assets.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy assets_update on commercial.assets
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1
      from commercial.memberships m
      where m.workspace_id = assets.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (
    workspace_id = identity.current_workspace_id()
    and uploaded_by = identity.current_actor_id()
  );

create policy assets_delete on commercial.assets
  for delete to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1
      from commercial.memberships m
      where m.workspace_id = assets.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

revoke all on function identity.current_workspace_id() from public;
revoke all on function identity.current_actor_id() from public;
revoke all on function identity.set_local_tenant_context(uuid, uuid) from public;
revoke all on function identity.touch_updated_at() from public;
revoke all on function identity.reject_identity_key_change() from public;
revoke all on function commercial.reject_tenant_key_change() from public;
revoke all on function identity.install_migrator_force_rls_policy(regclass) from public;
revoke all on function identity.install_migrator_force_rls_policy(regclass)
  from api_app, worker_app, purge_app, anon, authenticated;

grant execute on function identity.current_workspace_id() to api_app, worker_app, purge_app;
grant execute on function identity.current_actor_id() to api_app, worker_app, purge_app;
grant execute on function identity.set_local_tenant_context(uuid, uuid) to api_app, worker_app;

grant select, insert, update on identity.app_users to api_app;
grant select, insert, update on identity.action_grants to api_app;
grant select, insert, update on commercial.workspaces to api_app;
grant select, insert, update on commercial.memberships to api_app;
grant select, insert, update, delete on commercial.assets to api_app;

revoke all on identity.app_users from public, anon, authenticated, worker_app, purge_app;
revoke all on identity.action_grants from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.workspaces from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.memberships from public, anon, authenticated, worker_app, purge_app;
revoke all on commercial.assets from public, anon, authenticated, worker_app, purge_app;

-- D-011: restore the bootstrap session role. Supabase CLI records
-- schema_migrations as that role after this file returns; migrator has no catalog access.
reset role;
