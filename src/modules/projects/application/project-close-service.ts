import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { getArchiveSourceFormulaAdapter } from "@/modules/archives/application/archive-source-formula-registry";
import {
  archiveSourceFormulaFromPersistence,
  ARCHIVE_SOURCE_FORMULAS
} from "@/modules/archives/domain/archive-source-formula";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ARCHIVE_VERSION_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_SOURCES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";
import {
  CLOSURE_POLICY_BINDINGS,
  CLOSURE_POLICY_SELF_REFERENCE_EXCLUSION,
  buildClosurePolicyVersionFacts
} from "@/modules/governance/domain/project-closure-policy";

export type ProjectCloseFacts = {
  projectId: string;
  projectStatus: string;
  projectVersion: number;
  expectedProjectVersion: number;
  g9Approved: boolean;
  g9SubmissionProjectId: string | null;
  g9ArchiveVersionId: string | null;
  g9ClosurePolicyVersionId: string | null;
  g9ClosurePolicyChecksum: string | null;
  g9ArchiveSourceFormulaVersion: string | null;
  g9SnapshotStatus: string | null;
  archiveVersionId: string | null;
  archiveStatus: string | null;
  archiveSourceFormulaVersion: string | null;
  manifestChecksum: string | null;
  g9ManifestChecksum: string | null;
  sourceWatermark: string | null;
  g9SourceWatermark: string | null;
  sourceFactsCurrent: boolean;
  latestIntegrityStatus: string | null;
  archiveInputWatermark: string | null;
  archiveInputApplicability: string | null;
  g9ArchiveInputWatermark: string | null;
  archiveAInputWatermark: string | null;
  archiveAActualInputWatermark: string | null;
  archiveAId: string | null;
  archiveAStatus: string | null;
  archiveAFormula: string | null;
  archiveAInputApplicability: string | null;
  retrospectiveInputArchiveVersionId: string | null;
  retrospectiveInputArchiveManifestChecksum: string | null;
  retrospectiveInputArchiveSourceWatermark: string | null;
  archiveAManifestChecksum: string | null;
  archiveASourceWatermark: string | null;
  policyVersionId: string | null;
  policyChecksum: string | null;
  policyArchiveSourceFormulaVersion: string | null;
  policyBindingsValid: boolean;
  snapshotCheckerBindingsValid: boolean;
  sourceGateDefinitionBindingsValid: boolean;
  policyFactsValid: boolean;
  policySourceGateDefinitionMatches: boolean;
  policyIsActive: boolean;
  policyIsCurrent: boolean;
  gateInstancePolicyVersionId: string | null;
  gateInstancePolicyChecksum: string | null;
  gateInstanceArchiveSourceFormulaVersion: string | null;
  gateSnapshotPolicyVersionId: string | null;
  gateSnapshotPolicyChecksum: string | null;
  gateSnapshotArchiveSourceFormulaVersion: string | null;
  archiveCheckerPassed: boolean;
  retrospectiveCheckerPassed: boolean;
  retrospectiveVersionId: string | null;
  retrospectiveStatus: string | null;
  retrospectiveContentChecksum: string | null;
  g9RetrospectiveContentChecksum: string | null;
  currentRetrospectiveVersionId: string | null;
  latestApprovedRetrospectiveVersionId: string | null;
  archiveBIncludesRetrospectiveVersion: boolean;
  openResidualItemIds: readonly string[];
};

export type IntegrityFact = { id: string; sequence: number; status: string };

const PROJECT_CLOSURE_RECORD_AUDIT_FIELDS = [
  "projectId",
  "closureRecordId",
  "archiveBId",
  "archiveBManifestChecksum",
  "archiveBSourceWatermark",
  "closurePolicyVersionId",
  "closurePolicyChecksum",
  "retrospectiveVersionId"
] as const;

export const CLOSE_PROJECT_LOCK_ORDER = [
  "PROJECT",
  "ARCHIVE_B_AND_AGGREGATE",
  "ARCHIVE_A",
  "RETROSPECTIVE_AGGREGATE_AND_VERSION",
  "G9_INSTANCE_SNAPSHOT_AND_SUBMISSION",
  "CLOSURE_POLICY_AND_VERSION",
  "RESIDUALS",
  "CLOSURE_RECORD"
] as const;

export const CLOSE_PROJECT_TRANSACTION_MAX_ATTEMPTS = 3;

export const CLOSE_PROJECT_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 30_000
} as const;

export function archiveFormulaForClose(value: string | null | undefined): string | null {
  if (value !== "V1" && value !== "V2") return null;
  try {
    return archiveSourceFormulaFromPersistence(value);
  } catch {
    return null;
  }
}

export function latestIntegrityStatus(checks: readonly IntegrityFact[]): IntegrityFact | null {
  return [...checks].sort((left, right) => right.sequence - left.sequence)[0] ?? null;
}

