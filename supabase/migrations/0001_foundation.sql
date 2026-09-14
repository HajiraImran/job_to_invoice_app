-- Foundation only. No commercial tables (Stage 1).
-- Roles are documented in docs/DATABASE.md and must be created by the owner-controlled project.

create schema if not exists commercial;

comment on schema commercial is
  'Private commercial schema. Client grants remain revoked. Product tables are not created in foundation.';
