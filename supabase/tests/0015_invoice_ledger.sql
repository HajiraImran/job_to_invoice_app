-- Invoice ledger grants, append-only tables, and RESET ROLE (TX04 payment/refund).

select
  has_function_privilege(
    'api_app',
    'commercial.record_invoice_payment(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text, boolean)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.record_invoice_refund(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.record_invoice_payment(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.record_invoice_refund(uuid, uuid, text, uuid, uuid, bigint, date, text, text, text)',
    'execute'
  )
  and has_table_privilege('api_app', 'commercial.ledger_entries', 'select')
  and not has_table_privilege('api_app', 'commercial.ledger_entries', 'insert')
  and not has_table_privilege('api_app', 'commercial.ledger_refund_allocations', 'insert')
  and has_table_privilege('api_app', 'commercial.ledger_refund_allocations', 'select')
  and exists (
    select 1 from pg_indexes
    where schemaname = 'commercial' and indexname = 'ledger_entries_operation_id_key'
  )
  and exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'commercial'
      and c.relname = 'ledger_entries'
      and c.relrowsecurity
      and c.relforcerowsecurity
  )
  and exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'commercial'
      and c.relname = 'ledger_refund_allocations'
      and c.relrowsecurity
      and c.relforcerowsecurity
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
