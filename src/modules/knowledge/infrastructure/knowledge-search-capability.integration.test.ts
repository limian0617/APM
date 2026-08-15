import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { db } from "@/lib/db";

import { getKnowledgeSearchCapability } from "../application/knowledge-search-capability";
import { searchPublishedKnowledge } from "../application/knowledge-search-service";
import { createKnowledgeSearchRepository } from "./knowledge-repository";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  user: `knowledge-search-user-${suffix}`,
  project: `knowledge-search-project-${suffix}`,
  entry: `knowledge-search-entry-${suffix}`,
  version: `knowledge-search-version-${suffix}`,
  revokedEntry: `knowledge-search-entry-revoked-${suffix}`,
  revokedVersion: `knowledge-search-version-revoked-${suffix}`,
  staleEntry: `knowledge-search-entry-stale-${suffix}`,
  staleVersion: `knowledge-search-version-stale-${suffix}`,
  staleCurrentVersion: `knowledge-search-version-current-${suffix}`
};

const sourceTemplateChecksum = "7".repeat(64);
const snapshotChecksum = "8".repeat(64);

function connectionTarget(connectionUrl: string, variableName: string): string {
  let connection: URL;
  try {
    connection = new URL(connectionUrl);
  } catch {
    throw new Error(`${variableName} 必须是有效的 PostgreSQL 连接 URL。`);
  }
  const database = decodeURIComponent(connection.pathname).replace(/^\/+/, "");
  if (connection.protocol !== "postgresql:" || !connection.hostname || !database) {
    throw new Error(`${variableName} 必须是有效的 PostgreSQL 连接 URL。`);
  }
  const queryTarget = Array.from(connection.searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const left = `${leftKey}\u0000${leftValue}`;
      const right = `${rightKey}\u0000${rightValue}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return [
    connection.protocol,
    connection.hostname.toLowerCase(),
    connection.port || "5432",
    database,
    queryTarget
  ].join("|");
}

function restrictedFixtureSetupClient(): PrismaClient | null {
  if (process.env.APM104_RESTRICTED_NO_EXTENSION !== "1") return null;
  const setupUrl = process.env.APM104_FIXTURE_SETUP_DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!setupUrl) {
    throw new Error("受限检索测试必须设置 APM104_FIXTURE_SETUP_DATABASE_URL。");
  }
  if (
    !runtimeUrl ||
    connectionTarget(setupUrl, "APM104_FIXTURE_SETUP_DATABASE_URL") !==
      connectionTarget(runtimeUrl, "DATABASE_URL")
  ) {
    throw new Error("受限检索测试的夹具数据库必须与被测数据库具有相同的 host、port 和 database。");
  }
  return new PrismaClient({ datasources: { db: { url: setupUrl } } });
}

async function withEnvironment<T>(
  updates: Record<string, string | undefined>,
  action: () => T | Promise<T>
): Promise<T> {
  const previous = new Map(Object.keys(updates).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("受限检索夹具连接", () => {
  it("在缺少管理员夹具 URL 时默认拒绝", async () => {
    await withEnvironment(
      {
        APM104_RESTRICTED_NO_EXTENSION: "1",
        APM104_FIXTURE_SETUP_DATABASE_URL: undefined,
        DATABASE_URL: "postgresql://noext:noext-secret@fixture-host:5432/apm104?schema=public"
      },
      () => {
        expect(restrictedFixtureSetupClient).toThrow("APM104_FIXTURE_SETUP_DATABASE_URL");
      }
    );
  });

  it("在管理员夹具 URL 指向不同数据库时默认拒绝且不泄露凭证", async () => {
    await withEnvironment(
      {
        APM104_RESTRICTED_NO_EXTENSION: "1",
        APM104_FIXTURE_SETUP_DATABASE_URL:
          "postgresql://fixture-admin:admin-secret@fixture-host:5432/other",
        DATABASE_URL: "postgresql://noext:noext-secret@fixture-host:5432/apm104"
      },
      () => {
        try {
          restrictedFixtureSetupClient();
          throw new Error("预期数据库目标不匹配时被拒绝。");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toContain("host、port 和 database");
          expect(message).not.toContain("admin-secret");
          expect(message).not.toContain("noext-secret");
        }
      }
    );
  });

  it("在凭证不同而查询参数顺序不同时接受同一个数据库目标", async () => {
    await withEnvironment(
      {
        APM104_RESTRICTED_NO_EXTENSION: "1",
        APM104_FIXTURE_SETUP_DATABASE_URL:
          "postgresql://fixture-admin:admin-secret@fixture-host:5432/apm104?schema=public&connect_timeout=7",
        DATABASE_URL:
          "postgresql://noext:noext-secret@fixture-host:5432/apm104?connect_timeout=7&schema=public"
      },
      async () => {
        const client = restrictedFixtureSetupClient();
        try {
          expect(client).not.toBeNull();
        } finally {
          await client?.$disconnect();
        }
      }
    );
  });
});

async function createReadySourceProject(client: PrismaClient) {
  const publishedAt = new Date("2026-08-15T00:00:00.000Z");
  const template = await client.projectTemplate.create({
    data: {
      code: `KNOWLEDGE.SEARCH.TEMPLATE.${suffix}`.toUpperCase(),
      name: "Knowledge search fixture template",
      status: "ACTIVE",
      currentVersion: 1,
      createdById: ids.user,
      updatedById: ids.user,
      versions: {
        create: {
          version: 1,
          status: "PUBLISHED",
          name: "Knowledge search fixture template",
          checksum: sourceTemplateChecksum,
          publishedById: ids.user,
          publishedAt
        }
      }
    },
    include: { versions: true }
  });
  const version = template.versions[0]!;
  await client.project.create({
    data: {
      id: ids.project,
      code: `KNOW.SEARCH.${suffix}`.toUpperCase(),
      name: "Knowledge search source",
      status: "CLOSED",
      initializationStatus: "READY",
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "SINGLE_MACHINE",
      structureStatus: "READY",
      sourceTemplateVersionId: version.id,
      sourceTemplateChecksum: version.checksum,
      initializedAt: publishedAt,
      createdById: ids.user
    }
  });
  await client.projectTemplateSnapshot.create({
    data: {
      projectId: ids.project,
      sourceTemplateVersionId: version.id,
      sourceTemplateChecksum: version.checksum,
      snapshotChecksum,
      templateCode: template.code,
      templateName: version.name,
      templateVersion: version.version,
      templatePublishedAt: version.publishedAt
    }
  });
}

async function seedPublishedKnowledge() {
  const setupClient = restrictedFixtureSetupClient();
  const client = setupClient ?? db;
  try {
    await client.user.create({
      data: { id: ids.user, employeeNo: `KNOW-${suffix}`, name: "Knowledge search test" }
    });
    await createReadySourceProject(client);
    await client.knowledgeEntry.create({
      data: {
        id: ids.entry,
        code: `KNOW.SEARCH.${suffix}`.toUpperCase(),
        status: "ACTIVE",
        createdById: ids.user,
        updatedById: ids.user
      }
    });
    await client.knowledgeEntryVersion.create({
      data: {
        id: ids.version,
        entryId: ids.entry,
        sourceProjectId: ids.project,
        versionNo: 1,
        status: "PUBLISHED",
        title: "伺服抖动调参",
        sanitizedSummary: "仅包含内部通用调参经验。",
        experienceType: "COMMISSIONING",
        discipline: "ELECTRICAL",
        normalizedKeywordsJson: ["伺服", "抖动", "调参"],
        normalizedKeywordsText: "伺服 抖动 调参",
        applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
        applicableStageCodesJson: ["S5"],
        preconditions: "已备份基线参数。",
        recommendedPractice: "逐轴调整。",
        antiPatterns: "不得复制客户参数文件。",
        limitations: "仅适用于空载调试。",
        ipSanitizationDeclaration: "已完成脱敏。",
        internalReusable: true,
        contentChecksum: "a".repeat(64),
        createdById: ids.user,
        submittedById: ids.user,
        submittedAt: new Date(),
        publishedById: ids.user,
        publishedAt: new Date()
      }
    });
    await client.knowledgeEntry.update({
      where: { id: ids.entry },
      data: { currentPublishedVersionId: ids.version }
    });
    await client.knowledgeEntry.create({
      data: {
        id: ids.revokedEntry,
        code: `KNOW.SEARCH.REVOKED.${suffix}`.toUpperCase(),
        status: "REVOKED",
        createdById: ids.user,
        updatedById: ids.user
      }
    });
    await client.knowledgeEntryVersion.create({
      data: {
        id: ids.revokedVersion,
        entryId: ids.revokedEntry,
        sourceProjectId: ids.project,
        versionNo: 1,
        status: "PUBLISHED",
        title: "撤销知识不应公开",
        sanitizedSummary: "即使版本已发布也不可采用。",
        experienceType: "COMMISSIONING",
        discipline: "ELECTRICAL",
        normalizedKeywordsJson: ["伺服", "撤销"],
        normalizedKeywordsText: "伺服 撤销",
        applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
        applicableStageCodesJson: ["S5"],
        preconditions: "不适用。",
        recommendedPractice: "不适用。",
        antiPatterns: "不适用。",
        limitations: "撤销。",
        ipSanitizationDeclaration: "已脱敏。",
        internalReusable: true,
        contentChecksum: "b".repeat(64),
        createdById: ids.user,
        submittedById: ids.user,
        submittedAt: new Date(),
        publishedById: ids.user,
        publishedAt: new Date()
      }
    });
    await client.knowledgeEntry.create({
      data: {
        id: ids.staleEntry,
        code: `KNOW.SEARCH.STALE.${suffix}`.toUpperCase(),
        status: "ACTIVE",
        createdById: ids.user,
        updatedById: ids.user
      }
    });
    await client.knowledgeEntryVersion.createMany({
      data: [
        {
          id: ids.staleVersion,
          entryId: ids.staleEntry,
          sourceProjectId: ids.project,
          versionNo: 1,
          status: "PUBLISHED",
          title: "旧发布版本不应公开",
          sanitizedSummary: "旧指针版本。",
          experienceType: "COMMISSIONING",
          discipline: "ELECTRICAL",
          normalizedKeywordsJson: ["伺服", "旧版"],
          normalizedKeywordsText: "伺服 旧版",
          applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
          applicableStageCodesJson: ["S5"],
          preconditions: "不适用。",
          recommendedPractice: "不适用。",
          antiPatterns: "不适用。",
          limitations: "非当前版本。",
          ipSanitizationDeclaration: "已脱敏。",
          internalReusable: true,
          contentChecksum: "c".repeat(64),
          createdById: ids.user,
          submittedById: ids.user,
          submittedAt: new Date(),
          publishedById: ids.user,
          publishedAt: new Date()
        },
        {
          id: ids.staleCurrentVersion,
          entryId: ids.staleEntry,
          sourceProjectId: ids.project,
          versionNo: 2,
          status: "PUBLISHED",
          title: "当前发布版本",
          sanitizedSummary: "当前指针版本。",
          experienceType: "COMMISSIONING",
          discipline: "ELECTRICAL",
          normalizedKeywordsJson: ["其他"],
          normalizedKeywordsText: "其他",
          applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
          applicableStageCodesJson: ["S5"],
          preconditions: "不适用。",
          recommendedPractice: "不适用。",
          antiPatterns: "不适用。",
          limitations: "当前版本。",
          ipSanitizationDeclaration: "已脱敏。",
          internalReusable: true,
          contentChecksum: "d".repeat(64),
          createdById: ids.user,
          submittedById: ids.user,
          submittedAt: new Date(),
          publishedById: ids.user,
          publishedAt: new Date()
        }
      ]
    });
    await client.knowledgeEntry.update({
      where: { id: ids.staleEntry },
      data: { currentPublishedVersionId: ids.staleCurrentVersion }
    });
  } finally {
    await setupClient?.$disconnect();
  }
}

describeDatabase("APM-104 PostgreSQL knowledge search capability", () => {
  it.skipIf(process.env.APM104_RESTRICTED_NO_EXTENSION !== "1")(
    "server reports DEGRADED only when the restricted gate proves pg_trgm is absent",
    async () => {
      const extension = await db.$queryRaw<Array<{ available: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS available
    `;
      expect(extension[0]?.available).toBe(false);
      await expect(getKnowledgeSearchCapability(db)).resolves.toBe("DEGRADED");
    }
  );

  it.skipIf(process.env.APM104_NORMAL_TRIGRAM !== "1")(
    "server reports TRIGRAM only when the normal gate proves the extension and GIN index exist",
    async () => {
      const extension = await db.$queryRaw<Array<{ available: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS available
    `;
      expect(extension[0]?.available).toBe(true);
      await expect(getKnowledgeSearchCapability(db)).resolves.toBe("TRIGRAM");
    }
  );

  it("bounded ILIKE seeds and returns published knowledge", async () => {
    await seedPublishedKnowledge();
    const capability = await getKnowledgeSearchCapability(db);

    const result = await searchPublishedKnowledge(
      { query: "伺服", page: 1, pageSize: 20 },
      { getCapability: async () => capability, repository: createKnowledgeSearchRepository(db) }
    );

    expect(result.capability).toBe(capability);
    if (capability === "DEGRADED") {
      expect(result.warningCode).toBe("SEARCH_DEGRADED");
    } else {
      expect(result.warningCode).toBeNull();
    }
    expect(result.items).toContainEqual(
      expect.objectContaining({ entryCode: `KNOW.SEARCH.${suffix}`.toUpperCase() })
    );
    expect(result.items).not.toContainEqual(
      expect.objectContaining({ entryCode: `KNOW.SEARCH.REVOKED.${suffix}`.toUpperCase() })
    );
    expect(result.items).not.toContainEqual(
      expect.objectContaining({ entryCode: `KNOW.SEARCH.STALE.${suffix}`.toUpperCase() })
    );
  });
});
