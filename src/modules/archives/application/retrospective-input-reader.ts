import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

import { ArchiveManifestError } from "./archive-manifest-service";

export const RETROSPECTIVE_INPUT_FORMULA_VERSION = "RETROSPECTIVE.INPUT@1" as const;

export class RetrospectiveInputError extends Error {
  constructor(
    readonly code:
      "RETROSPECTIVE_INPUT_ARCHIVE_NOT_APPLICABLE" | "ARCHIVE_SOURCE_FACTS_UNAVAILABLE",
    message?: string
  ) {
    super(message ?? code);
    this.name = "RetrospectiveInputError";
  }
}

export function assertRetrospectiveInputArchive(input: {
  archiveSourceFormulaVersion: string | null | undefined;
  retrospectiveInputApplicability: string | null | undefined;
}): void {
  if (
    input.archiveSourceFormulaVersion !== "ARCHIVE.SOURCE@2" ||
    input.retrospectiveInputApplicability !== "APPLICABLE"
  ) {
    throw new RetrospectiveInputError(
      "RETROSPECTIVE_INPUT_ARCHIVE_NOT_APPLICABLE",
      "复盘输入只能使用 ARCHIVE.SOURCE@2 且已冻结适用复盘输入的归档 A。"
    );
  }
}

type RetrospectiveInputFacts = {
  project: Record<string, unknown>;
  deliveryUnits: Array<Record<string, any>>;
  projectStages: Array<Record<string, any>>;
  issues: Array<Record<string, any>>;
  acceptance: Array<Record<string, any>>;
  nonClosureGates: Array<Record<string, any>>;
  residuals: Array<Record<string, any>>;
};

export type RetrospectiveInputBuild = {
  snapshot: RetrospectiveInputFacts & {
    formulaVersion: typeof RETROSPECTIVE_INPUT_FORMULA_VERSION;
  };
  watermark: string;
};

function compareBy(fields: readonly string[]) {
  return (left: Record<string, any>, right: Record<string, any>) =>
    fields
      .map((field) => String(left[field] ?? ""))
      .join("\u0000")
      .localeCompare(fields.map((field) => String(right[field] ?? "")).join("\u0000"), "en");
}

export function buildRetrospectiveInputSnapshot(
  input: RetrospectiveInputFacts
): RetrospectiveInputBuild {
  if (!input.project?.id || !input.project?.code || !input.project?.name) {
    throw new RetrospectiveInputError(
      "ARCHIVE_SOURCE_FACTS_UNAVAILABLE",
      "项目复盘输入事实不可用。"
    );
  }
  const snapshot = {
    formulaVersion: RETROSPECTIVE_INPUT_FORMULA_VERSION,
    project: input.project,
    deliveryUnits: [...input.deliveryUnits].sort(compareBy(["id"])),
    projectStages: [...input.projectStages].sort(compareBy(["id"])),
    issues: [...input.issues].sort(compareBy(["id"])),
    acceptance: [...input.acceptance].sort(compareBy(["type", "batchId"])),
    nonClosureGates: input.nonClosureGates
      .filter((gate) => gate.code !== "G9")
      .sort(compareBy(["code", "revision"])),
    residuals: [...input.residuals].sort(compareBy(["id"]))
  };
  const normalized = payloadHash(snapshot);
  return {
    snapshot: normalized.value as RetrospectiveInputFacts & {
      formulaVersion: typeof RETROSPECTIVE_INPUT_FORMULA_VERSION;
    },
    watermark: normalized.hash
  };
}

export type RetrospectiveInputClient = {
  project: { findUnique(input: unknown): Promise<Record<string, any> | null> };
  deliveryUnit: { findMany(input: unknown): Promise<Array<Record<string, any>>> };
  projectStage: { findMany(input: unknown): Promise<Array<Record<string, any>>> };
  issue: { findMany(input: unknown): Promise<Array<Record<string, any>>> };
  acceptanceBatch: { findMany(input: unknown): Promise<Array<Record<string, any>>> };
  projectGateDefinition: { findMany(input: unknown): Promise<Array<Record<string, any>>> };
  residualItem: { findMany(input: unknown): Promise<Array<Record<string, any>>> };
};

