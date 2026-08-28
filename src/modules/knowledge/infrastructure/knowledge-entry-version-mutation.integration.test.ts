import { describe, expect, it } from "vitest";

import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const probeTable = '"apm104_knowledge_entry_version_mutation_probe"';

describeDatabase("APM-104 PostgreSQL knowledge version immutable mutation trigger", () => {
  it("allows SUPERSEDED to REVOKED while keeping the new status", async () => {
    await db.$transaction(async (client) => {
      await client.$executeRawUnsafe(`
        CREATE TEMPORARY TABLE ${probeTable} (
          id INTEGER PRIMARY KEY,
          status "KnowledgeEntryVersionStatus" NOT NULL,
          submitted_by_id TEXT,
          submitted_at TIMESTAMPTZ,
          published_by_id TEXT,
          published_at TIMESTAMPTZ,
          content_checksum TEXT NOT NULL
        ) ON COMMIT DROP
      `);
      await client.$executeRawUnsafe(`
        CREATE TRIGGER "apm104_knowledge_entry_version_mutation_probe_trigger"
        BEFORE UPDATE ON ${probeTable}
        FOR EACH ROW EXECUTE FUNCTION public."validate_knowledge_entry_version_mutation"()
      `);
      await client.$executeRawUnsafe(`
        INSERT INTO ${probeTable} (id, status, content_checksum)
        VALUES (1, 'SUPERSEDED', 'a')
      `);

      await client.$executeRawUnsafe(`UPDATE ${probeTable} SET status = 'REVOKED' WHERE id = 1`);
      const rows = await client.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status::text AS status FROM ${probeTable} WHERE id = 1`
      );

      expect(rows).toEqual([{ status: "REVOKED" }]);
    });
  });

  it("rejects a terminal reverse transition with SQLSTATE 23514", async () => {
    await db.$transaction(async (client) => {
      await client.$executeRawUnsafe(`
        CREATE TEMPORARY TABLE ${probeTable} (
          id INTEGER PRIMARY KEY,
          status "KnowledgeEntryVersionStatus" NOT NULL,
          submitted_by_id TEXT,
          submitted_at TIMESTAMPTZ,
          published_by_id TEXT,
          published_at TIMESTAMPTZ,
          content_checksum TEXT NOT NULL
        ) ON COMMIT DROP
      `);
      await client.$executeRawUnsafe(`
        CREATE TRIGGER "apm104_knowledge_entry_version_mutation_probe_trigger"
        BEFORE UPDATE ON ${probeTable}
        FOR EACH ROW EXECUTE FUNCTION public."validate_knowledge_entry_version_mutation"()
      `);
      await client.$executeRawUnsafe(`
        INSERT INTO ${probeTable} (id, status, content_checksum)
        VALUES (1, 'REVOKED', 'a')
      `);

      await client.$executeRawUnsafe(`
        DO $apm104$
        BEGIN
          BEGIN
            UPDATE ${probeTable} SET status = 'PUBLISHED' WHERE id = 1;
            RAISE EXCEPTION 'terminal reverse transition unexpectedly succeeded' USING ERRCODE = 'P0001';
          EXCEPTION WHEN SQLSTATE '23514' THEN
            NULL;
          END;
        END;
        $apm104$
      `);
    });
  });

  it("rejects a non-status content mutation with SQLSTATE 55000", async () => {
    await db.$transaction(async (client) => {
      await client.$executeRawUnsafe(`
        CREATE TEMPORARY TABLE ${probeTable} (
          id INTEGER PRIMARY KEY,
          status "KnowledgeEntryVersionStatus" NOT NULL,
          submitted_by_id TEXT,
          submitted_at TIMESTAMPTZ,
          published_by_id TEXT,
          published_at TIMESTAMPTZ,
          content_checksum TEXT NOT NULL
        ) ON COMMIT DROP
      `);
      await client.$executeRawUnsafe(`
        CREATE TRIGGER "apm104_knowledge_entry_version_mutation_probe_trigger"
        BEFORE UPDATE ON ${probeTable}
        FOR EACH ROW EXECUTE FUNCTION public."validate_knowledge_entry_version_mutation"()
      `);
      await client.$executeRawUnsafe(`
        INSERT INTO ${probeTable} (id, status, content_checksum)
        VALUES (1, 'SUPERSEDED', 'a')
      `);

      await client.$executeRawUnsafe(`
        DO $apm104$
        BEGIN
          BEGIN
            UPDATE ${probeTable} SET content_checksum = 'changed' WHERE id = 1;
            RAISE EXCEPTION 'immutable content mutation unexpectedly succeeded' USING ERRCODE = 'P0001';
          EXCEPTION WHEN SQLSTATE '55000' THEN
            NULL;
          END;
        END;
        $apm104$
      `);
    });
  });
});
