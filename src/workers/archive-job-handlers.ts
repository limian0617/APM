import type { JobHandler } from "@/modules/governance/contracts/jobs";
import { createPrismaArchiveGenerationHandler } from "@/modules/archives/application/archive-generation-handler";
import { createArchiveIntegrityHandler } from "@/modules/archives/application/archive-integrity-handler";
import type { ObjectStoragePort } from "@/modules/documents/contracts/file-storage";

export function createArchiveJobHandlers(input?: {
  storage?: ObjectStoragePort;
}): Readonly<Record<string, JobHandler>> {
  const handlers: Record<string, JobHandler> = {
    "archive.generate": createPrismaArchiveGenerationHandler()
  };
  if (input?.storage) {
    handlers["archive.integrity.check"] = createArchiveIntegrityHandler({ storage: input.storage });
  }
  return handlers;
}
