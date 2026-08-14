import { Prisma } from "@prisma/client";

export type KnowledgeSearchCapability = "TRIGRAM" | "DEGRADED";

export class KnowledgeSearchCapabilityError extends Error {
  constructor(
    readonly code: "KNOWLEDGE_SEARCH_CAPABILITY_UNAVAILABLE",
    message: string,
    readonly status = 503
  ) {
    super(message);
    this.name = "KnowledgeSearchCapabilityError";
  }
}

type CapabilityClient = {
  $queryRaw: (query: Prisma.Sql) => Promise<unknown>;
};

type CapabilityRow = {
  extensionAvailable: boolean;
  indexOnTargetTable: boolean;
  indexUsesGin: boolean;
  indexUsesTrigram: boolean;
  indexValid: boolean;
  indexReady: boolean;
  indexDefinitionCorrect: boolean;
};

export async function getKnowledgeSearchCapability(
  client: CapabilityClient
): Promise<KnowledgeSearchCapability> {
  try {
    const rows = (await client.$queryRaw(Prisma.sql`
      WITH named_index AS (
        SELECT
          indexed_table_namespace.nspname AS indexed_table_schema,
          indexed_table.relname AS indexed_table_name,
          access_method.amname AS access_method_name,
          opclass.opcname AS opclass_name,
          index_meta.indisvalid,
          index_meta.indisready,
          index_meta.indnkeyatts,
          pg_get_indexdef(index_class.oid, 1, true) AS first_key_definition
        FROM pg_class index_class
        INNER JOIN pg_namespace index_namespace
          ON index_namespace.oid = index_class.relnamespace
        INNER JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
        INNER JOIN pg_class indexed_table ON indexed_table.oid = index_meta.indrelid
        INNER JOIN pg_namespace indexed_table_namespace
          ON indexed_table_namespace.oid = indexed_table.relnamespace
        INNER JOIN pg_am access_method ON access_method.oid = index_class.relam
        LEFT JOIN pg_opclass opclass ON opclass.oid = index_meta.indclass[0]
        WHERE index_namespace.nspname = 'public'
          AND index_class.relname = 'knowledge_entry_versions_search_trgm_idx'
      )
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS "extensionAvailable",
        EXISTS (
          SELECT 1 FROM named_index
          WHERE indexed_table_schema = 'public'
            AND indexed_table_name = 'knowledge_entry_versions'
        ) AS "indexOnTargetTable",
        EXISTS (SELECT 1 FROM named_index WHERE access_method_name = 'gin') AS "indexUsesGin",
        EXISTS (SELECT 1 FROM named_index WHERE opclass_name = 'gin_trgm_ops') AS "indexUsesTrigram",
        EXISTS (SELECT 1 FROM named_index WHERE indisvalid) AS "indexValid",
        EXISTS (SELECT 1 FROM named_index WHERE indisready) AS "indexReady",
        EXISTS (
          SELECT 1 FROM named_index
          WHERE indnkeyatts = 1
            AND first_key_definition = 'normalized_keywords_text'
        ) AS "indexDefinitionCorrect"
    `)) as CapabilityRow[];
    const capability = rows[0];
    if (
      !capability ||
      typeof capability.extensionAvailable !== "boolean" ||
      typeof capability.indexOnTargetTable !== "boolean" ||
      typeof capability.indexUsesGin !== "boolean" ||
      typeof capability.indexUsesTrigram !== "boolean" ||
      typeof capability.indexValid !== "boolean" ||
      typeof capability.indexReady !== "boolean" ||
      typeof capability.indexDefinitionCorrect !== "boolean"
    ) {
      throw new Error("knowledge search capability response is invalid");
    }
    return capability.extensionAvailable &&
      capability.indexOnTargetTable &&
      capability.indexUsesGin &&
      capability.indexUsesTrigram &&
      capability.indexValid &&
      capability.indexReady &&
      capability.indexDefinitionCorrect
      ? "TRIGRAM"
      : "DEGRADED";
  } catch {
    throw new KnowledgeSearchCapabilityError(
      "KNOWLEDGE_SEARCH_CAPABILITY_UNAVAILABLE",
      "无法确认知识检索数据库能力。"
    );
  }
}
