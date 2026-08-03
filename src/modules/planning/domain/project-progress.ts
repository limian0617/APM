export type ProjectProgressTaskStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "CLOSED";

export type ProjectProgressTask = {
  status: ProjectProgressTaskStatus;
  plannedDurationMinutes: number;
  remainingDurationMinutes: number;
};

export type ProjectProgress =
  | { status: "EMPTY" }
  | {
      status: "READY";
      completedWorkdays: number;
      totalWorkdays: number;
      percent: number;
    };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function calculateProjectProgress(
  tasks: readonly ProjectProgressTask[],
  minutesPerWorkday: number
): ProjectProgress {
  if (!Number.isFinite(minutesPerWorkday) || minutesPerWorkday <= 0) {
    throw new RangeError("minutesPerWorkday must be a positive finite number.");
  }

  const totals = tasks.reduce(
    (current, task) => {
      if (task.status === "CLOSED") {
        return current;
      }
      const planned = Math.max(0, task.plannedDurationMinutes);
      const completed =
        task.status === "COMPLETED"
          ? planned
          : clamp(planned - task.remainingDurationMinutes, 0, planned);
      return { completed: current.completed + completed, planned: current.planned + planned };
    },
    { completed: 0, planned: 0 }
  );

  if (totals.planned === 0) {
    return { status: "EMPTY" };
  }

  return {
    status: "READY",
    completedWorkdays: totals.completed / minutesPerWorkday,
    totalWorkdays: totals.planned / minutesPerWorkday,
    percent: (totals.completed / totals.planned) * 100
  };
}
