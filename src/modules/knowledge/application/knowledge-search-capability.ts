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

type CapabilityRow = { extensionAvailable: boolean; indexAvailable: boolean };

export async function getKnowledgeSearchCapability(
  client: CapabilityClient
): Promise<KnowledgeSearchCapability> {
  try {
    const rows = (await client.$queryRaw(Prisma.sql`
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS "extensionAvailable",
        to_regclass('public.knowledge_entry_versions_search_trgm_idx') IS NOT NULL AS "indexAvailable"
    `)) as CapabilityRow[];
    const capability = rows[0];
    if (
      !capability ||
      typeof capability.extensionAvailable !== "boolean" ||
      typeof capability.indexAvailable !== "boolean"
    ) {
      throw new Error("knowledge search capability response is invalid");
    }
    return capability.extensionAvailable && capability.indexAvailable ? "TRIGRAM" : "DEGRADED";
  } catch {
    throw new KnowledgeSearchCapabilityError(
      "KNOWLEDGE_SEARCH_CAPABILITY_UNAVAILABLE",
      "无法确认知识检索数据库能力。"
    );
  }
}
