type KnowledgeAuthorizationClient = {
  knowledgeEntryVersion: {
    findUnique(input: {
      where: { id_entryId: { id: string; entryId: string } };
      select: { sourceProjectId: true };
    }): Promise<{ sourceProjectId: string } | null>;
  };
};

type KnowledgeReusePageContextClient = {
  knowledgeReuseRecord: {
    findUnique(input: {
      where: { id_targetProjectId: { id: string; targetProjectId: string } };
      select: { id: true; version: true };
    }): Promise<{ id: string; version: number } | null>;
  };
};

export class KnowledgeAuthorizationQueryError extends Error {
  constructor(
    readonly code: "KNOWLEDGE_VERSION_NOT_FOUND",
    message: string,
    readonly status = 404
  ) {
    super(message);
    this.name = "KnowledgeAuthorizationQueryError";
  }
}

export async function resolveKnowledgeVersionSourceProject(
  input: { entryId: string; versionId: string },
  client: KnowledgeAuthorizationClient
): Promise<{ sourceProjectId: string }> {
  const version = await client.knowledgeEntryVersion.findUnique({
    where: { id_entryId: { id: input.versionId, entryId: input.entryId } },
    select: { sourceProjectId: true }
  });
  if (!version) {
    throw new KnowledgeAuthorizationQueryError("KNOWLEDGE_VERSION_NOT_FOUND", "知识版本不存在。");
  }
  return { sourceProjectId: version.sourceProjectId };
}

export async function resolveKnowledgeReusePageContext(
  input: { targetProjectId: string; reuseId: string | undefined },
  client: KnowledgeReusePageContextClient
): Promise<{
  canCorrectReuse: boolean;
  reuseContext: { reuseId: string; version: number } | null;
}> {
  if (!input.reuseId) return { canCorrectReuse: false, reuseContext: null };
  const reuse = await client.knowledgeReuseRecord.findUnique({
    where: { id_targetProjectId: { id: input.reuseId, targetProjectId: input.targetProjectId } },
    select: { id: true, version: true }
  });
  return reuse
    ? { canCorrectReuse: true, reuseContext: { reuseId: reuse.id, version: reuse.version } }
    : { canCorrectReuse: false, reuseContext: null };
}
