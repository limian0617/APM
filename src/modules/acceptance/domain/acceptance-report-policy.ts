import { createHash } from "node:crypto";

export const ACCEPTANCE_REPORT_STATUSES = [
  "GENERATING",
  "FAILED",
  "READY",
  "PUBLISHED",
  "SUPERSEDED"
] as const;
export type AcceptanceReportStatus = (typeof ACCEPTANCE_REPORT_STATUSES)[number];

export const ACCEPTANCE_CONFIRMATION_DECISIONS = [
  "ACCEPTED",
  "ACCEPTED_WITH_RESERVATIONS",
  "REJECTED"
] as const;
export type AcceptanceConfirmationDecision = (typeof ACCEPTANCE_CONFIRMATION_DECISIONS)[number];

export const ACCEPTANCE_CONFIRMATION_CHANNELS = [
  "SIGNED_DOCUMENT",
  "EMAIL",
  "MEETING_MINUTES",
  "OTHER"
] as const;
export type AcceptanceConfirmationChannel = (typeof ACCEPTANCE_CONFIRMATION_CHANNELS)[number];

export class AcceptanceReportPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "AcceptanceReportPolicyError";
  }
}

export type AcceptanceReportSnapshot = {
  schemaVersion: 1;
  project: { id: string; name: string; code: string };
  batch: {
    id: string;
    acceptanceType: "FAT" | "SAT";
    scopeType: "PROJECT" | "DELIVERY_UNIT" | "MACHINE";
    scopeId: string;
  };
  template: { id: string; version: number; checksum: string };
  items: Array<{
    code: string;
    position: number;
    name: string;
    method: string;
    acceptanceCriteria: string;
    unit: string | null;
    required: boolean;
    decision: "PASS" | "FAIL" | "NA" | null;
    measuredValue: string | null;
    measuredUnit: string | null;
    note: string | null;
    resultRevisionId: string | null;
    evidence: Array<{ fileId: string; sha256: string }>;
  }>;
  summary: {
    passCount: number;
    failCount: number;
    naCount: number;
    unexecutedRequiredCount: number;
    denominator: number;
    passRate: number | null;
    calculability: "CALCULABLE" | "NOT_CALCULABLE";
  };
  issues: Array<{
    issueId: string;
    resultRevisionId: string;
    status: string;
    severity: string;
    category?: string | null;
    ownerMembershipId?: string | null;
    verifierMembershipId?: string | null;
    dueDate?: string | null;
  }>;
  gate: { status: string; warnings: string[]; residualItemIds: string[] };
  assetUsage?: { frozenAt: string; usageSnapshotChecksum: string; snapshot: unknown };
  retestOfBatchId: string | null;
  frozenAt: string;
  rendererVersion: string;
};

type SnapshotInput = Omit<AcceptanceReportSnapshot, "schemaVersion" | "summary"> & {
  items: Array<AcceptanceReportSnapshot["items"][number]>;
};

