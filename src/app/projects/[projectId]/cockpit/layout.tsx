import type { ReactNode } from "react";

import { CockpitNavigationClient } from "./cockpit-navigation-client";

type CockpitLayoutProps = Readonly<{
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}>;

export default async function CockpitLayout({ children, params }: CockpitLayoutProps) {
  const { projectId } = await params;

  return (
    <div className="cockpit-shell">
      <CockpitNavigationClient projectId={projectId} />
      {children}
    </div>
  );
}
