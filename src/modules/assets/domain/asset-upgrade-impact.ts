import { payloadHash } from "@/modules/governance/domain/idempotency";

export const ASSET_RELEASE_RECALL_SCOPES = ["RELEASE", "RELEASE_VERSION"] as const;
export type AssetReleaseRecallScope = (typeof ASSET_RELEASE_RECALL_SCOPES)[number];

export const ASSET_RELEASE_RECALL_REVISION_KINDS = [
  "ISSUED",
  "CORRECTED",
  "WITHDRAWN",
  "REISSUED"
] as const;
export type AssetReleaseRecallRevisionKind = (typeof ASSET_RELEASE_RECALL_REVISION_KINDS)[number];

export type AssetReleaseRecallState = "ACTIVE" | "WITHDRAWN";

export const ASSET_PROJECT_IMPACT_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "ASSESSING",
  "UPGRADE_PLANNED",
  "RISK_ACCEPTANCE_PENDING",
  "MITIGATED",
  "ACCEPTED_RISK",
  "CLOSED"
] as const;
export type AssetProjectImpactStatus = (typeof ASSET_PROJECT_IMPACT_STATUSES)[number];

export type AssetProjectImpactAction =
  | "ACKNOWLEDGE"
  | "ASSESS"
  | "PLAN_UPGRADE"
  | "REQUEST_RISK_ACCEPTANCE"
  | "MITIGATE"
  | "APPROVE_RISK_ACCEPTANCE"
  | "REJECT_RISK_ACCEPTANCE"
  | "CLOSE"
  | "REFRESH";

export class AssetUpgradeImpactError extends Error {
  constructor(
    readonly code:
      | "RECALL_TARGET_INVALID"
      | "RECALL_REVISION_INVALID"
      | "RECALL_REVISION_SOURCE_MISMATCH"
      | "RECALL_AFFECTED_VERSION_SET_CHANGED"
      | "UPGRADE_CANDIDATE_INVALID"
      | "IMPACT_SOURCE_INVALID"
      | "IMPACT_TRANSITION_INVALID"
      | "PROJECTION_ATTEMPT_INVALID",
    message: string
  ) {
    super(message);
  }
}

function stableId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 191) {
    throw new AssetUpgradeImpactError("RECALL_TARGET_INVALID", `${field}必须是 1 到 191 个字符。`);
  }
  return value.trim();
}

function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AssetUpgradeImpactError(
      "RECALL_AFFECTED_VERSION_SET_CHANGED",
      "affected-version set checksum 必须是小写 SHA-256。"
    );
  }
  return value;
}

export type AssetReleaseRecallAffectedVersion = {
  assetReleaseVersionId: string;
  releaseId: string;
  technicalAssetId: string;
  revision: number;
  snapshotChecksum: string;
  sourceWatermark: string;
  status: "PUBLISHED" | "SUPERSEDED";
};

type AssetUpgradeCandidateReleaseVersion = {
  releaseId: string;
  releaseVersionId: string;
  revision: number;
  snapshotChecksum: string;
  sourceWatermark: string;
  status: "PUBLISHED" | "SUPERSEDED" | "DRAFT";
};

function assertCandidateReleaseVersion(
  value: AssetUpgradeCandidateReleaseVersion,
  side: "source" | "target"
): { releaseVersionId: string } {
  stableId(value.releaseId, `${side}.releaseId`);
  const releaseVersionId = stableId(value.releaseVersionId, `${side}.releaseVersionId`);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new AssetUpgradeImpactError(
      "UPGRADE_CANDIDATE_INVALID",
      `${side} ReleaseVersion revision 必须是正整数。`
    );
  }
  checksum(value.snapshotChecksum);
  stableId(value.sourceWatermark, `${side}.sourceWatermark`);
  if (
    (side === "source" && value.status !== "PUBLISHED" && value.status !== "SUPERSEDED") ||
    (side === "target" && value.status !== "PUBLISHED")
  ) {
    throw new AssetUpgradeImpactError(
      "UPGRADE_CANDIDATE_INVALID",
      `${side} ReleaseVersion 状态不符合 exact 升级候选合同。`
    );
  }
  return { releaseVersionId };
}

