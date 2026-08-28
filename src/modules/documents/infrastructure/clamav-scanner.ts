import { once } from "node:events";
import { createConnection } from "node:net";

import type { VirusScannerPort, VirusScanResult } from "../contracts/file-storage";

export class ClamAvVirusScanner implements VirusScannerPort {
  constructor(
    private readonly configuration: {
      host: string;
      port: number;
      timeoutMilliseconds: number;
      version: string;
    }
  ) {}

  async scan(stream: AsyncIterable<Uint8Array>): Promise<VirusScanResult> {
    const socket = createConnection({
      host: this.configuration.host,
      port: this.configuration.port
    });
    socket.setTimeout(this.configuration.timeoutMilliseconds, () => {
      socket.destroy(new Error("ClamAV 扫描超时。"));
    });
    await once(socket, "connect");
    socket.write("zINSTREAM\0");
    for await (const chunk of stream) {
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(chunk.byteLength);
      if (!socket.write(length)) await once(socket, "drain");
      if (!socket.write(chunk)) await once(socket, "drain");
    }
    socket.write(Buffer.alloc(4));

    const responseChunks: Buffer[] = [];
    for await (const chunk of socket) {
      responseChunks.push(Buffer.from(chunk));
      if (chunk.includes(0)) break;
    }
    socket.destroy();
    const response = Buffer.concat(responseChunks).toString("utf8").replace(/\0.*$/u, "").trim();
    if (response.endsWith(" OK")) {
      return { result: "CLEAN", engine: "clamav", version: this.configuration.version };
    }
    const infected = response.match(/^.*?:\s*(.+)\s+FOUND$/u);
    if (infected?.[1]) {
      return {
        result: "INFECTED",
        engine: "clamav",
        version: this.configuration.version,
        signature: infected[1]
      };
    }
    throw new Error(`ClamAV 返回无法识别的扫描结果：${response || "empty response"}`);
  }
}

function positivePort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("APM_CLAMAV_PORT 必须是有效端口。");
  }
  return parsed;
}

export function createClamAvScannerFromEnvironment(): ClamAvVirusScanner {
  return new ClamAvVirusScanner({
    host: process.env.APM_CLAMAV_HOST?.trim() || "127.0.0.1",
    port: positivePort(process.env.APM_CLAMAV_PORT, 3310),
    timeoutMilliseconds: 120_000,
    version: process.env.APM_CLAMAV_VERSION?.trim() || "deployment-managed"
  });
}
