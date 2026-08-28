import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  addProjectIssueRelation,
  createProjectIssue,
  IssueServiceError
} from "@/modules/issues/application/issue-service";
import {
  assertFailureRevisionLink,
  AcceptanceIssuePolicyError,
  type AcceptanceFailureRevision
} from "@/modules/issues/domain/acceptance-issue-policy";

import { AcceptanceServiceError } from "./acceptance-service";

type AcceptanceFailureSourceInput = Readonly<{
  acceptanceType: "FAT" | "SAT";
  batchId: string;
  scopeType: "PROJECT" | "DELIVERY_UNIT" | "MACHINE";
  scopeId: string;
  templateVersionId: string;
  templateChecksum: string;
  resultId: string;
  resultRevisionId: string;
  revisionNo: number;
  decision: "PASS" | "FAIL" | "NA";
  measuredValue: string | null;
  measuredUnit: string | null;
  note: string | null;
  item: Readonly<{
    id: string;
    code: string;
    name: string;
    method: string;
    acceptanceCriteria: string;
    unit: string | null;
  }>;
}>;

export function buildAcceptanceFailureSourceSnapshot(input: AcceptanceFailureSourceInput) {
  return {
    acceptanceType: input.acceptanceType,
    batchId: input.batchId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    templateVersionId: input.templateVersionId,
    templateChecksum: input.templateChecksum,
    resultId: input.resultId,
    resultRevisionId: input.resultRevisionId,
    revisionNo: input.revisionNo,
    decision: input.decision,
    measuredValue: input.measuredValue,
    measuredUnit: input.measuredUnit,
    note: input.note,
    testItem: {
      id: input.item.id,
      code: input.item.code,
      name: input.item.name,
      method: input.item.method,
      acceptanceCriteria: input.item.acceptanceCriteria,
      unit: input.item.unit
    }
  } as const;
}

type FailureRevisionRow = Prisma.AcceptanceTestResultRevisionGetPayload<{
  include: {
    result: {
      include: {
        batch: { include: { templateVersion: true } };
        item: true;
        revisions: { orderBy: { revisionNo: "desc" }; take: 1 };
      };
    };
  };
}>;

function serviceError(error: unknown): never {
  if (error instanceof AcceptanceIssuePolicyError) {
    throw new AcceptanceServiceError(error.code, error.message, error.status);
  }
  throw error;
}

async function loadFailureRevision(
  client: Prisma.TransactionClient | typeof db,
  projectId: string,
  batchId: string,
  revisionId: string
): Promise<FailureRevisionRow> {
  await client.$queryRaw`
    SELECT revision."id"
    FROM "acceptance_test_result_revisions" revision
    INNER JOIN "acceptance_test_results" result
      ON result."id" = revision."result_id" AND result."project_id" = revision."project_id"
    INNER JOIN "acceptance_batches" batch
      ON batch."id" = result."batch_id" AND batch."project_id" = result."project_id"
    WHERE revision."id" = ${revisionId}
      AND revision."project_id" = ${projectId}
      AND result."batch_id" = ${batchId}
    FOR UPDATE
  `;
  const revision = await client.acceptanceTestResultRevision.findFirst({
    where: { id: revisionId, projectId },
    include: {
      result: {
        include: {
          batch: { include: { templateVersion: true } },
          item: true,
          revisions: { orderBy: { revisionNo: "desc" }, take: 1 }
        }
      }
    }
  });
  if (!revision || revision.result.batchId !== batchId) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_FAILURE_REVISION_NOT_FOUND",
      "失败结果修订不存在或不属于当前验收批次。",
      404
    );
  }
  const failure: AcceptanceFailureRevision = {
    projectId: revision.projectId,
    batchId: revision.result.batchId,
    resultId: revision.result.id,
    revisionId: revision.id,
    acceptanceType: revision.result.batch.acceptanceType,
    decision: revision.decision
  };
  try {
    assertFailureRevisionLink({ projectId, expectedBatchId: batchId, failure });
  } catch (error) {
    return serviceError(error);
  }
  const current = revision.result.revisions[0];
  if (!current || current.id !== revision.id) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_FAILURE_REVISION_NOT_CURRENT",
      "只能从当前有效的 FAIL 结果修订建立问题关联。",
      409
    );
  }
  return revision;
}

function requiredText(value: unknown, field: string, max = 1024) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new AcceptanceServiceError(
      "ACCEPTANCE_ISSUE_INVALID_INPUT",
      `${field} 必须是 1 到 ${max} 个字符。`,
      422
    );
  }
  return value.trim();
}

