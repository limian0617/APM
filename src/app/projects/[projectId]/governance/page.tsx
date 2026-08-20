import { RetrospectivePageClient } from "./retrospective-page-client";
export default async function GovernancePage({
  params
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <RetrospectivePageClient projectId={projectId} />;
}