export function assertAssetUpgradeCandidate(input: {
  technicalAssetId: string;
  source: AssetUpgradeCandidateReleaseVersion;
  target: AssetUpgradeCandidateReleaseVersion;
}): string {
  const technicalAssetId = stableId(input.technicalAssetId, "technicalAssetId");
  const source = assertCandidateReleaseVersion(input.source, "source");
  const target = assertCandidateReleaseVersion(input.target, "target");
  if (source.releaseVersionId === target.releaseVersionId) {
    throw new AssetUpgradeImpactError(
      "UPGRADE_CANDIDATE_INVALID",
      "升级候选的 source 与 target exact ReleaseVersion 不能相同。"
    );
  }
  return `${technicalAssetId}:${source.releaseVersionId}:${target.releaseVersionId}`;
}

export function buildAssetReleaseRecallAffectedVersionSet(input: {
  scope: AssetReleaseRecallScope;
  releaseId: string;
  targetReleaseVersionId?: string | null;
  versions: readonly AssetReleaseRecallAffectedVersion[];
}): {
  affectedVersions: readonly AssetReleaseRecallAffectedVersion[];
  affectedVersionSetChecksum: string;
} {
  const releaseId = stableId(input.releaseId, "releaseId");
  if (!Array.isArray(input.versions) || input.versions.length === 0) {
    throw new AssetUpgradeImpactError(
      "RECALL_TARGET_INVALID",
      "召回必须冻结至少一个 exact ReleaseVersion。"
    );
  }

  const affectedVersions = input.versions
    .map((version) => {
      const revision = version.revision;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new AssetUpgradeImpactError(
          "RECALL_TARGET_INVALID",
          "affected ReleaseVersion revision 必须是正整数。"
        );
      }
      if (version.status !== "PUBLISHED" && version.status !== "SUPERSEDED") {
        throw new AssetUpgradeImpactError(
          "RECALL_TARGET_INVALID",
          "affected ReleaseVersion 必须是已发布历史事实。"
        );
      }
      const versionReleaseId = stableId(version.releaseId, "affectedVersion.releaseId");
      if (versionReleaseId !== releaseId) {
        throw new AssetUpgradeImpactError(
          "RECALL_TARGET_INVALID",
          "affected ReleaseVersion 必须属于召回的 exact Release。"
        );
      }
      return {
        assetReleaseVersionId: stableId(
          version.assetReleaseVersionId,
          "affectedVersion.assetReleaseVersionId"
        ),
        releaseId: versionReleaseId,
        technicalAssetId: stableId(version.technicalAssetId, "affectedVersion.technicalAssetId"),
        revision,
        snapshotChecksum: checksum(version.snapshotChecksum),
        sourceWatermark: stableId(version.sourceWatermark, "affectedVersion.sourceWatermark"),
        status: version.status
      };
    })
    .sort((left, right) => left.assetReleaseVersionId.localeCompare(right.assetReleaseVersionId));

  const technicalAssetId = affectedVersions[0]!.technicalAssetId;
  const ids = new Set<string>();
  for (const version of affectedVersions) {
    if (version.technicalAssetId !== technicalAssetId || ids.has(version.assetReleaseVersionId)) {
      throw new AssetUpgradeImpactError(
        "RECALL_AFFECTED_VERSION_SET_CHANGED",
        "affected-version set 必须由同一技术资产的唯一 exact ReleaseVersion 构成。"
      );
    }
    ids.add(version.assetReleaseVersionId);
  }

  if (input.scope === "RELEASE") {
    if (input.targetReleaseVersionId !== undefined && input.targetReleaseVersionId !== null) {
      throw new AssetUpgradeImpactError(
        "RECALL_TARGET_INVALID",
        "RELEASE 召回不能指定单一 ReleaseVersion。"
      );
    }
  } else {
    const targetReleaseVersionId = stableId(input.targetReleaseVersionId, "targetReleaseVersionId");
    if (
      affectedVersions.length !== 1 ||
      affectedVersions[0]!.assetReleaseVersionId !== targetReleaseVersionId
    ) {
      throw new AssetUpgradeImpactError(
        "RECALL_TARGET_INVALID",
        "RELEASE_VERSION 召回只能冻结其一个 exact ReleaseVersion。"
      );
    }
  }

  return {
    affectedVersions,
    affectedVersionSetChecksum: payloadHash({ affectedVersions }).hash
  };
}

