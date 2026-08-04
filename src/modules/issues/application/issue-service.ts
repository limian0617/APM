import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  ISSUE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  IssueLifecycleError,
  nextIssueStatus,
  normalizeIssueTags,
  type IssueAction,
  type IssueCategory,
  type IssueSeverity,
  type IssueStatus
} from "../domain/issue-lifecycle";

const issueInclude = {
  tags: { orderBy: { tag: "asc" } },
  history: { orderBy: { sequence: "asc" } }
} satisfies Prisma.IssueInclude;

type IssueFact = Prisma.IssueGetPayload<{ include: typeof issueInclude }>;
type IssueEventType =
  | "CREATED"
  | "DETAILS_UPDATED"
  | "STARTED_ANALYSIS"
  | "STARTED_PROCESSING"
  | "VERIFICATION_SUBMITTED"
  | "CLOSED"
  | "REOPENED";

export class IssueServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new IssueServiceError(
      "ISSUE_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`,
      422
    );
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maximum);
}

function category(value: unknown): IssueCategory {
  if (!ISSUE_CATEGORIES.includes(value as IssueCategory)) {
    throw new IssueServiceError(
      "ISSUE_INVALID_INPUT",
      "category 必须是预定义的问题一级分类。",
      422
    );
  }
  return value as IssueCategory;
}

function severity(value: unknown): IssueSeverity {
  if (!ISSUE_SEVERITIES.includes(value as IssueSeverity)) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "severity 必须是预定义的问题严重度。", 422);
  }
  return value as IssueSeverity;
}

function rootCauseCategory(
  value: unknown
):
  | "DESIGN"
  | "MANUFACTURING"
  | "ASSEMBLY"
  | "SOFTWARE"
  | "PROCUREMENT"
  | "MATERIAL"
  | "PROCESS"
  | "OTHER"
  | null {
  if (value === undefined || value === null) return null;
  const values = [
    "DESIGN",
    "MANUFACTURING",
    "ASSEMBLY",
    "SOFTWARE",
    "PROCUREMENT",
    "MATERIAL",
    "PROCESS",
    "OTHER"
  ] as const;
  if (!values.includes(value as (typeof values)[number])) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "rootCauseCategory 未注册。", 422);
  }
  return value as (typeof values)[number];
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "version 必须是正整数。", 422);
  }
  return value as number;
}

function action(value: unknown): IssueAction {
  const values: IssueAction[] = [
    "START_ANALYSIS",
    "START_PROCESSING",
    "SUBMIT_VERIFICATION",
    "VERIFY_CLOSE",
    "REOPEN"
  ];
  if (!values.includes(value as IssueAction)) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "action 不是受支持的问题状态动作。", 422);
  }
  return value as IssueAction;
}

function details(input: {
  title: unknown;
  confirmedText: unknown;
  category: unknown;
  severity: unknown;
  phenomenonDescription: unknown;
  rootCauseCategory: unknown;
  rootCauseDescription: unknown;
  tags: unknown;
}) {
  if (!Array.isArray(input.tags) || input.tags.length > 50) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "tags 必须是不超过 50 项的数组。", 422);
  }
  const causeCategory = rootCauseCategory(input.rootCauseCategory);
  const causeDescription = optionalText(input.rootCauseDescription, "rootCauseDescription", 10_000);
  if ((causeCategory === null) !== (causeDescription === null)) {
    throw new IssueServiceError(
      "ISSUE_INVALID_INPUT",
      "根因分类和根因描述必须同时提供或同时留空。",
      422
    );
  }
  try {
    return {
      title: requiredText(input.title, "title", 191),
      confirmedText: requiredText(input.confirmedText, "confirmedText", 10_000),
      category: category(input.category),
      severity: severity(input.severity),
      phenomenonDescription: optionalText(
        input.phenomenonDescription,
        "phenomenonDescription",
        10_000
      ),
      rootCauseCategory: causeCategory,
      rootCauseDescription: causeDescription,
      tags: normalizeIssueTags(input.tags)
    };
  } catch (error) {
    if (error instanceof IssueLifecycleError) {
      throw new IssueServiceError("ISSUE_INVALID_INPUT", error.message, 422);
    }
    throw error;
  }
}

