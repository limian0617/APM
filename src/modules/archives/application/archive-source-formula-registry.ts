import type { Prisma } from "@prisma/client";

import {
  ARCHIVE_SOURCE_FORMULAS,
  parseArchiveSourceFormulaVersion,
  type ArchiveSourceFormulaVersion
} from "../domain/archive-source-formula";
import {
  createProjectArchiveManifest,
  createProjectArchiveManifestV2,
  type ArchiveManifestBuild,
  type ArchiveSourceFacts
} from "./archive-manifest-service";
import { readProjectArchiveSources } from "./archive-source-reader";
import { readProjectArchiveSourcesV2 } from "./archive-source-reader-v2";

export type ArchiveSourceFormulaAdapter = {
  readonly version: ArchiveSourceFormulaVersion;
  read(input: { client: Prisma.TransactionClient; projectId: string }): Promise<ArchiveSourceFacts>;
  buildManifest(input: ArchiveSourceFacts): ArchiveManifestBuild;
};

const adapters: Record<ArchiveSourceFormulaVersion, ArchiveSourceFormulaAdapter> = {
  [ARCHIVE_SOURCE_FORMULAS.V1]: {
    version: ARCHIVE_SOURCE_FORMULAS.V1,
    async read({ client, projectId }) {
      return { projectId, items: await readProjectArchiveSources({ client, projectId }) };
    },
    buildManifest: createProjectArchiveManifest
  },
  [ARCHIVE_SOURCE_FORMULAS.V2]: {
    version: ARCHIVE_SOURCE_FORMULAS.V2,
    async read({ client, projectId }) {
      return {
        projectId,
        items: await readProjectArchiveSourcesV2({
          projectId,
          client: client as never,
          readLegacySources: (id) => readProjectArchiveSources({ client, projectId: id })
        })
      };
    },
    buildManifest: createProjectArchiveManifestV2
  }
};

export function getArchiveSourceFormulaAdapter(
  version: string | null | undefined
): ArchiveSourceFormulaAdapter {
  return adapters[parseArchiveSourceFormulaVersion(version)];
}