export function buildAssetReleaseRecallTargetKey(input: {
  scope: AssetReleaseRecallScope;
  releaseId: string;
  releaseVersionId?: string | null;
}): string {
  stableId(input.releaseId, "releaseId");
  if (input.scope === "RELEASE") {
    if (input.releaseVersionId !== undefined && input.releaseVersionId !== null) {
      throw new AssetUpgradeImpactError(
        "RECALL_TARGET_INVALID",
        "RELEASE 召回不能指定单一 ReleaseVersion。"
      );
    }
    return `RELEASE:${input.releaseId.trim()}`;
  }
  return `RELEASE_VERSION:${stableId(input.releaseVersionId, "releaseVersionId")}`;
}

export function assertAssetReleaseRecallRevision(input: {
  currentState: AssetReleaseRecallState | null;
  currentRevision: number;
  nextRevision: number;
  kind: AssetReleaseRecallRevisionKind;
  affectedVersionSetChecksum: string;
  expectedAffectedVersionSetChecksum?: string | null;
}): AssetReleaseRecallState {
  const nextChecksum = checksum(input.affectedVersionSetChecksum);
  if (!Number.isSafeInteger(input.currentRevision) || input.currentRevision < 0) {
    throw new AssetUpgradeImpactError("RECALL_REVISION_INVALID", "当前召回修订无效。");
  }
  if (input.nextRevision !== input.currentRevision + 1) {
    throw new AssetUpgradeImpactError("RECALL_REVISION_INVALID", "召回修订必须严格递增一。 ");
  }
  if (input.currentRevision === 0) {
    if (input.kind !== "ISSUED" || input.currentState !== null) {
      throw new AssetUpgradeImpactError("RECALL_REVISION_INVALID", "首次召回只能为 ISSUED。 ");
    }
    return "ACTIVE";
  }
  if (
    !input.expectedAffectedVersionSetChecksum ||
    nextChecksum !== input.expectedAffectedVersionSetChecksum
  ) {
    throw new AssetUpgradeImpactError(
      "RECALL_AFFECTED_VERSION_SET_CHANGED",
      "后续召回修订不得改变冻结的 affected-version set。"
    );
  }
  if (input.currentState === "ACTIVE") {
    if (input.kind === "CORRECTED") return "ACTIVE";
    if (input.kind === "WITHDRAWN") return "WITHDRAWN";
    throw new AssetUpgradeImpactError(
      "RECALL_REVISION_INVALID",
      "ACTIVE 召回只能 CORRECTED 或 WITHDRAWN。"
    );
  }
  if (input.currentState === "WITHDRAWN" && input.kind === "REISSUED") {
    return "ACTIVE";
  }
  throw new AssetUpgradeImpactError("RECALL_REVISION_INVALID", "WITHDRAWN 召回只能 REISSUED。");
}

