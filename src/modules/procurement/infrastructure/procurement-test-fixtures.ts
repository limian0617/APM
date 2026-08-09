import { db } from "@/lib/db";

type ReadyProcurementProjectInput = {
  id: string;
  code: string;
  name: string;
  departmentId: string;
  createdById: string;
};

/**
 * Creates the smallest valid project fixture for procurement integration tests.
 * A READY project must point at a published template version; inserting a
 * READY row without that source violates the APM-011 database contract.
 */
export async function createReadyProcurementProject(input: ReadyProcurementProjectInput) {
  const templateKey = input.id.replace(/[^a-zA-Z0-9]/gu, "").toUpperCase();
  const templateId = `procurement-test-template-${templateKey}`;
  const templateVersionId = `${templateId}-v1`;
  const templateCode = `PROC.TEST.${templateKey}`;
  const checksum = "a".repeat(64);
  const publishedAt = new Date();

  await db.projectTemplate.create({
    data: {
      id: templateId,
      code: templateCode,
      name: `${input.name}模板`,
      status: "ACTIVE",
      currentVersion: 1,
      createdById: input.createdById,
      updatedById: input.createdById
    }
  });
  await db.projectTemplateVersion.create({
    data: {
      id: templateVersionId,
      templateId,
      version: 1,
      status: "PUBLISHED",
      name: `${input.name}模板 v1`,
      checksum,
      publishedById: input.createdById,
      publishedAt
    }
  });

  return db.project.create({
    data: {
      id: input.id,
      code: input.code,
      name: input.name,
      departmentId: input.departmentId,
      createdById: input.createdById,
      initializationStatus: "READY",
      sourceTemplateVersionId: templateVersionId,
      sourceTemplateChecksum: checksum,
      initializedAt: publishedAt,
      capabilityConfigurationStatus: "READY",
      capabilitiesConfiguredAt: publishedAt
    }
  });
}
