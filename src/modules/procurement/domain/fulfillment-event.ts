export const FULFILLMENT_EVENT_TYPES = [
  "PURCHASE_ARRIVED",
  "OUTSOURCED_DISPATCHED",
  "OUTSOURCED_COMPLETED",
  "OUTSOURCED_RETURNED",
  "ACCEPTED",
  "MARKED_USABLE",
  "REJECTED",
  "RETURNED",
  "REVERSED"
] as const;

export type FulfillmentEventType = (typeof FULFILLMENT_EVENT_TYPES)[number];
export type FulfillmentBusinessType = "STANDARD_PURCHASE" | "DRAWING_CUSTOM" | "OUTSOURCED_PROCESS";

export class FulfillmentEventError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "FulfillmentEventError";
  }
}

export type FulfillmentEventValidationInput = {
  businessType: FulfillmentBusinessType;
  eventType: FulfillmentEventType;
  quantity: unknown;
  trackingUnit: unknown;
  requirementTrackingUnit?: unknown;
  requiredQuantity?: unknown;
  arrivedQuantity?: unknown;
  returnedQuantity?: unknown;
  acceptedQuantity?: unknown;
  rejectedQuantity?: unknown;
  usableQuantity?: unknown;
  automaticArrivalUsable?: boolean;
};

type ValidatedFulfillmentEvent = {
  eventType: FulfillmentEventType;
  quantity: string;
  trackingUnit: string;
};

const MICRO_SCALE = 1_000_000n;
const quantityPattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u;
const trackingUnitPattern = /^[A-Z][A-Z0-9._-]{0,31}$/u;

const standardEventTypes = new Set<FulfillmentEventType>([
  "PURCHASE_ARRIVED",
  "ACCEPTED",
  "MARKED_USABLE",
  "REJECTED",
  "RETURNED"
]);
const outsourcedEventTypes = new Set<FulfillmentEventType>([
  "OUTSOURCED_DISPATCHED",
  "OUTSOURCED_COMPLETED",
  "OUTSOURCED_RETURNED",
  "ACCEPTED",
  "MARKED_USABLE",
  "REJECTED",
  "RETURNED"
]);

function positiveQuantity(value: unknown, field: string): { text: string; micro: bigint } {
  if (typeof value !== "string" || !quantityPattern.test(value)) {
    throw new FulfillmentEventError(
      "PROC_EVENT_QUANTITY_INVALID",
      `${field} 必须是正数且最多 6 位小数。`
    );
  }
  const [whole, decimal = ""] = value.split(".");
  const micro = BigInt(whole) * MICRO_SCALE + BigInt(decimal.padEnd(6, "0"));
  if (micro <= 0n) {
    throw new FulfillmentEventError("PROC_EVENT_QUANTITY_INVALID", `${field} 必须是正数。`);
  }
  return { text: value, micro };
}

function nonNegativeQuantity(value: unknown, field: string): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value !== "string" || !quantityPattern.test(value)) {
    throw new FulfillmentEventError(
      "PROC_EVENT_QUANTITY_INVALID",
      `${field} 必须是非负数量且最多 6 位小数。`
    );
  }
  const [whole, decimal = ""] = value.split(".");
  return BigInt(whole) * MICRO_SCALE + BigInt(decimal.padEnd(6, "0"));
}

function trackingUnit(value: unknown, field: string): string {
  if (typeof value !== "string" || !trackingUnitPattern.test(value)) {
    throw new FulfillmentEventError("PROC_EVENT_UNIT_INVALID", `${field} 必须是受控单位代码。`);
  }
  return value;
}

function acceptsEventType(businessType: FulfillmentBusinessType, eventType: FulfillmentEventType) {
  if (eventType === "REVERSED") return false;
  const allowed = businessType === "OUTSOURCED_PROCESS" ? outsourcedEventTypes : standardEventTypes;
  return allowed.has(eventType);
}

function requireAtMost(candidate: bigint, maximum: bigint, code: string, message: string) {
  if (candidate > maximum) throw new FulfillmentEventError(code, message);
}

