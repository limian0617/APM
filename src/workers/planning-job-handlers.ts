import type { JobHandler } from "@/modules/governance/contracts/jobs";
import { createScheduleRecalculationHandler } from "@/modules/planning/application/schedule-recalculation-handler";

export function createPlanningJobHandlers(): Readonly<Record<string, JobHandler>> {
  return {
    "planning.schedule-recalculation.requested": createScheduleRecalculationHandler()
  };
}
