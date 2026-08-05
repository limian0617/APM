import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({ loadResourceLoadProjectionSource: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const outbox = vi.hoisted(() => ({ appendOutboxEvent: vi.fn() }));

vi.mock("../infrastructure/prisma-resource-load-source", () => source);
vi.mock("@/modules/audit/infrastructure/write-audit", () => audit);
vi.mock("@/modules/governance/infrastructure/outbox", () => outbox);

import { refreshProjectResourceLoad } from "./resource-load-projection-service";

const auditContext = {
  actorId: "manager-1",
  requestId: "request-1",
  traceId: null,
  source: "API" as const,
  sourceIp: null,
  userAgent: "Vitest",
  reason: null,
  projectId: "project-1",
  departmentId: "engineering",
  operationId: "operation-1"
};

describe("APM-042 resource-load projection refresh", () => {
  beforeEach(() => {
    source.loadResourceLoadProjectionSource.mockReset();
    audit.writeAudit.mockReset();
    outbox.appendOutboxEvent.mockReset();
  });

  it("persists a project-locked, day-based task snapshot with audit and outbox facts", async () => {
    source.loadResourceLoadProjectionSource.mockResolvedValue({
      sourceVersions: { project: { id: "project-1", version: 1 }, tasks: [] },
      rows: [
        {
          ownerMembershipId: "member-1",
          personId: "user-1",
          personName: "Engineer",
          departmentId: "engineering",
          discipline: "ENGINEER",
          taskId: "task-1",
          taskCode: "DESIGN",
          taskName: "Design",
          plannedStartAt: new Date("2026-08-03T09:00:00.000Z"),
          plannedFinishAt: new Date("2026-08-05T17:00:00.000Z")
        }
      ]
    });
    const createdProjection = {
      id: "projection-1",
      projectId: "project-1",
      sourceChecksum: "a".repeat(64),
      sourceVersionsJson: { project: { id: "project-1", version: 1 }, tasks: [] },
      calculatedAt: new Date("2026-08-05T00:00:00.000Z"),
      people: [
        {
          id: "person-projection-1",
          ownerMembershipId: "member-1",
          departmentId: "engineering",
          discipline: "ENGINEER",
          plannedDays: 3,
          activeTaskCount: 1,
          ownerMembership: { userId: "user-1", user: { name: "Engineer" } },
          tasks: [
            {
              taskId: "task-1",
              taskCode: "DESIGN",
              taskName: "Design",
              plannedStartAt: new Date("2026-08-03T09:00:00.000Z"),
              plannedFinishAt: new Date("2026-08-05T17:00:00.000Z"),
              plannedDays: 3
            }
          ]
        }
      ]
    };
    const transaction = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([{ now: new Date("2026-08-05T00:00:00.000Z") }]),
      resourceLoadProjection: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(createdProjection)
      }
    } as unknown as Prisma.TransactionClient;
    audit.writeAudit.mockResolvedValue({ id: "audit-1" });
    outbox.appendOutboxEvent.mockResolvedValue({ id: "outbox-1" });

    const result = await refreshProjectResourceLoad(
      {
        projectId: "project-1",
        actorId: "manager-1",
        reason: "Refresh resource load",
        auditContext
      },
      transaction
    );

    expect(transaction.$executeRaw).toHaveBeenCalledOnce();
    expect(transaction.resourceLoadProjection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "project-1",
          people: {
            create: [
              expect.objectContaining({
                ownerMembershipId: "member-1",
                personId: "user-1",
                personName: "Engineer",
                departmentId: "engineering",
                discipline: "ENGINEER",
                plannedDays: 3,
                tasks: { create: [expect.objectContaining({ taskId: "task-1", plannedDays: 3 })] }
              })
            ]
          }
        })
      })
    );
    expect(audit.writeAudit).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: "COCKPIT_RESOURCE_LOAD_REFRESHED" })
    );
    expect(outbox.appendOutboxEvent).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ eventType: "cockpit.resource-load.refreshed" })
    );
    expect(result).toMatchObject({
      reused: false,
      auditId: "audit-1",
      projection: { projectionId: "projection-1", departments: [{ plannedDays: 3 }] }
    });
    expect(result.projection.departments[0]?.disciplines[0]?.people).toEqual([]);
  });

  it("reuses an equal source checksum without another audit or outbox write", async () => {
    source.loadResourceLoadProjectionSource.mockResolvedValue({
      sourceVersions: { project: { id: "project-1", version: 1 }, tasks: [] },
      rows: []
    });
    const existing = {
      id: "projection-existing",
      projectId: "project-1",
      sourceChecksum: "b".repeat(64),
      sourceVersionsJson: { project: { id: "project-1", version: 1 }, tasks: [] },
      calculatedAt: new Date("2026-08-05T00:00:00.000Z"),
      people: []
    };
    const transaction = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([{ now: new Date("2026-08-05T00:00:00.000Z") }]),
      resourceLoadProjection: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn()
      }
    } as unknown as Prisma.TransactionClient;

    const result = await refreshProjectResourceLoad(
      {
        projectId: "project-1",
        actorId: "manager-1",
        reason: "Refresh resource load",
        auditContext
      },
      transaction
    );

    expect(transaction.resourceLoadProjection.create).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
    expect(outbox.appendOutboxEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reused: true,
      auditId: null,
      projection: { projectionId: "projection-existing" }
    });
  });
});
