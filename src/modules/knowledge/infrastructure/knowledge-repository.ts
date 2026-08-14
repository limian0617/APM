import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

import type {
  KnowledgeRepositorySearchInput,
  KnowledgeSearchRepository,
  KnowledgeSearchRow
} from "../application/knowledge-search-service";

type Client = Prisma.TransactionClient | typeof db;
type DatabaseSearchRow = Omit<KnowledgeSearchRow, "entry"> & { entryCode: string };

function filters(input: KnowledgeRepositorySearchInput, keywordPredicate: Prisma.Sql) {
  const values: Prisma.Sql[] = [
    Prisma.sql`v.status = 'PUBLISHED'::"KnowledgeEntryVersionStatus"`,
    Prisma.sql`v.internal_reusable = TRUE`,
    keywordPredicate
  ];
  if (input.experienceType) values.push(Prisma.sql`v.experience_type = ${input.experienceType}`);
  if (input.discipline) values.push(Prisma.sql`v.discipline = ${input.discipline}`);
  if (input.applicableProjectType) {
    values.push(
      Prisma.sql`v.applicable_project_types_json @> ${JSON.stringify([input.applicableProjectType])}::jsonb`
    );
  }
  if (input.applicableStageCode) {
    values.push(
      Prisma.sql`v.applicable_stage_codes_json @> ${JSON.stringify([input.applicableStageCode])}::jsonb`
    );
  }
  return Prisma.join(values, " AND ");
}

async function readRows(
  client: Client,
  input: KnowledgeRepositorySearchInput,
  keywordPredicate: Prisma.Sql
): Promise<DatabaseSearchRow[]> {
  return (await client.$queryRaw(Prisma.sql`
    SELECT
      v.id,
      e.code AS "entryCode",
      v.version_no AS "versionNo",
      v.title,
      v.sanitized_summary AS "sanitizedSummary",
      v.experience_type AS "experienceType",
      v.discipline,
      v.normalized_keywords_json AS "normalizedKeywordsJson",
      v.applicable_project_types_json AS "applicableProjectTypesJson",
      v.applicable_stage_codes_json AS "applicableStageCodesJson",
      v.status,
      v.published_at AS "publishedAt"
    FROM knowledge_entry_versions v
    INNER JOIN knowledge_entries e ON e.id = v.entry_id
    WHERE ${filters(input, keywordPredicate)}
    ORDER BY v.published_at DESC NULLS LAST, v.id DESC
    OFFSET ${input.skip}
    LIMIT ${input.take}
  `)) as DatabaseSearchRow[];
}

export function createKnowledgeSearchRepository(client: Client = db): KnowledgeSearchRepository {
  return {
    async searchPublishedTrigram(input) {
      const rows = await readRows(
        client,
        input,
        Prisma.sql`v.normalized_keywords_text % ${input.query}`
      );
      return rows.map(({ entryCode, ...row }) => ({ ...row, entry: { code: entryCode } }));
    },
    async searchPublishedBoundedIlike(input) {
      const rows = await readRows(
        client,
        input,
        Prisma.sql`v.normalized_keywords_text ILIKE ${`%${input.query}%`}`
      );
      return rows.map(({ entryCode, ...row }) => ({ ...row, entry: { code: entryCode } }));
    }
  };
}
