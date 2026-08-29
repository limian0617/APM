import type { ReactNode } from "react";

import { ProjectNavigationClient } from "./project-navigation-client";

type ProjectLayoutProps = Readonly<{
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}>;

export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const { projectId } = await params;

  return (
    <div className="project-shell">
      <div className="project-shell-navigation">
        <ProjectNavigationClient projectId={projectId} />
      </div>
      <div className="project-shell-content">{children}</div>
    </div>
  );
}
