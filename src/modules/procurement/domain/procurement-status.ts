export const PROCUREMENT_DISPLAY_STATUSES = [
  "PENDING_CONFIRMATION",
  "PENDING_REQUISITION",
  "REQUISITIONED",
  "ORDERED",
  "PARTIALLY_ARRIVED",
  "PENDING_ACCEPTANCE",
  "READY",
  "OVERDUE_BLOCKED",
  "REJECTED_RETURNED",
  "CHANGE_PENDING",
  "CANCELED"
] as const;

export type ProcurementDisplayStatus = (typeof PROCUREMENT_DISPLAY_STATUSES)[number];

export type ProcurementStatusFacts = {
  requirementStatus: "DRAFT" | "CONFIRMED" | "SUPERSEDED" | "CANCELED";
  hasChangeImpact?: boolean;
  rejectedOrReturnedQuantity?: string;
  isOverdue?: boolean;
  requiredQuantity?: string;
  arrivedQuantity?: string;
  usableQuantity?: string;
  orderedQuantity?: string;
  requisitioned?: boolean;
};

const SCALE = 1_000_000n;

function toScaledQuantity(value: string | undefined): bigint {
  if (!value || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(value)) return 0n;
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer) * SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function deriveProcurementDisplayStatus(
  facts: ProcurementStatusFacts
): ProcurementDisplayStatus {
  const required = toScaledQuantity(facts.requiredQuantity);
  const arrived = toScaledQuantity(facts.arrivedQuantity);
  const usable = toScaledQuantity(facts.usableQuantity);
  const ordered = toScaledQuantity(facts.orderedQuantity);
  const rejectedOrReturned = toScaledQuantity(facts.rejectedOrReturnedQuantity);

  if (facts.requirementStatus === "CANCELED" || facts.requirementStatus === "SUPERSEDED")
    return "CANCELED";
  if (facts.requirementStatus === "DRAFT") return "PENDING_CONFIRMATION";
  if (facts.hasChangeImpact) return "CHANGE_PENDING";
  if (rejectedOrReturned > 0n && (required === 0n || usable < required)) return "REJECTED_RETURNED";
  if (facts.isOverdue && (required === 0n || usable < required)) return "OVERDUE_BLOCKED";
  if (required > 0n && usable >= required) return "READY";
  if (required > 0n && arrived > 0n && arrived < required) return "PARTIALLY_ARRIVED";
  if (arrived > usable) return "PENDING_ACCEPTANCE";
  if (ordered > 0n) return "ORDERED";
  if (facts.requisitioned) return "REQUISITIONED";
  return "PENDING_REQUISITION";
}
