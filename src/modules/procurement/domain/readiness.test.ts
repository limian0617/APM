import { describe, expect, it } from "vitest";

import {
  calculateReadiness,
  calculateRequirementReadiness,
  type ReadinessRequirementLine
} from "./readiness";

function requirementLine(
  overrides: Partial<ReadinessRequirementLine> & Pick<ReadinessRequirementLine, "id">
): ReadinessRequirementLine {
  const { id, ...rest } = overrides;
  return {
    id,
    trackingUnit: "PCS",
    requiredQuantity: "10",
    isCritical: false,
    isEffective: true,
    events: [],
    ...rest
  };
}

describe("APM-091B deterministic readiness", () => {
  it("counts ready material lines instead of summing incompatible units", () => {
    const result = calculateReadiness({
      lines: [
        requirementLine({
          id: "pcs",
          requiredQuantity: "10",
          isCritical: true,
          events: [
            { id: "pcs-accepted", eventType: "ACCEPTED", quantity: "10", trackingUnit: "PCS" }
          ]
        }),
        requirementLine({
          id: "meter",
          trackingUnit: "M",
          requiredQuantity: "4",
          events: [
            { id: "meter-accepted", eventType: "ACCEPTED", quantity: "2", trackingUnit: "M" }
          ]
        })
      ]
    });

    expect(result).toMatchObject({
      status: "BLOCKED",
      totalLines: 2,
      readyLines: 1,
      readinessRate: "0.5",
      criticalTotalLines: 1,
      criticalReadyLines: 1
    });
    expect(result).not.toHaveProperty("totalQuantity");
  });

  it("marks a missing frozen ERP unit conversion as invalid input for its requirement", () => {
    const result = calculateReadiness({
      lines: [
        requirementLine({
          id: "erp-unit-mismatch",
          events: [
            { id: "erp-arrival", eventType: "PURCHASE_ARRIVED", quantity: "1", trackingUnit: "M" }
          ]
        })
      ]
    });

    expect(result).toMatchObject({
      status: "INVALID_INPUT",
      invalidRequirementIds: ["erp-unit-mismatch"],
      lines: [{ dataError: { code: "PROC_UNIT_CONVERSION_REQUIRED" } }]
    });
  });

  it("marks mismatched, invalid and inexact unit conversions as invalid input", () => {
    const invalidConversions = [
      {
        id: "mismatched-conversion",
        unitConversion: { fromUnit: "KG", toUnit: "PCS", numerator: 1n, denominator: 1n }
      },
      {
        id: "invalid-conversion-ratio",
        unitConversion: { fromUnit: "M", toUnit: "PCS", numerator: 0n, denominator: 1n }
      },
      {
        id: "inexact-conversion",
        unitConversion: { fromUnit: "M", toUnit: "PCS", numerator: 1n, denominator: 3n }
      }
    ] as const;

    for (const { id, unitConversion } of invalidConversions) {
      const result = calculateRequirementReadiness(
        requirementLine({
          id,
          events: [
            {
              id: `${id}-event`,
              eventType: "PURCHASE_ARRIVED",
              quantity: "0.000001",
              trackingUnit: "M",
              unitConversion
            }
          ]
        })
      );

      expect(result.dataError).toEqual({ code: "PROC_UNIT_CONVERSION_INVALID" });
    }
  });

  it("returns a ready range to blocked after a usable quantity is returned", () => {
    const line = requirementLine({
      id: "returned-line",
      events: [
        { id: "accepted", eventType: "ACCEPTED", quantity: "10", trackingUnit: "PCS" },
        { id: "returned", eventType: "RETURNED", quantity: "1", trackingUnit: "PCS" }
      ]
    });
    expect(calculateReadiness({ lines: [line] }).status).toBe("BLOCKED");
    expect(calculateRequirementReadiness(line)).toMatchObject({
      usableQuantity: "9",
      gapQuantity: "1",
      isReady: false,
      dataError: null
    });
  });

  it("rejects a recorded-arrival underflow without rejecting an availability-only projection", () => {
    const result = calculateRequirementReadiness(
      requirementLine({
        id: "arrival-underflow",
        events: [
          { id: "arrival", eventType: "PURCHASE_ARRIVED", quantity: "1", trackingUnit: "PCS" },
          { id: "accepted", eventType: "ACCEPTED", quantity: "2", trackingUnit: "PCS" },
          { id: "return", eventType: "RETURNED", quantity: "2", trackingUnit: "PCS" }
        ]
      })
    );

    expect(result.dataError).toEqual({ code: "PROC_EVENT_BALANCE_INVALID" });
  });

  it("keeps critical-line readiness separate from ordinary-line readiness", () => {
    const result = calculateReadiness({
      lines: [
        requirementLine({
          id: "critical-ready",
          isCritical: true,
          events: [
            {
              id: "critical-ready-event",
              eventType: "ACCEPTED",
              quantity: "10",
              trackingUnit: "PCS"
            }
          ]
        }),
        requirementLine({ id: "critical-short", isCritical: true }),
        requirementLine({
          id: "ordinary-short",
          events: [
            { id: "ordinary-event", eventType: "ACCEPTED", quantity: "9", trackingUnit: "PCS" }
          ]
        })
      ]
    });

    expect(result).toMatchObject({
      status: "BLOCKED",
      criticalTotalLines: 2,
      criticalReadyLines: 1,
      criticalReadinessRate: "0.5",
      blockingCriticalLines: 1
    });
  });

  it("returns empty when no effective requirement lines exist", () => {
    const result = calculateReadiness({
      lines: [requirementLine({ id: "superseded", isEffective: false })]
    });

    expect(result).toMatchObject({
      status: "EMPTY",
      totalLines: 0,
      readyLines: 0,
      readinessRate: "0"
    });
  });

  it("returns ready only when every effective requirement line is ready and nonstale", () => {
    const result = calculateReadiness({
      lines: [
        requirementLine({
          id: "accepted-line",
          events: [{ id: "accepted", eventType: "ACCEPTED", quantity: "10", trackingUnit: "PCS" }]
        }),
        requirementLine({
          id: "usable-line",
          events: [
            { id: "usable", eventType: "MARKED_USABLE", quantity: "10", trackingUnit: "PCS" }
          ]
        }),
        requirementLine({ id: "superseded", isEffective: false })
      ]
    });

    expect(result).toMatchObject({ status: "READY", totalLines: 2, readyLines: 2 });
  });

  it("reports on-time status from available and required dates without inferring missing dates", () => {
    const readyEvent = [
      { id: "accepted", eventType: "ACCEPTED" as const, quantity: "10", trackingUnit: "PCS" }
    ];

    expect(
      calculateRequirementReadiness(
        requirementLine({
          id: "on-time",
          requiredOn: "2026-08-10T00:00:00.000Z",
          availableOn: "2026-08-09T00:00:00.000Z",
          events: readyEvent
        })
      ).isOnTime
    ).toBe(true);
    expect(
      calculateRequirementReadiness(
        requirementLine({
          id: "late",
          requiredOn: "2026-08-10T00:00:00.000Z",
          availableOn: "2026-08-11T00:00:00.000Z",
          events: readyEvent
        })
      ).isOnTime
    ).toBe(false);
    expect(
      calculateRequirementReadiness(requirementLine({ id: "unknown-date", events: readyEvent }))
        .isOnTime
    ).toBeNull();
  });

  it("marks an otherwise-ready result stale after its source freshness threshold", () => {
    const result = calculateReadiness({
      lines: [
        requirementLine({
          id: "stale-line",
          events: [{ id: "usable", eventType: "ACCEPTED", quantity: "10", trackingUnit: "PCS" }]
        })
      ],
      sourceSyncedAt: "2026-08-01T00:00:00.000Z",
      staleAfterDays: 1,
      now: "2026-08-03T00:00:00.000Z"
    });

    expect(result).toMatchObject({ status: "STALE", readyLines: 1, readinessRate: "1" });
  });

  it("excludes a reversed fact rather than counting the reversal as an additional event", () => {
    const result = calculateRequirementReadiness(
      requirementLine({
        id: "reversed-arrival",
        events: [
          { id: "arrival", eventType: "PURCHASE_ARRIVED", quantity: "10", trackingUnit: "PCS" },
          {
            id: "reversal",
            eventType: "REVERSED",
            quantity: "10",
            trackingUnit: "PCS",
            reversesEventId: "arrival"
          }
        ]
      })
    );

    expect(result).toMatchObject({ arrivedQuantity: "0", usableQuantity: "0", gapQuantity: "10" });
  });

  it("requires each reversal to target one distinct nonreversed fact", () => {
    const selfReference = calculateRequirementReadiness(
      requirementLine({
        id: "self-reference",
        events: [
          {
            id: "reverse",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "PCS",
            reversesEventId: "reverse"
          }
        ]
      })
    );
    const chainedReference = calculateRequirementReadiness(
      requirementLine({
        id: "chained-reference",
        events: [
          { id: "arrival", eventType: "PURCHASE_ARRIVED", quantity: "1", trackingUnit: "PCS" },
          {
            id: "first-reversal",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "PCS",
            reversesEventId: "arrival"
          },
          {
            id: "chained-reversal",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "PCS",
            reversesEventId: "first-reversal"
          }
        ]
      })
    );
    const duplicateReference = calculateRequirementReadiness(
      requirementLine({
        id: "duplicate-reference",
        events: [
          { id: "arrival", eventType: "PURCHASE_ARRIVED", quantity: "1", trackingUnit: "PCS" },
          {
            id: "first-reversal",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "PCS",
            reversesEventId: "arrival"
          },
          {
            id: "duplicate-reversal",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "PCS",
            reversesEventId: "arrival"
          }
        ]
      })
    );

    expect(selfReference.dataError).toEqual({ code: "PROC_EVENT_REFERENCE_INVALID" });
    expect(chainedReference.dataError).toEqual({ code: "PROC_EVENT_REFERENCE_INVALID" });
    expect(duplicateReference.dataError).toEqual({ code: "PROC_EVENT_REFERENCE_INVALID" });
  });

  it("requires reversals to exactly match their target quantity after unit conversion", () => {
    const quantityMismatch = calculateRequirementReadiness(
      requirementLine({
        id: "reversal-quantity-mismatch",
        events: [
          { id: "arrival", eventType: "PURCHASE_ARRIVED", quantity: "2", trackingUnit: "PCS" },
          {
            id: "reversal",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "PCS",
            reversesEventId: "arrival"
          }
        ]
      })
    );
    const invalidConversion = calculateRequirementReadiness(
      requirementLine({
        id: "reversal-conversion-mismatch",
        events: [
          { id: "arrival", eventType: "PURCHASE_ARRIVED", quantity: "1", trackingUnit: "PCS" },
          {
            id: "reversal",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "M",
            reversesEventId: "arrival",
            unitConversion: { fromUnit: "M", toUnit: "KG", numerator: 1n, denominator: 1n }
          }
        ]
      })
    );

    expect(quantityMismatch.dataError).toEqual({ code: "PROC_EVENT_REFERENCE_INVALID" });
    expect(invalidConversion.dataError).toEqual({ code: "PROC_UNIT_CONVERSION_INVALID" });
  });

  it("calculates arrival and usable aggregates with their independent fixed event formulas", () => {
    const result = calculateRequirementReadiness(
      requirementLine({
        id: "aggregate-line",
        requiredQuantity: "9",
        events: [
          { id: "arrival", eventType: "PURCHASE_ARRIVED", quantity: "10", trackingUnit: "PCS" },
          {
            id: "outsourced-return",
            eventType: "OUTSOURCED_RETURNED",
            quantity: "4",
            trackingUnit: "PCS"
          },
          { id: "accepted", eventType: "ACCEPTED", quantity: "10", trackingUnit: "PCS" },
          { id: "usable", eventType: "MARKED_USABLE", quantity: "2", trackingUnit: "PCS" },
          { id: "rejected", eventType: "REJECTED", quantity: "1", trackingUnit: "PCS" },
          { id: "returned", eventType: "RETURNED", quantity: "2", trackingUnit: "PCS" }
        ]
      })
    );

    expect(result).toMatchObject({
      arrivedQuantity: "12",
      usableQuantity: "9",
      rejectedReturnedQuantity: "3",
      gapQuantity: "0",
      isReady: true,
      dataError: null
    });
  });

  it("rejects missing reversal references and impossible negative usable balances", () => {
    const missingReference = calculateRequirementReadiness(
      requirementLine({
        id: "missing-reference",
        events: [
          {
            id: "reverse",
            eventType: "REVERSED",
            quantity: "1",
            trackingUnit: "PCS",
            reversesEventId: "absent"
          }
        ]
      })
    );
    const invalidBalance = calculateRequirementReadiness(
      requirementLine({
        id: "invalid-balance",
        events: [{ id: "return", eventType: "RETURNED", quantity: "1", trackingUnit: "PCS" }]
      })
    );

    expect(missingReference.dataError).toEqual({ code: "PROC_EVENT_REFERENCE_INVALID" });
    expect(invalidBalance.dataError).toEqual({ code: "PROC_EVENT_BALANCE_INVALID" });
  });
});
