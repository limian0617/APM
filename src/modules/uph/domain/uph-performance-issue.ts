import { decideUphPerformance } from "./uph-performance-target";

export type PerformanceIssueDecision = ReturnType<typeof decideUphPerformance>;

export function decidePerformanceIssue(input: {
  actualGoodUph: string;
  targetUph: string;
  status: string;
}): PerformanceIssueDecision {
  return decideUphPerformance(input);
}

export function assertPerformanceIssueCreation(input: PerformanceIssueDecision): void {
  if (!input.underperforming) throw new Error("UPH_TARGET_MET");
}