function serializeIssue(issue: IssueFact) {
  return {
    id: issue.id,
    projectId: issue.projectId,
    title: issue.title,
    confirmedText: issue.confirmedText,
    sourceType: issue.sourceType,
    category: issue.category,
    severity: issue.severity,
    phenomenonDescription: issue.phenomenonDescription,
    rootCauseCategory: issue.rootCauseCategory,
    rootCauseDescription: issue.rootCauseDescription,
    status: issue.status,
    statusChangedAt: issue.statusChangedAt.toISOString(),
    closedAt: issue.closedAt?.toISOString() ?? null,
    closedById: issue.closedById,
    verificationEvidence: issue.verificationEvidence,
    version: issue.version,
    createdById: issue.createdById,
    updatedById: issue.updatedById,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
    tags: issue.tags.map((tag) => ({
      id: tag.id,
      tag: tag.tag,
      createdAt: tag.createdAt.toISOString()
    })),
    history: issue.history.map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      eventType: entry.eventType,
      reason: entry.reason,
      snapshot: entry.snapshotJson,
      actorId: entry.actorId,
      createdAt: entry.createdAt.toISOString()
    }))
  };
}

function auditValue(
  issue: ReturnType<typeof serializeIssue>,
  eventType: IssueEventType,
  reason: string
) {
  return {
    projectId: issue.projectId,
    issueId: issue.id,
    title: issue.title,
    sourceType: issue.sourceType,
    category: issue.category,
    severity: issue.severity,
    status: issue.status,
    rootCauseCategory: issue.rootCauseCategory,
    tagCount: issue.tags.length,
    eventType,
    reason,
    version: issue.version
  };
}

function historySnapshot(
  issue: ReturnType<typeof serializeIssue>,
  eventType: IssueEventType,
  reason: string
) {
  return {
    ...auditValue(issue, eventType, reason),
    confirmedText: issue.confirmedText,
    phenomenonDescription: issue.phenomenonDescription,
    rootCauseDescription: issue.rootCauseDescription,
    verificationEvidence: issue.verificationEvidence,
    tags: issue.tags.map((tag) => tag.tag)
  };
}

function historyEvent(action: IssueAction): IssueEventType {
  switch (action) {
    case "START_ANALYSIS":
      return "STARTED_ANALYSIS";
    case "START_PROCESSING":
      return "STARTED_PROCESSING";
    case "SUBMIT_VERIFICATION":
      return "VERIFICATION_SUBMITTED";
    case "VERIFY_CLOSE":
      return "CLOSED";
    case "REOPEN":
      return "REOPENED";
  }
}

function issueActionAudit(action: IssueAction) {
  if (action === "REOPEN") return AUDIT_ACTIONS.ISSUE_REOPENED;
  return AUDIT_ACTIONS.ISSUE_STATUS_CHANGED;
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。 ");
  return clock.now;
}

async function lockIssue(client: Prisma.TransactionClient, projectId: string, issueId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "issues" WHERE "id" = ${issueId} AND "project_id" = ${projectId} FOR UPDATE
  `;
  return client.issue.findFirst({ where: { id: issueId, projectId }, include: issueInclude });
}

async function lockProject(client: Prisma.TransactionClient, projectId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
  `;
  return client.project.findUnique({ where: { id: projectId } });
}

export function assertProjectIssuesWritable(status: string) {
  if (status === "CLOSED" || status === "CANCELED") {
    throw new IssueServiceError("PROJECT_READ_ONLY", "已关闭或取消项目不能写入问题。", 409);
  }
}

async function appendHistory(
  client: Prisma.TransactionClient,
  input: {
    issueId: string;
    projectId: string;
    eventType: IssueEventType;
    reason: string;
    snapshot: Record<string, unknown>;
    actorId: string;
  }
) {
  const sequence = (await client.issueHistory.count({ where: { issueId: input.issueId } })) + 1;
  return client.issueHistory.create({
    data: {
      issueId: input.issueId,
      projectId: input.projectId,
      sequence,
      eventType: input.eventType,
      reason: input.reason,
      snapshotJson: input.snapshot as Prisma.InputJsonValue,
      actorId: input.actorId
    }
  });
}

async function readIssueOrThrow(
  client: Prisma.TransactionClient,
  projectId: string,
  issueId: string
) {
  const issue = await client.issue.findFirst({
    where: { id: issueId, projectId },
    include: issueInclude
  });
  if (!issue) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
  return issue;
}