export async function createIssueFromAcceptanceFailure(input: {
  projectId: string;
  batchId: string;
  resultRevisionId: string;
  title: unknown;
  confirmedText: unknown;
  category: unknown;
  severity: unknown;
  actorId: string;
  auditContext: AuditContext;
  transaction?: Prisma.TransactionClient;
}) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const batchId = requiredText(input.batchId, "batchId", 191);
  const revisionId = requiredText(input.resultRevisionId, "resultRevisionId", 191);
  const reason = "从 FAT/SAT FAIL 结果创建统一问题并建立 TEST_RESULT 关系。";
  return inTransaction(input.transaction, async (client) => {
    const revision = await loadFailureRevision(client, projectId, batchId, revisionId);
    const sourceSnapshot = buildAcceptanceFailureSourceSnapshot({
      acceptanceType: revision.result.batch.acceptanceType,
      batchId: revision.result.batch.id,
      scopeType: revision.result.batch.scopeType,
      scopeId: revision.result.batch.scopeId,
      templateVersionId: revision.result.batch.templateVersionId,
      templateChecksum: revision.result.batch.templateVersion.snapshotChecksum,
      resultId: revision.result.id,
      resultRevisionId: revision.id,
      revisionNo: revision.revisionNo,
      decision: revision.decision,
      measuredValue: revision.measuredValue,
      measuredUnit: revision.measuredUnit,
      note: revision.note,
      item: revision.result.item
    });
    const created = await createProjectIssue(
      {
        projectId,
        title: input.title,
        confirmedText: input.confirmedText,
        category: input.category,
        severity: input.severity,
        phenomenonDescription: null,
        rootCauseCategory: null,
        rootCauseDescription: null,
        tags: [],
        sourceType: revision.result.batch.acceptanceType,
        sourceSnapshot,
        creationReason: reason,
        actorId: input.actorId,
        auditContext: { ...input.auditContext, reason }
      },
      client
    );
    const relation = await addProjectIssueRelation(
      {
        projectId,
        issueId: created.issue.id,
        version: created.issue.version,
        relationType: "TEST_RESULT",
        targetId: revision.id,
        reason,
        actorId: input.actorId,
        auditContext: { ...input.auditContext, reason }
      },
      client
    );
    return { ...created, ...relation, sourceSnapshot };
  });
}

export async function linkExistingIssueToAcceptanceFailure(input: {
  projectId: string;
  issueId: string;
  issueVersion: unknown;
  batchId: string;
  resultRevisionId: string;
  reason: unknown;
  actorId: string;
  auditContext: AuditContext;
  transaction?: Prisma.TransactionClient;
}) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const batchId = requiredText(input.batchId, "batchId", 191);
  const revisionId = requiredText(input.resultRevisionId, "resultRevisionId", 191);
  const reason = requiredText(input.reason, "reason");
  return inTransaction(input.transaction, async (client) => {
    const revision = await loadFailureRevision(client, projectId, batchId, revisionId);
    try {
      return await addProjectIssueRelation(
        {
          projectId,
          issueId,
          version: input.issueVersion,
          relationType: "TEST_RESULT",
          targetId: revision.id,
          reason,
          actorId: input.actorId,
          auditContext: { ...input.auditContext, reason }
        },
        client
      );
    } catch (error) {
      if (error instanceof IssueServiceError) throw error;
      throw error;
    }
  });
}

export async function listIssuesForAcceptanceFailure(input: {
  projectId: string;
  batchId: string;
  resultRevisionId: string;
}) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const batchId = requiredText(input.batchId, "batchId", 191);
  const revisionId = requiredText(input.resultRevisionId, "resultRevisionId", 191);
  const revision = await loadFailureRevision(db, projectId, batchId, revisionId);
  const relations = await db.issueRelation.findMany({
    where: { projectId, relationType: "TEST_RESULT", targetId: revision.id, status: "ACTIVE" },
    include: {
      issue: {
        select: {
          id: true,
          projectId: true,
          title: true,
          category: true,
          severity: true,
          status: true,
          ownerMembershipId: true,
          verifierMembershipId: true,
          dueDate: true,
          version: true
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
  return {
    projectId,
    batchId,
    resultRevisionId: revision.id,
    issues: relations.map((relation) => ({
      relationId: relation.id,
      issue: {
        ...relation.issue,
        dueDate: relation.issue.dueDate?.toISOString().slice(0, 10) ?? null
      }
    }))
  };
}
