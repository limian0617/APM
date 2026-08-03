import { describe, expect, it, vi } from "vitest";

import {
  createProjectMilestone,
  linkMilestoneTask,
  manuallyAchieveProjectMilestone,
  ProjectMilestoneError,
  shouldInstantiateMilestoneSnapshotComponent,
  updateProjectMilestone,
  voidMilestoneTaskLink,
  voidProjectMilestone
} from "@/modules/projects/application/milestone-service";

describe("APM-025 project milestone lifecycle service", () => {
  it("accepts only canonical MILESTONE snapshot component content for instantiation", () => {
    expect(
      shouldInstantiateMilestoneSnapshotComponent({
        componentType: "MILESTONE",
        contentJson: {
          milestones: [
            { code: "DESIGN.FREEZE", name: "设计冻结", description: "评审完成", position: 0 }
          ]
        }
      })
    ).toEqual([{ code: "DESIGN.FREEZE", name: "设计冻结", description: "评审完成", position: 0 }]);
    expect(
      shouldInstantiateMilestoneSnapshotComponent({
        componentType: "WBS",
        contentJson: { packages: [] }
      })
    ).toEqual([]);
  });

  it("exposes HTTP-mappable lifecycle errors", () => {
    const error = new ProjectMilestoneError("VERSION_CONFLICT", "里程碑版本已变化。", 409);
    expect(error).toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("exposes the complete project-milestone command surface", () => {
    expect(createProjectMilestone).toBeTypeOf("function");
    expect(updateProjectMilestone).toBeTypeOf("function");
    expect(voidProjectMilestone).toBeTypeOf("function");
    expect(manuallyAchieveProjectMilestone).toBeTypeOf("function");
    expect(linkMilestoneTask).toBeTypeOf("function");
    expect(voidMilestoneTaskLink).toBeTypeOf("function");
  });

  it("creates a project-owned milestone together with its first durable lifecycle event", async () => {
    const created = {
      id: "milestone-1",
      projectId: "project-1",
      sourceSnapshotComponentId: null,
      code: "DESIGN.FREEZE",
      name: "设计冻结",
      description: null,
      position: 10,
      targetAt: null,
      status: "PENDING" as const,
      achievementSource: null,
      achievedAt: null,
      voidedAt: null,
      version: 1
    };
    const client = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "project-1",
          departmentId: "engineering",
          status: "EXECUTING",
          initializationStatus: "READY",
          structureStatus: "READY"
        })
      },
      projectMilestone: { create: vi.fn().mockResolvedValue(created) },
      projectMilestoneEvent: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockImplementation(async ({ data }) => ({ id: "event-1", ...data }))
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      outboxEvent: {
        upsert: vi.fn().mockImplementation(async ({ create }) => ({
          id: "outbox-1",
          payloadHash: create.payloadHash,
          aggregateType: create.aggregateType,
          aggregateId: create.aggregateId
        }))
      }
    };

    const result = await createProjectMilestone(
      {
        projectId: "project-1",
        code: "DESIGN.FREEZE",
        name: "设计冻结",
        position: 10,
        reason: "PM 确认设计冻结里程碑",
        actorId: "user-1",
        auditContext: {
          actorId: "user-1",
          requestId: "request-1",
          traceId: null,
          source: "API",
          sourceIp: null,
          userAgent: "Vitest",
          reason: null,
          projectId: null,
          departmentId: null,
          operationId: "operation-1"
        }
      },
      client as never
    );

    expect(result).toMatchObject({
      milestone: { code: "DESIGN.FREEZE", status: "PENDING" },
      event: { sequence: 1, eventType: "CREATED", toStatus: "PENDING" },
      auditId: "audit-1",
      outboxEventId: "outbox-1",
      resourceVersion: 1
    });
    expect(client.projectMilestone.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: "project-1" }) })
    );
  });
});
