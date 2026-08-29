import { describe, expect, it } from "vitest";

import {
  deriveAutoUsableEvent,
  selectFulfillmentReversalEventIds,
  validateFulfillmentEvent
} from "./fulfillment-event";

const base = {
  businessType: "STANDARD_PURCHASE" as const,
  trackingUnit: "PCS",
  eventType: "PURCHASE_ARRIVED" as const,
  quantity: "5",
  arrivedQuantity: "0",
  returnedQuantity: "0",
  usableQuantity: "0"
};

describe("APM-091A fulfillment event rules", () => {
  it("accepts split arrivals and acceptance in the same tracking unit", () => {
    expect(validateFulfillmentEvent(base)).toMatchObject({
      eventType: "PURCHASE_ARRIVED",
      quantity: "5"
    });
    expect(
      validateFulfillmentEvent({
        ...base,
        eventType: "ACCEPTED",
        quantity: "5",
        arrivedQuantity: "5"
      })
    ).toMatchObject({ eventType: "ACCEPTED" });
  });

  it("rejects acceptance above arrived minus returned quantity", () => {
    expect(() =>
      validateFulfillmentEvent({
        ...base,
        eventType: "ACCEPTED",
        quantity: "4",
        arrivedQuantity: "5",
        returnedQuantity: "2"
      })
    ).toThrow(
      expect.objectContaining({ code: "PROC_ACCEPTANCE_EXCEEDS_AVAILABLE_ARRIVAL", status: 422 })
    );
  });

  it("rejects an event unit that differs from the requirement unit", () => {
    expect(() => validateFulfillmentEvent({ ...base, trackingUnit: "M" })).toThrow(
      expect.objectContaining({ code: "PROC_EVENT_UNIT_MISMATCH", status: 422 })
    );
  });

  it("rejects outsourced-only events for a standard purchase requirement", () => {
    expect(() => validateFulfillmentEvent({ ...base, eventType: "OUTSOURCED_DISPATCHED" })).toThrow(
      expect.objectContaining({ code: "PROC_EVENT_TYPE_INVALID", status: 422 })
    );
  });

  it("creates a system usable event only for an automatic-usable arrival", () => {
    expect(
      deriveAutoUsableEvent({ arrivalAutoUsable: true, inspectionRequired: false, event: base })
    ).toMatchObject({ eventType: "MARKED_USABLE", quantity: "5", source: "LOCAL" });
    expect(
      deriveAutoUsableEvent({ arrivalAutoUsable: false, inspectionRequired: false, event: base })
    ).toBeNull();
  });

  it("does not auto-create usable quantity when inspection is required", () => {
    expect(
      deriveAutoUsableEvent({ arrivalAutoUsable: true, inspectionRequired: true, event: base })
    ).toBeNull();
  });

  it("reverses an active automatically derived usable fact with its source arrival", () => {
    expect(
      selectFulfillmentReversalEventIds({
        eventId: "arrival-1",
        derivedAutoUsableEvent: { id: "usable-1", hasReversal: false }
      })
    ).toEqual(["arrival-1", "usable-1"]);
    expect(
      selectFulfillmentReversalEventIds({
        eventId: "arrival-1",
        derivedAutoUsableEvent: { id: "usable-1", hasReversal: true }
      })
    ).toEqual(["arrival-1"]);
  });
});
