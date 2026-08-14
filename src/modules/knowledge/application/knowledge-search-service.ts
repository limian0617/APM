import type { KnowledgeSearchCapability } from "./knowledge-search-capability";

export type KnowledgeSearchRow = {
  id: string;
  entry: { code: string };
  versionNo: number;
  title: string;
  sanitizedSummary: string;
  experienceType: string;
  discipline: string;
  normalizedKeywordsJson: unknown;
  applicableProjectTypesJson: unknown;
  applicableStageCodesJson: unknown;
  status: string;
  publishedAt: Date | null;
};

export type KnowledgeSearchRepository = {
  searchPublishedTrigram(input: KnowledgeRepositorySearchInput): Promise<KnowledgeSearchRow[]>;
  searchPublishedBoundedIlike(input: KnowledgeRepositorySearchInput): Promise<KnowledgeSearchRow[]>;
};

export type KnowledgeRepositorySearchInput = {
  query: string;
  skip: number;
  take: number;
  maxWindow: number;
  experienceType?: string;
  discipline?: string;
  applicableProjectType?: string;
  applicableStageCode?: string;
};

export type PublicKnowledgeVersionDto = {
  entryCode: string;
  version: number;
  title: string;
  sanitizedSummary: string;
  experienceType: string;
  discipline: string;
  keywords: string[];
  applicableProjectTypes: string[];
  applicableStageCodes: string[];
  status: "PUBLISHED";
};

export type KnowledgeSearchResult = {
  capability: KnowledgeSearchCapability;
  warningCode: "SEARCH_DEGRADED" | null;
  items: PublicKnowledgeVersionDto[];
  nextCursor: string | null;
};

export class KnowledgeSearchServiceError extends Error {
  constructor(
    readonly code: "KNOWLEDGE_SEARCH_QUERY_INVALID" | "KNOWLEDGE_SEARCH_WINDOW_EXCEEDED",
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "KnowledgeSearchServiceError";
  }
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

function normalizedQuery(value: string): string {
  const query = value.trim();
  if (!query || [...query].length > 64) {
    throw new KnowledgeSearchServiceError(
      "KNOWLEDGE_SEARCH_QUERY_INVALID",
      "知识检索关键词必须为 1 到 64 个 Unicode 字符。"
    );
  }
  return query;
}

function searchBounds(page: number, pageSize: number) {
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 20
  ) {
    throw new KnowledgeSearchServiceError(
      "KNOWLEDGE_SEARCH_QUERY_INVALID",
      "知识检索分页参数无效。"
    );
  }
  const maxWindow = 100;
  const skip = (page - 1) * pageSize;
  if (skip >= maxWindow || skip + pageSize > maxWindow) {
    throw new KnowledgeSearchServiceError(
      "KNOWLEDGE_SEARCH_WINDOW_EXCEEDED",
      "降级检索最多读取 100 条受控结果。"
    );
  }
  return { skip, take: Math.min(pageSize + 1, maxWindow - skip), maxWindow };
}

function publicDto(row: KnowledgeSearchRow): PublicKnowledgeVersionDto {
  return {
    entryCode: row.entry.code,
    version: row.versionNo,
    title: row.title,
    sanitizedSummary: row.sanitizedSummary,
    experienceType: row.experienceType,
    discipline: row.discipline,
    keywords: textArray(row.normalizedKeywordsJson),
    applicableProjectTypes: textArray(row.applicableProjectTypesJson),
    applicableStageCodes: textArray(row.applicableStageCodesJson),
    status: "PUBLISHED"
  };
}

export async function searchPublishedKnowledge(
  input: {
    query: string;
    page: number;
    pageSize: number;
    experienceType?: string;
    discipline?: string;
    applicableProjectType?: string;
    applicableStageCode?: string;
  },
  dependencies: {
    getCapability: () => Promise<KnowledgeSearchCapability>;
    repository: KnowledgeSearchRepository;
  }
): Promise<KnowledgeSearchResult> {
  const query = normalizedQuery(input.query);
  const bounds = searchBounds(input.page, input.pageSize);
  const capability = await dependencies.getCapability();
  const repositoryInput = {
    query,
    ...bounds,
    ...(input.experienceType ? { experienceType: input.experienceType.trim().toUpperCase() } : {}),
    ...(input.discipline ? { discipline: input.discipline.trim().toUpperCase() } : {}),
    ...(input.applicableProjectType
      ? { applicableProjectType: input.applicableProjectType.trim().toUpperCase() }
      : {}),
    ...(input.applicableStageCode
      ? { applicableStageCode: input.applicableStageCode.trim().toUpperCase() }
      : {})
  };
  const rows =
    capability === "TRIGRAM"
      ? await dependencies.repository.searchPublishedTrigram(repositoryInput)
      : await dependencies.repository.searchPublishedBoundedIlike(repositoryInput);
  const hasNext = rows.length > input.pageSize;
  const visible = rows.slice(0, input.pageSize);
  const next = rows[input.pageSize];
  return {
    capability,
    warningCode: capability === "DEGRADED" ? "SEARCH_DEGRADED" : null,
    items: visible.map(publicDto),
    nextCursor: hasNext && next?.publishedAt ? `${next.publishedAt.toISOString()}:${next.id}` : null
  };
}
