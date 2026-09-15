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

mc admin policy create local documents-worker /policies/worker.json >/dev/null 2>&1 || true
mc admin policy create local documents-api /policies/api.json >/dev/null 2>&1 || true
mc admin user add local "${STORAGE_WORKER_ACCESS_KEY_ID}" "${STORAGE_WORKER_SECRET_ACCESS_KEY}" >/dev/null 2>&1 || true
mc admin user add local "${STORAGE_API_ACCESS_KEY_ID}" "${STORAGE_API_SECRET_ACCESS_KEY}" >/dev/null 2>&1 || true
mc admin policy attach local documents-worker --user "${STORAGE_WORKER_ACCESS_KEY_ID}" >/dev/null 2>&1 || true
mc admin policy attach local documents-api --user "${STORAGE_API_ACCESS_KEY_ID}" >/dev/null 2>&1 || true
