#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

replay=".github/scripts/apm-104-restricted-pg-trgm-replay.sh"
parser=".github/scripts/apm-104-legacy-ddl-markers.awk"
fixture_root="$(mktemp -d)"
positive_sql="$fixture_root/positive.sql"
unmarked_sql="$fixture_root/unmarked.sql"
duplicate_sql="$fixture_root/duplicate.sql"
blank_sql="$fixture_root/blank.sql"
comment_sql="$fixture_root/comment.sql"
eof_sql="$fixture_root/eof.sql"
mismatch_sql="$fixture_root/mismatch.sql"
replay_log="$fixture_root/replay.log"

cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT

test -f "$replay"
test -f "$parser"

expect_parser_failure() {
  label="$1"
  fixture="$2"
  if awk -f "$parser" "$fixture" >/dev/null 2>&1; then
    echo "$label was incorrectly accepted" >&2
    exit 1
  fi
}

printf '%s\n' \
  '-- APM104_LEGACY_DDL TABLE project_template_snapshots' 'ALTER TABLE "project_template_snapshots" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE project_archive_versions' 'ALTER TABLE "project_archive_versions" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE project_gate_definitions' 'ALTER TABLE "project_gate_definitions" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE project_gate_instances' 'ALTER TABLE "project_gate_instances" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE gate_check_snapshots' 'ALTER TABLE "gate_check_snapshots" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE gate_submissions' 'ALTER TABLE "gate_submissions" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE issue_histories' 'ALTER TABLE "issue_histories" ADD CONSTRAINT "x" CHECK (true);' \
  '-- APM104_LEGACY_DDL TYPE ArchiveManifestSourceType' 'ALTER TYPE "ArchiveManifestSourceType" ADD VALUE IF NOT EXISTS '\''PROJECT_RETROSPECTIVE_VERSION'\'';' \
  '-- APM104_LEGACY_DDL FUNCTION validate_project_archive_version_mutation' 'CREATE OR REPLACE FUNCTION "validate_project_archive_version_mutation"()' 'RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;' >"$positive_sql"

expected="$(printf '%s\n' 'FUNCTION validate_project_archive_version_mutation' 'TABLE gate_check_snapshots' 'TABLE gate_submissions' 'TABLE issue_histories' 'TABLE project_archive_versions' 'TABLE project_gate_definitions' 'TABLE project_gate_instances' 'TABLE project_template_snapshots' 'TYPE ArchiveManifestSourceType')"
actual="$(awk -f "$parser" "$positive_sql" | sort -u)"
[ "$actual" = "$expected" ]

printf '%s\n' 'CREATE TABLE "knowledge_entries" ("id" text PRIMARY KEY);' 'ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_code_key" UNIQUE ("id");' >"$unmarked_sql"
[ -z "$(awk -f "$parser" "$unmarked_sql")" ]

printf '%s\n' \
  '-- APM104_LEGACY_DDL TABLE project_archive_versions' \
  '-- APM104_LEGACY_DDL TABLE project_archive_versions' \
  'ALTER TABLE "project_archive_versions" ADD COLUMN "x" text;' >"$duplicate_sql"
expect_parser_failure "duplicate marker" "$duplicate_sql"

printf '%s\n' \
  '-- APM104_LEGACY_DDL TABLE project_archive_versions' \
  '' \
  'ALTER TABLE "project_archive_versions" ADD COLUMN "x" text;' >"$blank_sql"
expect_parser_failure "blank marker binding" "$blank_sql"

printf '%s\n' \
  '-- APM104_LEGACY_DDL TABLE project_archive_versions' \
  '-- intervening comment is forbidden' \
  'ALTER TABLE "project_archive_versions" ADD COLUMN "x" text;' >"$comment_sql"
expect_parser_failure "comment marker binding" "$comment_sql"

printf '%s\n' '-- APM104_LEGACY_DDL TABLE project_archive_versions' >"$eof_sql"
expect_parser_failure "unbound marker" "$eof_sql"

printf '%s\n' \
  '-- APM104_LEGACY_DDL FUNCTION validate_project_archive_version_mutation' \
  'ALTER TABLE "validate_project_archive_version_mutation" ADD COLUMN "x" text;' >"$mismatch_sql"
expect_parser_failure "function marker mismatch" "$mismatch_sql"

createdb() {
  printf 'createdb %s\n' "$*" >>"$APM104_REPLAY_LOG"
}

dropdb() {
  printf 'dropdb %s\n' "$*" >>"$APM104_REPLAY_LOG"
}

npx() {
  printf 'npx %s\n' "$*" >>"$APM104_REPLAY_LOG"
}

npm() {
  printf 'npm RUN_DATABASE_INTEGRATION=%s APM104_NORMAL_TRIGRAM=%s APM104_RESTRICTED_NO_EXTENSION=%s %s\n' \
    "$(env | sed -n 's/^RUN_DATABASE_INTEGRATION=//p')" \
    "$(env | sed -n 's/^APM104_NORMAL_TRIGRAM=//p')" \
    "$(env | sed -n 's/^APM104_RESTRICTED_NO_EXTENSION=//p')" \
    "$*" >>"$APM104_REPLAY_LOG"
}

