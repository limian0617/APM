export type LivenessStatus = {
  service: "apm";
  status: "ok";
  timestamp: string;
};

export function createHealthStatus(now = new Date()): LivenessStatus {
  return {
    service: "apm",
    status: "ok",
    timestamp: now.toISOString()
  };
}
