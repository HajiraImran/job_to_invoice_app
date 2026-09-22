-- Owner catalogue items (CAT01 / S20). Copy-on-use defaults only; never live-linked.
-- Forward-only. Do not edit 0001–0019.

set role migrator;

create table commercial.catalogue_items (
  workspace_id uuid not null,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  description text not null,
  unit text not null,
  custom_unit_label text,
  default_quantity numeric(12, 3) not null,
  unit_price_cents bigint not null,
  discount_cents bigint not null default 0,
  tax_bp integer not null default 0,
  archived_at timestamptz,
  constraint catalogue_items_pkey primary key (id),
  constraint catalogue_items_tenant_id_key unique (workspace_id, id),
  constraint catalogue_items_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint catalogue_items_version_check check (version >= 1),
  constraint catalogue_items_description_len check (char_length(btrim(description)) between 1 and 500),
  constraint catalogue_items_unit_check check (
    unit in ('item', 'hour', 'day', 'square_foot', 'linear_foot', 'custom')
  ),
  constraint catalogue_items_custom_unit_check check (
    (unit = 'custom' and char_length(btrim(coalesce(custom_unit_label, ''))) between 1 and 20)
    or (unit <> 'custom' and custom_unit_label is null)
  ),
  constraint catalogue_items_quantity_check check (
    default_quantity > 0
    and default_quantity < 1000000
  ),
  constraint catalogue_items_price_check check (
    unit_price_cents >= 0
    and unit_price_cents <= 99999999
  ),
  constraint catalogue_items_discount_check check (discount_cents >= 0),
  constraint catalogue_items_tax_check check (tax_bp between 0 and 2500)
);

create index catalogue_items_list_idx
  on commercial.catalogue_items (workspace_id, updated_at desc, id desc);

create index catalogue_items_description_idx
  on commercial.catalogue_items (workspace_id, lower(description));

create trigger catalogue_items_touch_updated_at
  before update on commercial.catalogue_items
  for each row execute function identity.touch_updated_at();

create trigger catalogue_items_reject_key_change
  before update on commercial.catalogue_items
  for each row execute function commercial.reject_tenant_key_change();

alter table commercial.catalogue_items enable row level security;
alter table commercial.catalogue_items force row level security;
select identity.install_migrator_force_rls_policy('commercial.catalogue_items');

create policy catalogue_items_select on commercial.catalogue_items
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = catalogue_items.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy catalogue_items_insert on commercial.catalogue_items
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = catalogue_items.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy catalogue_items_update on commercial.catalogue_items
  for update to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = catalogue_items.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  )
  with check (workspace_id = identity.current_workspace_id());