export function assertReportCanGenerate(status: string): asserts status is "LOCKED" {
  if (status !== "LOCKED") {
    throw new AcceptanceReportPolicyError(
      "ACCEPTANCE_REPORT_BATCH_NOT_LOCKED",
      "只有 LOCKED 验收批次可以生成正式报告。",
      409
    );
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function sortedIssues(input: SnapshotInput["issues"]) {
  return [...input]
    .map((issue) => ({
      issueId: issue.issueId,
      resultRevisionId: issue.resultRevisionId,
      status: issue.status,
      severity: issue.severity,
      category: issue.category ?? null,
      ownerMembershipId: issue.ownerMembershipId ?? null,
      verifierMembershipId: issue.verifierMembershipId ?? null,
      dueDate: issue.dueDate ?? null
    }))
    .sort((a, b) =>
      `${a.resultRevisionId}:${a.issueId}`.localeCompare(`${b.resultRevisionId}:${b.issueId}`)
    );
}

export function buildAcceptanceReportSnapshot(input: SnapshotInput): AcceptanceReportSnapshot {
  const items = [...input.items]
    .map((item) => ({
      code: item.code,
      position: item.position,
      name: item.name,
      method: item.method,
      acceptanceCriteria: item.acceptanceCriteria,
      unit: item.unit ?? null,
      required: item.required,
      decision: item.decision ?? null,
      measuredValue: item.measuredValue ?? null,
      measuredUnit: item.measuredUnit ?? null,
      note: item.note ?? null,
      resultRevisionId: item.resultRevisionId ?? null,
      evidence: [...item.evidence]
        .map((evidence) => ({ fileId: evidence.fileId, sha256: evidence.sha256 }))
        .sort((a, b) => a.fileId.localeCompare(b.fileId))
    }))
    .sort((a, b) => a.position - b.position || a.code.localeCompare(b.code));
  const passCount = items.filter((item) => item.decision === "PASS").length;
  const failCount = items.filter((item) => item.decision === "FAIL").length;
  const naCount = items.filter((item) => item.decision === "NA").length;
  const unexecutedRequiredCount = items.filter((item) => item.required && !item.decision).length;
  const denominator = passCount + failCount;
  return {
    schemaVersion: 1,
    project: { ...input.project },
    batch: { ...input.batch },
    template: { ...input.template },
    items,
    summary: {
      passCount,
      failCount,
      naCount,
      unexecutedRequiredCount,
      denominator,
      passRate: denominator === 0 ? null : passCount / denominator,
      calculability: denominator === 0 ? "NOT_CALCULABLE" : "CALCULABLE"
    },
    issues: sortedIssues(input.issues),
    gate: {
      status: input.gate.status,
      warnings: [...input.gate.warnings].sort(),
      residualItemIds: [...input.gate.residualItemIds].sort()
    },
    ...(input.assetUsage ? { assetUsage: input.assetUsage } : {}),
    retestOfBatchId: input.retestOfBatchId ?? null,
    frozenAt: input.frozenAt,
    rendererVersion: input.rendererVersion
  };
}

export function calculateSnapshotChecksum(snapshot: AcceptanceReportSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}

/**
 * Replays the current facts at the original frozen timestamp before comparing the canonical,
 * persisted snapshot checksum. This preserves resource-level idempotency without introducing a
 * second content-hash definition or treating a newly generated timestamp as a fact change.
 */
export function matchesExistingAcceptanceReportSnapshot(input: {
  existingSnapshot: unknown;
  existingSnapshotChecksum: string;
  currentSnapshot: AcceptanceReportSnapshot;
}): boolean {
  const frozenAt =
    input.existingSnapshot &&
    typeof input.existingSnapshot === "object" &&
    "frozenAt" in input.existingSnapshot
      ? (input.existingSnapshot as { frozenAt?: unknown }).frozenAt
      : null;
  if (typeof frozenAt !== "string" || Number.isNaN(new Date(frozenAt).getTime())) return false;
  const assetUsage = input.currentSnapshot.assetUsage;
  const usageSnapshot =
    assetUsage?.snapshot &&
    typeof assetUsage.snapshot === "object" &&
    !Array.isArray(assetUsage.snapshot)
      ? { ...assetUsage.snapshot, frozenAt }
      : assetUsage?.snapshot;
  const checksum = calculateSnapshotChecksum({
    ...input.currentSnapshot,
    frozenAt,
    ...(assetUsage
      ? {
          assetUsage: {
            ...assetUsage,
            frozenAt,
            snapshot: usageSnapshot,
            usageSnapshotChecksum: createHash("sha256")
              .update(canonicalJson(usageSnapshot), "utf8")
              .digest("hex")
          }
        }
      : {})
  });
  return checksum === input.existingSnapshotChecksum;
}

export function calculateConfirmationChecksum(input: {
  projectId: string;
  reportId: string;
  reportChecksum: string;
  controlledDocumentVersionId: string;
  decision: AcceptanceConfirmationDecision;
  customerOrganization: string;
  customerRepresentative: string;
  representativeTitle: string;
  confirmationChannel: AcceptanceConfirmationChannel;
  customerConfirmedAt: string;
  comment: string;
  evidence: Array<{ fileId: string; sha256: string }>;
  supersedesConfirmationId: string | null;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ...input,
        evidence: [...input.evidence].sort((a, b) => a.fileId.localeCompare(b.fileId))
      }),
      "utf8"
    )
    .digest("hex");
}

export function assertConfirmationEvidence(input: {
  projectId: string;
  file: {
    projectId: string;
    status: string;
    storageArea: string;
    sensitivity: string;
    scannedAt: Date | null;
    sha256: string | null;
  };
}): void {
  if (input.file.projectId !== input.projectId) {
    throw new AcceptanceReportPolicyError(
      "CONFIRMATION_EVIDENCE_PROJECT_MISMATCH",
      "确认凭证必须属于当前项目。",
      404
    );
  }
  if (
    input.file.status !== "AVAILABLE" ||
    input.file.storageArea !== "CONTROLLED" ||
    input.file.sensitivity !== "RESTRICTED" ||
    !input.file.scannedAt ||
    !input.file.sha256
  ) {
    throw new AcceptanceReportPolicyError(
      "CONFIRMATION_EVIDENCE_NOT_AVAILABLE",
      "确认凭证必须已扫描、可用、位于受控存储并标记为严格受限。",
      409
    );
  }
}
