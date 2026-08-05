import { createFileScanHandler } from "@/modules/documents/application/file-scan-handler";
import { createClamAvScannerFromEnvironment } from "@/modules/documents/infrastructure/clamav-scanner";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";
import type { JobHandler } from "@/modules/governance/contracts/jobs";

export function createFileJobHandlers(): Readonly<Record<string, JobHandler>> {
  return {
    "file.scan.requested": createFileScanHandler({
      storage: createS3ObjectStorageFromEnvironment(),
      scanner: createClamAvScannerFromEnvironment()
    })
  };
}
