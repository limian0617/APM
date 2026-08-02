export type HealthStatus = {
  service: "apm";
  status: "ok";
  timestamp: string;
};

export function createHealthStatus(now = new Date()): HealthStatus {
  return {
    service: "apm",
    status: "ok",
    timestamp: now.toISOString()
  };
}
