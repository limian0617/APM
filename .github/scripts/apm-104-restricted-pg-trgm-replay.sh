#!/usr/bin/env bash
set -Eeuo pipefail

host="${PGHOST:?PGHOST is required}"
port="${PGPORT:?PGPORT is required}"
owner_user="${PGOWNER_USER:?PGOWNER_USER is required}"
owner_password="${PGOWNER_PASSWORD:?PGOWNER_PASSWORD is required}"
suffix="${GITHUB_RUN_ID:-local}-$$"
normal_db="apm104_normal_${suffix}"
noext_db="apm104_noext_${suffix}"
noext_user="apm104_noext_${suffix}"
noext_password="$(openssl rand -hex 24)"
root="$(mktemp -d)"
url_password="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$owner_password")"
owner_url="postgresql://${owner_user}:${url_password}@${host}:${port}/${noext_db}"
noext_url_password="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$noext_password")"
noext_url="postgresql://${noext_user}:${noext_url_password}@${host}:${port}/${noext_db}"

cleanup() {
  set +e
  PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$normal_db','$noext_db') AND pid <> pg_backend_pid()"
  PGPASSWORD="$owner_password" dropdb -h "$host" -p "$port" -U "$owner_user" --if-exists "$normal_db"
  PGPASSWORD="$owner_password" dropdb -h "$host" -p "$port" -U "$owner_user" --if-exists "$noext_db"
  if PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname='$noext_user'" | grep -qx 1; then
    PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -c "REVOKE \"$noext_user\" FROM \"$owner_user\"; DROP ROLE \"$noext_user\""
  fi
  rm -rf "$root"
}
trap cleanup EXIT

