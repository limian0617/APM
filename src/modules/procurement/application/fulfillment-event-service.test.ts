import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";

import { appendProcurementFulfillmentEvent } from "./fulfillment-event-service";

const auditContext = {
  actorId: "user-1",
  requestId: "request-1",
  traceId: "a".repeat(32),
  source: "API" as const,
  sourceIp: null,
  userAgent: "Vitest",
  reason: null,
  projectId: "project-1",
  departmentId: "engineering",
  operationId: "fulfillment-test"
};

describe("APM-091B fulfillment event readiness policy", () => {
  it("derives usable quantity from the current configured policy inside the append transaction", async () => {
    const events: any[] = [];
    const outbox: any[] = [];
    const policyLookup = vi.fn(async () => ({
      projectId: "project-1",
      currentReadinessPolicyVersion: {
        id: "policy-1",
        arrivalAutoUsable: true,
        inspectionRequired: false
      }
    }));
    const client: any = {
      $queryRaw: async () => [{ now: new Date("2026-08-07T00:00:00.000Z") }],
      project: {
        findUnique: async () => ({ id: "project-1", status: "ACTIVE", departmentId: "engineering" })
      },
      projectCapability: { findUnique: async () => ({ selectedEnabled: true }) },
      companyCapability: { findUnique: async () => ({ enabled: true }) },
      projectProcurementSettings: { findUnique: policyLookup },
      projectMaterialRequirement: {
        findFirst: async () => ({
          id: "requirement-1",
          version: 1,
          status: "CONFIRMED",
          currentRevision: {
            id: "revision-1",
            status: "CONFIRMED",
            businessType: "STANDARD_PURCHASE",
            trackingUnit: "PCS",
            quantity: new Prisma.Decimal("2")
          }
        }),
        update: async () => ({ version: 2 })
      },
      procurementFulfillmentEvent: {
        findMany: async () => [],
        create: async ({ data }: any) => {
          const event = {
            id: `event-${events.length + 1}`,
            version: 1,
            ...data,
            externalEventKey: data.externalEventKey ?? null,
            externalDocumentRef: data.externalDocumentRef ?? null,
            evidenceFileId: data.evidenceFileId ?? null,
            reversesEventId: data.reversesEventId ?? null,
            derivedFromEventId: data.derivedFromEventId ?? null
          };
          events.push(event);
          return event;
        }
      },
      auditLog: {
        create: async ({ data }: any) => ({ id: `audit-${events.length}`, ...data })
      },
      outboxEvent: {
        upsert: async ({ create }: any) => {
          const event = { id: `outbox-${outbox.length + 1}`, ...create };
          outbox.push(event);
          return event;
        }
      }
    };
    const transaction = vi
      .spyOn(db, "$transaction")
      .mockImplementation(((operation: (transactionClient: typeof client) => unknown) =>
        operation(client)) as never);
    try {
      const result = await appendProcurementFulfillmentEvent({
        projectId: "project-1",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "PURCHASE_ARRIVED",
        quantity: "1",
        trackingUnit: "PCS",
        businessOccurredAt: "2026-08-07T00:00:00.000Z",
        reason: "normal arrival",
        actorId: "user-1",
        auditContext
      });

      expect(policyLookup).toHaveBeenCalledWith({
        where: { projectId: "project-1" },
        include: { currentReadinessPolicyVersion: true }
      });
      expect(result.events).toHaveLength(2);
      expect(result.events.map((event) => event.eventType)).toEqual([
        "PURCHASE_ARRIVED",
        "MARKED_USABLE"
      ]);
      expect(result.events[1]?.derivedFromEventId).toBe(result.events[0]?.id);
    } finally {
      transaction.mockRestore();
    }
  });
});
