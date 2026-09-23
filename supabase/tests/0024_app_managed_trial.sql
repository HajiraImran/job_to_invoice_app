-- SUB03 trial grants and RESET ROLE.

select
  has_function_privilege(
    'api_app',
    'commercial.start_trial(uuid, uuid, text, uuid, boolean)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.subscription_state(uuid)',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.claim_trial_ending_email()',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.start_trial(uuid, uuid, text, uuid, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.subscription_state(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'api_app',
    'commercial.claim_trial_ending_email()',
    'execute'
  )
  and not has_function_privilege(
    'purge_app',
    'commercial.allocate_first_publication_slot(uuid)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
