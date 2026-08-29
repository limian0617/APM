export const PROCUREMENT_CHANGE_IMPACT_TYPES = ["REVISED", "CANCELED"] as const;
export type ProcurementChangeImpactType = (typeof PROCUREMENT_CHANGE_IMPACT_TYPES)[number];

export const PROCUREMENT_CHANGE_IMPACT_DISPOSITIONS = [
  "OWNER_PLAN_CONFIRMED",
  "SUPPLIER_ACCEPTED",
  "ERP_PROJECTED",
  "CANCELED",
  "REWORK",
  "RETURNED",
  "CONTINUE_USE"
] as const;
export type ProcurementChangeImpactDisposition =
  (typeof PROCUREMENT_CHANGE_IMPACT_DISPOSITIONS)[number];

export const PROCUREMENT_CHANGE_IMPACT_OBLIGATION_TYPES = [
  "PROCUREMENT_OWNER",
  "SUPPLIER",
  "ERP_PROJECTION",
  "OLD_TRACKING",
  "OLD_FULFILLMENT"
] as const;
export type ProcurementChangeImpactObligationType =
  (typeof PROCUREMENT_CHANGE_IMPACT_OBLIGATION_TYPES)[number];

export type ProcurementRevisionForChangeImpact = Readonly<{
  id: string;
  requirementId: string;
  materialReferenceId: string;
  quantity: string;
  trackingUnit: string;
  businessType: string;
  deliveryUnitId: string | null;
  moduleId: string | null;
  responsibilityPackageId: string | null;
  taskId: string | null;
  requiredOn: string;
  predictedAssemblyStartOn: string | null;
  drawingId: string | null;
  drawingVersionId: string | null;
  outsourcedProcess: string | null;
}>;

type PreviousTrackingLine = Readonly<{
  id: string;
  supplierReferenceId?: string | null;
  responsibleMembershipId?: string | null;
  source: "LOCAL" | "ERP";
}>;

type PreviousFulfillmentEvent = Readonly<{
  id: string;
  source: "LOCAL" | "ERP";
}>;

export type ProcurementChangeImpactObligation = Readonly<{
  type: ProcurementChangeImpactObligationType;
  subjectId: string;
}>;

export type DetectedProcurementChangeImpact = Readonly<{
  type: ProcurementChangeImpactType;
  requirementId: string;
  previousRevisionId: string;
  nextRevisionId: string | null;
  changedFields: readonly string[];
  obligations: readonly ProcurementChangeImpactObligation[];
}>;

function normalizedDecimal(value: string): string {
  const [integerRaw, fractionRaw = ""] = value.trim().split(".");
  const integer = (integerRaw ?? "").replace(/^0+(?=\d)/u, "") || "0";
  const fraction = fractionRaw.replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function sameValue(left: string | null, right: string | null): boolean {
  return left === right;
}

function changedFields(
  previous: ProcurementRevisionForChangeImpact,
  next: ProcurementRevisionForChangeImpact
): string[] {
  const changes: string[] = [];
  if (previous.materialReferenceId !== next.materialReferenceId)
    changes.push("materialReferenceId");
  if (normalizedDecimal(previous.quantity) !== normalizedDecimal(next.quantity))
    changes.push("quantity");
  if (previous.trackingUnit !== next.trackingUnit) changes.push("trackingUnit");
  if (previous.businessType !== next.businessType) changes.push("businessType");
  for (const field of [
    "deliveryUnitId",
    "moduleId",
    "responsibilityPackageId",
    "taskId",
    "requiredOn",
    "predictedAssemblyStartOn",
    "drawingId",
    "drawingVersionId",
    "outsourcedProcess"
  ] as const) {
    if (!sameValue(previous[field], next[field])) changes.push(field);
  }
  return changes;
}

function uniqueObligations(
  obligations: readonly ProcurementChangeImpactObligation[]
): ProcurementChangeImpactObligation[] {
  const deduplicated = new Map<string, ProcurementChangeImpactObligation>();
  for (const obligation of obligations) {
    deduplicated.set(`${obligation.type}:${obligation.subjectId}`, obligation);
  }
  return [...deduplicated.values()].sort((left, right) =>
    `${left.type}:${left.subjectId}`.localeCompare(`${right.type}:${right.subjectId}`)
  );
}

function obligationsFor(input: {
  trackingLines: readonly PreviousTrackingLine[];
  fulfillmentEvents: readonly PreviousFulfillmentEvent[];
  mode?: "LOCAL" | "ERP";
}): ProcurementChangeImpactObligation[] {
  const obligations: ProcurementChangeImpactObligation[] = [];
  for (const line of input.trackingLines) {
    obligations.push({
      type: "PROCUREMENT_OWNER",
      subjectId: line.responsibleMembershipId ?? "unassigned"
    });
    obligations.push({ type: "OLD_TRACKING", subjectId: line.id });
    if (line.supplierReferenceId) {
      obligations.push({ type: "SUPPLIER", subjectId: line.supplierReferenceId });
    }
  }
  for (const event of input.fulfillmentEvents) {
    obligations.push({ type: "OLD_FULFILLMENT", subjectId: event.id });
  }
  if (
    input.mode === "ERP" ||
    input.trackingLines.some((line) => line.source === "ERP") ||
    input.fulfillmentEvents.some((event) => event.source === "ERP")
  ) {
    obligations.push({ type: "ERP_PROJECTION", subjectId: "project" });
  }
  return uniqueObligations(obligations);
}

export function detectProcurementChangeImpact(input: {
  previous: ProcurementRevisionForChangeImpact;
  next: ProcurementRevisionForChangeImpact | null;
  previousStatus: string;
  previousTrackingLines: readonly PreviousTrackingLine[];
  previousFulfillmentEvents: readonly PreviousFulfillmentEvent[];
  mode?: "LOCAL" | "ERP";
}): DetectedProcurementChangeImpact | null {
  if (input.previousStatus !== "CONFIRMED") return null;
  if (input.previousTrackingLines.length === 0 && input.previousFulfillmentEvents.length === 0) {
    return null;
  }
  const type: ProcurementChangeImpactType = input.next ? "REVISED" : "CANCELED";
  const changes = input.next ? changedFields(input.previous, input.next) : ["canceled"];
  if (changes.length === 0) return null;
  return {
    type,
    requirementId: input.previous.requirementId,
    previousRevisionId: input.previous.id,
    nextRevisionId: input.next?.id ?? null,
    changedFields: changes,
    obligations: obligationsFor({
      trackingLines: input.previousTrackingLines,
      fulfillmentEvents: input.previousFulfillmentEvents,
      mode: input.mode
    })
  };
}
