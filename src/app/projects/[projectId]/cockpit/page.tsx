import { CockpitPageClient } from "./cockpit-page-client";
import {
  buildCockpitDashboardPageState,
  developmentCockpitDashboardFixture
} from "@/modules/cockpit/contracts/cockpit-dashboard-page-state";

type CockpitPageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ fixture?: string }>;
};

export default async function CockpitPage({ params, searchParams }: CockpitPageProps) {
  const { projectId } = await params;
  const { fixture } = await searchParams;
  const fixtureSources = developmentCockpitDashboardFixture(projectId, fixture);
  const initialState = fixtureSources ? buildCockpitDashboardPageState(fixtureSources) : null;

  return <CockpitPageClient projectId={projectId} initialState={initialState} />;
}