create or replace function commercial.insert_default_catalogue_items(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = commercial, pg_temp
as $$
begin
  if p_workspace_id is null then
    raise exception 'invalid workspace' using errcode = '22023';
  end if;
  if exists (
    select 1 from commercial.catalogue_items i
    where i.workspace_id = p_workspace_id
  ) then
    return;
  end if;

  insert into commercial.catalogue_items (
    workspace_id, id, description, unit, default_quantity,
    unit_price_cents, discount_cents, tax_bp
  ) values
    (p_workspace_id, gen_random_uuid(), 'Labour hour', 'hour', 1, 0, 0, 0),
    (p_workspace_id, gen_random_uuid(), 'Materials', 'item', 1, 0, 0, 0),
    (p_workspace_id, gen_random_uuid(), 'Small repair', 'item', 1, 0, 0, 0),
    (p_workspace_id, gen_random_uuid(), 'Installation', 'item', 1, 0, 0, 0),
    (p_workspace_id, gen_random_uuid(), 'Disposal', 'item', 1, 0, 0, 0);
end;
$$;

create or replace function commercial.seed_catalogue_items_on_setup()
returns trigger
language plpgsql
security definer
set search_path = commercial, pg_temp
as $$
begin
  perform commercial.insert_default_catalogue_items(new.workspace_id);
  return new;
end;
$$;

create trigger workspaces_seed_catalogue_items
  after update of setup_completed_at on commercial.workspaces
  for each row
  when (old.setup_completed_at is null and new.setup_completed_at is not null)
  execute function commercial.seed_catalogue_items_on_setup();

create or replace function commercial.create_catalogue_item(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_item_id uuid,
  p_description text,
  p_unit text,
  p_custom_unit_label text,
  p_default_quantity numeric,
  p_unit_price_cents bigint,
  p_discount_cents bigint,
  p_tax_bp integer
)
returns table (
  id uuid,
  workspace_id uuid,
  description text,
  unit text,
  custom_unit_label text,
  default_quantity numeric,
  unit_price_cents bigint,
  discount_cents bigint,
  tax_bp integer,
  archived_at timestamptz,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_status text;
  v_ws uuid;
  v_setup timestamptz;
  v_existing commercial.idempotency_records%rowtype;
  v_item commercial.catalogue_items%rowtype;
  v_payload jsonb;
  v_label text;
begin
  if p_actor_id is null
    or p_idempotency_key is null
    or p_request_hash is null
    or p_request_id is null
    or p_item_id is null
    or p_description is null
    or p_unit is null
    or p_default_quantity is null
    or p_unit_price_cents is null
    or p_discount_cents is null
    or p_tax_bp is null then
    raise exception 'invalid catalogue item' using errcode = '22023';
  end if;

  v_label := nullif(btrim(coalesce(p_custom_unit_label, '')), '');

  select u.status into v_status
  from identity.app_users u
  where u.id = p_actor_id
  for update;
  if v_status is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select w.workspace_id, w.setup_completed_at
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
          v_existing.response_json->>'description',
          v_existing.response_json->>'unit',
          v_existing.response_json->>'custom_unit_label',
          (v_existing.response_json->>'default_quantity')::numeric,
          (v_existing.response_json->>'unit_price_cents')::bigint,
          (v_existing.response_json->>'discount_cents')::bigint,
          (v_existing.response_json->>'tax_bp')::integer,
          (v_existing.response_json->>'archived_at')::timestamptz,
          (v_existing.response_json->>'version')::integer,
          (v_existing.response_json->>'created_at')::timestamptz,
          (v_existing.response_json->>'updated_at')::timestamptz,
          true;
      return;
    end if;
  end if;

  insert into commercial.catalogue_items (
    workspace_id, id, description, unit, custom_unit_label, default_quantity,
    unit_price_cents, discount_cents, tax_bp
  ) values (
    v_ws, p_item_id, btrim(p_description), p_unit, v_label, p_default_quantity,
    p_unit_price_cents, p_discount_cents, p_tax_bp
  )
  returning * into v_item;

  insert into commercial.audit_events (
    workspace_id, actor_type, actor_id, action, entity_type, entity_id,
    request_id, after_version, safe_metadata_json
  ) values (
    v_ws, 'owner', p_actor_id, 'catalogue_item_created', 'catalogue_item', p_item_id,
    p_request_id, v_item.version, '{}'::jsonb
  );

  v_payload := jsonb_build_object(
    'id', v_item.id,
    'workspace_id', v_item.workspace_id,
    'description', v_item.description,
    'unit', v_item.unit,
    'custom_unit_label', v_item.custom_unit_label,
    'default_quantity', v_item.default_quantity,
    'unit_price_cents', v_item.unit_price_cents,
    'discount_cents', v_item.discount_cents,
    'tax_bp', v_item.tax_bp,
    'archived_at', v_item.archived_at,
    'version', v_item.version,
    'created_at', v_item.created_at,
    'updated_at', v_item.updated_at
  );

  if v_existing.id is null then
    insert into commercial.idempotency_records (
      workspace_id, actor_scope, key, route, request_hash, operation_id,
      status, response_code, response_json, expires_at, permanence
    ) values (
      v_ws, p_actor_id, p_idempotency_key, '/v1/items', p_request_hash, gen_random_uuid(),
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
      v_item.id,
      v_item.workspace_id,
      v_item.description,
      v_item.unit,
      v_item.custom_unit_label,
      v_item.default_quantity,
      v_item.unit_price_cents,
      v_item.discount_cents,
      v_item.tax_bp,
      v_item.archived_at,
      v_item.version,
      v_item.created_at,
      v_item.updated_at,
      false;
end;
$$;

create or replace function commercial.save_catalogue_item(
  p_actor_id uuid,
  p_item_id uuid,
  p_version integer,
  p_description text,
  p_unit text,
  p_custom_unit_label text,
  p_default_quantity numeric,
  p_unit_price_cents bigint,
  p_discount_cents bigint,
  p_tax_bp integer
)
returns table (
  id uuid,
  workspace_id uuid,
  description text,
  unit text,
  custom_unit_label text,
  default_quantity numeric,
  unit_price_cents bigint,
  discount_cents bigint,
  tax_bp integer,
  archived_at timestamptz,
  version integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_item commercial.catalogue_items%rowtype;
  v_label text;
begin
  if p_actor_id is null
    or p_item_id is null
    or p_version is null
    or p_description is null
    or p_unit is null
    or p_default_quantity is null
    or p_unit_price_cents is null
    or p_discount_cents is null
    or p_tax_bp is null then
    raise exception 'invalid catalogue item' using errcode = '22023';
  end if;

  v_label := nullif(btrim(coalesce(p_custom_unit_label, '')), '');

  select w.workspace_id into v_ws
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select * into v_item
  from commercial.catalogue_items i
  where i.workspace_id = v_ws
    and i.id = p_item_id
  for update;
  if not found then
    raise exception 'ITEM_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_item.version is distinct from p_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update commercial.catalogue_items i
    set description = btrim(p_description),
        unit = p_unit,
        custom_unit_label = v_label,
        default_quantity = p_default_quantity,
        unit_price_cents = p_unit_price_cents,
        discount_cents = p_discount_cents,
        tax_bp = p_tax_bp,
        version = v_item.version + 1
    where i.workspace_id = v_ws
      and i.id = p_item_id
  returning * into v_item;

  return query
    select
      v_item.id,
      v_item.workspace_id,
      v_item.description,
      v_item.unit,
      v_item.custom_unit_label,
      v_item.default_quantity,
      v_item.unit_price_cents,
      v_item.discount_cents,
      v_item.tax_bp,
      v_item.archived_at,
      v_item.version,
      v_item.created_at,
      v_item.updated_at;
end;
$$;

create or replace function commercial.archive_catalogue_item(
  p_actor_id uuid,
  p_item_id uuid,
  p_version integer,
  p_archived boolean
)
returns table (
  id uuid,
  workspace_id uuid,
  description text,
  unit text,
  custom_unit_label text,
  default_quantity numeric,
  unit_price_cents bigint,
  discount_cents bigint,
  tax_bp integer,
  archived_at timestamptz,
  version integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = commercial, identity, pg_temp
as $$
#variable_conflict use_column
declare
  v_ws uuid;
  v_item commercial.catalogue_items%rowtype;
begin
  if p_actor_id is null or p_item_id is null or p_version is null or p_archived is null then
    raise exception 'invalid catalogue item' using errcode = '22023';
  end if;

  select w.workspace_id into v_ws
  from commercial.workspaces w
  where w.owner_user_id = p_actor_id
  for update;
  if v_ws is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select * into v_item
  from commercial.catalogue_items i
  where i.workspace_id = v_ws
    and i.id = p_item_id
  for update;
  if not found then
    raise exception 'ITEM_NOT_FOUND' using errcode = 'P0005';
  end if;
  if v_item.version is distinct from p_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update commercial.catalogue_items i
    set archived_at = case when p_archived then coalesce(v_item.archived_at, now()) else null end,
        version = v_item.version + 1
    where i.workspace_id = v_ws
      and i.id = p_item_id
  returning * into v_item;

  return query
    select
      v_item.id,
      v_item.workspace_id,
      v_item.description,
      v_item.unit,
      v_item.custom_unit_label,
      v_item.default_quantity,
      v_item.unit_price_cents,
      v_item.discount_cents,
      v_item.tax_bp,
      v_item.archived_at,
      v_item.version,
      v_item.created_at,
      v_item.updated_at;
end;
$$;

comment on table commercial.catalogue_items is
  'Workspace catalogue defaults. Copied into draft lines; never live-linked to issued documents.';
comment on function commercial.insert_default_catalogue_items(uuid) is
  'Seeds five zero-price CAT01 examples once per workspace.';
comment on function commercial.create_catalogue_item(uuid, uuid, text, uuid, uuid, text, text, text, numeric, bigint, bigint, integer) is
  'Creates a catalogue item. Derives workspace from owner identity.';

revoke all on function commercial.insert_default_catalogue_items(uuid) from public;
revoke all on function commercial.insert_default_catalogue_items(uuid)
  from api_app, worker_app, purge_app, anon, authenticated;
revoke all on function commercial.seed_catalogue_items_on_setup() from public;
revoke all on function commercial.seed_catalogue_items_on_setup()
  from api_app, worker_app, purge_app, anon, authenticated;

revoke all on function commercial.create_catalogue_item(uuid, uuid, text, uuid, uuid, text, text, text, numeric, bigint, bigint, integer) from public;
grant execute on function commercial.create_catalogue_item(uuid, uuid, text, uuid, uuid, text, text, text, numeric, bigint, bigint, integer) to api_app;
revoke all on function commercial.create_catalogue_item(uuid, uuid, text, uuid, uuid, text, text, text, numeric, bigint, bigint, integer)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.save_catalogue_item(uuid, uuid, integer, text, text, text, numeric, bigint, bigint, integer) from public;
grant execute on function commercial.save_catalogue_item(uuid, uuid, integer, text, text, text, numeric, bigint, bigint, integer) to api_app;
revoke all on function commercial.save_catalogue_item(uuid, uuid, integer, text, text, text, numeric, bigint, bigint, integer)
  from worker_app, purge_app, anon, authenticated;

revoke all on function commercial.archive_catalogue_item(uuid, uuid, integer, boolean) from public;
grant execute on function commercial.archive_catalogue_item(uuid, uuid, integer, boolean) to api_app;
revoke all on function commercial.archive_catalogue_item(uuid, uuid, integer, boolean)
  from worker_app, purge_app, anon, authenticated;

grant select, insert, update on commercial.catalogue_items to api_app;
revoke all on commercial.catalogue_items from public, anon, authenticated, worker_app, purge_app;

insert into commercial.catalogue_items (
  workspace_id, id, description, unit, default_quantity,
  unit_price_cents, discount_cents, tax_bp
)
select
  w.workspace_id,
  gen_random_uuid(),
  seed.description,
  seed.unit,
  1,
  0,
  0,
  0
from commercial.workspaces w
cross join (
  values
    ('Labour hour', 'hour'),
    ('Materials', 'item'),
    ('Small repair', 'item'),
    ('Installation', 'item'),
    ('Disposal', 'item')
) as seed(description, unit)
where w.setup_completed_at is not null
  and not exists (
    select 1 from commercial.catalogue_items i
    where i.workspace_id = w.workspace_id
  );

reset role;
