import pino, { type Logger } from "pino";

import type { LogFields, StructuredLogger } from "../contracts/telemetry";
import { sanitizeLogFields } from "../domain/sanitize";

export class PinoStructuredLogger implements StructuredLogger {
  constructor(private readonly logger: Logger) {}

  info(event: string, fields: LogFields = {}): void {
    this.logger.info({ ...sanitizeLogFields(fields), event });
  }

  warn(event: string, fields: LogFields = {}): void {
    this.logger.warn({ ...sanitizeLogFields(fields), event });
  }

  error(event: string, fields: LogFields = {}): void {
    this.logger.error({ ...sanitizeLogFields(fields), event });
  }
}

export function createStructuredLogger(): StructuredLogger {
  return new PinoStructuredLogger(
    pino({
      name: "apm",
      level: process.env.NODE_ENV === "test" ? "silent" : process.env.LOG_LEVEL || "info",
      base: { service: "apm" },
      timestamp: pino.stdTimeFunctions.isoTime
    })
  );
}