export class ProjectCloseError extends Error {
  constructor(
    readonly code:
      | "PROJECT_G9_NOT_APPROVED"
      | "PROJECT_ARCHIVE_NOT_READY"
      | "PROJECT_ARCHIVE_FACTS_STALE"
      | "PROJECT_RESIDUALS_OPEN"
      | "PROJECT_VERSION_CONFLICT"
      | "PROJECT_NOT_FOUND"
      | "PROJECT_ALREADY_CLOSED"
      | "CLOSURE_POLICY_VERSION_REQUIRED"
      | "CLOSURE_POLICY_STALE"
      | "CLOSURE_POLICY_BINDING_MISMATCH"
      | "CLOSURE_SUBMISSION_PROJECT_MISMATCH"
      | "CLOSURE_G9_CHECK_FAILED"
      | "CLOSURE_RETROSPECTIVE_NOT_CURRENT"
      | "CLOSURE_TRANSACTION_CONFLICT"
      | "IDEMPOTENCY_KEY_REUSED"
      | "CLOSE_IDEMPOTENCY_RESULT_UNAVAILABLE",
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "ProjectCloseError";
  }
}

export function assertProjectCanClose(facts: ProjectCloseFacts): void {
  if (facts.expectedProjectVersion !== facts.projectVersion) {
    throw new ProjectCloseError("PROJECT_VERSION_CONFLICT", "项目已变化，请刷新后重试。");
  }
  if (facts.projectStatus === "CLOSED") {
    throw new ProjectCloseError("PROJECT_ALREADY_CLOSED", "项目已经结项。");
  }
  if (facts.g9SubmissionProjectId !== facts.projectId) {
    throw new ProjectCloseError("CLOSURE_SUBMISSION_PROJECT_MISMATCH", "G9 申请不属于当前项目。");
  }
  if (!facts.g9Approved || !facts.g9ArchiveVersionId) {
    throw new ProjectCloseError("PROJECT_G9_NOT_APPROVED", "项目级 G9 尚未批准。");
  }
  if (!facts.policyVersionId || !facts.policyChecksum || !facts.g9ClosurePolicyVersionId) {
    throw new ProjectCloseError(
      "CLOSURE_POLICY_VERSION_REQUIRED",
      "G9 申请没有冻结可执行的关项策略版本。"
    );
  }
  if (
    !facts.policyIsActive ||
    !facts.policyIsCurrent ||
    facts.g9ClosurePolicyVersionId !== facts.policyVersionId
  ) {
    throw new ProjectCloseError("CLOSURE_POLICY_STALE", "G9 申请未引用当前可执行的关项策略版本。");
  }
  if (
    !facts.policyBindingsValid ||
    !facts.snapshotCheckerBindingsValid ||
    !facts.sourceGateDefinitionBindingsValid ||
    !facts.policyFactsValid ||
    !facts.policySourceGateDefinitionMatches ||
    facts.g9ClosurePolicyChecksum !== facts.policyChecksum ||
    facts.g9ArchiveSourceFormulaVersion !== "ARCHIVE.SOURCE@2" ||
    facts.policyArchiveSourceFormulaVersion !== "ARCHIVE.SOURCE@2" ||
    facts.gateInstancePolicyVersionId !== facts.policyVersionId ||
    facts.gateInstancePolicyChecksum !== facts.policyChecksum ||
    facts.gateInstanceArchiveSourceFormulaVersion !== "ARCHIVE.SOURCE@2" ||
    facts.gateSnapshotPolicyVersionId !== facts.policyVersionId ||
    facts.gateSnapshotPolicyChecksum !== facts.policyChecksum ||
    facts.gateSnapshotArchiveSourceFormulaVersion !== "ARCHIVE.SOURCE@2"
  ) {
    throw new ProjectCloseError(
      "CLOSURE_POLICY_BINDING_MISMATCH",
      "G9 申请、检查快照、实例与关项策略绑定不一致。"
    );
  }
  if (!facts.archiveCheckerPassed || !facts.retrospectiveCheckerPassed) {
    throw new ProjectCloseError("CLOSURE_G9_CHECK_FAILED", "G9 V2 检查未全部通过。");
  }
  if (facts.g9SnapshotStatus !== "PASSED") {
    throw new ProjectCloseError("CLOSURE_G9_CHECK_FAILED", "G9 检查快照不是通过状态。");
  }
  if (
    !facts.archiveVersionId ||
    facts.archiveVersionId !== facts.g9ArchiveVersionId ||
    facts.archiveStatus !== "READY" ||
    facts.archiveSourceFormulaVersion !== "ARCHIVE.SOURCE@2" ||
    facts.archiveInputApplicability !== "APPLICABLE" ||
    !facts.manifestChecksum ||
    !facts.sourceWatermark ||
    facts.latestIntegrityStatus !== "PASSED"
  ) {
    throw new ProjectCloseError("PROJECT_ARCHIVE_NOT_READY", "归档版本不是确切的 READY 版本。");
  }
  if (
    facts.manifestChecksum !== facts.g9ManifestChecksum ||
    facts.sourceWatermark !== facts.g9SourceWatermark ||
    !facts.sourceFactsCurrent
  ) {
    throw new ProjectCloseError(
      "PROJECT_ARCHIVE_FACTS_STALE",
      "归档事实已偏离 G9 快照，请重新检查。"
    );
  }
  if (
    facts.archiveInputWatermark !== facts.g9ArchiveInputWatermark ||
    facts.archiveAInputWatermark !== facts.archiveInputWatermark ||
    facts.archiveAActualInputWatermark !== facts.archiveInputWatermark
  ) {
    throw new ProjectCloseError(
      "PROJECT_ARCHIVE_FACTS_STALE",
      "归档 B 的复盘输入水位已偏离 G9 快照。"
    );
  }
  if (
    !facts.retrospectiveVersionId ||
    facts.retrospectiveStatus !== "APPROVED" ||
    !facts.retrospectiveContentChecksum ||
    facts.g9RetrospectiveContentChecksum !== facts.retrospectiveContentChecksum ||
    facts.currentRetrospectiveVersionId !== facts.retrospectiveVersionId ||
    facts.latestApprovedRetrospectiveVersionId !== facts.retrospectiveVersionId ||
    !facts.archiveBIncludesRetrospectiveVersion
  ) {
    throw new ProjectCloseError(
      "CLOSURE_RETROSPECTIVE_NOT_CURRENT",
      "当前批准复盘未被最终归档冻结。"
    );
  }
  if (
    facts.archiveAId !== facts.retrospectiveInputArchiveVersionId ||
    facts.archiveAStatus !== "READY" ||
    facts.archiveAFormula !== "ARCHIVE.SOURCE@2" ||
    facts.archiveAInputApplicability !== "APPLICABLE" ||
    facts.retrospectiveInputArchiveManifestChecksum !== facts.archiveAManifestChecksum ||
    facts.retrospectiveInputArchiveSourceWatermark !== facts.archiveASourceWatermark
  ) {
    throw new ProjectCloseError(
      "CLOSURE_RETROSPECTIVE_NOT_CURRENT",
      "当前批准复盘的归档 A 输入事实已变化。"
    );
  }
  if (facts.openResidualItemIds.length > 0) {
    throw new ProjectCloseError("PROJECT_RESIDUALS_OPEN", "仍存在未闭环遗留项，不能结项。");
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workerContext(actorId: string, projectId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: null,
    traceId: operationId,
    source: AUDIT_SOURCES.API,
    sourceIp: null,
    userAgent: null,
    reason: null,
    projectId,
    departmentId: null,
    operationId
  };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

export type CloseProjectInput = {
  projectId: string;
  archiveVersionId: string;
  g9SubmissionId: string;
  expectedProjectVersion: number;
  actorId: string;
  operationId: string;
  idempotencyKey: string;
};

export type CloseProjectResult = {
  projectId: string;
  status: "CLOSED";
  finalArchiveVersionId: string;
  idempotent: boolean;
};

class CloseIdempotencyClaimConflict extends Error {}

function requiredCommandText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191) {
    throw new TypeError(`${field} 必须是 1 到 191 个字符。`);
  }
  return normalized;
}