function context(
  input: { actorId: string; auditContext: AuditContext },
  projectId: string,
  reason: string
) {
  return { ...input.auditContext, actorId: input.actorId, projectId, reason };
}

export async function createProjectIssue(
  input: {
    projectId: string;
    title: unknown;
    confirmedText: unknown;
    category: unknown;
    severity: unknown;
    phenomenonDescription: unknown;
    rootCauseCategory: unknown;
    rootCauseDescription: unknown;
    tags: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const value = details(input);
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const issue = await client.issue.create({
      data: {
        projectId,
        title: value.title,
        confirmedText: value.confirmedText,
        sourceType: "PROJECT",
        category: value.category,
        severity: value.severity,
        phenomenonDescription: value.phenomenonDescription,
        rootCauseCategory: value.rootCauseCategory,
        rootCauseDescription: value.rootCauseDescription,
        createdById: input.actorId,
        updatedById: input.actorId,
        tags: { create: value.tags.map((tag) => ({ projectId, tag })) }
      },
      include: issueInclude
    });
    const serialized = serializeIssue(issue);
    const reason = "创建统一问题主记录。";
    await appendHistory(client, {
      issueId: issue.id,
      projectId,
      eventType: "CREATED",
      reason,
      snapshot: historySnapshot(serialized, "CREATED", reason),
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ISSUE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.ISSUE,
      objectId: issue.id,
      context: context(input, projectId, reason),
      after: { value: auditValue(serialized, "CREATED", reason), allowedFields: ISSUE_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "issues.issue.created",
      aggregateType: "ISSUE",
      aggregateId: issue.id,
      idempotencyKey: issue.id,
      payload: { ...auditValue(serialized, "CREATED", reason), auditId: audit.id }
    });
    return {
      issue: serializeIssue(await readIssueOrThrow(client, projectId, issue.id)),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function updateProjectIssue(
  input: {
    projectId: string;
    issueId: string;
    version: unknown;
    title: unknown;
    confirmedText: unknown;
    category: unknown;
    severity: unknown;
    phenomenonDescription: unknown;
    rootCauseCategory: unknown;
    rootCauseDescription: unknown;
    tags: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const expectedVersion = version(input.version);
  const reason = requiredText(input.reason, "reason", 1024);
  const value = details(input);
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const current = await lockIssue(client, projectId, issueId);
    if (!current) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
    if (current.status === "CLOSED") {
      throw new IssueServiceError("ISSUE_CLOSED", "已关闭问题必须先重开才能更新详情。", 409);
    }
    const updated = await client.issue.updateMany({
      where: { id: issueId, projectId, version: expectedVersion },
      data: {
        title: value.title,
        confirmedText: value.confirmedText,
        category: value.category,
        severity: value.severity,
        phenomenonDescription: value.phenomenonDescription,
        rootCauseCategory: value.rootCauseCategory,
        rootCauseDescription: value.rootCauseDescription,
        updatedById: input.actorId,
        version: { increment: 1 }
      }
    });
    if (updated.count !== 1) {
      throw new IssueServiceError("VERSION_CONFLICT", "问题已被其他操作更新。", 409);
    }
    await client.issueTag.deleteMany({ where: { issueId } });
    if (value.tags.length > 0) {
      await client.issueTag.createMany({
        data: value.tags.map((tag) => ({ projectId, issueId, tag }))
      });
    }
    const issue = serializeIssue(await readIssueOrThrow(client, projectId, issueId));
    await appendHistory(client, {
      issueId,
      projectId,
      eventType: "DETAILS_UPDATED",
      reason,
      snapshot: {
        before: historySnapshot(serializeIssue(current), "DETAILS_UPDATED", reason),
        after: historySnapshot(issue, "DETAILS_UPDATED", reason)
      },
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ISSUE_UPDATED,
      objectType: AUDIT_OBJECT_TYPES.ISSUE,
      objectId: issueId,
      context: context(input, projectId, reason),
      before: {
        value: auditValue(serializeIssue(current), "DETAILS_UPDATED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      },
      after: {
        value: auditValue(issue, "DETAILS_UPDATED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "issues.issue.updated",
      aggregateType: "ISSUE",
      aggregateId: issueId,
      idempotencyKey: `${issueId}:version:${issue.version}`,
      payload: { ...auditValue(issue, "DETAILS_UPDATED", reason), auditId: audit.id }
    });
    return {
      issue: serializeIssue(await readIssueOrThrow(client, projectId, issueId)),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function transitionProjectIssue(
  input: {
    projectId: string;
    issueId: string;
    version: unknown;
    action: unknown;
    reason: unknown;
    verificationEvidence: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const expectedVersion = version(input.version);
  const requestedAction = action(input.action);
  const reason = requiredText(input.reason, "reason", 1024);
  const evidence = optionalText(input.verificationEvidence, "verificationEvidence", 10_000);
  if (requestedAction === "VERIFY_CLOSE" && !evidence) {
    throw new IssueServiceError(
      "ISSUE_VERIFICATION_EVIDENCE_REQUIRED",
      "关闭问题必须提供验证证据。",
      422
    );
  }
  if (requestedAction !== "VERIFY_CLOSE" && evidence) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "只有关闭问题时可以提交验证证据。", 422);
  }
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const current = await lockIssue(client, projectId, issueId);
    if (!current) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
    let next: IssueStatus;
    try {
      next = nextIssueStatus(current.status as IssueStatus, requestedAction);
    } catch (error) {
      if (error instanceof IssueLifecycleError) {
        throw new IssueServiceError("ISSUE_TRANSITION_INVALID", error.message, 409);
      }
      throw error;
    }
    const now = await databaseNow(client);
    const updated = await client.issue.updateMany({
      where: { id: issueId, projectId, version: expectedVersion },
      data: {
        status: next,
        statusChangedAt: now,
        updatedById: input.actorId,
        version: { increment: 1 },
        ...(next === "CLOSED"
          ? { closedAt: now, closedById: input.actorId, verificationEvidence: evidence }
          : { closedAt: null, closedById: null, verificationEvidence: null })
      }
    });
    if (updated.count !== 1) {
      throw new IssueServiceError("VERSION_CONFLICT", "问题已被其他操作更新。", 409);
    }
    const eventType = historyEvent(requestedAction);
    const issue = serializeIssue(await readIssueOrThrow(client, projectId, issueId));
    await appendHistory(client, {
      issueId,
      projectId,
      eventType,
      reason,
      snapshot: {
        before: historySnapshot(serializeIssue(current), eventType, reason),
        after: historySnapshot(issue, eventType, reason)
      },
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: issueActionAudit(requestedAction),
      objectType: AUDIT_OBJECT_TYPES.ISSUE,
      objectId: issueId,
      context: context(input, projectId, reason),
      before: {
        value: auditValue(serializeIssue(current), eventType, reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      },
      after: { value: auditValue(issue, eventType, reason), allowedFields: ISSUE_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType:
        requestedAction === "REOPEN" ? "issues.issue.reopened" : "issues.issue.status-changed",
      aggregateType: "ISSUE",
      aggregateId: issueId,
      idempotencyKey: `${issueId}:version:${issue.version}`,
      payload: { ...auditValue(issue, eventType, reason), auditId: audit.id }
    });
    return {
      issue: serializeIssue(await readIssueOrThrow(client, projectId, issueId)),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function listProjectIssues(input: {
  projectId: string;
  cursor?: string;
  limit: number;
}) {
  if (input.cursor) {
    const cursor = await db.issue.findFirst({
      where: { id: input.cursor, projectId: input.projectId },
      select: { id: true }
    });
    if (!cursor) {
      throw new IssueServiceError(
        "ISSUE_CURSOR_NOT_FOUND",
        "问题列表游标不存在或不属于该项目。",
        404
      );
    }
  }
  const issues = await db.issue.findMany({
    where: { projectId: input.projectId },
    include: issueInclude,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const page = issues.slice(0, input.limit);
  return {
    issues: page.map(serializeIssue),
    nextCursor: issues.length > input.limit ? (page[page.length - 1]?.id ?? null) : null
  };
}

export async function getProjectIssue(projectId: string, issueId: string) {
  const issue = await db.issue.findFirst({
    where: { id: issueId, projectId },
    include: issueInclude
  });
  if (!issue) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
  return { issue: serializeIssue(issue) };
}
