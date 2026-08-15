import { randomUUID } from "node:crypto";

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
    await db.user.create({
      data: { id: ids.user, employeeNo: `KNOW-${suffix}`, name: "Knowledge search test" }
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `KNOW.SEARCH.${suffix}`.toUpperCase(),
        name: "Knowledge search source",
        status: "CLOSED",
        initializationStatus: "READY",
        projectType: "CUSTOMER_DELIVERY",
        equipmentShape: "SINGLE_MACHINE",
        structureStatus: "READY",
        createdById: ids.user
      }
    });
    await db.knowledgeEntry.create({
      data: {
        id: ids.entry,
        code: `KNOW.SEARCH.${suffix}`.toUpperCase(),
        status: "ACTIVE",
        createdById: ids.user,
        updatedById: ids.user
      }
    });
    await db.knowledgeEntryVersion.create({
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
    await db.knowledgeEntry.update({
      where: { id: ids.entry },
      data: { currentPublishedVersionId: ids.version }
    });
    await db.knowledgeEntry.create({
      data: {
        id: ids.revokedEntry,
        code: `KNOW.SEARCH.REVOKED.${suffix}`.toUpperCase(),
        status: "REVOKED",
        createdById: ids.user,
        updatedById: ids.user
      }
    });
    await db.knowledgeEntryVersion.create({
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
    await db.knowledgeEntry.create({
      data: {
        id: ids.staleEntry,
        code: `KNOW.SEARCH.STALE.${suffix}`.toUpperCase(),
        status: "ACTIVE",
        createdById: ids.user,
        updatedById: ids.user
      }
    });
    await db.knowledgeEntryVersion.createMany({
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
    await db.knowledgeEntry.update({
      where: { id: ids.staleEntry },
      data: { currentPublishedVersionId: ids.staleCurrentVersion }
    });

    const result = await searchPublishedKnowledge(
      { query: "伺服", page: 1, pageSize: 20 },
      { getCapability: async () => "DEGRADED", repository: createKnowledgeSearchRepository(db) }
    );

    expect(result).toMatchObject({ capability: "DEGRADED", warningCode: "SEARCH_DEGRADED" });
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