function responseJson(value: CloseProjectResult): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function errorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

/** PostgreSQL can surface the same transient conflict through Prisma or its cause chain. */
export function isRetryableCloseTransactionError(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate: unknown = error;
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const code = errorCode(candidate);
    if (code === "P2034" || code === "40001" || code === "40P01") return true;
    const record = candidate as Record<string, unknown>;
    const metaCode = errorCode(record.meta);
    if (metaCode === "40001" || metaCode === "40P01") return true;
    candidate = record.cause;
  }
  return false;
}

function parseCheckerBindings(value: unknown): Array<{ code: string; version: number }> | null {
  if (!Array.isArray(value)) return null;
  const bindings = value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).code !== "string" ||
      !Number.isInteger((entry as Record<string, unknown>).version)
    ) {
      return [];
    }
    return [
      {
        code: (entry as Record<string, unknown>).code as string,
        version: (entry as Record<string, unknown>).version as number
      }
    ];
  });
  return bindings.length === value.length ? bindings : null;
}

function hasExactClosureBindings(
  bindings: Array<{ code: string; version: number }> | null
): boolean {
  if (!bindings) return false;
  try {
    const expected = buildClosurePolicyVersionFacts({
      projectId: "binding-check-project",
      sourceTemplateSnapshotId: "binding-check-template",
      sourceGateDefinitionId: "binding-check-definition",
      checkerBindings: bindings
    });
    return expected.archiveCheckerCode === CLOSURE_POLICY_BINDINGS[0].code;
  } catch {
    return false;
  }
}

