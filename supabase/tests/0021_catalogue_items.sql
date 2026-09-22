-- Catalogue item grants and RESET ROLE (CAT01 / S20).

select
  has_table_privilege('api_app', 'commercial.catalogue_items', 'select')
  and has_table_privilege('api_app', 'commercial.catalogue_items', 'insert')
  and has_table_privilege('api_app', 'commercial.catalogue_items', 'update')
  and has_function_privilege(
    'api_app',
    'commercial.create_catalogue_item(uuid, uuid, text, uuid, uuid, text, text, text, numeric, bigint, bigint, integer)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.save_catalogue_item(uuid, uuid, integer, text, text, text, numeric, bigint, bigint, integer)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.archive_catalogue_item(uuid, uuid, integer, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'api_app',
    'commercial.insert_default_catalogue_items(uuid)',
    'execute'
  )
  and not has_table_privilege('anon', 'commercial.catalogue_items', 'select')
  and not has_table_privilege('authenticated', 'commercial.catalogue_items', 'select')
  and not has_table_privilege('worker_app', 'commercial.catalogue_items', 'select')
  and not has_table_privilege('purge_app', 'commercial.catalogue_items', 'select')
  and not has_function_privilege(
    'anon',
    'commercial.create_catalogue_item(uuid, uuid, text, uuid, uuid, text, text, text, numeric, bigint, bigint, integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.save_catalogue_item(uuid, uuid, integer, text, text, text, numeric, bigint, bigint, integer)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.archive_catalogue_item(uuid, uuid, integer, boolean)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
