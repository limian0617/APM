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
  const templateChecksum = "a".repeat(64);
  const componentChecksum = "b".repeat(64);
  const capabilityComponentId = `${templateId}-capability-rule`;
  const capabilityComponentVersionId = `${capabilityComponentId}-v1`;
  const capabilitySnapshotId = `${templateId}-capability-snapshot`;
  const capabilityRule = { capabilities: [] };
  const publishedAt = new Date();

  await db.templateComponent.create({
    data: {
      id: capabilityComponentId,
      code: `PROC.CAPABILITY.${templateKey}`,
      componentType: "CAPABILITY_RULE",
      name: `${input.name}采购能力规则`,
      draftContent: capabilityRule,
      status: "ACTIVE",
      currentVersion: 1,
      createdById: input.createdById,
      updatedById: input.createdById
    }
  });
  await db.templateComponentVersion.create({
    data: {
      id: capabilityComponentVersionId,
      componentId: capabilityComponentId,
      version: 1,
      status: "PUBLISHED",
      componentType: "CAPABILITY_RULE",
      name: `${input.name}采购能力规则 v1`,
      contentJson: capabilityRule,
      checksum: componentChecksum,
      publishedById: input.createdById,
      publishedAt
    }
  });
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
      checksum: templateChecksum,
      publishedById: input.createdById,
      publishedAt,
      components: {
        create: {
          componentVersionId: capabilityComponentVersionId,
          componentType: "CAPABILITY_RULE",
          slot: "CAPABILITY_RULE.0",
          position: 0
        }
      }
    }
  });

  const project = await db.project.create({
    data: {
      id: input.id,
      code: input.code,
      name: input.name,
      departmentId: input.departmentId,
      createdById: input.createdById,
      initializationStatus: "READY",
      sourceTemplateVersionId: templateVersionId,
      sourceTemplateChecksum: templateChecksum,
      initializedAt: publishedAt
    }
  });
  await db.projectTemplateSnapshot.create({
    data: {
      id: capabilitySnapshotId,
      projectId: project.id,
      sourceTemplateVersionId: templateVersionId,
      sourceTemplateChecksum: templateChecksum,
      snapshotChecksum: "c".repeat(64),
      templateCode,
      templateName: `${input.name}模板 v1`,
      templateVersion: 1,
      templatePublishedAt: publishedAt,
      components: {
        create: {
          sourceComponentVersionId: capabilityComponentVersionId,
          componentType: "CAPABILITY_RULE",
          slot: "CAPABILITY_RULE.0",
          position: 0,
          sourceChecksum: componentChecksum,
          componentCode: `PROC.CAPABILITY.${templateKey}`,
          componentName: `${input.name}采购能力规则 v1`,
          componentVersion: 1,
          contentJson: capabilityRule
        }
      }
    }
  });
  return db.project.update({
    where: { id: project.id },
    data: {
      capabilityConfigurationStatus: "READY",
      capabilitiesConfiguredAt: publishedAt
    }
  });
}