export function evaluateClosurePolicyBinding(input: {
  projectId: string;
  sourceTemplateSnapshotId: string;
  sourceGateDefinitionId: string;
  sourceGateDefinitionBindings: Array<{ code: string; version: number }> | null;
  snapshotBindings: Array<{ code: string; version: number }> | null;
  persisted: {
    archiveCheckerCode: string;
    archiveCheckerVersion: number;
    retrospectiveCheckerCode: string;
    retrospectiveCheckerVersion: number;
    archiveSourceFormulaVersion: string;
    selfReferenceExclusionVersion: string;
    bindingChecksum: string;
    policyChecksum: string;
  } | null;
}) {
  const sourceGateDefinitionBindingsValid = hasExactClosureBindings(
    input.sourceGateDefinitionBindings
  );
  const snapshotCheckerBindingsValid = hasExactClosureBindings(input.snapshotBindings);
  try {
    const snapshotFacts =
      input.persisted && input.snapshotBindings
        ? buildClosurePolicyVersionFacts({
            projectId: input.projectId,
            sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
            sourceGateDefinitionId: input.sourceGateDefinitionId,
            checkerBindings: input.snapshotBindings
          })
        : null;
    const sourceDefinitionFacts =
      input.persisted && input.sourceGateDefinitionBindings
        ? buildClosurePolicyVersionFacts({
            projectId: input.projectId,
            sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
            sourceGateDefinitionId: input.sourceGateDefinitionId,
            checkerBindings: input.sourceGateDefinitionBindings
          })
        : null;
    return {
      sourceGateDefinitionBindingsValid,
      snapshotCheckerBindingsValid,
      policyFactsValid: Boolean(
        snapshotFacts &&
        sourceDefinitionFacts &&
        input.persisted?.bindingChecksum === snapshotFacts.bindingChecksum &&
        input.persisted.policyChecksum === snapshotFacts.policyChecksum &&
        sourceDefinitionFacts.bindingChecksum === snapshotFacts.bindingChecksum &&
        sourceDefinitionFacts.policyChecksum === snapshotFacts.policyChecksum &&
        input.persisted.archiveCheckerCode === snapshotFacts.archiveCheckerCode &&
        input.persisted.archiveCheckerVersion === snapshotFacts.archiveCheckerVersion &&
        input.persisted.retrospectiveCheckerCode === snapshotFacts.retrospectiveCheckerCode &&
        input.persisted.retrospectiveCheckerVersion === snapshotFacts.retrospectiveCheckerVersion &&
        input.persisted.archiveSourceFormulaVersion === "V2" &&
        input.persisted.selfReferenceExclusionVersion === CLOSURE_POLICY_SELF_REFERENCE_EXCLUSION
      )
    };
  } catch {
    return {
      sourceGateDefinitionBindingsValid,
      snapshotCheckerBindingsValid,
      policyFactsValid: false
    };
  }
}

function parseCloseReplay(
  value: Prisma.JsonValue | null
): Omit<CloseProjectResult, "idempotent"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  return typeof payload.projectId === "string" &&
    payload.status === "CLOSED" &&
    typeof payload.finalArchiveVersionId === "string"
    ? {
        projectId: payload.projectId,
        status: "CLOSED",
        finalArchiveVersionId: payload.finalArchiveVersionId
      }
    : null;
}

