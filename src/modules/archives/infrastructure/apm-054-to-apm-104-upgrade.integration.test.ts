import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { canonicalJson } from "@/modules/governance/domain/idempotency";

import { APM_054_ARCHIVE_V1 } from "../fixtures/apm-054-archive-v1.fixture";
import { getArchiveSourceFormulaAdapter } from "../application/archive-source-formula-registry";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
);
const workflowPath = resolve(process.cwd(), ".github/workflows/ci.yml");
const restrictedReplayPath = resolve(
  process.cwd(),
  ".github/scripts/apm-104-restricted-pg-trgm-replay.sh"
);
const restrictedReplayTestPath = resolve(
  process.cwd(),
  ".github/scripts/apm-104-restricted-pg-trgm-replay.test.sh"
);
const markerParserPath = resolve(process.cwd(), ".github/scripts/apm-104-legacy-ddl-markers.awk");
const readmePath = resolve(process.cwd(), "README.md");
const searchCapabilityIntegrationPath = resolve(
  process.cwd(),
  "src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts"
);

describe("APM-054 to APM-104 persistence upgrade contract", () => {
  it("backfills only dispatch metadata and leaves legacy hash facts untouched", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("DEFAULT 'ARCHIVE.SOURCE@1'");
    expect(migration).toContain("DEFAULT 'NOT_APPLICABLE'");
    expect(migration).not.toMatch(
      /UPDATE\s+"?project_archive_versions"?[\s\S]+(snapshot_json|manifest_checksum|source_watermark)/i
    );
    expect(migration).not.toMatch(/UPDATE\s+"?project_archive_manifest_items"?/i);
    expect(migration).toContain("PROJECT_RETROSPECTIVE_VERSION");
  });

  it("requires all four named APM-104 PostgreSQL replay gates and their shell contract", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const restrictedReplay = readFileSync(restrictedReplayPath, "utf8");
    const restrictedReplayTest = readFileSync(restrictedReplayTestPath, "utf8");
    const searchIntegration = readFileSync(searchCapabilityIntegrationPath, "utf8");

    expect(workflow).toContain("APM-104 empty database replay");
    expect(workflow).toContain("APM-104 normal pg_trgm replay");
    expect(workflow).toContain("APM-054 to APM-104 upgrade replay");
    expect(workflow).toContain("APM-104 restricted role no-extension replay");
    expect(workflow).toContain("bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.sh");
    expect(workflow).toContain("bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh");
    expect(workflow).toContain("bash .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh");
    expect(workflow).toContain("apm104-upgrade-archive-v1");
    expect(workflow).toContain("APM104_UPGRADE_REPLAY=1");
    expect(searchIntegration).toContain("APM104_NORMAL_TRIGRAM");
    expect(searchIntegration).toContain("APM104_RESTRICTED_NO_EXTENSION");
    expect(searchIntegration).toContain("expect(extension[0]?.available).toBe(true)");
    expect(searchIntegration).toContain("expect(extension[0]?.available).toBe(false)");
    expect(existsSync(restrictedReplayPath)).toBe(true);
    expect(existsSync(restrictedReplayTestPath)).toBe(true);
    expect(existsSync(markerParserPath)).toBe(true);

    expect(workflow).toContain(
      "RUN_DATABASE_INTEGRATION=1 APM104_NORMAL_TRIGRAM=1 npm run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts"
    );
    expect(workflow).not.toMatch(/knowledge-search-capability\.integration\.test\.ts\s+-t/);
    expect(restrictedReplay).toContain(
      'GRANT INSERT ON TABLE public.permissions, public.role_permissions TO "$noext_user";'
    );
    expect(restrictedReplay).toContain(
      "has_table_privilege('$noext_user', 'public.permissions', 'INSERT')"
    );
    expect(restrictedReplay).toContain(
      "has_table_privilege('$noext_user', 'public.role_permissions', 'INSERT')"
    );
    expect(restrictedReplay).toContain(
      "NOT has_table_privilege('$noext_user', 'public.permissions', 'UPDATE')"
    );
    expect(restrictedReplay).toContain(
      "NOT has_table_privilege('$noext_user', 'public.permissions', 'DELETE')"
    );
    expect(restrictedReplay).toContain(
      "NOT has_table_privilege('$noext_user', 'public.role_permissions', 'UPDATE')"
    );
    expect(restrictedReplay).toContain(
      "NOT has_table_privilege('$noext_user', 'public.role_permissions', 'DELETE')"
    );
    expect(restrictedReplay).not.toContain(
      'ALTER TABLE public.permissions OWNER TO "$noext_user";'
    );
    expect(restrictedReplay).not.toContain(
      'ALTER TABLE public.role_permissions OWNER TO "$noext_user";'
    );
    for (const permissionCode of [
      "PROJECT_RETROSPECTIVE_READ",
      "PROJECT_RETROSPECTIVE_MANAGE",
      "PROJECT_RETROSPECTIVE_REVIEW",
      "KNOWLEDGE_READ",
      "KNOWLEDGE_REVIEW",
      "KNOWLEDGE_REUSE_CONFIRM"
    ]) {
      expect(restrictedReplay).toContain(permissionCode);
    }
    expect(restrictedReplay).toContain(
      "RUN_DATABASE_INTEGRATION=1 APM104_RESTRICTED_NO_EXTENSION=1"
    );
    expect(restrictedReplay).toContain("RUN_DATABASE_INTEGRATION=1 APM104_NORMAL_TRIGRAM=1");
    expect(restrictedReplay).not.toMatch(/knowledge-search-capability\.integration\.test\.ts\s+-t/);
    expect(restrictedReplayTest).toContain("duplicate marker");
    expect(restrictedReplayTest).toContain("blank marker binding");
    expect(restrictedReplayTest).toContain("comment marker binding");
    expect(restrictedReplayTest).toContain("unbound marker");
    expect(restrictedReplayTest).toContain("APM104 restricted pg_trgm replay: PASS");
    expect(restrictedReplayTest).not.toContain("|| true");
  });

  it("documents the V2 closure template, disposable fixture, replay, and search capability contracts", () => {
    const readme = readFileSync(readmePath, "utf8");

    expect(readme).toContain("CLOSURE.ARCHIVE.G9@2");
    expect(readme).toContain("CLOSURE.RETROSPECTIVE.G9@1");
    expect(readme).toContain("ARCHIVE.SOURCE@2");
    expect(readme).toContain("APM104_BROWSER_FIXTURE_ENABLED");
    expect(readme).toContain("apm104_fixture_");
    expect(readme).toContain("APM-104 empty database replay");
    expect(readme).toContain("APM-054 to APM-104 upgrade replay");
    expect(readme).toContain("APM-104 restricted role no-extension replay");
    expect(readme).toContain("TRIGRAM");
    expect(readme).toContain("DEGRADED");
    expect(readme).toContain("bounded ILIKE");
  });

  it.skipIf(process.env.APM104_UPGRADE_REPLAY !== "1")(
    "keeps a persisted APM-054 V1 fixture byte-compatible while adding metadata-only defaults",
    async () => {
      const [archive] = await db.$queryRaw<
        Array<{
          manifestChecksum: string;
          sourceWatermark: string;
          snapshotJson: string;
          formula: string;
          applicability: string;
          retrospectiveInputWatermarkVersion: string | null;
          retrospectiveInputSnapshotJson: unknown | null;
          retrospectiveInputWatermark: string | null;
        }>
      >`
        SELECT
          "manifest_checksum" AS "manifestChecksum",
          "source_watermark" AS "sourceWatermark",
          "snapshot_json"::text AS "snapshotJson",
          "archive_source_formula_version"::text AS "formula",
          "retrospective_input_applicability"::text AS "applicability",
          "retrospective_input_watermark_version" AS "retrospectiveInputWatermarkVersion",
          "retrospective_input_snapshot_json" AS "retrospectiveInputSnapshotJson",
          "retrospective_input_watermark" AS "retrospectiveInputWatermark"
        FROM "project_archive_versions"
        WHERE "id" = 'apm104-upgrade-archive-v1'
      `;
      expect(archive).toMatchObject({
        manifestChecksum: APM_054_ARCHIVE_V1.manifestChecksum,
        sourceWatermark: APM_054_ARCHIVE_V1.sourceWatermark,
        formula: "ARCHIVE.SOURCE@1",
        applicability: "NOT_APPLICABLE",
        retrospectiveInputWatermarkVersion: null,
        retrospectiveInputSnapshotJson: null,
        retrospectiveInputWatermark: null
      });
      expect(canonicalJson(JSON.parse(archive.snapshotJson)).serialized).toBe(
        APM_054_ARCHIVE_V1.snapshotJsonText
      );

      const items = await db.$queryRaw<Array<{ sourceChecksum: string }>>`
        SELECT "source_checksum" AS "sourceChecksum"
        FROM "project_archive_manifest_items"
        WHERE "archive_version_id" = 'apm104-upgrade-archive-v1'
        ORDER BY "position" ASC
      `;
      expect(items.map((item) => item.sourceChecksum)).toEqual(APM_054_ARCHIVE_V1.itemChecksums);

      const v1 = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@1").buildManifest({
        projectId: APM_054_ARCHIVE_V1.projectId,
        items: APM_054_ARCHIVE_V1.sources
      });
      expect(v1.manifestChecksum).toBe(archive.manifestChecksum);
      expect(v1.sourceWatermark).toBe(archive.sourceWatermark);
    }
  );
});