psql() {
  args="$*"
  stdin="$(cat)"
  payload="$args $stdin"
  database="$(printf '%s\n' "$args" | sed -n 's/.* -d \([^ ]*\).*/\1/p')"
  printf 'psql %s\n' "$payload" >>"$APM104_REPLAY_LOG"
  case "$payload" in
    *"unexpected migration error"*) return 1 ;;
    *"SELECT 1 FROM pg_roles WHERE rolname="*) printf '1\n' ;;
    *"rolcreatedb AND rolcreaterole"*) printf 't\n' ;;
    *"NOT rolsuper AND NOT rolcreatedb"*) printf 't\n' ;;
    *"SELECT pg_has_role"*) printf 't\n' ;;
    *"SELECT d.datdba="*) printf 't\n' ;;
    *"string_agg(c.relname"*) printf '_prisma_migrations,gate_check_snapshots,gate_submissions,issue_histories,project_archive_versions,project_gate_definitions,project_gate_instances,project_template_snapshots\n' ;;
    *"string_agg(t.typname"*) printf 'AuditAction,AuditObjectType\n' ;;
    *"FROM pg_type t JOIN pg_roles"*) printf '%s\n' "$database" ;;
    *"FROM pg_proc p JOIN pg_namespace"*) printf '%s\n' "$database" ;;
    *"has_table_privilege"*) printf 't\n' ;;
    *"WITH expected(permission_id, permission_code"*) printf 't\n' ;;
    *"knowledge_entry_versions_search_trgm_idx') IS NULL"*) printf 't\n' ;;
    *"knowledge_entry_versions_search_trgm_idx') IS NOT NULL"*) printf 't\n' ;;
    *"SELECT EXISTS (SELECT 1 FROM pg_extension"*)
      case "$database" in
        apm104_normal_*) printf 't\n' ;;
        *) printf 'f\n' ;;
      esac
      ;;
    *"to_regclass('public.knowledge_entries')"*|*"PROJECT_RETROSPECTIVE_VERSION"*|*"knowledge_entry_reviews_version_entry_project_fkey"*|*"knowledge_reuse_records_version_entry_fkey"*) printf 't\n' ;;
  esac
}

export -f createdb dropdb npx npm psql

fixture_output="$(APM104_REPLAY_LOG="$replay_log" PGHOST=fixture-host PGPORT=6543 PGOWNER_USER=fixture-admin PGOWNER_PASSWORD=fixture-password GITHUB_RUN_ID=fixture bash "$replay")"
[ "$fixture_output" = 'APM104 restricted pg_trgm replay: PASS' ]

grep -Eq '^createdb .*apm104_normal_fixture-[0-9]+$' "$replay_log"
grep -Eq '^createdb .*apm104_noext_fixture-[0-9]+$' "$replay_log"
grep -Eq '^psql -h fixture-host -p 6543 -U fixture-admin ' "$replay_log"
grep -E 'GRANT INSERT ON TABLE public.permissions, public.role_permissions TO "apm104_noext_fixture-[0-9]+"' "$replay_log"
grep -E "has_table_privilege\\('apm104_noext_fixture-[0-9]+', 'public.permissions', 'INSERT'\\)" "$replay_log"
grep -E "has_table_privilege\\('apm104_noext_fixture-[0-9]+', 'public.role_permissions', 'INSERT'\\)" "$replay_log"
grep -F 'WITH expected(permission_id, permission_code, role_id, scope)' "$replay_log"
grep -F 'PROJECT_RETROSPECTIVE_READ' "$replay_log"
grep -F 'KNOWLEDGE_REUSE_CONFIRM' "$replay_log"
grep -F 'SELECT pg_terminate_backend(pid)' "$replay_log"
grep -Eq '^dropdb .*--if-exists apm104_normal_fixture-[0-9]+$' "$replay_log"
grep -Eq '^dropdb .*--if-exists apm104_noext_fixture-[0-9]+$' "$replay_log"
grep -E 'REVOKE "apm104_noext_fixture-[0-9]+" FROM "fixture-admin"; DROP ROLE "apm104_noext_fixture-[0-9]+"' "$replay_log"
grep -F 'unexpected migration error' "$replay_log"
grep -F 'npm RUN_DATABASE_INTEGRATION=1 APM104_NORMAL_TRIGRAM= APM104_RESTRICTED_NO_EXTENSION=1 run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts' "$replay_log"
grep -F 'npm RUN_DATABASE_INTEGRATION=1 APM104_NORMAL_TRIGRAM=1 APM104_RESTRICTED_NO_EXTENSION= run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts' "$replay_log"
if grep -F -- ' -t ' "$replay_log" >/dev/null; then
  echo 'search capability replay must not filter tests by a display-name selector' >&2
  exit 1
fi

printf 'APM104 restricted replay shell contract: PASS\n'
