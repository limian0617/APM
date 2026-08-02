import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { PinoStructuredLogger } from "./structured-logger";

describe("PinoStructuredLogger", () => {
  it("writes structured JSON and sanitizes fields before serialization", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const logger = new PinoStructuredLogger(
      pino({ base: undefined, timestamp: false }, destination)
    );

    logger.info("request.completed", {
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      password: "must-not-leak",
      result: "success"
    });
    await new Promise<void>((resolve) => destination.end(resolve));

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: "request.completed",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      password: "[REDACTED]",
      result: "success"
    });
    expect(output).not.toContain("must-not-leak");
  });
});