function checksum(value: unknown): string {
  return payloadHash(value).hash;
}

function latestSubmission(gate: Record<string, any>) {
  const submissions = (gate.instances ?? [])
    .flatMap((instance: Record<string, any>) => instance.submissions ?? [])
    .sort(
      (left: Record<string, any>, right: Record<string, any>) =>
        Number(right.sequence ?? 0) - Number(left.sequence ?? 0)
    );
  return submissions[0] ?? null;
}

export async function readRetrospectiveInput(input: {
  projectId: string;
  client: RetrospectiveInputClient;
}) {
  const [project, deliveryUnits, projectStages, issues, acceptance, gateDefinitions, residuals] =
    await Promise.all([
      input.client.project.findUnique({ where: { id: input.projectId } }),
      input.client.deliveryUnit.findMany({ where: { projectId: input.projectId } }),
      input.client.projectStage.findMany({ where: { projectId: input.projectId } }),
      input.client.issue.findMany({
        where: { projectId: input.projectId },
        include: { history: { orderBy: { sequence: "desc" }, take: 1 } }
      }),
      input.client.acceptanceBatch.findMany({
        where: { projectId: input.projectId, status: "LOCKED" },
        include: {
          results: {
            include: { revisions: { orderBy: { revisionNo: "desc" }, take: 1 } },
            orderBy: { itemId: "asc" }
          }
        }
      }),
      input.client.projectGateDefinition.findMany({
        where: { projectId: input.projectId, code: { not: "G9" } },
        include: {
          instances: {
            include: { submissions: { include: { gateCheckSnapshot: true } } }
          }
        }
      }),
      input.client.residualItem.findMany({ where: { projectId: input.projectId } })
    ]);
  if (!project) {
    throw new ArchiveManifestError("ARCHIVE_SOURCE_FACTS_UNAVAILABLE", "复盘输入项目不存在。 ");
  }
  return buildRetrospectiveInputSnapshot({
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      type: project.projectType,
      status: project.status,
      mainControlStageCode: project.mainControlStageCode
    },
    deliveryUnits: deliveryUnits.map((unit) => ({
      id: unit.id,
      code: unit.code,
      type: unit.unitType,
      status: unit.status,
      version: unit.version
    })),
    projectStages: projectStages.map((stage) => ({
      id: stage.id,
      code: stage.code,
      status: stage.status,
      version: stage.version
    })),
    issues: issues.map((issue) => {
      const latest = issue.history?.[0] ?? null;
      return {
        id: issue.id,
        category: issue.category,
        severity: issue.severity,
        status: issue.status,
        version: issue.version,
        latestHistory: latest
          ? {
              id: latest.id,
              sequence: latest.sequence,
              snapshotChecksum: checksum(latest.snapshotJson)
            }
          : null
      };
    }),
    acceptance: acceptance.map((batch) => ({
      type: batch.acceptanceType,
      batchId: batch.id,
      status: batch.status,
      version: batch.version,
      summaryChecksum: checksum({
        acceptanceType: batch.acceptanceType,
        batchId: batch.id,
        status: batch.status,
        version: batch.version,
        results: (batch.results ?? []).map((result: Record<string, any>) => ({
          itemId: result.itemId,
          revision: result.revisions?.[0]
            ? {
                id: result.revisions[0].id,
                revisionNo: result.revisions[0].revisionNo,
                decision: result.revisions[0].decision
              }
            : null
        }))
      })
    })),
    nonClosureGates: gateDefinitions.map((gate) => {
      const submission = latestSubmission(gate);
      return {
        code: gate.code,
        revision: gate.revision,
        latestSubmissionId: submission?.id ?? null,
        status: submission?.status ?? null,
        resultChecksum: submission?.gateCheckSnapshot?.resultChecksum ?? null
      };
    }),
    residuals: residuals.map((residual) => ({
      id: residual.id,
      status: residual.status,
      version: residual.version
    }))
  });
}

export function retrospectiveInputSnapshotJson(value: unknown): JsonValue {
  return payloadHash(value).value;
}
