-- Quote drafts are api_app tenant tables. Client and worker roles have no DML.

select
  has_table_privilege('api_app', 'commercial.document_drafts', 'select')
  and has_table_privilege('api_app', 'commercial.document_drafts', 'insert')
  and has_table_privilege('api_app', 'commercial.document_drafts', 'update')
  and has_function_privilege(
    'api_app',
    'commercial.open_quote_draft(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.save_quote_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)',
    'execute'
  )
  and not has_table_privilege('anon', 'commercial.document_drafts', 'select')
  and not has_table_privilege('authenticated', 'commercial.document_drafts', 'select')
  and not has_table_privilege('worker_app', 'commercial.document_drafts', 'select')
  and not has_table_privilege('purge_app', 'commercial.document_drafts', 'select')
  and not has_function_privilege(
    'anon',
    'commercial.open_quote_draft(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.save_quote_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)',
    'execute'
  )
  as ok;
