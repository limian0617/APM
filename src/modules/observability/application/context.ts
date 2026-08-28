import { AsyncLocalStorage } from "node:async_hooks";

import type { ObservabilityContext } from "../contracts/telemetry";

const contextStorage = new AsyncLocalStorage<ObservabilityContext>();

export function currentObservabilityContext(): ObservabilityContext | null {
  return contextStorage.getStore() ?? null;
}

export function runWithObservabilityContext<T>(
  context: ObservabilityContext,
  operation: () => T
): T {
  return contextStorage.run(context, operation);
}
