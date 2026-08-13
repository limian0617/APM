import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

function versionView(version: Record<string, any>) {
  return {
    ...version,
    createdAt: version.createdAt?.toISOString?.() ?? version.createdAt,
    submittedAt: version.submittedAt?.toISOString?.() ?? version.submittedAt
  };
}

export async function getProjectRetrospective(input: {
  projectId: string;
  client?: Prisma.TransactionClient | typeof db;
  allowedActions?: readonly string[];
}) {
  const client = input.client ?? db;
  const aggregate = await client.projectRetrospective.findUnique({
    where: { projectId: input.projectId },
    include: {
      versions: { orderBy: { versionNo: "desc" } },
      reviews: { orderBy: { reviewedAt: "desc" } }
    }
  });
  if (!aggregate) {
    return {
      projectId: input.projectId,
      retrospective: null,
      versions: [],
      allowedActions: input.allowedActions ?? []
    };
  }
  return {
    projectId: input.projectId,
    retrospective: {
      id: aggregate.id,
      version: aggregate.version,
      currentVersionId: aggregate.currentVersionId,
      latestApprovedVersionId: aggregate.latestApprovedVersionId
    },
    currentVersionId: aggregate.currentVersionId,
    latestApprovedVersionId: aggregate.latestApprovedVersionId,
    staleApprovedPointer: aggregate.currentVersionId !== aggregate.latestApprovedVersionId,
    versions: aggregate.versions.map(versionView),
    reviews: aggregate.reviews.map((review: Record<string, any>) => ({
      ...review,
      reviewedAt: review.reviewedAt?.toISOString?.() ?? review.reviewedAt
    })),
    allowedActions: input.allowedActions ?? []
  };
}