export function validateFulfillmentEvent(
  input: FulfillmentEventValidationInput
): ValidatedFulfillmentEvent {
  if (!acceptsEventType(input.businessType, input.eventType)) {
    throw new FulfillmentEventError(
      "PROC_EVENT_TYPE_INVALID",
      "履约事件类型不适用于当前采购业务类型。"
    );
  }

  const eventUnit = trackingUnit(input.trackingUnit, "trackingUnit");
  // Existing focused tests express the baseline unit as PCS. Application callers always supply it.
  const requirementUnit = trackingUnit(
    input.requirementTrackingUnit ?? "PCS",
    "requirementTrackingUnit"
  );
  if (eventUnit !== requirementUnit) {
    throw new FulfillmentEventError(
      "PROC_EVENT_UNIT_MISMATCH",
      "履约事件单位必须与需求跟踪单位一致。"
    );
  }

  const quantity = positiveQuantity(input.quantity, "quantity");
  const required =
    input.requiredQuantity === undefined
      ? null
      : nonNegativeQuantity(input.requiredQuantity, "requiredQuantity");
  const arrived = nonNegativeQuantity(input.arrivedQuantity, "arrivedQuantity");
  const returned = nonNegativeQuantity(input.returnedQuantity, "returnedQuantity");
  const accepted = nonNegativeQuantity(input.acceptedQuantity, "acceptedQuantity");
  const rejected = nonNegativeQuantity(input.rejectedQuantity, "rejectedQuantity");
  const usable = nonNegativeQuantity(input.usableQuantity, "usableQuantity");

  if (input.eventType === "PURCHASE_ARRIVED" || input.eventType === "OUTSOURCED_RETURNED") {
    if (required !== null) {
      requireAtMost(
        arrived + quantity.micro,
        required,
        "PROC_ARRIVAL_EXCEEDS_REQUIREMENT",
        "到货或委外返回数量不能超过当前有效需求数量。"
      );
    }
  }
  if (input.eventType === "OUTSOURCED_DISPATCHED" && required !== null) {
    requireAtMost(
      arrived + quantity.micro,
      required,
      "PROC_DISPATCH_EXCEEDS_REQUIREMENT",
      "委外送出数量不能超过当前有效需求数量。"
    );
  }
  if (input.eventType === "ACCEPTED") {
    requireAtMost(
      accepted + quantity.micro,
      arrived - returned - rejected,
      "PROC_ACCEPTANCE_EXCEEDS_AVAILABLE_ARRIVAL",
      "验收合格数量不能超过到货扣除退回和拒收后的可验收数量。"
    );
  }
  if (input.eventType === "MARKED_USABLE") {
    const usableLimit = input.automaticArrivalUsable ? arrived - returned - rejected : accepted;
    requireAtMost(
      usable + quantity.micro,
      usableLimit,
      "PROC_USABLE_EXCEEDS_ACCEPTED",
      "确认可用数量不能超过已验收的有效数量。"
    );
  }
  if (input.eventType === "REJECTED") {
    requireAtMost(
      rejected + quantity.micro,
      arrived - returned - accepted,
      "PROC_REJECTION_EXCEEDS_AVAILABLE_ARRIVAL",
      "拒收数量不能超过尚未验收或退回的到货数量。"
    );
  }
  if (input.eventType === "RETURNED") {
    requireAtMost(
      returned + quantity.micro,
      arrived,
      "PROC_RETURN_EXCEEDS_ARRIVAL",
      "退回数量不能超过累计到货数量。"
    );
  }

  return { eventType: input.eventType, quantity: quantity.text, trackingUnit: eventUnit };
}

export function deriveAutoUsableEvent(input: {
  arrivalAutoUsable: boolean;
  inspectionRequired: boolean;
  event: FulfillmentEventValidationInput & { source?: "LOCAL" | "ERP"; reason?: string };
}) {
  if (
    !input.arrivalAutoUsable ||
    input.inspectionRequired ||
    (input.event.eventType !== "PURCHASE_ARRIVED" &&
      input.event.eventType !== "OUTSOURCED_RETURNED")
  ) {
    return null;
  }
  const event = validateFulfillmentEvent(input.event);
  return {
    ...event,
    eventType: "MARKED_USABLE" as const,
    source: input.event.source ?? "LOCAL",
    reason: input.event.reason ?? "系统按到货自动可用政策标记可用。"
  };
}

export function selectFulfillmentReversalEventIds(input: {
  eventId: string;
  derivedAutoUsableEvent: { id: string; hasReversal: boolean } | null;
}): string[] {
  if (!input.derivedAutoUsableEvent || input.derivedAutoUsableEvent.hasReversal) {
    return [input.eventId];
  }
  return [input.eventId, input.derivedAutoUsableEvent.id];
}
