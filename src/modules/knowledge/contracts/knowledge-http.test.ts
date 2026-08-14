import { describe, expect, it } from "vitest";

import {
  createKnowledgeEntryBodySchema,
  createKnowledgeEntryVersionBodySchema,
  knowledgeCorrectionBodySchema,
  knowledgeReviewBodySchema,
  knowledgeRevokeBodySchema,
  knowledgeReuseBodySchema,
  knowledgeSearchQuerySchema,
  knowledgeSubmitBodySchema
} from "./knowledge-http";

const draft = {
  title: "  输送线卡料的隔离与复位  ",
  sanitizedSummary: "  先隔离，再确认传感器状态。  ",
  experienceType: "LESSON_LEARNED",
  discipline: "MECHANICAL",
  keywords: ["输送线", "卡料"],
  applicableProjectTypes: ["LINE"],
  applicableStageCodes: ["S4"],
  preconditions: "设备已停机。",
  recommendedPractice: "按受控步骤复位。",
  antiPatterns: "不得带电清障。",
  limitations: "不适用于运动中的设备。",
  ipSanitizationDeclaration: "已移除客户、人员与图纸标识。",
  internalReusable: true
};

describe("knowledge HTTP contracts", () => {
  it("bounds and normalizes public search filters while rejecting unknown query fields", () => {
    expect(
      knowledgeSearchQuerySchema.parse({
        query: "  卡料 ",
        page: "2",
        pageSize: "20",
        experienceType: " lesson_learned ",
        discipline: " mechanical ",
        applicableProjectType: " line ",
        applicableStageCode: " s4 "
      })
    ).toEqual({
      query: "卡料",
      page: 2,
      pageSize: 20,
      experienceType: "LESSON_LEARNED",
      discipline: "MECHANICAL",
      applicableProjectType: "LINE",
      applicableStageCode: "S4"
    });
    expect(
      knowledgeSearchQuerySchema.safeParse({ query: "卡料", unsupported: "yes" }).success
    ).toBe(false);
    expect(knowledgeSearchQuerySchema.safeParse({ query: "卡料", pageSize: "21" }).success).toBe(
      false
    );
    expect(knowledgeSearchQuerySchema.safeParse({ query: "知".repeat(65) }).success).toBe(false);
  });

  it("requires exact sanitized source facts and rejects unknown create fields", () => {
    const create = createKnowledgeEntryBodySchema.parse({
      code: " knw-001 ",
      sourceProjectId: "source-project-1",
      finalArchiveVersionId: "archive-b-1",
      retrospectiveInputArchiveVersionId: "archive-a-1",
      retrospectiveVersionId: "retrospective-1",
      issueHistoryIds: ["issue-history-1"],
      draft,
      expectedEntryVersion: null
    });

    expect(create.code).toBe("KNW-001");
    expect(create.draft.title).toBe("输送线卡料的隔离与复位");
    expect(
      createKnowledgeEntryBodySchema.safeParse({
        ...create,
        sourceProjectId: "",
        customerName: "must-not-be-accepted"
      }).success
    ).toBe(false);
    expect(
      createKnowledgeEntryVersionBodySchema.safeParse({
        ...create,
        expectedEntryVersion: 3
      }).success
    ).toBe(true);
  });

  it("accepts only versioned review, revoke, reuse, and correction commands", () => {
    expect(knowledgeSubmitBodySchema.parse({ expectedEntryVersion: 3 })).toEqual({
      expectedEntryVersion: 3
    });
    expect(
      knowledgeReviewBodySchema.parse({
        expectedEntryVersion: 3,
        decision: "PUBLISH",
        reason: "已完成脱敏与知识产权检查。",
        ipConfirmed: true,
        sanitizationConfirmed: true
      })
    ).toMatchObject({ decision: "PUBLISH", expectedEntryVersion: 3 });
    expect(
      knowledgeRevokeBodySchema.parse({
        versionId: "knowledge-version-1",
        expectedEntryVersion: 3,
        reason: "发现过期的安全前提。"
      })
    ).toMatchObject({ versionId: "knowledge-version-1" });
    expect(
      knowledgeSubmitBodySchema.safeParse({
        expectedEntryVersion: 3,
        sourceProjectId: "forged-project"
      }).success
    ).toBe(false);
    expect(
      knowledgeReviewBodySchema.safeParse({
        expectedEntryVersion: 3,
        sourceProjectId: "forged-project",
        decision: "PUBLISH",
        reason: "已完成脱敏与知识产权检查。",
        ipConfirmed: true,
        sanitizationConfirmed: true
      }).success
    ).toBe(false);
    expect(
      knowledgeRevokeBodySchema.safeParse({
        versionId: "knowledge-version-1",
        sourceProjectId: "forged-project",
        expectedEntryVersion: 3,
        reason: "发现过期的安全前提。"
      }).success
    ).toBe(false);
    expect(
      knowledgeReuseBodySchema.parse({
        targetDeliveryUnitId: null,
        knowledgeEntryId: "knowledge-entry-1",
        knowledgeVersionId: "knowledge-version-1",
        scenario: "新产线的上料段复位。",
        evidenceSummary: "现场验证记录已归档。"
      })
    ).toMatchObject({ knowledgeEntryId: "knowledge-entry-1" });
    expect(
      knowledgeCorrectionBodySchema.parse({
        expectedReuseVersion: 2,
        correctionType: "SCOPE_CORRECTION",
        reason: "适用范围说明不完整。",
        correctionText: "仅适用于停机状态。"
      })
    ).toMatchObject({ expectedReuseVersion: 2 });
    expect(
      knowledgeCorrectionBodySchema.safeParse({
        expectedReuseVersion: 2,
        correctionType: "SCOPE_CORRECTION",
        reason: "适用范围说明不完整。",
        correctionText: "仅适用于停机状态。",
        untracked: true
      }).success
    ).toBe(false);
  });
});