export function assertAssetReleaseRecallRevisionSource(input: {
  sourceAssetReleaseId: string;
  sourceAssetReleaseVersionId: string;
  technicalAssetId: string;
  anchor: {
    releaseId: string;
    assetReleaseVersionId: string;
    technicalAssetId: string;
  };
}): void {
  const source = [
    stableId(input.sourceAssetReleaseId, "sourceAssetReleaseId"),
    stableId(input.sourceAssetReleaseVersionId, "sourceAssetReleaseVersionId"),
    stableId(input.technicalAssetId, "technicalAssetId")
  ];
  const anchor = [
    stableId(input.anchor.releaseId, "anchor.releaseId"),
    stableId(input.anchor.assetReleaseVersionId, "anchor.assetReleaseVersionId"),
    stableId(input.anchor.technicalAssetId, "anchor.technicalAssetId")
  ];
  if (source.some((value, index) => value !== anchor[index])) {
    throw new AssetUpgradeImpactError(
      "RECALL_REVISION_SOURCE_MISMATCH",
      "召回修订必须绑定同一 Release、ReleaseVersion 和 TechnicalAsset 的 exact source。"
    );
  }
}

export function buildAssetImpactAssessmentSource(input: {
  recallId: string;
  recallRevisionId: string;
  recallRevisionNumber: number;
  recallRevisionSnapshotChecksum: string;
  recallRevisionKind: AssetReleaseRecallRevisionKind;
  recallRevisionState: AssetReleaseRecallState;
  projectFactsWatermark: string;
}) {
  if (!Number.isSafeInteger(input.recallRevisionNumber) || input.recallRevisionNumber < 1) {
    throw new AssetUpgradeImpactError(
      "IMPACT_SOURCE_INVALID",
      "recallRevisionNumber 必须是正整数。"
    );
  }
  const source = {
    recallId: stableId(input.recallId, "recallId"),
    recallRevisionId: stableId(input.recallRevisionId, "recallRevisionId"),
    recallRevisionNumber: input.recallRevisionNumber,
    recallRevisionSnapshotChecksum: checksum(input.recallRevisionSnapshotChecksum),
    recallRevisionKind: input.recallRevisionKind,
    recallRevisionState: input.recallRevisionState,
    projectFactsWatermark: stableId(input.projectFactsWatermark, "projectFactsWatermark")
  };
  const sourceWatermark = payloadHash(source).hash;
  return { ...source, sourceWatermark };
}

export function buildAssetDeactivationImpactAssessmentSource(input: {
  technicalAssetId: string;
  technicalAssetEventId: string;
  eventSequence: number;
  eventSnapshot: unknown;
  projectFactsWatermark: string;
}) {
  if (!Number.isSafeInteger(input.eventSequence) || input.eventSequence < 1) {
    throw new AssetUpgradeImpactError("IMPACT_SOURCE_INVALID", "eventSequence 必须是正整数。 ");
  }
  const source = {
    technicalAssetId: stableId(input.technicalAssetId, "technicalAssetId"),
    technicalAssetEventId: stableId(input.technicalAssetEventId, "technicalAssetEventId"),
    eventSequence: input.eventSequence,
    fromStatus: "VALIDATED" as const,
    toStatus: "DISABLED" as const,
    eventSnapshot: payloadHash(input.eventSnapshot).value,
    projectFactsWatermark: stableId(input.projectFactsWatermark, "projectFactsWatermark")
  };
  const sourceWatermark = payloadHash(source).hash;
  return { ...source, sourceWatermark };
}

export function assertAssetImpactSource(input: {
  sourceType: "RECALL" | "ASSET_DEACTIVATION";
  recallId?: string | null;
  technicalAssetEventId?: string | null;
}): string {
  const hasRecall = Boolean(input.recallId?.trim());
  const hasDeactivation = Boolean(input.technicalAssetEventId?.trim());
  if (hasRecall === hasDeactivation) {
    throw new AssetUpgradeImpactError(
      "IMPACT_SOURCE_INVALID",
      "impact cause 必须且只能关联一个 recall 或 technical asset deactivation event。"
    );
  }
  if (input.sourceType === "RECALL" && hasRecall) return `RECALL:${input.recallId!.trim()}`;
  if (input.sourceType === "ASSET_DEACTIVATION" && hasDeactivation) {
    return `ASSET_DEACTIVATION:${input.technicalAssetEventId!.trim()}`;
  }
  throw new AssetUpgradeImpactError(
    "IMPACT_SOURCE_INVALID",
    "impact sourceType 与 cause 不一致。 "
  );
}

