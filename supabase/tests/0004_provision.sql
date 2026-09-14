-- Owner provisioning is executable by api_app only.

select
  has_function_privilege('api_app', 'identity.provision_owner(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'identity.provision_owner(uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'identity.provision_owner(uuid, text, text)', 'execute')
  and not has_function_privilege('worker_app', 'identity.provision_owner(uuid, text, text)', 'execute')
  and not has_function_privilege('purge_app', 'identity.provision_owner(uuid, text, text)', 'execute')
  as ok;
