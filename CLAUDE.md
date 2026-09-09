# APM repository guide

## Migrations are hand-written SQL only

`prisma/schema.prisma` and `prisma/migrations/` are maintained as two independent lines. The
migrations are the source of truth for the database schema; `schema.prisma` exists so that
`prisma generate` can produce the Prisma Client. The two have never been reconciled, and
reconciling them is not planned.

**Never run `prisma migrate dev` or `prisma db push` against any database.** Measured on
2026-09-08 against the live development database, the migration that `migrate dev` would generate
is 2184 lines and 725 operations:

- 370 `ALTER TABLE ... RENAME CONSTRAINT` plus 238 `ALTER INDEX ... RENAME`. The database uses the
  hand-written names from the migrations; Prisma wants its own canonical
  `<table>_<column>_<suffix>` names. Three separate causes are at work: model name instead of
  table name (`SystemSetting_pkey` to `system_settings_pkey`), an omitted `_id` segment
  (`acceptance_batches_created_by_fkey` to `acceptance_batches_created_by_id_fkey`), and two
  different ways of truncating identifiers to Postgres' 63-byte limit. Renaming these would break
  every migration-contract test and every hand-written statement that refers to a constraint or
  index by name.
- 31 foreign keys dropped against 20 added. The drop set contains real referential-integrity
  constraints that exist only in the database, mostly `actor` / `created_by` / `updated_by` /
  `owner_membership` user references, because `schema.prisma` models those columns as plain
  scalars with no `@relation` (a deliberate choice, to avoid a large number of back-relations on
  `User`).
- 4 indexes dropped, including `knowledge_entry_versions_search_trgm_idx`, a GIN trigram index
  that Prisma cannot express. Dropping it degrades knowledge-base search silently rather than
  raising an error.
- 29 `ALTER TABLE` blocks, almost entirely column default changes.

`npm run db:migrate` and `npm run db:push` are deliberately wired to refuse and print the reason
instead of running.

### Safe Prisma commands

- `npm run db:migrate:deploy` (`prisma migrate deploy`) applies existing migrations without
  generating new ones. This is the correct way to bring a database up to date, and CI relies on
  it.
- `prisma migrate status` and `prisma migrate diff` are read-only. `migrate diff` neither writes
  the database nor writes the migrations directory; its `--exit-code` flag returns 0 for an empty
  diff, 2 for a non-empty diff, and 1 on error.
- To re-measure the drift described above:

  ```
  npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
    --to-schema-datamodel prisma/schema.prisma --script --exit-code
  ```

### Adding a migration

Write `prisma/migrations/<timestamp>_<name>/migration.sql` by hand, following the naming and
style conventions of the existing 62 migrations. Apply it with `npm run db:migrate:deploy`. Then
update `schema.prisma` separately so the generated client matches the new database shape, and
verify with `npm run db:validate`.

Triggers, functions, rules and `CHECK` constraints sit outside Prisma's migration model and can
only be created by hand-written migrations. This was verified on 2026-09-08: `migrate diff` emits
no `DROP TRIGGER`, `DROP FUNCTION` or `DROP RULE` at all, and none of its `DROP CONSTRAINT`
statements target a non-foreign-key constraint, even though the repository defines 439 triggers,
269 functions and 63 hand-written `CHECK` constraints. Partial unique indexes are inside the
index class but are preserved as-is.

## Local database

Start PostgreSQL with `docker compose up -d`, or `docker start apm-postgres` if the container
already exists. `docker-compose.yml` pins `name: apm-083` at the top level, which is what makes
Compose usable here at all: without it Compose derives the project name from the directory name,
which is non-ASCII in this checkout, so it sanitizes to an empty string and Compose fails with
`project name must not be empty`.

Never override the project name with `-p`. The development database lives in the Docker volume
`apm-083_apm-postgres-data`, created on 2026-09-06 and labelled
`com.docker.compose.project=apm-083`. It is the only copy and holds 197 tables and 62 applied
migrations. Compose builds a volume's real name from the project name plus the volume key, so
`docker compose -p apm up -d` would mount a brand-new empty `apm_apm-postgres-data` instead and
leave the real database stranded. The `apm-083` name is a leftover from the `worktrees/apm-083`
directory the volume was first created in: meaningless, but load-bearing. Renaming it means
abandoning the existing database.

Recreating or removing the `apm-postgres` container is harmless: the data lives in the volume, not
in the container. Changing this file makes the next `docker compose up -d` recreate the container
once, which is expected. What is not recoverable is the volume, so never run
`docker compose down -v` and never remove the `apm-083_apm-postgres-data` volume.

If `npm run db:generate` fails with `EPERM ... rename query_engine-windows.dll.node`, the dev
server is holding the engine DLL open. Stop it and retry.

## Quality gates

Run all seven before handing off a change:

```
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run db:generate
npm run db:validate
npm run build
```

Database integration tests are gated behind `RUN_DATABASE_INTEGRATION=1` and skip by default.
