import type { JobHandler } from "@/modules/governance/contracts/jobs";
import { createReadinessRecalculationHandler } from "@/modules/procurement/application/readiness-recalculation-handler";

export function createProcurementJobHandlers(): Readonly<Record<string, JobHandler>> {
  return {
    "procurement.readiness-recalculation.requested": createReadinessRecalculationHandler()
  };
}
