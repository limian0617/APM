export class ProjectWritePolicyError extends Error {
  readonly code = "PROJECT_READ_ONLY";
  readonly status = 409;

  constructor() {
    super("项目已关闭或取消，历史业务事实只读。");
    this.name = "ProjectWritePolicyError";
  }
}

export function assertProjectWritable(status: string): void {
  if (status === "CLOSED" || status === "CANCELED") throw new ProjectWritePolicyError();
}

export async function assertProjectWritableById(
  client: { project?: { findUnique: (...args: any[]) => Promise<{ status: string } | null> } },
  projectId: string
): Promise<void> {
  const projectDelegate = client.project;
  if (!projectDelegate) return;
  const project = await projectDelegate.findUnique({
    where: { id: projectId },
    select: { status: true }
  });
  if (!project) return;
  assertProjectWritable(project.status);
}
