import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_BATCH_STATUSES,
  ACCEPTANCE_DECISIONS,
  ACCEPTANCE_SCOPE_TYPES,
  ACCEPTANCE_TYPES,
  AcceptancePolicyError,
  assertBatchCanTransition,
  assertBatchMutable,
  assertFailureIssueLinksPresent,
  assertRetestBatchCompatible,
  assertMeasuredUnitMatchesFrozenDefinition,
  assertRequiredEvidencePresent,
  assertScopeBelongsToProject,
  calculateAcceptanceTemplateChecksum,
  calculateAcceptanceSummary,
  normalizeAcceptanceEvidenceFileIds,
  validateMeasuredValue,
  validateTemplateSnapshot
} from "./acceptance-policy";

describe("acceptance policy", () => {
  it("normalizes a revision evidence list and rejects duplicated file references", () => {
    expect(normalizeAcceptanceEvidenceFileIds(["file-1", " file-2 "])).toEqual([
      "file-1",
      "file-2"
    ]);
    try {
      normalizeAcceptanceEvidenceFileIds(["file-1", "file-1"]);
      throw new Error("expected duplicated evidence to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "ACCEPTANCE_EVIDENCE_DUPLICATE" });
    }
  });

  it("rejects a required-evidence result when no append-only evidence reference exists", () => {
    expect(() =>
      assertRequiredEvidencePresent([
        { evidenceRequired: true, decision: "PASS", evidenceCount: 0 },
        { evidenceRequired: false, decision: "PASS", evidenceCount: 0 }
      ])
    ).toThrowError("必测证据尚未引用已扫描且可用的文件。");
    expect(() =>
      assertRequiredEvidencePresent([
        { evidenceRequired: true, decision: "PASS", evidenceCount: 1 },
        { evidenceRequired: true, decision: null, evidenceCount: 0 }
      ])
    ).not.toThrow();
  });
  const frozenItem = {
    code: "POWER",
    name: "上电",
    position: 1,
    method: "观察",
    acceptanceCriteria: "正常",
    unit: "V",
    required: true,
    evidenceRequired: true,
    applicableScope: "MACHINE",
    defaultDiscipline: "电气"
  };

  it("exposes the frozen FAT/SAT and scope vocabularies", () => {
    expect(ACCEPTANCE_TYPES).toEqual(["FAT", "SAT"]);
    expect(ACCEPTANCE_SCOPE_TYPES).toEqual(["PROJECT", "DELIVERY_UNIT", "MACHINE"]);
    expect(ACCEPTANCE_BATCH_STATUSES).toEqual(["DRAFT", "IN_PROGRESS", "LOCKED"]);
    expect(ACCEPTANCE_DECISIONS).toEqual(["PASS", "FAIL", "NA"]);
  });

  it("rejects a template snapshot with duplicate or incomplete test items", () => {
    expect(() =>
      validateTemplateSnapshot({
        items: [
          {
            code: "POWER",
            name: "上电",
            position: 1,
            method: "观察",
            acceptanceCriteria: "正常",
            unit: null,
            required: true,
            evidenceRequired: false,
            applicableScope: "PROJECT",
            defaultDiscipline: "电气"
          },
          {
            code: "POWER",
            name: "重复上电",
            position: 1,
            method: "观察",
            acceptanceCriteria: "正常",
            unit: null,
            required: true,
            evidenceRequired: false,
            applicableScope: "PROJECT",
            defaultDiscipline: "电气"
          }
        ]
      })
    ).toThrowError(AcceptancePolicyError);
  });

  it("requires a project, delivery unit, or machine scope to belong to the project", () => {
    expect(() =>
      assertScopeBelongsToProject({
        projectId: "project-a",
        scopeType: "MACHINE",
        scopeId: "machine-b",
        scope: { id: "machine-b", projectId: "project-b" }
      })
    ).toThrowError("验收范围不属于当前项目。");

    expect(() =>
      assertScopeBelongsToProject({
        projectId: "project-a",
        scopeType: "PROJECT",
        scopeId: "project-a",
        scope: { id: "project-a", projectId: "project-a" }
      })
    ).not.toThrow();
  });

  it("allows only DRAFT to IN_PROGRESS to LOCKED transitions", () => {
    expect(assertBatchCanTransition("DRAFT", "IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(assertBatchCanTransition("IN_PROGRESS", "LOCKED")).toBe("LOCKED");
    expect(() => assertBatchCanTransition("LOCKED", "IN_PROGRESS")).toThrowError(
      "已锁定的验收批次不可重新打开。"
    );
  });

  it("rejects all mutations once a batch is locked", () => {
    expect(() => assertBatchMutable("LOCKED")).toThrowError("验收批次已锁定，不可修改。");
    expect(() => assertBatchMutable("DRAFT")).not.toThrow();
  });

  it("calculates PASS divided by PASS plus FAIL and never treats NA as 100 percent", () => {
    expect(
      calculateAcceptanceSummary([
        { required: true, decision: "PASS" },
        { required: true, decision: "FAIL" },
        { required: false, decision: "NA" }
      ])
    ).toEqual({
      passCount: 1,
      failCount: 1,
      naCount: 1,
      unexecutedRequiredCount: 0,
      denominator: 2,
      passRate: 0.5,
      outcome: "FAILED"
    });

    expect(calculateAcceptanceSummary([{ required: true, decision: "NA" }])).toEqual({
      passCount: 0,
      failCount: 0,
      naCount: 1,
      unexecutedRequiredCount: 0,
      denominator: 0,
      passRate: null,
      outcome: "NOT_CALCULABLE"
    });
  });

  it("does not pass when a required item has no result", () => {
    expect(calculateAcceptanceSummary([{ required: true, decision: null }])).toMatchObject({
      unexecutedRequiredCount: 1,
      outcome: "PENDING"
    });
  });

  it("refuses to lock a batch when a current FAIL has no active unified issue relation", () => {
    expect(() =>
      assertFailureIssueLinksPresent([
        { decision: "FAIL", hasActiveIssueRelation: false },
        { decision: "PASS", hasActiveIssueRelation: false },
        { decision: "NA", hasActiveIssueRelation: false }
      ])
    ).toThrowError("失败测试项尚未关联有效统一问题，验收批次不能锁定。 ".trim());
    expect(() =>
      assertFailureIssueLinksPresent([
        { decision: "FAIL", hasActiveIssueRelation: true },
        { decision: "PASS", hasActiveIssueRelation: false }
      ])
    ).not.toThrow();
  });

  it("accepts text measured values and rejects arbitrary non-text values", () => {
    expect(validateMeasuredValue("230V")).toBe("230V");
    expect(validateMeasuredValue(null)).toBeNull();
    expect(() => validateMeasuredValue(230)).toThrowError("measuredValue 必须是文本或 null。");
  });

  it("computes one deterministic server checksum from normalized frozen template content", () => {
    const first = calculateAcceptanceTemplateChecksum({
      acceptanceType: "FAT",
      items: [{ ...frozenItem, name: "  上电  " }]
    });
    const same = calculateAcceptanceTemplateChecksum({
      acceptanceType: "FAT",
      items: [{ ...frozenItem }]
    });
    const changed = calculateAcceptanceTemplateChecksum({
      acceptanceType: "FAT",
      items: [{ ...frozenItem, acceptanceCriteria: "电压稳定" }]
    });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first).toBe(same);
    expect(changed).not.toBe(first);
  });

  it("uses the frozen item unit and rejects client unit substitution", () => {
    expect(() => assertMeasuredUnitMatchesFrozenDefinition("V", "V")).not.toThrow();
    expect(() => assertMeasuredUnitMatchesFrozenDefinition("V", "A")).toThrowError(
      "实测单位必须与冻结测试项单位一致。"
    );
    expect(() => assertMeasuredUnitMatchesFrozenDefinition(null, "V")).toThrowError(
      "未定义单位的测试项不能录入实测单位。"
    );
  });

  it("permits a retest only for a locked batch with exactly the same type and scope", () => {
    const original = {
      projectId: "project-1",
      acceptanceType: "FAT" as const,
      scopeType: "MACHINE" as const,
      scopeId: "machine-1",
      status: "LOCKED" as const
    };
    expect(() =>
      assertRetestBatchCompatible({
        projectId: "project-1",
        acceptanceType: "FAT",
        scopeType: "MACHINE",
        scopeId: "machine-1",
        original
      })
    ).not.toThrow();
    expect(() =>
      assertRetestBatchCompatible({
        projectId: "project-1",
        acceptanceType: "SAT",
        scopeType: "MACHINE",
        scopeId: "machine-1",
        original
      })
    ).toThrowError("重测批次必须与原批次使用相同验收类型和范围。");
  });
});
