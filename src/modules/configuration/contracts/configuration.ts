import type { AuditContext } from "@/modules/audit/contracts/audit";

import type { CapabilityCodeValue } from "../domain/definitions";

export type UpdateSettingCommand = {
  key: string;
  value: unknown;
  version: unknown;
  reason: unknown;
  actorId: string;
  auditContext: AuditContext;
};

export type UpdateCapabilityCommand = {
  code: CapabilityCodeValue;
  enabled: unknown;
  version: unknown;
  reason: unknown;
  actorId: string;
  auditContext: AuditContext;
};