copy_until_apm054() {
  local found=0
  mkdir -p "$root/prisma/migrations"
  cp prisma/schema.prisma "$root/prisma/schema.prisma"
  for migration in prisma/migrations/*; do
    name="$(basename "$migration")"
    cp -R "$migration" "$root/prisma/migrations/$name"
    if [ "$name" = 20260811040000_apm_054_project_archives ]; then
      found=1
      break
    fi
  done
  [ "$found" -eq 1 ] || { echo 'APM-054 migration was not found' >&2; exit 1; }
}
copy_until_apm054

PGPASSWORD="$owner_password" createdb -h "$host" -p "$port" -U "$owner_user" -O "$owner_user" "$normal_db"
PGPASSWORD="$owner_password" createdb -h "$host" -p "$port" -U "$owner_user" -O "$owner_user" "$noext_db"
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -Atqc "SELECT rolcreatedb AND rolcreaterole FROM pg_roles WHERE rolname=current_user" | grep -qx t
PGPASSWORD="$owner_password" DATABASE_URL="postgresql://${owner_user}:${url_password}@${host}:${port}/${normal_db}" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"
PGPASSWORD="$owner_password" DATABASE_URL="$owner_url" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"
cp -R prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy "$root/prisma/migrations/"
PGPASSWORD="$owner_password" DATABASE_URL="postgresql://${owner_user}:${url_password}@${host}:${port}/${normal_db}" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 <<SQL
REVOKE CREATE ON DATABASE "$noext_db" FROM PUBLIC;
CREATE ROLE "$noext_user" LOGIN PASSWORD '$noext_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT "$noext_user" TO "$owner_user";
GRANT CONNECT ON DATABASE "$noext_db" TO "$noext_user";
GRANT USAGE, CREATE ON SCHEMA public TO "$noext_user";
REVOKE CREATE ON DATABASE "$noext_db" FROM "$noext_user";
SQL

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -Atqc "SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit FROM pg_roles WHERE rolname='$noext_user'" | grep -qx t
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -Atqc "SELECT pg_has_role(current_user, '$noext_user', 'MEMBER')" | grep -qx t
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT d.datdba=(SELECT oid FROM pg_roles WHERE rolname='$owner_user') AND NOT has_database_privilege('$noext_user',current_database(),'CREATE') FROM pg_database d WHERE d.datname=current_database()" | grep -qx t

expected_legacy_objects="$(printf '%s\n' 'FUNCTION validate_project_archive_version_mutation' 'TABLE gate_check_snapshots' 'TABLE gate_submissions' 'TABLE issue_histories' 'TABLE project_archive_versions' 'TABLE project_gate_definitions' 'TABLE project_gate_instances' 'TABLE project_template_snapshots' 'TYPE ArchiveManifestSourceType')"
actual_legacy_objects="$(awk -f .github/scripts/apm-104-legacy-ddl-markers.awk prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql | sort -u)"
[ "$actual_legacy_objects" = "$expected_legacy_objects" ] || { printf 'legacy DDL allow-list mismatch\nexpected:\n%s\nactual:\n%s\n' "$expected_legacy_objects" "$actual_legacy_objects" >&2; exit 1; }

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 <<SQL
ALTER TABLE public.project_template_snapshots OWNER TO "$noext_user";
ALTER TABLE public.project_archive_versions OWNER TO "$noext_user";
ALTER TABLE public.project_gate_definitions OWNER TO "$noext_user";
ALTER TABLE public.project_gate_instances OWNER TO "$noext_user";
ALTER TABLE public.gate_check_snapshots OWNER TO "$noext_user";
ALTER TABLE public.gate_submissions OWNER TO "$noext_user";
ALTER TABLE public.issue_histories OWNER TO "$noext_user";
ALTER TABLE public._prisma_migrations OWNER TO "$noext_user";
ALTER TYPE public."ArchiveManifestSourceType" OWNER TO "$noext_user";
ALTER TYPE public."AuditAction" OWNER TO "$noext_user";
ALTER TYPE public."AuditObjectType" OWNER TO "$noext_user";
ALTER FUNCTION public.validate_project_archive_version_mutation() OWNER TO "$noext_user";
GRANT SELECT, REFERENCES ON ALL TABLES IN SCHEMA public TO "$noext_user";
GRANT INSERT ON TABLE public.permissions, public.role_permissions TO "$noext_user";
GRANT INSERT, UPDATE, DELETE ON public._prisma_migrations TO "$noext_user";
SQL

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='$noext_user' AND c.relname IN ('project_template_snapshots','project_archive_versions','project_gate_definitions','project_gate_instances','gate_check_snapshots','gate_submissions','issue_histories','_prisma_migrations')" | grep -qx '_prisma_migrations,gate_check_snapshots,gate_submissions,issue_histories,project_archive_versions,project_gate_definitions,project_gate_instances,project_template_snapshots'
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT r.rolname FROM pg_type t JOIN pg_roles r ON r.oid=t.typowner WHERE t.typname='ArchiveManifestSourceType'" | grep -qx "$noext_user"
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT string_agg(t.typname, ',' ORDER BY t.typname) FROM pg_type t JOIN pg_roles r ON r.oid=t.typowner WHERE r.rolname='$noext_user' AND t.typname IN ('AuditAction','AuditObjectType')" | grep -qx 'AuditAction,AuditObjectType'
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname='validate_project_archive_version_mutation' AND pg_get_function_identity_arguments(p.oid)=''" | grep -qx "$noext_user"
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT has_table_privilege('$noext_user', 'public.permissions', 'INSERT') AND has_table_privilege('$noext_user', 'public.role_permissions', 'INSERT') AND NOT has_table_privilege('$noext_user', 'public.permissions', 'UPDATE') AND NOT has_table_privilege('$noext_user', 'public.permissions', 'DELETE') AND NOT has_table_privilege('$noext_user', 'public.role_permissions', 'UPDATE') AND NOT has_table_privilege('$noext_user', 'public.role_permissions', 'DELETE')" | grep -qx t

PGPASSWORD="$noext_password" DATABASE_URL="$noext_url" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"

assert_scalar() {
  local expected="$1"
  local sql="$2"
  local actual
  actual="$(PGPASSWORD="$noext_password" psql -h "$host" -p "$port" -U "$noext_user" -d "$noext_db" -Atqc "$sql")"
  [ "$actual" = "$expected" ] || { echo "assertion failed: expected [$expected], got [$actual]" >&2; exit 1; }
}
assert_scalar t "SELECT to_regclass('public.knowledge_entries') IS NOT NULL"
assert_scalar t "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='ArchiveManifestSourceType' AND e.enumlabel='PROJECT_RETROSPECTIVE_VERSION')"
assert_scalar t "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='knowledge_entry_reviews_version_entry_project_fkey')"
assert_scalar t "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='knowledge_reuse_records_version_entry_fkey')"
assert_scalar t "SELECT to_regclass('public.knowledge_entry_versions_search_trgm_idx') IS NULL"
assert_scalar f "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm')"
assert_scalar t "WITH expected(permission_id, permission_code, role_id, scope) AS (VALUES ('permission-project-retrospective-read', 'PROJECT_RETROSPECTIVE_READ', 'role-project-manager', 'PROJECT'), ('permission-project-retrospective-read', 'PROJECT_RETROSPECTIVE_READ', 'role-department-lead', 'DEPARTMENT'), ('permission-project-retrospective-read', 'PROJECT_RETROSPECTIVE_READ', 'role-quality', 'PROJECT'), ('permission-project-retrospective-read', 'PROJECT_RETROSPECTIVE_READ', 'role-admin', 'ALL'), ('permission-project-retrospective-manage', 'PROJECT_RETROSPECTIVE_MANAGE', 'role-project-manager', 'PROJECT'), ('permission-project-retrospective-manage', 'PROJECT_RETROSPECTIVE_MANAGE', 'role-department-lead', 'DEPARTMENT'), ('permission-project-retrospective-manage', 'PROJECT_RETROSPECTIVE_MANAGE', 'role-admin', 'ALL'), ('permission-project-retrospective-review', 'PROJECT_RETROSPECTIVE_REVIEW', 'role-department-lead', 'DEPARTMENT'), ('permission-project-retrospective-review', 'PROJECT_RETROSPECTIVE_REVIEW', 'role-quality', 'PROJECT'), ('permission-project-retrospective-review', 'PROJECT_RETROSPECTIVE_REVIEW', 'role-admin', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-project-manager', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-department-lead', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-engineer', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-procurement', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-quality', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-technical-asset-maintainer', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-executive', 'ALL'), ('permission-knowledge-read', 'KNOWLEDGE_READ', 'role-admin', 'ALL'), ('permission-knowledge-review', 'KNOWLEDGE_REVIEW', 'role-department-lead', 'ALL'), ('permission-knowledge-review', 'KNOWLEDGE_REVIEW', 'role-quality', 'ALL'), ('permission-knowledge-review', 'KNOWLEDGE_REVIEW', 'role-admin', 'ALL'), ('permission-knowledge-reuse-confirm', 'KNOWLEDGE_REUSE_CONFIRM', 'role-project-manager', 'PROJECT'), ('permission-knowledge-reuse-confirm', 'KNOWLEDGE_REUSE_CONFIRM', 'role-quality', 'PROJECT'), ('permission-knowledge-reuse-confirm', 'KNOWLEDGE_REUSE_CONFIRM', 'role-admin', 'ALL')), actual AS (SELECT p.id AS permission_id, p.code AS permission_code, rp.role_id, rp.scope::text AS scope FROM public.permissions p JOIN public.role_permissions rp ON rp.permission_id = p.id WHERE p.id IN ('permission-project-retrospective-read', 'permission-project-retrospective-manage', 'permission-project-retrospective-review', 'permission-knowledge-read', 'permission-knowledge-review', 'permission-knowledge-reuse-confirm')) SELECT NOT EXISTS (SELECT 1 FROM expected FULL OUTER JOIN actual USING (permission_id, permission_code, role_id, scope) WHERE expected.permission_id IS NULL OR actual.permission_id IS NULL)"
RUN_DATABASE_INTEGRATION=1 APM104_RESTRICTED_NO_EXTENSION=1 PGPASSWORD="$noext_password" DATABASE_URL="$noext_url" npm run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$normal_db" -Atqc "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AND to_regclass('public.knowledge_entry_versions_search_trgm_idx') IS NOT NULL" | grep -qx t
RUN_DATABASE_INTEGRATION=1 APM104_NORMAL_TRIGRAM=1 PGPASSWORD="$owner_password" DATABASE_URL="postgresql://${owner_user}:${url_password}@${host}:${port}/${normal_db}" npm run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts

set +e
PGPASSWORD="$noext_password" psql -h "$host" -p "$port" -U "$noext_user" -d "$noext_db" -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN RAISE EXCEPTION 'unexpected migration error' USING ERRCODE = 'XX000'; EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '58P01' OR SQLSTATE '0A000' THEN RAISE NOTICE 'allowed'; END \$\$;"
unexpected_status=$?
set -e
[ "$unexpected_status" -ne 0 ] || { echo 'unexpected SQLSTATE was incorrectly accepted' >&2; exit 1; }

printf 'APM104 restricted pg_trgm replay: PASS\n'
