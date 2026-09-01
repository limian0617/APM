import { UphPageClient } from "./uph-page-client";

type UphPageProps = { params: Promise<{ projectId: string }> };

export default async function UphPage({ params }: UphPageProps) {
  const { projectId } = await params;
  return <UphPageClient projectId={projectId} />;
}
