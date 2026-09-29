#!/bin/sh
set -eu
# Do not enable xtrace. Credentials stay in process environment only.

mc alias set local http://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null
mc mb --ignore-existing local/job-to-invoice-documents-development >/dev/null
mc anonymous set none local/job-to-invoice-documents-development >/dev/null

anon="$(mc anonymous get local/job-to-invoice-documents-development)"
case "${anon}" in
  *public*|*download*)
    echo "private bucket policy is required" >&2
    exit 1
    ;;
esac

# This mc release has no policy update. Replace an existing policy by
# detaching it, removing it, and creating it again from the mounted JSON.
# Command output stays discarded so credentials and policy documents are not printed.
apply_policy() {
  name="$1"
  file="$2"
  user="$3"
  if mc admin policy info "local" "${name}" >/dev/null 2>&1; then
    mc admin policy detach "local" "${name}" --user "${user}" >/dev/null 2>&1 || true
    mc admin policy remove "local" "${name}" >/dev/null
  fi
  mc admin policy create "local" "${name}" "${file}" >/dev/null
}

apply_policy documents-worker /policies/worker.json "${STORAGE_WORKER_ACCESS_KEY_ID}"
apply_policy documents-api /policies/api.json "${STORAGE_API_ACCESS_KEY_ID}"
mc admin user add local "${STORAGE_WORKER_ACCESS_KEY_ID}" "${STORAGE_WORKER_SECRET_ACCESS_KEY}" >/dev/null 2>&1 || true
mc admin user add local "${STORAGE_API_ACCESS_KEY_ID}" "${STORAGE_API_SECRET_ACCESS_KEY}" >/dev/null 2>&1 || true
mc admin policy attach local documents-worker --user "${STORAGE_WORKER_ACCESS_KEY_ID}" >/dev/null 2>&1 || true
mc admin policy attach local documents-api --user "${STORAGE_API_ACCESS_KEY_ID}" >/dev/null 2>&1 || true