export async function closeProject(rawInput: CloseProjectInput): Promise<CloseProjectResult> {
  const actorId = requiredCommandText(rawInput.actorId, "actorId");
  const idempotencyKey = requiredCommandText(rawInput.idempotencyKey, "idempotencyKey");
  const request = payloadHash({
    projectId: rawInput.projectId,
    archiveVersionId: rawInput.archiveVersionId,
    g9SubmissionId: rawInput.g9SubmissionId,
    expectedProjectVersion: rawInput.expectedProjectVersion,
    operationId: rawInput.operationId
  });
  const input = { ...rawInput, actorId, idempotencyKey };
  const operation = async (transaction: Prisma.TransactionClient): Promise<CloseProjectResult> => {
    await transaction.$queryRaw`SELECT id FROM "projects" WHERE id = ${input.projectId} FOR UPDATE`;
    const project = await transaction.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, status: true, version: true, finalArchiveVersionId: true }
    });
    if (!project) throw new ProjectCloseError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    if (input.expectedProjectVersion !== project.version) {
      throw new ProjectCloseError("PROJECT_VERSION_CONFLICT", "项目已变化，请刷新后重试。");
    }
    if (project.status === "CLOSED") {
      throw new ProjectCloseError("PROJECT_ALREADY_CLOSED", "项目已经结项。");
    }

    // Locate dependent identities without treating an unlocked read as authoritative.
    const [submissionPreview, retrospectivePreview] = await Promise.all([
      transaction.gateSubmission.findFirst({
        where: { id: input.g9SubmissionId, projectId: input.projectId },
        select: {
          gateInstanceId: true,
          gateCheckSnapshotId: true,
          closurePolicyVersionId: true
        }
      }),
      transaction.projectRetrospective.findUnique({
        where: { projectId: input.projectId },
        select: {
          id: true,
          currentVersionId: true,
          currentVersion: { select: { retrospectiveInputArchiveVersionId: true } }
        }
      })
    ]);

    // Project -> Archive B and aggregate -> Archive A.
    await transaction.$queryRaw`
      SELECT id
      FROM "project_archive_versions"
      WHERE id = ${input.archiveVersionId} AND project_id = ${input.projectId}
      FOR UPDATE
    `;
    const archive = await transaction.projectArchiveVersion.findFirst({
      where: { id: input.archiveVersionId, projectId: input.projectId },
      include: {
        integrityChecks: { orderBy: { sequence: "desc" }, take: 1 },
        manifestItems: { where: { sourceType: "PROJECT_RETROSPECTIVE_VERSION" } }
      }
    });
    if (archive) {
      await transaction.$queryRaw`
        SELECT id
        FROM "project_archives"
        WHERE id = ${archive.archiveId} AND project_id = ${input.projectId}
        FOR UPDATE
      `;
    }
    const previewArchiveAId =
      retrospectivePreview?.currentVersion?.retrospectiveInputArchiveVersionId;
    if (previewArchiveAId) {
      await transaction.$queryRaw`
        SELECT id
        FROM "project_archive_versions"
        WHERE id = ${previewArchiveAId} AND project_id = ${input.projectId}
        FOR UPDATE
      `;
    }

    // Retrospective aggregate and its current version are locked before their facts are re-read.
    if (retrospectivePreview) {
      await transaction.$queryRaw`
        SELECT id
        FROM "project_retrospectives"
        WHERE id = ${retrospectivePreview.id} AND project_id = ${input.projectId}
        FOR UPDATE
      `;
      if (retrospectivePreview.currentVersionId) {
        await transaction.$queryRaw`
          SELECT id
          FROM "project_retrospective_versions"
          WHERE id = ${retrospectivePreview.currentVersionId} AND project_id = ${input.projectId}
          FOR UPDATE
        `;
      }
    }
    const retrospective = await transaction.projectRetrospective.findUnique({
      where: { projectId: input.projectId },
      include: {
        currentVersion: { include: { reviews: true } },
        latestApprovedVersion: true
      }
    });
    if (retrospective?.currentVersion?.retrospectiveInputArchiveVersionId !== previewArchiveAId) {
      throw new ProjectCloseError(
        "CLOSURE_RETROSPECTIVE_NOT_CURRENT",
        "复盘版本在结项锁定期间发生变化，请重新执行 G9。"
      );
    }
    const archiveA = previewArchiveAId
      ? await transaction.projectArchiveVersion.findFirst({
          where: { id: previewArchiveAId, projectId: input.projectId }
        })
      : null;

    // G9 instance -> snapshot -> submission precede policy. Every G9 mutation
    // starts by locking its project, then follows this same mutable evidence order.
    if (submissionPreview) {
      await transaction.$queryRaw`
        SELECT id
        FROM "project_gate_instances"
        WHERE id = ${submissionPreview.gateInstanceId} AND project_id = ${input.projectId}
        FOR UPDATE
      `;
      await transaction.$queryRaw`
        SELECT id
        FROM "gate_check_snapshots"
        WHERE id = ${submissionPreview.gateCheckSnapshotId} AND project_id = ${input.projectId}
        FOR UPDATE
      `;
      await transaction.$queryRaw`
        SELECT id
        FROM "gate_submissions"
        WHERE id = ${input.g9SubmissionId} AND project_id = ${input.projectId}
        FOR UPDATE
      `;
    }
    const submission = await transaction.gateSubmission.findFirst({
      where: {
        id: input.g9SubmissionId,
        projectId: input.projectId,
        status: "APPROVED",
        gateInstance: { scope: "PROJECT", gateDefinition: { code: "G9" } }
      },
      include: {
        approvals: true,
        gateInstance: { include: { gateDefinition: true, closurePolicyVersion: true } },
        gateCheckSnapshot: { include: { results: true, closurePolicyVersion: true } },
        closurePolicyVersion: true
      }
    });

    // The exact submitted policy is authoritative only after its G9 evidence is locked.
    await transaction.$queryRaw`
      SELECT id
      FROM "project_closure_policies"
      WHERE project_id = ${input.projectId}
      FOR UPDATE
    `;
    if (submissionPreview?.closurePolicyVersionId) {
      await transaction.$queryRaw`
        SELECT id
        FROM "project_closure_policy_versions"
        WHERE id = ${submissionPreview.closurePolicyVersionId} AND project_id = ${input.projectId}
        FOR UPDATE
      `;
    }
    const policyVersionId =
      submission?.closurePolicyVersionId ??
      submission?.gateCheckSnapshot.closurePolicyVersionId ??
      submission?.gateInstance.closurePolicyVersionId;
    const policy = policyVersionId
      ? await transaction.projectClosurePolicyVersion.findFirst({
          where: { id: policyVersionId, projectId: input.projectId },
          include: { policy: true }
        })
      : null;

    // Residual obligations -> singleton closure record complete the deterministic lock sequence.
    await transaction.$queryRaw`SELECT id FROM "residual_items" WHERE "project_id" = ${input.projectId} AND "status" <> 'CLOSED' FOR UPDATE`;
    const openResiduals = await transaction.residualItem.findMany({
      where: { projectId: input.projectId, status: { not: "CLOSED" } },
      select: { id: true }
    });
    await transaction.$queryRaw`
      SELECT id
      FROM "project_closure_records"
      WHERE project_id = ${input.projectId}
      FOR UPDATE
    `;
    let sourceFactsCurrent = false;
    if (archive) {
      try {
        const formula = archiveFormulaForClose(archive.archiveSourceFormulaVersion);
        if (!formula) throw new Error("unknown archive source formula");
        const adapter = getArchiveSourceFormulaAdapter(formula);
        const currentManifest = adapter.buildManifest(
          await adapter.read({ client: transaction, projectId: input.projectId })
        );
        sourceFactsCurrent =
          currentManifest.sourceWatermark === archive.sourceWatermark &&
          currentManifest.manifestChecksum === archive.manifestChecksum;
      } catch {
        sourceFactsCurrent = false;
      }
    }
    const closureResults = submission?.gateCheckSnapshot.results ?? [];
    const archiveResult = closureResults.find(
      (result) => result.checkerCode === "CLOSURE.ARCHIVE.G9" && result.checkerVersion === 2
    );
    const retrospectiveResult = closureResults.find(
      (result) => result.checkerCode === "CLOSURE.RETROSPECTIVE.G9" && result.checkerVersion === 1
    );
    const archiveEvidence = record(archiveResult?.evidenceJson);
    const retrospectiveEvidence = record(retrospectiveResult?.evidenceJson);
    const archiveBInputWatermark = text(
      archiveEvidence.archiveBInputWatermark ?? retrospectiveEvidence.archiveBInputWatermark
    );
    const archiveBId = text(archiveEvidence.archiveBId ?? retrospectiveEvidence.archiveBId);
    const retrospectiveVersionId = text(
      archiveEvidence.retrospectiveVersionId ?? retrospectiveEvidence.retrospectiveVersionId
    );
    const policyChecksum = policy?.policyChecksum ?? null;
    const gateInstance = submission?.gateInstance ?? null;
    const snapshot = submission?.gateCheckSnapshot ?? null;
    const snapshotBindings = parseCheckerBindings(snapshot?.checkerBindingsJson);
    const sourceGateDefinitionBindings = parseCheckerBindings(
      gateInstance?.gateDefinition.checkerBindingsJson
    );
    const bindingValidation = evaluateClosurePolicyBinding({
      projectId: input.projectId,
      sourceTemplateSnapshotId: policy?.sourceTemplateSnapshotId ?? "",
      sourceGateDefinitionId: policy?.sourceGateDefinitionId ?? "",
      sourceGateDefinitionBindings,
      snapshotBindings,
      persisted: policy
        ? {
            archiveCheckerCode: policy.archiveCheckerCode,
            archiveCheckerVersion: policy.archiveCheckerVersion,
            retrospectiveCheckerCode: policy.retrospectiveCheckerCode,
            retrospectiveCheckerVersion: policy.retrospectiveCheckerVersion,
            archiveSourceFormulaVersion: policy.archiveSourceFormulaVersion,
            selfReferenceExclusionVersion: policy.selfReferenceExclusionVersion,
            bindingChecksum: policy.bindingChecksum,
            policyChecksum: policy.policyChecksum
          }
        : null
    });
    const policyBindingsValid = Boolean(
      policy &&
      policy.archiveCheckerCode === "CLOSURE.ARCHIVE.G9" &&
      policy.archiveCheckerVersion === 2 &&
      policy.retrospectiveCheckerCode === "CLOSURE.RETROSPECTIVE.G9" &&
      policy.retrospectiveCheckerVersion === 1 &&
      policy.archiveSourceFormulaVersion === "V2" &&
      policy.selfReferenceExclusionVersion === "CLOSURE.SELF_REFERENCE_EXCLUSION@1"
    );
    assertProjectCanClose({
      projectId: project.id,
      projectStatus: project.status,
      projectVersion: project.version,
      expectedProjectVersion: input.expectedProjectVersion,
      g9Approved: Boolean(
        submission?.status === "APPROVED" &&
        archiveResult?.status === "PASSED" &&
        retrospectiveResult?.status === "PASSED"
      ),
      g9SubmissionProjectId: submission?.projectId ?? null,
      g9ArchiveVersionId: archiveBId,
      g9ClosurePolicyVersionId: submission?.closurePolicyVersionId ?? null,
      g9ClosurePolicyChecksum: submission?.closurePolicyChecksum ?? null,
      g9ArchiveSourceFormulaVersion:
        submission?.archiveSourceFormulaVersion === "V2" ? "ARCHIVE.SOURCE@2" : null,
      g9SnapshotStatus: snapshot?.status ?? null,
      archiveVersionId: archive?.id ?? null,
      archiveStatus: archive?.status ?? null,
      archiveSourceFormulaVersion:
        archive?.archiveSourceFormulaVersion === "V2"
          ? "ARCHIVE.SOURCE@2"
          : archive?.archiveSourceFormulaVersion === "V1"
            ? "ARCHIVE.SOURCE@1"
            : null,
      manifestChecksum: archive?.manifestChecksum ?? null,
      g9ManifestChecksum: text(archiveEvidence.manifestChecksum),
      sourceWatermark: archive?.sourceWatermark ?? null,
      g9SourceWatermark: text(archiveEvidence.sourceWatermark),
      sourceFactsCurrent,
      latestIntegrityStatus: latestIntegrityStatus(archive?.integrityChecks ?? [])?.status ?? null,
      archiveInputWatermark: archive?.retrospectiveInputWatermark ?? null,
      archiveInputApplicability: archive?.retrospectiveInputApplicability ?? null,
      g9ArchiveInputWatermark: archiveBInputWatermark,
      archiveAInputWatermark: text(
        archiveEvidence.archiveAInputWatermark ?? retrospectiveEvidence.archiveAInputWatermark
      ),
      archiveAActualInputWatermark: archiveA?.retrospectiveInputWatermark ?? null,
      archiveAId: archiveA?.id ?? null,
      archiveAStatus: archiveA?.status ?? null,
      archiveAFormula:
        archiveA?.archiveSourceFormulaVersion === "V2"
          ? "ARCHIVE.SOURCE@2"
          : archiveA?.archiveSourceFormulaVersion === "V1"
            ? "ARCHIVE.SOURCE@1"
            : null,
      archiveAInputApplicability: archiveA?.retrospectiveInputApplicability ?? null,
      retrospectiveInputArchiveVersionId:
        retrospective?.currentVersion?.retrospectiveInputArchiveVersionId ?? null,
      retrospectiveInputArchiveManifestChecksum:
        retrospective?.currentVersion?.retrospectiveInputManifestChecksum ?? null,
      retrospectiveInputArchiveSourceWatermark:
        retrospective?.currentVersion?.retrospectiveInputSourceWatermark ?? null,
      archiveAManifestChecksum: archiveA?.manifestChecksum ?? null,
      archiveASourceWatermark: archiveA?.sourceWatermark ?? null,
      policyVersionId: policy?.id ?? null,
      policyChecksum,
      policyArchiveSourceFormulaVersion:
        policy?.archiveSourceFormulaVersion === "V2" ? "ARCHIVE.SOURCE@2" : null,
      policyBindingsValid,
      snapshotCheckerBindingsValid: bindingValidation.snapshotCheckerBindingsValid,
      sourceGateDefinitionBindingsValid: bindingValidation.sourceGateDefinitionBindingsValid,
      policyFactsValid: bindingValidation.policyFactsValid,
      policySourceGateDefinitionMatches:
        policy?.sourceGateDefinitionId === gateInstance?.gateDefinitionId,
      policyIsActive: policy?.status === "ACTIVE" && policy?.policy.status === "ACTIVE",
      policyIsCurrent: policy?.policy.currentVersionId === policy?.id,
      gateInstancePolicyVersionId: gateInstance?.closurePolicyVersionId ?? null,
      gateInstancePolicyChecksum: gateInstance?.closurePolicyChecksum ?? null,
      gateInstanceArchiveSourceFormulaVersion:
        gateInstance?.archiveSourceFormulaVersion === "V2" ? "ARCHIVE.SOURCE@2" : null,
      gateSnapshotPolicyVersionId: snapshot?.closurePolicyVersionId ?? null,
      gateSnapshotPolicyChecksum: snapshot?.closurePolicyChecksum ?? null,
      gateSnapshotArchiveSourceFormulaVersion:
        snapshot?.archiveSourceFormulaVersion === "V2" ? "ARCHIVE.SOURCE@2" : null,
      archiveCheckerPassed: archiveResult?.status === "PASSED",
      retrospectiveCheckerPassed: retrospectiveResult?.status === "PASSED",
      retrospectiveVersionId,
      retrospectiveStatus:
        retrospective?.currentVersion?.id === retrospectiveVersionId
          ? retrospective.currentVersion.status
          : null,
      retrospectiveContentChecksum:
        retrospective?.currentVersion?.id === retrospectiveVersionId
          ? retrospective.currentVersion.contentChecksum
          : null,
      g9RetrospectiveContentChecksum: text(
        archiveEvidence.retrospectiveContentChecksum ??
          retrospectiveEvidence.retrospectiveContentChecksum
      ),
      currentRetrospectiveVersionId: retrospective?.currentVersionId ?? null,
      latestApprovedRetrospectiveVersionId: retrospective?.latestApprovedVersionId ?? null,
      archiveBIncludesRetrospectiveVersion: Boolean(
        archiveBId === archive?.id &&
        archive?.manifestItems.some((item) => item.sourceId === retrospectiveVersionId)
      ),
      openResidualItemIds: openResiduals.map((residual) => residual.id)
    });
    const now = await databaseNow(transaction);
    await transaction.projectArchiveVersion.update({
      where: { id: input.archiveVersionId },
      data: { status: "FINALIZED", finalizedAt: now }
    });
    if (!policy || !submission || !snapshot || !gateInstance || !retrospective?.currentVersion) {
      throw new ProjectCloseError("CLOSURE_POLICY_VERSION_REQUIRED", "关项事实不完整。", 409);
    }
    const closureRecordCreated = await transaction.projectClosureRecord.create({
      data: {
        projectId: input.projectId,
        archiveBId: archive!.id,
        archiveSourceFormulaVersion: "V2",
        archiveBManifestChecksum: archive!.manifestChecksum,
        archiveBSourceWatermark: archive!.sourceWatermark,
        closurePolicyVersionId: policy.id,
        closurePolicyChecksum: policy.policyChecksum,
        gateInstanceId: gateInstance.id,
        gateCheckSnapshotId: snapshot.id,
        gateSubmissionId: submission.id,
        gateApprovalSnapshotJson: submission.approvals.map((approval) => ({
          id: approval.id,
          decision: approval.decision,
          decidedById: approval.decidedById,
          decidedAt: approval.decidedAt.toISOString()
        })) as Prisma.InputJsonValue,
        retrospectiveVersionId: retrospective.currentVersion.id,
        retrospectiveContentChecksum: retrospective.currentVersion.contentChecksum,
        closedById: input.actorId,
        closedAt: now
      }
    });
    const finalizedArchive = await transaction.projectArchive.updateMany({
      where: {
        id: archive!.archiveId,
        projectId: input.projectId,
        finalArchiveVersionId: null
      },
      data: { finalArchiveVersionId: archive!.id }
    });
    if (finalizedArchive.count !== 1) {
      throw new ProjectCloseError("PROJECT_ARCHIVE_FACTS_STALE", "归档聚合已发生变化。", 409);
    }
    const closed = await transaction.project.updateMany({
      where: {
        id: input.projectId,
        version: input.expectedProjectVersion,
        status: { not: "CLOSED" }
      },
      data: {
        status: "CLOSED",
        finalArchiveVersionId: input.archiveVersionId,
        version: { increment: 1 }
      }
    });
    if (closed.count !== 1) {
      throw new ProjectCloseError("PROJECT_VERSION_CONFLICT", "项目已变化，请刷新后重试。", 409);
    }
    await writeAudit(transaction, {
      action: AUDIT_ACTIONS.PROJECT_CLOSED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT,
      objectId: input.projectId,
      context: workerContext(input.actorId, input.projectId, input.operationId),
      after: {
        value: {
          projectId: input.projectId,
          finalArchiveVersionId: input.archiveVersionId,
          status: "CLOSED",
          manifestChecksum: archive?.manifestChecksum,
          sourceWatermark: archive?.sourceWatermark,
          closureRecordId: closureRecordCreated.id
        },
        allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
      }
    });
    await appendOutboxEvent(transaction, {
      eventType: "project.closed",
      aggregateType: AUDIT_OBJECT_TYPES.PROJECT,
      aggregateId: input.projectId,
      idempotencyKey: `${input.projectId}:closed:${input.archiveVersionId}`,
      payload: {
        projectId: input.projectId,
        finalArchiveVersionId: input.archiveVersionId,
        closedAt: now.toISOString()
      },
      traceId: input.operationId
    });
    await writeAudit(transaction, {
      action: AUDIT_ACTIONS.PROJECT_CLOSURE_RECORD_CREATED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_CLOSURE_RECORD,
      objectId: closureRecordCreated.id,
      context: workerContext(input.actorId, input.projectId, input.operationId),
      after: {
        value: {
          projectId: input.projectId,
          closureRecordId: closureRecordCreated.id,
          archiveBId: archive!.id,
          archiveBManifestChecksum: archive!.manifestChecksum,
          archiveBSourceWatermark: archive!.sourceWatermark,
          closurePolicyVersionId: policy.id,
          closurePolicyChecksum: policy.policyChecksum,
          retrospectiveVersionId: retrospective.currentVersion.id
        },
        allowedFields: PROJECT_CLOSURE_RECORD_AUDIT_FIELDS
      }
    });
    return {
      projectId: input.projectId,
      status: "CLOSED" as const,
      finalArchiveVersionId: input.archiveVersionId,
      idempotent: false
    };
  };
  for (let attempt = 1; attempt <= CLOSE_PROJECT_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(async (transaction) => {
        try {
          await transaction.apiIdempotencyRecord.create({
            data: {
              actorId,
              operation: "projects.close",
              idempotencyKey,
              requestHash: request.hash
            }
          });
        } catch (error) {
          if (isUniqueConflict(error)) throw new CloseIdempotencyClaimConflict();
          throw error;
        }
        const result = await operation(transaction);
        await transaction.apiIdempotencyRecord.update({
          where: {
            actorId_operation_idempotencyKey: {
              actorId,
              operation: "projects.close",
              idempotencyKey
            }
          },
          data: {
            responseStatus: 200,
            responseJson: responseJson(result) as Prisma.InputJsonValue,
            completedAt: await databaseNow(transaction)
          }
        });
        return result;
      }, CLOSE_PROJECT_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof CloseIdempotencyClaimConflict) break;
      if (isRetryableCloseTransactionError(error)) {
        if (attempt < CLOSE_PROJECT_TRANSACTION_MAX_ATTEMPTS) continue;
        throw new ProjectCloseError(
          "CLOSURE_TRANSACTION_CONFLICT",
          "结项事实正在并发变化，请刷新后重试。"
        );
      }
      throw error;
    }
  }
  const replay = await db.apiIdempotencyRecord.findUnique({
    where: {
      actorId_operation_idempotencyKey: { actorId, operation: "projects.close", idempotencyKey }
    }
  });
  if (!replay || replay.completedAt === null || replay.responseStatus === null) {
    throw new ProjectCloseError(
      "CLOSE_IDEMPOTENCY_RESULT_UNAVAILABLE",
      "结项命令正在执行，请稍后使用相同幂等键重试。"
    );
  }
  if (replay.requestHash !== request.hash) {
    throw new ProjectCloseError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key 已绑定到不同的结项请求。"
    );
  }
  const response = parseCloseReplay(replay.responseJson);
  if (!response) {
    throw new ProjectCloseError(
      "CLOSE_IDEMPOTENCY_RESULT_UNAVAILABLE",
      "结项幂等记录没有可用的已完成响应。"
    );
  }
  return { ...response, idempotent: true };
}
