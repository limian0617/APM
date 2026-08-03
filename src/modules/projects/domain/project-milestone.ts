export type ProjectMilestoneStatus = "PENDING" | "ACHIEVED" | "VOID";
export type ProjectMilestoneTaskLinkStatus = "ACTIVE" | "VOID";
export type LinkedMilestoneTaskStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "CLOSED";

export function canManuallyAchieveMilestone(status: ProjectMilestoneStatus) {
  return status === "PENDING";
}

export function canVoidMilestone(status: ProjectMilestoneStatus) {
  return status !== "VOID";
}

export function shouldAutoAchieveMilestone(input: {
  status: ProjectMilestoneStatus;
  links: ReadonlyArray<{
    status: ProjectMilestoneTaskLinkStatus;
    taskStatus: LinkedMilestoneTaskStatus;
  }>;
}) {
  if (input.status !== "PENDING") {
    return false;
  }
  const activeLinks = input.links.filter(({ status }) => status === "ACTIVE");
  return (
    activeLinks.length > 0 && activeLinks.every(({ taskStatus }) => taskStatus === "COMPLETED")
  );
}
