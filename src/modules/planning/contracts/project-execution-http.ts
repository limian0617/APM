import { projectMilestoneErrorResponse } from "@/modules/projects/contracts/project-http";

import { planningErrorResponse } from "./planning-http";

export function projectExecutionErrorResponse(error: unknown): Response | null {
  return planningErrorResponse(error) ?? projectMilestoneErrorResponse(error);
}
