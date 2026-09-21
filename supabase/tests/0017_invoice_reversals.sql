-- Ledger reversal grants and RESET ROLE (S16 / BIL07).

select
  has_function_privilege(
    'api_app',
    'commercial.record_invoice_reversal(uuid, uuid, text, uuid, uuid, text)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.record_invoice_reversal(uuid, uuid, text, uuid, uuid, text)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.record_invoice_reversal(uuid, uuid, text, uuid, uuid, text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.record_invoice_reversal(uuid, uuid, text, uuid, uuid, text)',
    'execute'
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'commercial' and indexname = 'ledger_entries_reverses_once'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
