-- Quote publication tables are api_app readable. Client and worker roles have no DML.
-- Publish and preview run only through migrator-owned SECURITY DEFINER functions.

select
  has_table_privilege('api_app', 'commercial.documents', 'select')
  and has_table_privilege('api_app', 'commercial.document_lines', 'select')
  and has_table_privilege('api_app', 'commercial.artifacts', 'select')
  and not has_table_privilege('api_app', 'commercial.documents', 'insert')
  and not has_table_privilege('api_app', 'commercial.document_counters', 'select')
  and not has_table_privilege('api_app', 'commercial.outbox_tasks', 'select')
  and has_function_privilege(
    'api_app',
    'commercial.freeze_quote_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid)',
    'execute'
  )
  and not has_table_privilege('anon', 'commercial.documents', 'select')
  and not has_table_privilege('authenticated', 'commercial.documents', 'select')
  and not has_table_privilege('worker_app', 'commercial.documents', 'select')
  and not has_table_privilege('purge_app', 'commercial.documents', 'select')
  and not has_table_privilege('worker_app', 'commercial.outbox_tasks', 'select')
  and not has_function_privilege(
    'anon',
    'commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid)',
    'execute'
  )
  as ok;