const impactTransitions: Readonly<
  Record<
    AssetProjectImpactStatus,
    Partial<Record<AssetProjectImpactAction, AssetProjectImpactStatus>>
  >
> = {
  OPEN: { ACKNOWLEDGE: "ACKNOWLEDGED", REFRESH: "OPEN" },
  ACKNOWLEDGED: { ASSESS: "ASSESSING", REFRESH: "OPEN" },
  ASSESSING: {
    PLAN_UPGRADE: "UPGRADE_PLANNED",
    REQUEST_RISK_ACCEPTANCE: "RISK_ACCEPTANCE_PENDING",
    MITIGATE: "MITIGATED",
    REFRESH: "OPEN"
  },
  UPGRADE_PLANNED: {
    MITIGATE: "MITIGATED",
    REQUEST_RISK_ACCEPTANCE: "RISK_ACCEPTANCE_PENDING",
    REFRESH: "OPEN"
  },
  RISK_ACCEPTANCE_PENDING: {
    APPROVE_RISK_ACCEPTANCE: "ACCEPTED_RISK",
    REJECT_RISK_ACCEPTANCE: "ASSESSING",
    REFRESH: "OPEN"
  },
  MITIGATED: { CLOSE: "CLOSED", REFRESH: "OPEN" },
  ACCEPTED_RISK: { CLOSE: "CLOSED", REFRESH: "OPEN" },
  CLOSED: { REFRESH: "OPEN" }
};

export function nextAssetImpactStatus(
  status: AssetProjectImpactStatus,
  action: AssetProjectImpactAction
): AssetProjectImpactStatus {
  const next = impactTransitions[status]?.[action];
  if (!next) {
    throw new AssetUpgradeImpactError(
      "IMPACT_TRANSITION_INVALID",
      `资产影响状态 ${status} 不能执行 ${action}。`
    );
  }
  return next;
}

export function buildAssetImpactProjectionAttemptKey(input: {
  impactId: string;
  assessmentRevisionId: string;
  assessmentSequence: number;
  snapshotChecksum: string;
  sourceWatermark: string;
  desiredState: "ACTIVE" | "RESOLVED";
  sourceJobId: string;
  sourceEventType: string;
  ruleId?: string | null;
  ruleVersion?: number | null;
}): string {
  stableId(input.impactId, "impactId");
  stableId(input.assessmentRevisionId, "assessmentRevisionId");
  const sourceJobId = stableId(input.sourceJobId, "sourceJobId");
  const sourceEventType = stableId(input.sourceEventType, "sourceEventType");
  const ruleId = input.ruleId ? stableId(input.ruleId, "ruleId") : "-";
  const ruleVersion = input.ruleVersion ?? 0;
  if (
    !Number.isSafeInteger(input.assessmentSequence) ||
    input.assessmentSequence < 1 ||
    !Number.isSafeInteger(ruleVersion) ||
    ruleVersion < 0 ||
    !/^[0-9a-f]{64}$/u.test(input.snapshotChecksum) ||
    !/^[0-9a-f]{64}$/u.test(input.sourceWatermark) ||
    (input.desiredState !== "ACTIVE" && input.desiredState !== "RESOLVED")
  ) {
    throw new AssetUpgradeImpactError("PROJECTION_ATTEMPT_INVALID", "资产影响投影事实无效。 ");
  }
  const fingerprint = payloadHash({
    sourceJobId,
    sourceEventType,
    ruleId,
    ruleVersion
  }).hash;
  return `asset-impact-projection:${fingerprint}`;
}
